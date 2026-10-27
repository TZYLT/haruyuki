/**
 * `/compact`'s receipt, its cancellation exits, and the usage ledger (F-04 §5.14).
 *
 * Three things are asserted here that the state-machine file deliberately does
 * not cover:
 *
 * - the receipt's copy, as a pure function of the preview and the apply result,
 *   including the degraded run and the "nothing was written" refusal;
 * - the two zero-write exits — the picker's cancel and Escape during the
 *   summarizer — each of which must still leave a ledger row, because the tokens
 *   were spent either way;
 * - the ledger row itself: `source:"compaction"`, the model, the three token
 *   counts and the outcome.
 *
 * Every test redirects `HARUYUKI_HOME` to a temporary root, because the ledger's
 * default path is the real home (`《31》A2`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import {
  cancelCompactionPreparation,
  formatCompactionReceipt,
  handleCompactCommand,
} from "@/cli/app/submit-compact-commands";
import { takeTopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import {
  cleanupCompactHarness,
  createStorageDirectory,
  fixtureRuntime,
  harness,
  localConversation,
  previewFor,
  topicBlocks,
} from "@/test-utils/compact-command-harness";
import { readUsageLedger } from "@/usage/ledger";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;

beforeEach(async () => {
  process.env.HARUYUKI_HOME = await createStorageDirectory();
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  __testSetBackend(null);
  takeTopicTrimRequest();
  await cleanupCompactHarness();
});

/** The apply result the fixture returns, for the receipt's own unit tests. */
const APPLIED: CompactionApplyResult = {
  executed: true,
  source: "topic_pick",
  topicTitle: null,
  foldedTopicIds: ["topic-1", "topic-2"],
  foldedTitles: ["Auth token refresh", "Deploy check"],
  numMessagesBefore: 20,
  numMessagesAfter: 6,
  summarizedMessageCount: 14,
  summarizedTokens: 4_200,
  retainedTokens: 1_100,
  retentionCapTokens: 1_500,
  firstKeptMessageId: "kept",
  stats: { context_tokens_after: 1_200 },
};

describe("formatCompactionReceipt", () => {
  test("names the summary, the folded topics, the tokens and the cut", () => {
    const preview = previewFor({
      conversationId: "conv",
      agentId: "agent",
      blocks: [],
      suggestionIndex: 1,
    });
    const receipt = formatCompactionReceipt(preview, APPLIED);

    expect(receipt).toContain("Compaction complete.");
    // The overview's rendered length, not the narrative's: the write-back
    // carries the restricted sections too.
    expect(receipt).toContain(
      "characters · 2 topics folded (Auth token refresh, Deploy check)",
    );
    expect(receipt).toContain("~4200 → ~1100");
    expect(receipt).toContain("20 → 6 messages");
    expect(receipt).toContain("cap ~1500");
    expect(receipt).toContain("cut point:  the topic block you picked");
    expect(receipt).toContain("openai/gpt-5.5 · 1.5s");
    expect(receipt).toContain("1200 prompt (800 cached) · 240 completion");
    expect(receipt).toContain("evicts the provider cache");
  });

  test("a degraded run says it produced no topics and why", () => {
    const preview = previewFor({
      conversationId: "conv",
      agentId: "agent",
      blocks: [],
      suggestionIndex: 1,
      degraded: "format",
    });

    expect(formatCompactionReceipt(preview, APPLIED)).toContain(
      "the summarizer's structured answer was unusable twice",
    );
  });

  test("the rate's own cut is named as the rate's, not as the user's pick", () => {
    const preview = previewFor({
      conversationId: "conv",
      agentId: "agent",
      blocks: [],
      suggestionIndex: 1,
    });

    expect(
      formatCompactionReceipt(preview, {
        ...APPLIED,
        source: "ratio_suggestion",
      }),
    ).toContain("no marker defines a boundary here");
    expect(
      formatCompactionReceipt(preview, { ...APPLIED, source: "ratio_cap" }),
    ).toContain("the picked block kept more than the rate allows");
  });

  test("a confirmed suggestion is reported as the ratio's choice", () => {
    const preview = previewFor({
      conversationId: "conv",
      agentId: "agent",
      blocks: [],
      suggestionIndex: 1,
    });

    expect(
      formatCompactionReceipt(preview, APPLIED, { confirmedSuggestion: true }),
    ).toContain("compression rate (the block it points at");
  });

  test("a refusal says what was not written instead of pretending it ran", () => {
    const preview = previewFor({
      conversationId: "conv",
      agentId: "agent",
      blocks: [],
      suggestionIndex: 1,
    });
    const receipt = formatCompactionReceipt(preview, {
      ...APPLIED,
      executed: false,
      noopReason: "nothing_before_boundary",
    });

    expect(receipt).toContain("Nothing was written");
    // The structured reason becomes prose: a receipt is read, not decoded.
    expect(receipt).toContain("starts at the first message");
    expect(receipt).not.toContain("Compaction complete.");
  });

  test("a run without a retention cap does not print an empty one", () => {
    const preview = previewFor({
      conversationId: "conv",
      agentId: "agent",
      blocks: [],
      suggestionIndex: 1,
    });
    const receipt = formatCompactionReceipt(preview, {
      ...APPLIED,
      retentionCapTokens: null,
    });

    expect(receipt).not.toContain("cap ~");
  });
});

describe("the zero-write exits", () => {
  test("cancelling the picker writes nothing and records the cancelled run", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({ blocks, suggestionIndex: 2 });
    h.ctx.compaction = runtime;
    await handleCompactCommand("/compact", h.ctx);

    takeTopicTrimRequest()?.onCancel?.();
    await Bun.sleep(25);

    // Zero writes (§5.9.1): apply was never called, and the row says so.
    expect(calls.applied).toEqual([]);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toBe("Cancelled: the context is unchanged.");
    expect(h.tracker.lastContextTokens).toBe(0);
    expect((await readUsageLedger()).at(-1)).toMatchObject({
      source: "compaction",
      outcome: "cancelled",
      sessionId: local.conversationId,
    });
  });

  test("a failed preparation writes nothing, records the failure, and says why", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({
      blocks,
      suggestionIndex: 1,
      prepareError: new Error("provider refused the request"),
    });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact", h.ctx);

    expect(calls.applied).toEqual([]);
    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("provider refused the request");
    expect(h.overlays).toEqual(["compaction", null]);
    expect((await readUsageLedger()).at(-1)).toMatchObject({
      source: "compaction",
      outcome: "failed",
      sessionId: local.conversationId,
    });
  });

  test("Esc while the summarizer runs aborts it, drops the preview, and records the cancellation", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({ blocks, suggestionIndex: 1 });
    // A summarizer that never answers until the signal fires: the case §5.2.6
    // says the user's Escape is the only exit from.
    runtime.prepare = (input) =>
      new Promise((_resolve, reject) => {
        calls.prepared.push({
          conversationId: input.conversationId,
          agentId: input.agentId,
          hasSignal: input.signal !== undefined,
        });
        input.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    h.ctx.compaction = runtime;

    const pending = handleCompactCommand("/compact", h.ctx);
    await Bun.sleep(0);
    cancelCompactionPreparation();
    await pending;

    expect(calls.applied).toEqual([]);
    expect(h.commands[0]?.output).toBe("Cancelled: the context is unchanged.");
    expect(h.commands[0]?.succeeded).toBe(true);
    expect(h.overlays).toEqual(["compaction", null]);
    expect((await readUsageLedger()).at(-1)).toMatchObject({
      source: "compaction",
      outcome: "cancelled",
    });
  });

  test("a failed apply writes no context change and records the failure", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime } = fixtureRuntime({
      blocks,
      suggestionIndex: 1,
      applyError: new Error("the rewrite was refused"),
    });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("the rewrite was refused");
    // Nothing was re-based, because nothing was written.
    expect(h.tracker.lastContextTokens).toBe(0);
    expect(h.descriptions()).toBe(0);
    expect((await readUsageLedger()).at(-1)).toMatchObject({
      source: "compaction",
      outcome: "failed",
    });
  });
});

describe("the usage ledger", () => {
  test("a completed run names the model, the tokens and the wall time", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime } = fixtureRuntime({ blocks, suggestionIndex: 1 });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact", h.ctx);

    expect((await readUsageLedger()).at(-1)).toMatchObject({
      agentId: local.agentId,
      model: "openai/gpt-5.5",
      source: "compaction",
      outcome: "completed",
      prompt: 1_200,
      cachedInput: 800,
      completion: 240,
      sessionId: local.conversationId,
    });
  });
});
