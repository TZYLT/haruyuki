/**
 * `DreamStatus` (F-06 R-5.3.5 / Q-56).
 *
 * The run is unattended, so the tool has to answer two questions honestly:
 * "how much budget is left" and "how much room do I have left to finish". It
 * also has to be plainly read-only — a status check that wrote the run record
 * would corrupt the very numbers it reports.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { setConversationId } from "@/agent/context";
import { DREAM_SETTINGS_DEFAULTS } from "@/dream-settings";
import { runOutsideRuntimeContext } from "@/runtime-context";
import {
  buildDreamStatusSnapshot,
  DREAM_STATUS_TOKENS_PER_STEP_ESTIMATE,
  dream_status,
  dreamStatusHint,
} from "@/tools/impl/dream-status";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

const NOW = Date.UTC(2026, 9, 30, 22, 30);

afterEach(() => {
  setConversationId(null);
});

function metadata(overrides: Partial<DreamRunMetadata> = {}): DreamRunMetadata {
  return {
    runId: "run-1",
    triggerSource: "idle",
    agentId: "agent-1",
    conversationId: "conv-dream-1",
    tierPlan: ["tidy", "think", "task", "wander"],
    tierReached: "think",
    startedAt: NOW - 30 * 60_000,
    endedAt: null,
    baselineSha: "abc123",
    budgetTokens: 100_000,
    spentTokens: 32_000,
    timeLimitMinutes: null,
    status: "running",
    reportPath: null,
    handoff: null,
    ...overrides,
  };
}

function backendFor(record: unknown) {
  const calls = { retrieve: 0, write: 0 };
  return {
    calls,
    backend: {
      retrieveConversation: async () => {
        calls.retrieve += 1;
        return record;
      },
      // Present so a write would be visible; the tool must never call it.
      updateConversation: async () => {
        calls.write += 1;
        throw new Error("DreamStatus must not write");
      },
    },
  };
}

function run(record: unknown, deps: Parameters<typeof dream_status>[1] = {}) {
  return dream_status(
    {},
    {
      backend: { retrieveConversation: async () => record },
      agentId: "agent-1",
      conversationId: "conv-dream-1",
      settings: DREAM_SETTINGS_DEFAULTS,
      now: NOW,
      ...deps,
    },
  );
}

describe("buildDreamStatusSnapshot", () => {
  test("computes budget, percent, tier progress and estimated steps", () => {
    const snapshot = buildDreamStatusSnapshot({
      metadata: metadata(),
      settings: DREAM_SETTINGS_DEFAULTS,
      now: NOW,
    });
    expect(snapshot.remainingTokens).toBe(68_000);
    expect(snapshot.spentPercent).toBe(32);
    expect(snapshot.remainingTiers).toEqual(["task", "wander"]);
    expect(snapshot.estimatedRemainingSteps).toBe(
      Math.floor(68_000 / DREAM_STATUS_TOKENS_PER_STEP_ESTIMATE),
    );
    expect(snapshot.elapsedMinutes).toBe(30);
    expect(snapshot.remainingMinutes).toBeNull();
  });

  test("never reports negative room", () => {
    const snapshot = buildDreamStatusSnapshot({
      metadata: metadata({ spentTokens: 150_000, budgetTokens: 100_000 }),
      settings: DREAM_SETTINGS_DEFAULTS,
      now: NOW,
    });
    expect(snapshot.remainingTokens).toBe(0);
    expect(snapshot.spentPercent).toBe(100);
    expect(snapshot.estimatedRemainingSteps).toBe(0);
  });

  test("reports the time left when a limit is configured", () => {
    const snapshot = buildDreamStatusSnapshot({
      metadata: metadata({ timeLimitMinutes: 60 }),
      settings: DREAM_SETTINGS_DEFAULTS,
      now: NOW,
    });
    expect(snapshot.remainingMinutes).toBe(30);
  });

  test("all tiers are remaining before anything was reached", () => {
    const snapshot = buildDreamStatusSnapshot({
      metadata: metadata({ tierReached: null }),
      settings: DREAM_SETTINGS_DEFAULTS,
      now: NOW,
    });
    expect(snapshot.remainingTiers).toEqual([
      "tidy",
      "think",
      "task",
      "wander",
    ]);
  });
});

describe("dreamStatusHint", () => {
  test("escalates at the 40/75/90/100 thresholds", () => {
    expect(dreamStatusHint(0)).toContain("comfortable");
    expect(dreamStatusHint(39)).toContain("comfortable");
    expect(dreamStatusHint(40)).toContain("prefer finishing");
    expect(dreamStatusHint(74)).toContain("prefer finishing");
    expect(dreamStatusHint(75)).toContain("wrapping up");
    expect(dreamStatusHint(89)).toContain("wrapping up");
    expect(dreamStatusHint(90)).toContain("call DreamDone");
    expect(dreamStatusHint(99)).toContain("call DreamDone");
    expect(dreamStatusHint(100)).toContain("Budget exhausted");
  });
});

describe("dream_status", () => {
  test("reports the run in readable lines", async () => {
    const result = await run({ dream: metadata() });
    expect(result.status).toBe("success");
    expect(result.content).toContain("run run-1");
    expect(result.content).toContain("status: running");
    expect(result.content).toContain("100,000 tokens");
    expect(result.content).toContain("32,000");
    expect(result.content).toContain("32%");
    expect(result.content).toContain("68,000");
    expect(result.content).toContain("tier reached: think");
    expect(result.content).toContain("tiers remaining: task, wander");
    expect(result.content).toContain("estimated remaining steps");
    expect(result.content).toContain("read-only");
  });

  test("shows the recorded handoff", async () => {
    const result = await run({
      dream: metadata({ handoff: "next: finish projects/acme" }),
    });
    expect(result.content).toContain("handoff: next: finish projects/acme");
  });

  test("is read-only: it never writes the record", async () => {
    const tracked = backendFor({ dream: metadata() });
    const result = await dream_status(
      {},
      {
        backend: tracked.backend,
        agentId: "agent-1",
        conversationId: "conv-dream-1",
        settings: DREAM_SETTINGS_DEFAULTS,
        now: NOW,
      },
    );
    expect(result.status).toBe("success");
    expect(tracked.calls.retrieve).toBe(1);
    expect(tracked.calls.write).toBe(0);
  });

  test("names disabled tiers", async () => {
    const result = await run(
      { dream: metadata() },
      {
        settings: {
          ...DREAM_SETTINGS_DEFAULTS,
          tiers: { tidy: true, think: true, task: false, wander: false },
        },
      },
    );
    expect(result.content).toContain("disabled tiers: task, wander");
  });

  test("refuses a conversation without a run record", async () => {
    const result = await run({ hidden: true });
    expect(result.status).toBe("error");
    expect(result.content).toContain("not a dream run");
  });

  test("reports an unknown conversation", async () => {
    const result = await run(null, {
      backend: {
        retrieveConversation: async () => {
          throw new Error("not found");
        },
      },
    });
    expect(result.status).toBe("error");
    expect(result.content).toContain("was not found");
  });

  test("refuses without an agent or conversation context", async () => {
    setConversationId(null);
    const noAgent = await runOutsideRuntimeContext(() =>
      dream_status({}, { conversationId: "c" }),
    );
    expect(noAgent.status).toBe("error");
    expect(noAgent.content).toContain("no agent");

    const noConversation = await runOutsideRuntimeContext(() =>
      dream_status({}, { agentId: "a" }),
    );
    expect(noConversation.status).toBe("error");
    expect(noConversation.content).toContain("no conversation");
  });
});
