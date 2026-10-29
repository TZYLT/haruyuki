import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrajectoryStatsSnapshot } from "@/agent/stats";
import { readUsageLedger } from "@/usage/ledger";
import {
  __testResetScheduledRunContext,
  peekScheduledRunContext,
  setScheduledRunContext,
} from "@/usage/scheduled-run-context";
import { appendTurnUsageRecord } from "./usage-record";

const tempRoots: string[] = [];
const originalHome = process.env.HARUYUKI_HOME;

afterEach(async () => {
  __testResetScheduledRunContext();
  if (originalHome === undefined) {
    delete process.env.HARUYUKI_HOME;
  } else {
    process.env.HARUYUKI_HOME = originalHome;
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "haruyuki-usage-record-"));
  tempRoots.push(root);
  return root;
}

function snapshotOf(
  overrides: Partial<TrajectoryStatsSnapshot> = {},
): TrajectoryStatsSnapshot {
  return {
    trajectoryStartMs: 0,
    wallMs: 4_000,
    workMs: 3_000,
    apiMs: 3_000,
    localMs: 0,
    stepCount: 0,
    tokens: 0,
    usage: {
      promptTokens: 1_000,
      completionTokens: 500,
      totalTokens: 1_500,
      cachedInputTokens: 3_000,
      cacheWriteTokens: 200,
      reasoningTokens: 100,
      contextTokens: 84_000,
      stepCount: 0,
    },
    usageSteps: 2,
    cost: {
      input: 0.1,
      cacheRead: 0.2,
      cacheWrite: 0.3,
      output: 0.4,
      total: 1,
    },
    ...overrides,
  } satisfies TrajectoryStatsSnapshot;
}

describe("appendTurnUsageRecord", () => {
  test("maps the turn snapshot onto one ledger record", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;

    expect(
      await appendTurnUsageRecord(snapshotOf(), {
        agentId: "agent-1",
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).toBe(true);

    const records = await readUsageLedger();
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.agentId).toBe("agent-1");
    expect(record?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(record?.prompt).toBe(1_000);
    expect(record?.cachedInput).toBe(3_000);
    expect(record?.cacheWrite).toBe(200);
    expect(record?.completion).toBe(500);
    expect(record?.reasoning).toBe(100);
    expect(record?.steps).toBe(2);
    expect(record?.wallMs).toBe(4_000);
    expect(record?.apiMs).toBe(3_000);
    expect(record?.contextTokens).toBe(84_000);
    // Both input buckets, because `prompt` is the miss count.
    expect(record?.cacheHitRate).toBe(0.75);
    expect(record?.cost?.total).toBe(1);
    // The hour is derived, not supplied, so it must look like one.
    expect(record?.tsHour).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    // F-03 §5.16.2: a turn the user drove is tagged, so automated spend can be
    // kept apart on the Usage page.
    expect(record?.source).toBe("interactive");
    expect(record?.outcome).toBeUndefined();
  });

  test("falls back to a placeholder identity rather than dropping the turn", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;

    await appendTurnUsageRecord(snapshotOf(), { agentId: null, model: null });

    const records = await readUsageLedger();
    // A turn with no identity is still a turn; losing it would make the totals
    // disagree with what the session actually spent.
    expect(records[0]?.agentId).toBe("unknown");
    expect(records[0]?.model).toBe("unknown");
  });

  test("a cancelled turn is marked, and keeps its request composition", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;

    await appendTurnUsageRecord(
      snapshotOf({
        contextBreakdown: { system: 8_000, messages: 21_000, tools: 30_000 },
      }),
      { agentId: "agent-1", model: "m" },
      { cancelled: true },
    );

    const [record] = await readUsageLedger();
    expect(record?.cancelled).toBe(true);
    expect(record?.contextBreakdown).toEqual({
      system: 8_000,
      messages: 21_000,
      tools: 30_000,
    });
  });

  test("a second turn appends instead of replacing", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;

    await appendTurnUsageRecord(snapshotOf(), {
      agentId: "agent-1",
      model: "m",
    });
    await appendTurnUsageRecord(snapshotOf({ usageSteps: 7 }), {
      agentId: "agent-1",
      model: "m",
    });

    const records = await readUsageLedger();
    expect(records).toHaveLength(2);
    expect(records[1]?.steps).toBe(7);
  });

  // ── F-05 M2 F12 / F5: a scheduled turn's row ───────────────────────

  test("a scheduled turn's row carries runId, outcome and the conversation", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    setScheduledRunContext({
      runId: "run-42",
      taskId: "task-7",
      source: "cron",
      agentId: "agent-1",
      conversationId: "conv-9",
    });

    await appendTurnUsageRecord(
      snapshotOf(),
      { agentId: "agent-1", conversationId: "conv-9", model: "m" },
      { outcome: "failed" },
    );

    const [record] = await readUsageLedger();
    expect(record?.source).toBe("cron");
    expect(record?.runId).toBe("run-42");
    // F12: without the outcome the Usage page cannot tell a failed run apart.
    expect(record?.outcome).toBe("failed");
    expect(record?.sessionId).toBe("conv-9");
  });

  test("a turn in another conversation does not consume the scheduled context", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    setScheduledRunContext({
      runId: "run-other",
      taskId: "task-7",
      source: "cron",
      conversationId: "conv-other",
    });

    // The scheduled run's turn in conv-other has not run yet; this is a user
    // turn in conv-mine, which must stay interactive and leave the context.
    await appendTurnUsageRecord(snapshotOf(), {
      agentId: "agent-1",
      conversationId: "conv-mine",
      model: "m",
    });

    const [record] = await readUsageLedger();
    expect(record?.source).toBe("interactive");
    expect(record?.runId).toBeUndefined();
    expect(record?.outcome).toBeUndefined();
    // The other conversation's run is still waiting for its own turn.
    expect(peekScheduledRunContext("conv-other")?.runId).toBe("run-other");
  });

  test("without a conversation id the sole pending context is consumed (compat path)", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    setScheduledRunContext({
      runId: "run-single",
      taskId: "task-7",
      source: "cron",
    });

    await appendTurnUsageRecord(snapshotOf(), {
      agentId: "agent-1",
      model: "m",
    });

    const [record] = await readUsageLedger();
    expect(record?.source).toBe("cron");
    expect(record?.runId).toBe("run-single");
    expect(record?.outcome).toBe("completed");
    expect(record?.sessionId).toBeUndefined();
  });
});
