/**
 * `dream_status` sourcing (M5-A stage 2, B2).
 *
 * The snapshot must be explainable: the switch comes from the resolved
 * settings, `running` only from a live lease+marker, `nextEligibleAt` from the
 * signal source's own window/cooldown rules, and `lastRun` from the hidden
 * conversation's dream record. These tests pin each source, including the
 * "no record yet" fallback for a live lease.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDreamLease, deleteDreamLease } from "@/agent/dream/dream-lease";
import { writeDreamRunMetadata } from "@/agent/dream-run-metadata";
import { createDreamSession } from "@/agent/dream-session";
import { __testSetBackend } from "@/backend";
import { DeterministicPongExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  dreamDayKey,
  EMPTY_DREAM_SIGNAL_STATE,
  markDreamRunActive,
  markDreamRunFinished,
  readDreamSignalState,
  writeDreamSignalState,
} from "@/cron/dream-signal";
import { readDreamSettings } from "@/dream-settings";
import { settingsManager } from "@/settings-manager";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";
import {
  computeDreamNextEligibleAt,
  readDreamDeviceSummary,
  readDreamLastRunSnapshot,
  readDreamRunningSnapshot,
  readDreamRunRecords,
  readDreamStatusSnapshot,
} from "@/websocket/listener/dream-status";

const AGENT = "agent-dream-status";
const previousHome = process.env.HOME;
const previousHaruyukiHome = process.env.HARUYUKI_HOME;
let testHome: string;
let root: string | undefined;

function runMetadata(
  overrides: Partial<DreamRunMetadata> = {},
): DreamRunMetadata {
  return {
    runId: "run-1",
    triggerSource: "manual",
    agentId: AGENT,
    conversationId: "conv-1",
    tierPlan: ["tidy"],
    tierReached: null,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    baselineSha: "sha-1",
    budgetTokens: 1_000,
    spentTokens: 100,
    timeLimitMinutes: null,
    status: "running",
    reportPath: null,
    handoff: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await settingsManager.reset();
  testHome = await mkdtemp(join(tmpdir(), "hryk-dream-status-"));
  process.env.HARUYUKI_HOME = testHome;
  process.env.HOME = testHome;
  await settingsManager.initialize();
});

afterEach(async () => {
  __testSetBackend(null);
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(testHome, { recursive: true, force: true });
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("readDreamStatusSnapshot", () => {
  test("a fresh agent reports disabled with no run and nothing scheduled", async () => {
    const snapshot = await readDreamStatusSnapshot(AGENT);

    expect(snapshot).toEqual({
      enabled: false,
      running: null,
      nextEligibleAt: null,
      lastRun: null,
    });
  });

  test("the switch is the resolved settings value", async () => {
    await settingsManager.updateSettings({ dreamEnabled: true });
    const snapshot = await readDreamStatusSnapshot(AGENT);
    expect(snapshot.enabled).toBe(true);
  });
});

describe("computeDreamNextEligibleAt", () => {
  test("null while the master switch is off", () => {
    const now = new Date(2026, 0, 15, 12, 0, 0);
    const settings = readDreamSettings(AGENT);
    expect(
      computeDreamNextEligibleAt(settings, EMPTY_DREAM_SIGNAL_STATE, now),
    ).toBeNull();
  });

  test("outside the idle window the next window start is named", () => {
    const now = new Date(2026, 0, 15, 12, 0, 0);
    const settings = {
      ...readDreamSettings(AGENT),
      enabled: true,
      autoTrigger: true,
      idleWindows: [{ start: "22:00", end: "07:00" }],
    };
    expect(
      computeDreamNextEligibleAt(settings, EMPTY_DREAM_SIGNAL_STATE, now),
    ).toBe(new Date(2026, 0, 15, 22, 0, 0).toISOString());
  });

  test("a live cooldown inside the window wins", () => {
    const now = new Date(2026, 0, 15, 12, 0, 0);
    const settings = {
      ...readDreamSettings(AGENT),
      enabled: true,
      autoTrigger: true,
      idleWindows: [{ start: "00:00", end: "23:59" }],
    };
    const cooldown = now.getTime() + 5 * 60_000;
    const state = {
      ...EMPTY_DREAM_SIGNAL_STATE,
      dayKey: dreamDayKey(now),
      nextEligibleAt: cooldown,
    };
    expect(computeDreamNextEligibleAt(settings, state, now)).toBe(
      new Date(cooldown).toISOString(),
    );
  });

  test("the daily attempt cap rolls to the next window", () => {
    const now = new Date(2026, 0, 15, 12, 0, 0);
    const settings = {
      ...readDreamSettings(AGENT),
      enabled: true,
      autoTrigger: true,
      idleWindows: [{ start: "00:00", end: "23:59" }],
    };
    const state = {
      ...EMPTY_DREAM_SIGNAL_STATE,
      dayKey: dreamDayKey(now),
      dayCount: 6,
    };
    // A 00:00–23:59 window's next start is tomorrow midnight.
    expect(computeDreamNextEligibleAt(settings, state, now)).toBe(
      new Date(2026, 0, 16, 0, 0, 0).toISOString(),
    );
  });

  test("an agent without a dream carrier task has no automatic next run", async () => {
    await settingsManager.updateSettings({ dreamEnabled: true });
    const snapshot = await readDreamStatusSnapshot(AGENT);
    expect(snapshot.enabled).toBe(true);
    // No task yet: the signal source has nothing to evaluate.
    expect(snapshot.nextEligibleAt).toBeNull();
  });
});

describe("readDreamRunningSnapshot", () => {
  test("a live lease reports the run record's spend, budget and tier", () => {
    const now = new Date();
    createDreamLease({ agentId: AGENT, runId: "run-live" });
    markDreamRunActive(AGENT, "run-live", new Date(now.getTime() - 60_000));
    const record = runMetadata({
      runId: "run-live",
      conversationId: "conv-live",
      startedAt: now.getTime() - 60_000,
      budgetTokens: 5_000,
      spentTokens: 1_200,
      tierReached: "think",
    });

    expect(readDreamRunningSnapshot(AGENT, [record], now)).toEqual({
      runId: "run-live",
      startedAt: now.getTime() - 60_000,
      spentTokens: 1_200,
      budgetTokens: 5_000,
      tier: "think",
    });
  });

  test("a live lease without a readable record reports the lease, zero spend", () => {
    const now = new Date();
    const lease = createDreamLease({ agentId: AGENT, runId: "run-live" });
    markDreamRunActive(AGENT, "run-live", now);

    expect(readDreamRunningSnapshot(AGENT, [], now)).toEqual({
      runId: "run-live",
      startedAt: lease.startedAt,
      spentTokens: 0,
      budgetTokens: 0,
      tier: null,
    });
  });

  test("a finished marker is not live", () => {
    const now = new Date();
    createDreamLease({ agentId: AGENT, runId: "run-done" });
    markDreamRunActive(AGENT, "run-done", now);
    markDreamRunFinished(AGENT, "succeeded", now);

    expect(readDreamRunningSnapshot(AGENT, [runMetadata()], now)).toBeNull();
    deleteDreamLease(AGENT);
  });

  test("a marker without a lease is a crash remnant", () => {
    const now = new Date();
    writeDreamSignalState(AGENT, {
      ...readDreamSignalState(AGENT),
      running: { runId: "run-crashed", startedAt: now.getTime() },
    });
    expect(readDreamRunningSnapshot(AGENT, [], now)).toBeNull();
  });
});

describe("readDreamLastRunSnapshot", () => {
  test("newest started record wins and keeps the wire fields", () => {
    const older = runMetadata({
      runId: "run-old",
      startedAt: 1_000,
      endedAt: 2_000,
      status: "succeeded",
    });
    const newer = runMetadata({
      runId: "run-new",
      startedAt: 3_000,
      status: "budget_exhausted",
      triggerSource: "scheduled",
    });
    expect(readDreamLastRunSnapshot([newer, older])).toEqual({
      runId: "run-new",
      status: "budget_exhausted",
      triggerSource: "scheduled",
      startedAt: 3_000,
      endedAt: null,
    });
    expect(readDreamLastRunSnapshot([])).toBeNull();
  });

  test("a running record is not the last finished run", () => {
    const running = runMetadata({ runId: "run-live", startedAt: 5_000 });
    const finished = runMetadata({
      runId: "run-done",
      startedAt: 1_000,
      endedAt: 2_000,
      status: "succeeded",
    });
    expect(readDreamLastRunSnapshot([running, finished])?.runId).toBe(
      "run-done",
    );
    expect(readDreamLastRunSnapshot([running])).toBeNull();
  });
});

describe("readDreamStatusSnapshot over the local backend", () => {
  test("lastRun comes from the hidden conversation's dream record", async () => {
    root = await mkdtemp(join(tmpdir(), "hryk-dream-status-backend-"));
    const backend = new LocalBackend({
      storageDir: join(root, "store"),
      executor: new DeterministicPongExecutor(),
      memfsEnabled: false,
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({ name: "Dream status test" });
    const session = await createDreamSession({
      agentId: agent.id,
      runId: "run-record-1",
    });
    const startedAt = Date.now() - 3_600_000;
    await writeDreamRunMetadata({
      conversationId: session.conversationId,
      metadata: runMetadata({
        runId: "run-record-1",
        agentId: agent.id,
        conversationId: session.conversationId,
        startedAt,
        endedAt: startedAt + 600_000,
        status: "succeeded",
        triggerSource: "idle",
      }),
    });

    const records = await readDreamRunRecords(agent.id);
    expect(records.map((record) => record.runId)).toEqual(["run-record-1"]);

    const snapshot = await readDreamStatusSnapshot(agent.id);
    expect(snapshot.lastRun).toEqual({
      runId: "run-record-1",
      status: "succeeded",
      triggerSource: "idle",
      startedAt,
      endedAt: startedAt + 600_000,
    });
    expect(snapshot.running).toBeNull();
  });

  test("a readable agent with no dream record has no lastRun", async () => {
    root = await mkdtemp(join(tmpdir(), "hryk-dream-status-backend-"));
    const backend = new LocalBackend({
      storageDir: join(root, "store"),
      executor: new DeterministicPongExecutor(),
      memfsEnabled: false,
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({ name: "No dream test" });
    // A hidden dream conversation that never got a run record written.
    await createDreamSession({
      agentId: agent.id,
      runId: "run-no-record",
    });

    expect(await readDreamRunRecords(agent.id)).toEqual([]);
    expect((await readDreamStatusSnapshot(agent.id)).lastRun).toBeNull();
  });
});

describe("readDreamDeviceSummary", () => {
  test("null scope has no summary", () => {
    expect(readDreamDeviceSummary(null)).toBeNull();
  });

  test("a disabled agent answers from the settings alone", () => {
    expect(readDreamDeviceSummary(AGENT)).toEqual({
      enabled: false,
      runningRunId: null,
    });
  });

  test("an enabled agent reports the live run id and clears it when done", () => {
    settingsManager.updateSettings({ dreamEnabled: true });
    const now = new Date();
    createDreamLease({ agentId: AGENT, runId: "run-live" });
    markDreamRunActive(AGENT, "run-live", now);

    expect(readDreamDeviceSummary(AGENT, now)).toEqual({
      enabled: true,
      runningRunId: "run-live",
    });

    markDreamRunFinished(AGENT, "succeeded", now);
    expect(readDreamDeviceSummary(AGENT, now)).toEqual({
      enabled: true,
      runningRunId: null,
    });
  });
});
