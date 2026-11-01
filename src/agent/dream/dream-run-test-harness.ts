/**
 * Shared test harness for the dream run controller (F-06 M2).
 *
 * `dream-run.ts` takes every side effect through `DreamRunDeps`, so a test
 * drives the whole lifecycle — locks, baseline, hidden session, tier turns,
 * budget gate, rollback, report, notes, decay ledger, terminal record — with no
 * backend, git, harness home or child process. The harness lives here because
 * two test files need it (`dream-run.test.ts` for the state machine,
 * `dream-run-notes.test.ts` for the W11/W12 notes + seed + decay wiring) and
 * both files must stay under the repository's 1,000-line ceiling.
 *
 * This module is test support only: nothing in production imports it.
 */

import type {
  ConsumeDreamNotesResult,
  DreamNote,
} from "@/agent/dream/dream-notes";
import type {
  DreamRunDeps,
  DreamTurnInput,
  DreamTurnResult,
} from "@/agent/dream/dream-run";
import type { DreamSeed } from "@/agent/dream/dream-seed";
import type { ScheduleTaskV2 } from "@/cron/cron-types";
import {
  DREAM_SETTINGS_DEFAULTS,
  type ResolvedDreamSettings,
} from "@/dream-settings";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

export function makeTask(payload = ""): ScheduleTaskV2 {
  return {
    id: "task-1",
    agentId: "agent-a",
    name: "Dream",
    description: "",
    type: "dream",
    target: { kind: "new", hidden: true },
    payload,
    cron: "0 0 0 1 1 *",
    timezone: "UTC",
    recurring: true,
    scheduledFor: null,
    catchUp: false,
    permission: "acceptEdits",
    timeoutMinutes: 0,
    waitMinutes: 10,
    status: "active",
    pausedReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastFiredAt: null,
    fireCount: 0,
    lastRunAt: null,
    lastOutcome: null,
    lastReason: null,
    lastError: null,
    consecutiveFailures: 0,
    missedCount: 0,
    failedCount: 0,
    lastConsumedOccurrence: null,
    lease: null,
    jitterOffsetMs: 0,
    firedAt: null,
    missedAt: null,
  };
}

export function makeSettings(
  overrides: Partial<ResolvedDreamSettings> = {},
): ResolvedDreamSettings {
  return {
    ...DREAM_SETTINGS_DEFAULTS,
    enabled: true,
    tiers: { tidy: true, think: true, task: false, wander: false },
    overBudgetApprovals: 1,
    ...overrides,
  };
}

export const EMPTY_PARTS = {
  outputTokens: 0,
  uncachedReadTokens: 0,
  cachedReadTokens: 0,
};

export interface Harness {
  deps: DreamRunDeps;
  events: string[];
  metadata: DreamRunMetadata[];
  reports: Array<{ body: string; metadata: DreamRunMetadata }>;
  markers: Array<{ outcome: string; runId: string; model: string }>;
  rollbacks: Array<{ baselineSha: string; memoryDir: string }>;
  finished: string[];
  released: { dream: number; memory: number };
  deletedLeases: number;
  pressureBaselines: number[];
  turns: DreamTurnInput[];
  noteClaimCalls: Array<{ agentId: string; runId: string; now: number }>;
  seedInputs: Array<{
    agentId: string;
    memoryDir: string;
    runId: string;
    notes: readonly DreamNote[];
  }>;
  consumeCalls: Array<{
    agentId: string;
    runId: string;
    outcomes: Record<string, string>;
  }>;
  markRunIds: string[];
  decayInputs: Array<Parameters<DreamRunDeps["applyDecay"]>[0]>;
}

export const EMPTY_SEED: DreamSeed = {
  layout: null,
  manifest: null,
  changes: null,
  decay: null,
  coreCost: null,
  deferred: null,
  notes: [],
  degraded: [],
};

export function claimedNote(id: string, text = `remember ${id}`): DreamNote {
  return {
    version: 1,
    id,
    createdAt: Date.UTC(2026, 9, 31, 12, 0),
    author: "user",
    text,
    source: {},
  };
}

export interface HarnessOptions {
  settings?: ResolvedDreamSettings;
  spawnedTurn?: (
    input: DreamTurnInput,
    index: number,
  ) => DreamTurnResult | Promise<DreamTurnResult>;
  overrides?: Partial<DreamRunDeps>;
  dreamLockBusy?: boolean;
  memoryLockBusy?: boolean;
  activityAt?: number | null;
  now?: () => Date;
  /** What the default `consumeNotes` seam answers (defaults to nothing). */
  consumeResult?: ConsumeDreamNotesResult;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const harness: Harness = {
    deps: {} as DreamRunDeps,
    events: [],
    metadata: [],
    reports: [],
    markers: [],
    rollbacks: [],
    finished: [],
    released: { dream: 0, memory: 0 },
    deletedLeases: 0,
    pressureBaselines: [],
    turns: [],
    noteClaimCalls: [],
    seedInputs: [],
    consumeCalls: [],
    markRunIds: [],
    decayInputs: [],
  };
  const settings = options.settings ?? makeSettings();
  let turnIndex = 0;

  harness.deps = {
    now: options.now ?? (() => new Date(1_700_000_000_000)),
    resolveSettings: () => settings,
    memoryDir: (agentId) => `/memory/${agentId}`,
    tryAcquireDreamLock: async () => {
      if (options.dreamLockBusy) return null;
      harness.events.push("lock.dream");
      return async () => {
        harness.released.dream += 1;
        harness.events.push("unlock.dream");
      };
    },
    acquireMemoryLock: async () => {
      if (options.memoryLockBusy) return null;
      harness.events.push("lock.memory");
      return async () => {
        harness.released.memory += 1;
        harness.events.push("unlock.memory");
      };
    },
    createBaseline: async ({ memoryDir, runId }) => {
      harness.events.push("baseline");
      return { sha: `baseline-${runId}-${memoryDir.length}` };
    },
    rollbackBaseline: async (input) => {
      harness.events.push("rollback");
      harness.rollbacks.push(input);
      return { changed: true };
    },
    createSession: async ({ runId }) => {
      harness.events.push("session");
      return { conversationId: `conv-${runId}` };
    },
    writeMetadata: async ({ metadata }) => {
      harness.metadata.push(metadata);
      harness.events.push(`metadata.${metadata.status}`);
    },
    readMetadata: async () => undefined,
    createLease: () => {
      harness.events.push("lease.create");
    },
    updateLease: ({ patch }) => {
      harness.events.push(`lease.${Object.keys(patch).join("+")}`);
    },
    startLeaseHeartbeat: () => {
      harness.events.push("lease.heartbeat.start");
      return () => harness.events.push("lease.heartbeat.stop");
    },
    deleteLease: () => {
      harness.deletedLeases += 1;
    },
    markRunActive: () => harness.events.push("signal.active"),
    markRunFinished: (finishedAgentId, outcome) => {
      harness.finished.push(`${finishedAgentId}:${outcome}`);
    },
    readActivity: () => options.activityAt ?? null,
    readPressure: () => 100_000,
    recordPressureBaseline: (_agentId, endedAt) => {
      harness.events.push("pressure.baseline");
      harness.pressureBaselines.push(endedAt);
    },
    spawnTurn: async (input) => {
      harness.turns.push(input);
      const index = turnIndex;
      turnIndex += 1;
      if (options.spawnedTurn) return await options.spawnedTurn(input, index);
      return {
        success: true,
        report: `report for ${input.tier}`,
        aborted: false,
        usage: { ...EMPTY_PARTS, outputTokens: 100 },
        model: "local/test-model",
      };
    },
    writeReport: async ({ body, metadata }) => {
      harness.events.push("report");
      harness.reports.push({ body, metadata });
      return { reportPath: "maintenance/dream.md", committed: true };
    },
    recordLedgerMarker: async (marker) => {
      harness.events.push(`ledger.${marker.outcome}`);
      harness.markers.push(marker);
    },
    retrieveAgentName: async () => "Test Agent",
    // 46-6-Fix-A W11/W12 seams: no real harness home, git or memory repo.
    claimNotes: async (agentId, runId, now) => {
      harness.events.push("notes.claim");
      harness.noteClaimCalls.push({ agentId, runId, now });
      return [];
    },
    collectSeed: async (input) => {
      harness.events.push("seed.collect");
      harness.seedInputs.push({
        agentId: input.agentId,
        memoryDir: input.memoryDir,
        runId: input.runId,
        notes: input.notes,
      });
      return input.notes.length > 0
        ? { ...EMPTY_SEED, notes: [...input.notes] }
        : EMPTY_SEED;
    },
    consumeNotes: async (agentId, runId, outcomes) => {
      harness.events.push("notes.consume");
      harness.consumeCalls.push({
        agentId,
        runId,
        outcomes: Object.fromEntries(
          outcomes instanceof Map
            ? outcomes.entries()
            : Object.entries(outcomes),
        ),
      });
      return options.consumeResult ?? { consumed: [], kept: [] };
    },
    readMarks: async (runId) => {
      harness.events.push("marks.read");
      harness.markRunIds.push(runId);
      return [];
    },
    applyDecay: async (input) => {
      harness.events.push("decay.apply");
      harness.decayInputs.push(input);
    },
    ...options.overrides,
  };
  return harness;
}

export const RUN_INPUT = {
  task: makeTask(),
  runId: "run-1",
  occurrence: "",
  signal: new AbortController().signal,
};
