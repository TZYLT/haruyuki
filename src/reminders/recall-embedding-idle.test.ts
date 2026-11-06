/**
 * Cooldown-expiry self-check for the incremental embedding index (48-1 §6.10,
 * 48-3 §13.10-1, user ruling 2026-11-06).
 *
 * What this file pins — the no-next-turn case after a turn-end catch-up:
 *
 * - still behind at cooldown expiry → exactly one more incremental build;
 * - caught up → no second build and no re-arm;
 * - embedding turned off before the timer fires → no build;
 * - a failed build → the chain stops (no retry storm);
 * - a second turn-end replaces the pending check instead of stacking timers;
 * - the scheduled handle is `unref()`ed (and a handle without `unref` is fine),
 *   so a pending self-check never keeps the process alive;
 * - the chain cap bounds consecutive checks.
 *
 * Everything is synthetic under the OS temp directory and every build/worker is
 * a seam: no ONNX, no model, no network (docs/31 §1.2 A2). The clock and the
 * timer are injected, so a 5-minute cooldown costs no wall time.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import type {
  EmbeddingRunnerOptions,
  EmbeddingRunResult,
  EmbeddingRunUnit,
} from "@/backend/local/embedding-runner";
import { resolveEmbeddingSpace } from "@/backend/local/embedding-space";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";
import {
  EMBEDDING_AUTOBUILD_COOLDOWN_MS,
  EMBEDDING_AUTOBUILD_IDLE_MAX_CHECKS,
  type EmbeddingAutobuildDeps,
  type EmbeddingAutobuildTimers,
  resetRecallEmbeddingAutobuildForTests,
  runEmbeddingCatchUpIfBehind,
  scheduleEmbeddingIdleSelfCheck,
} from "@/reminders/recall-embedding-autobuild";
import {
  EMBEDDING_FIXTURE_DIMENSIONS,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const AGENT_ID = "agent-idle";
const CONVERSATION_KEY = "conv-idle";
const START = 1_000_000;

let root: string;
let storageDir: string;
let memoryDir: string;
let now: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haru-embedding-idle-"));
  storageDir = join(root, "storage");
  memoryDir = join(root, "memory");
  mkdirSync(memoryDir, { recursive: true });
  now = START;
  resetRecallEmbeddingAutobuildForTests();
});

afterEach(() => {
  resetRecallEmbeddingAutobuildForTests();
  rmSync(root, { recursive: true, force: true });
});

function settings(
  overrides: Record<string, unknown> = {},
): ResolvedEmbeddingSettings {
  return {
    ...EMBEDDING_SETTING_DEFAULTS,
    enabled: true,
    ...overrides,
  } as ResolvedEmbeddingSettings;
}

function spaceId(): string {
  return resolveEmbeddingSpace(AGENT_ID, settings(), { root }).spaceId;
}

/** `<storage>/conversations/<key>`, the unit's source directory. */
function conversationDir(): string {
  const directory = join(storageDir, "conversations", CONVERSATION_KEY);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "conversation.json"),
    JSON.stringify({ id: "conv-1", agent_id: AGENT_ID }),
  );
  writeFileSync(
    join(directory, "messages.jsonl"),
    `${JSON.stringify({ id: "m1", role: "user", content: "hello" })}\n`,
  );
  return directory;
}

/** Commits one unit for the conversation, as a completed build would. */
function writeUnit(): void {
  const text = "hello world";
  const unit = {
    agentId: AGENT_ID,
    spaceId: spaceId(),
    conversationKey: CONVERSATION_KEY,
  };
  const plan = buildEmbeddingChunkPlan({ parentId: "m1", text });
  writeEmbeddingIndex({
    unitDir: embeddingVectorUnitDir(unit, { root }),
    unit,
    modelId: "bge-small-zh-v1.5",
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    records: embeddingChunkRecordsFromPlan(plan),
    vectors: plan.chunks.map((chunk) => fakeEmbeddingVector(chunk.text)),
    coverage: {
      embeddedChars: text.length,
      recallableChars: text.length,
      ratio: 1,
    },
  });
}

interface TimerEntry {
  ms: number;
  cancelled: boolean;
  unrefCalls: number;
  callback: () => void;
  unref: () => void;
}

/** Timer seam that records the schedule instead of waiting for it. */
function fakeTimers(): {
  entries: TimerEntry[];
  timers: EmbeddingAutobuildTimers;
  active: () => TimerEntry[];
} {
  const entries: TimerEntry[] = [];
  const timers: EmbeddingAutobuildTimers = {
    setTimeout: (callback, ms) => {
      const entry: TimerEntry = {
        ms,
        cancelled: false,
        unrefCalls: 0,
        callback,
        unref: () => {
          entry.unrefCalls += 1;
        },
      };
      entries.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      (handle as TimerEntry).cancelled = true;
    },
  };
  return {
    entries,
    timers,
    active: () => entries.filter((entry) => !entry.cancelled),
  };
}

/** Let the fire-and-forget timer body reach its last awaited step. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** "Advance the clock and let this timer fire", exactly as the event loop does. */
async function fire(entry: TimerEntry): Promise<void> {
  entry.cancelled = true;
  entry.callback();
  await flush();
}

interface Recorder {
  builds: number;
  deps: EmbeddingAutobuildDeps;
}

/**
 * A recorder whose build either succeeds (optionally committing the unit, as a
 * real successful incremental build would) or answers with a failed result.
 */
function recorder(
  options: { afterBuild?: () => void; fail?: boolean } = {},
): Recorder {
  const recorded: Recorder = { builds: 0, deps: {} };
  recorded.deps = {
    createEmbed: async () => ({
      embed: async () => [],
      dispose: async () => {},
      degradedReason: null,
      device: {
        backend: "builtin",
        requested: ["cpu"],
        initialized: ["cpu"],
        gpu: false,
        degraded: false,
        threads: 0,
        warmupMs: 0,
        measuredAt: "2026-11-05T00:00:00.000Z",
      },
    }),
    runBuild: async (
      _options: EmbeddingRunnerOptions,
    ): Promise<EmbeddingRunResult> => {
      recorded.builds += 1;
      options.afterBuild?.();
      return {
        status: options.fail === true ? "failed" : "completed",
        aborted: false,
        buildId: "fake-build",
        mode: "incremental",
        totalUnits: 0,
        completedUnits: 0,
        failedUnits: 0,
        reusedChunks: 0,
        embeddedChunks: 0,
        elapsedMs: 1,
        state: null,
        unitFailures: [],
      };
    },
    scanUnits: (): EmbeddingRunUnit[] => [],
  };
  return recorded;
}

function input(
  recorded: Recorder,
  extras: {
    timers?: EmbeddingAutobuildTimers;
    readSettings?: () => ResolvedEmbeddingSettings;
  } = {},
) {
  return {
    backend: { getLocalStorageDir: () => storageDir },
    agentId: AGENT_ID,
    settings: settings(),
    root,
    now: () => now,
    deps: {
      ...recorded.deps,
      ...(extras.timers === undefined ? {} : { timers: extras.timers }),
      // Default to the fixture settings: the production default reads the real
      // settings file, which a test must never touch (docs/31 §1.2 A2).
      readSettings: extras.readSettings ?? (() => settings()),
    },
  };
}

describe("cooldown-expiry self-check", () => {
  test("still behind when the cooldown expires → one more incremental build, then armed again", async () => {
    conversationDir();
    const recorded = recorder();
    const fake = fakeTimers();
    const opts = input(recorded, { timers: fake.timers });

    // The turn-end catch-up: one build, then the self-check is armed.
    expect(await runEmbeddingCatchUpIfBehind(opts)).toBe(true);
    expect(recorded.builds).toBe(1);
    scheduleEmbeddingIdleSelfCheck(opts);

    const [armed] = fake.active();
    expect(armed?.ms).toBe(EMBEDDING_AUTOBUILD_COOLDOWN_MS);
    // Never keeps the process alive: the handle is unref'd at scheduling time.
    expect(armed?.unrefCalls).toBe(1);

    // Cooldown expires; nothing was caught up in between.
    now = START + EMBEDDING_AUTOBUILD_COOLDOWN_MS;
    if (armed !== undefined) await fire(armed);
    expect(recorded.builds).toBe(2);

    // The second build may also have left the index behind, so one verification
    // is armed; the chain cap bounds how far that can go.
    expect(fake.active()).toHaveLength(1);
  });

  test("caught up after the build → no second build and no re-arm", async () => {
    conversationDir();
    // The build commits the unit, as a successful incremental build would.
    const recorded = recorder({ afterBuild: () => writeUnit() });
    const fake = fakeTimers();
    const opts = input(recorded, { timers: fake.timers });

    expect(await runEmbeddingCatchUpIfBehind(opts)).toBe(true);
    scheduleEmbeddingIdleSelfCheck(opts);
    const [armed] = fake.active();

    now = START + EMBEDDING_AUTOBUILD_COOLDOWN_MS;
    if (armed !== undefined) await fire(armed);
    expect(recorded.builds).toBe(1);
    expect(fake.active()).toHaveLength(0);
  });

  test("embedding turned off while the check is pending → nothing runs", async () => {
    conversationDir();
    const recorded = recorder();
    const fake = fakeTimers();
    let current = settings();
    const opts = input(recorded, {
      timers: fake.timers,
      readSettings: () => current,
    });

    expect(await runEmbeddingCatchUpIfBehind(opts)).toBe(true);
    scheduleEmbeddingIdleSelfCheck(opts);
    const [armed] = fake.active();

    current = settings({ enabled: false });
    now = START + EMBEDDING_AUTOBUILD_COOLDOWN_MS;
    if (armed !== undefined) await fire(armed);
    expect(recorded.builds).toBe(1);
    expect(fake.active()).toHaveLength(0);
  });

  test("a failing build stops the chain (no retry storm)", async () => {
    conversationDir();
    const recorded = recorder({ fail: true });
    const fake = fakeTimers();
    const opts = input(recorded, { timers: fake.timers });

    expect(await runEmbeddingCatchUpIfBehind(opts)).toBe(true);
    scheduleEmbeddingIdleSelfCheck(opts);
    const [armed] = fake.active();

    now = START + EMBEDDING_AUTOBUILD_COOLDOWN_MS;
    if (armed !== undefined) await fire(armed);
    // The failed attempt ran; nothing is armed afterwards.
    expect(recorded.builds).toBe(2);
    expect(fake.active()).toHaveLength(0);
    expect(fake.entries).toHaveLength(1);
  });

  test("a second turn-end replaces the pending check instead of stacking timers", async () => {
    conversationDir();
    const recorded = recorder();
    const fake = fakeTimers();
    const opts = input(recorded, { timers: fake.timers });

    expect(await runEmbeddingCatchUpIfBehind(opts)).toBe(true);
    scheduleEmbeddingIdleSelfCheck(opts);
    now = START + 1_000;
    scheduleEmbeddingIdleSelfCheck(opts);

    expect(fake.entries).toHaveLength(2);
    expect(fake.entries[0]?.cancelled).toBe(true);
    expect(fake.active()).toHaveLength(1);
  });

  test("a timer handle without unref is accepted (fake timers, browser-shaped handles)", async () => {
    conversationDir();
    const recorded = recorder();
    const timers: EmbeddingAutobuildTimers = {
      setTimeout: () => 42,
      clearTimeout: () => {},
    };
    const opts = input(recorded, { timers });

    expect(await runEmbeddingCatchUpIfBehind(opts)).toBe(true);
    expect(() => scheduleEmbeddingIdleSelfCheck(opts)).not.toThrow();
  });

  test("the chain cap bounds consecutive self-checks", async () => {
    conversationDir();
    const recorded = recorder();
    const fake = fakeTimers();
    const opts = input(recorded, { timers: fake.timers });

    expect(await runEmbeddingCatchUpIfBehind(opts)).toBe(true);
    scheduleEmbeddingIdleSelfCheck(opts);

    // Every tick keeps finding the index behind (the fake build commits no unit).
    for (let tick = 0; tick < EMBEDDING_AUTOBUILD_IDLE_MAX_CHECKS; tick += 1) {
      now += EMBEDDING_AUTOBUILD_COOLDOWN_MS;
      const [armed] = fake.active();
      expect(armed).toBeDefined();
      if (armed !== undefined) await fire(armed);
    }

    // One build for the turn plus the capped chain; the last tick does not re-arm.
    expect(recorded.builds).toBe(1 + EMBEDDING_AUTOBUILD_IDLE_MAX_CHECKS);
    expect(fake.active()).toHaveLength(0);
  });
});
