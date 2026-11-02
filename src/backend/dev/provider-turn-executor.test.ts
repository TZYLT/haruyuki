import { describe, expect, test } from "bun:test";
import {
  emptyLocalUsage,
  type LocalAssistantMessage,
  type LocalMessage,
} from "@/backend/local/local-message";
import type { LocalAgentRecord } from "@/backend/local/local-store";
import {
  estimateProviderContextComposition,
  estimateProviderContextTokens,
  type ProviderTurnInput,
} from "./provider-turn-executor";

/**
 * The T-05 context-number correction, at its only backend seam.
 *
 * 47-2 §1.5 #1 fixes the change to one call inside
 * `estimateProviderContextComposition`: `messages` must be the pure transcript
 * estimate (`estimateLocalMessagesTokens`), not the anchored whole-request total
 * (`estimateLocalContextTokens`). The anchored number already includes the
 * system prompt, the tools and the previous reply, so the old composition
 * counted them twice and the three parts could sum past the window. The total
 * (`estimateProviderContextTokens`) and the compaction estimate deliberately keep
 * the anchored behaviour — these tests pin both sides so a later "cleanup" cannot
 * quietly change the wrong one.
 *
 * `local-context-estimate.test.ts` stays byte-for-byte untouched: it is G-5's
 * evidence that the estimator functions themselves were not rewritten.
 */

function agent(): LocalAgentRecord {
  return {
    id: "agent-local-1",
    name: "Local",
    description: null,
    system: "",
    tags: [],
    model: "openai/gpt-5.5",
    model_settings: {},
  };
}

function input(overrides: Partial<ProviderTurnInput> = {}): ProviderTurnInput {
  return {
    conversationId: "local-conv-1",
    agentId: "agent-local-1",
    agent: agent(),
    body: { messages: [] } as never,
    history: [],
    uiMessages: [],
    clientTools: [],
    ...overrides,
    // Required on `ProviderTurnInput`; `Partial` above would otherwise widen it
    // to `unknown[] | undefined` and fail the return type.
    clientSkills: overrides.clientSkills ?? [],
  };
}

function user(text: string, id = "local-user-1"): LocalMessage {
  return { id, role: "user", content: text, timestamp: 1 };
}

function assistant(
  text: string,
  totalTokens: number,
  id = "local-assistant-1",
): LocalAssistantMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: { ...emptyLocalUsage(), totalTokens },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("estimateProviderContextComposition", () => {
  test("messages is the pure transcript, not the anchored request total", () => {
    // A realistic local turn: a small visible transcript, but the last assistant
    // reply carries the provider's usage anchor for the whole previous request
    // (system prompt + tools + messages + output) — here 407k tokens.
    const uiMessages: LocalMessage[] = [
      user("x".repeat(4_000)), // 1,000 tokens
      assistant("done", 407_000), // 1 token of text, 407k of anchor
      user("keep going", "local-user-2"), // ceil(10 / 4) = 3 tokens
    ];
    const turnInput = input({ uiMessages });

    // The total still uses the anchor: that is what the context window and the
    // hard-overflow guard are compared against, and it is what the rail shows.
    expect(estimateProviderContextTokens(turnInput)).toBe(407_003);
    // The composition does not: `messages` is 1,000 + 1 + 3 = 1,004 tokens.
    const composition = estimateProviderContextComposition(turnInput);
    expect(composition?.messages).toBe(1_004);
    // The old code returned the anchor here (407,003), which is the double
    // counting R-05.3 removed.
    expect(composition?.messages).not.toBe(
      estimateProviderContextTokens(turnInput),
    );
  });

  test("the three components and the total stay the same order of magnitude", () => {
    // system ≈ 10k, transcript ≈ 100k, tools ≈ 5k; the anchor says the real
    // request was ≈120k. The estimate misses by a few percent (4 bytes/token),
    // which is the tolerance O-06 accepts — the parts must not overshoot the
    // whole by counting them twice, as they did when `messages` was anchored.
    const systemPrompt = "s".repeat(40_000); // ceil(40,000 / 4)
    const clientTools = ["t".repeat(20_000)]; // JSON length 20,002 -> 5,001
    const uiMessages: LocalMessage[] = [
      user("u".repeat(400_000)), // 100,000 tokens
      assistant("done", 120_000), // the previous request's anchored total
    ];
    const turnInput = input({ systemPrompt, clientTools, uiMessages });

    const total = estimateProviderContextTokens(turnInput);
    const composition = estimateProviderContextComposition(turnInput);
    expect(total).toBe(120_000);
    expect(composition?.system).toBe(10_000);
    expect(composition?.messages).toBe(100_001);
    expect(composition?.tools).toBe(5_001);

    const sum =
      (composition?.system ?? 0) +
      (composition?.messages ?? 0) +
      (composition?.tools ?? 0);
    // Same magnitude: within 10% of the provider-reported request size.
    expect(Math.abs(sum - (total ?? 0))).toBeLessThanOrEqual(
      (total ?? 0) * 0.1,
    );
    // And never the old double count: the three parts are comfortably under the
    // whole, not over it.
    expect(sum).toBeLessThan(total ?? 0);
  });

  test("without a usage anchor the parts add up to the total exactly", () => {
    // The total falls back to system + transcript + tools, so the composition is
    // that same sum by construction; this is the invariant that makes the two
    // numbers comparable when there is no provider anchor.
    const systemPrompt = "s".repeat(4_000); // 1,000
    const clientTools = ["t".repeat(2_000)]; // JSON length 2,004 -> 501
    const turnInput = input({
      systemPrompt,
      clientTools,
      uiMessages: [user("u".repeat(4_000))], // 1,000
    });

    const total = estimateProviderContextTokens(turnInput);
    const composition = estimateProviderContextComposition(turnInput);
    expect(total).toBe(2_501);
    expect(
      (composition?.system ?? 0) +
        (composition?.messages ?? 0) +
        (composition?.tools ?? 0),
    ).toBe(total ?? -1);
  });

  test("an empty request has no composition and no total", () => {
    // No system prompt, no transcript, no frozen tool set: nothing to split.
    // (`[]` would serialize to two characters and is deliberately not "empty".)
    const turnInput = input({
      clientTools: undefined as unknown as unknown[],
    });
    expect(estimateProviderContextComposition(turnInput)).toBeUndefined();
    expect(estimateProviderContextTokens(turnInput)).toBeUndefined();
  });
});
