/**
 * Tests for the background vector-index build loop (feature 48, package A3).
 *
 * Everything is synthetic and isolated under a fresh OS temp directory
 * (docs/31 §1.2 A2): `HARUYUKI_HOME` and `LETTA_LOCAL_BACKEND_DIR` are pointed
 * at per-test directories and restored afterwards, so no real harness data is
 * read or written. The embed callback is a deterministic fake, the clock is
 * injected, and the index/state/lock modules are the real A2/B2/B3 code, so the
 * tests exercise the production checkpoint order (build → write → state).
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingCalibrationBudget } from "@/backend/local/embedding/calibration";
import type { EmbeddingEmbedCallback } from "@/backend/local/embedding-build";
import {
  type EmbeddingBuildIdentity,
  type EmbeddingBuildStateRecord,
  embeddingBuildStatePath,
  readEmbeddingBuildState,
  writeEmbeddingBuildState,
} from "@/backend/local/embedding-build-state";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunk,
  type EmbeddingChunkPlan,
} from "@/backend/local/embedding-chunk";
import {
  type EmbeddingIndexSnapshot,
  type EmbeddingVectorUnit,
  embeddingVectorUnitDir,
  readEmbeddingIndex,
} from "@/backend/local/embedding-format";
import { inspectEmbeddingLease } from "@/backend/local/embedding-lease";
import {
  acquireEmbeddingBuildLock,
  embeddingBuildLockPath,
  inspectEmbeddingBuildLock,
} from "@/backend/local/embedding-lock";
import {
  EMBEDDING_RUN_MAX_CHUNKS_PER_BATCH,
  EMBEDDING_RUN_MAX_TOKENS_PER_BATCH,
  type EmbeddingRunBatchPlan,
  type EmbeddingRunnerOptions,
  type EmbeddingRunUnit,
  resolveEmbeddingRunBatchSize,
  runEmbeddingBuild,
} from "@/backend/local/embedding-runner";
import {
  createEmbeddingFixtureDirs,
  EMBEDDING_FIXTURE_DIMENSIONS,
  type EmbeddingFixtureDirs,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const MODEL_ID = "bge-small-zh-v1.5";

const IDENTITY: EmbeddingBuildIdentity = {
  agentId: "agent-runner",
  spaceId: "space-runner",
};

const TEXT_A = "部署卡住的原因是 readiness 探针超时。";
const TEXT_B = "回滚脚本仍然可用，先回退再排查。";
const TEXT_C = "监控面板显示队列积压已经清空。";
const TEXT_FAIL = "这一条会故意失败 FAIL_MARK 用于验证单单元失败继续。";
const LONG_TEXT = Array.from(
  { length: 80 },
  (_unused, index) => `这是第${index}句测试文本用于生成多个块。`,
).join("");

const originalHome = process.env.HARUYUKI_HOME;
const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
let dirs: EmbeddingFixtureDirs;
let spaceDir: string;
let clock: ReturnType<typeof createClock>;

type FakeClock = {
  now: () => number;
  advance: (ms: number) => void;
};

function createClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function restoreHarnessEnv(): void {
  if (originalHome === undefined) {
    delete process.env.HARUYUKI_HOME;
  } else {
    process.env.HARUYUKI_HOME = originalHome;
  }
  if (originalLocalBackendDir === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
  }
}

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs("haru-embedding-runner-");
  process.env.HARUYUKI_HOME = dirs.homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = dirs.localBackendDir;
  clock = createClock();
  spaceDir = join(dirs.root, IDENTITY.agentId, IDENTITY.spaceId);
});

afterEach(() => {
  dirs.cleanup();
  restoreHarnessEnv();
});

afterAll(() => {
  restoreHarnessEnv();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function conversationUnit(
  conversationKey: string,
  entries: readonly (readonly [parentId: string, text: string])[],
  identity: EmbeddingBuildIdentity = IDENTITY,
): EmbeddingRunUnit {
  return {
    unit: {
      agentId: identity.agentId,
      spaceId: identity.spaceId,
      conversationKey,
    },
    plans: entries.map(([parentId, text]) =>
      buildEmbeddingChunkPlan({ parentId, text }),
    ),
  };
}

function memoryUnit(
  memoryFileKey: string,
  text: string,
  identity: EmbeddingBuildIdentity = IDENTITY,
): EmbeddingRunUnit {
  return {
    unit: {
      agentId: identity.agentId,
      spaceId: identity.spaceId,
      memoryFileKey,
    },
    plans: [buildEmbeddingChunkPlan({ parentId: "memory:notes.md", text })],
    parentLineSpan: () => ({ startLine: 1, endLine: 3 }),
  };
}

function defaultUnits(): EmbeddingRunUnit[] {
  return [
    conversationUnit("conv-a", [
      ["msg-1", TEXT_A],
      ["msg-2", TEXT_B],
    ]),
    conversationUnit("conv-b", [["msg-3", TEXT_C]]),
  ];
}

function expectedChunks(units: readonly EmbeddingRunUnit[]): number {
  let total = 0;
  for (const unit of units) {
    for (const plan of unit.plans) total += plan.chunks.length;
  }
  return total;
}

type EmbedRecorder = {
  embed: EmbeddingEmbedCallback;
  calls: EmbeddingChunk[][];
  texts: string[];
};

function recordingEmbed(
  options: {
    clock?: FakeClock;
    advanceMs?: number;
    failWhen?: (text: string) => boolean;
    onCall?: (call: number, chunks: readonly EmbeddingChunk[]) => void;
  } = {},
): EmbedRecorder {
  const calls: EmbeddingChunk[][] = [];
  const texts: string[] = [];
  const embed: EmbeddingEmbedCallback = async (chunks) => {
    calls.push([...chunks]);
    texts.push(...chunks.map((chunk) => chunk.text));
    options.clock?.advance(options.advanceMs ?? 100);
    options.onCall?.(calls.length, chunks);
    const failing = chunks.find(
      (chunk) => options.failWhen?.(chunk.text) === true,
    );
    if (failing !== undefined) {
      throw new Error(`embed refused: ${failing.text.slice(0, 24)}`);
    }
    return chunks.map((chunk) => fakeEmbeddingVector(chunk.text));
  };
  return { embed, calls, texts };
}

function runnerOptions(
  recorder: EmbedRecorder,
  units: readonly EmbeddingRunUnit[],
  overrides: Partial<EmbeddingRunnerOptions> = {},
): EmbeddingRunnerOptions {
  return {
    identity: IDENTITY,
    units,
    embed: recorder.embed,
    modelId: MODEL_ID,
    root: dirs.root,
    spaceDir,
    clock: clock.now,
    ...overrides,
  };
}

async function readState(): Promise<EmbeddingBuildStateRecord> {
  const read = await readEmbeddingBuildState(
    embeddingBuildStatePath(spaceDir),
    IDENTITY,
  );
  return read.state;
}

function readUnitSnapshot(
  unit: EmbeddingVectorUnit,
): EmbeddingIndexSnapshot | null {
  const read = readEmbeddingIndex(
    embeddingVectorUnitDir(unit, { root: dirs.root }),
  );
  return read.ok ? read.snapshot : null;
}

function unitOf(runUnit: EmbeddingRunUnit): EmbeddingVectorUnit {
  return runUnit.unit;
}

function unitAt(
  units: readonly EmbeddingRunUnit[],
  index: number,
): EmbeddingRunUnit {
  const unit = units[index];
  if (unit === undefined) throw new Error(`missing unit at ${index}`);
  return unit;
}

function fakeBudget(
  overrides: Partial<EmbeddingCalibrationBudget> = {},
): EmbeddingCalibrationBudget {
  return {
    tier: "small",
    calibrated: true,
    timedOut: false,
    queryBudgetMs: 100,
    threads: 2,
    cpuArena: false,
    gpuRole: "off",
    quantization: "float32",
    rssBytes: 200 * 1024 * 1024,
    diskFreeBytes: 4 * 1024 ** 3,
    diskHeadroomOk: true,
    totalMemoryBytes: 16 * 1024 ** 3,
    batchTokensPerSec: 8_800,
    queryExecutionProviders: ["cpu"],
    buildExecutionProviders: ["cpu"],
    ...overrides,
  };
}

function fakeChunk(
  parentId: string,
  chunkIndex: number,
  estimatedTokens: number,
): EmbeddingChunk {
  return {
    parentId,
    chunkIndex,
    kind: "prose",
    text: `chunk-${parentId}-${chunkIndex}`,
    startChar: 0,
    endChar: 1,
    spans: [{ startChar: 0, endChar: 1 }],
    focusChar: 0,
    estimatedTokens,
  };
}

function fakePlan(
  parentId: string,
  chunkTokens: readonly number[],
): EmbeddingChunkPlan {
  return {
    parentId,
    chunks: chunkTokens.map((tokens, index) =>
      fakeChunk(parentId, index, tokens),
    ),
    skipVector: false,
    skipReason: undefined,
    coverage: { embeddedChars: 1, recallableChars: 1, ratio: 1 },
    truncatedByCap: false,
  };
}

// ── Batch derivation ────────────────────────────────────────────────────────

describe("resolveEmbeddingRunBatchSize", () => {
  test("defaults to the 32-chunk / 1,700-token ceilings", () => {
    const batch = resolveEmbeddingRunBatchSize([
      fakePlan(
        "p",
        Array.from({ length: 40 }, () => 100),
      ),
    ]);
    expect(batch.tokenBudget).toBe(EMBEDDING_RUN_MAX_TOKENS_PER_BATCH);
    expect(batch.maxChunkTokens).toBe(100);
    // floor(1700 / 100) = 17, below the 32-chunk ceiling.
    expect(batch.chunkBatchSize).toBe(17);
  });

  test("infers a lower token budget from the measured throughput", () => {
    const plans = [fakePlan("p", [100, 100, 100, 100, 100])];
    // 2,000 tok/s × 200 ms = 400 tokens → 4 chunks of 100.
    const throttled = resolveEmbeddingRunBatchSize(plans, {
      batchTokensPerSec: 2_000,
    });
    expect(throttled.tokenBudget).toBe(400);
    expect(throttled.chunkBatchSize).toBe(4);
  });

  test("never splits below one chunk, however large the chunk is", () => {
    const batch = resolveEmbeddingRunBatchSize([fakePlan("p", [2_000])]);
    expect(batch.chunkBatchSize).toBe(1);
  });

  test("explicit chunk and token ceilings win but stay consistent", () => {
    const plans = [
      fakePlan(
        "p",
        Array.from({ length: 40 }, () => 100),
      ),
    ];
    expect(
      resolveEmbeddingRunBatchSize(plans, { batchSize: 3 }).chunkBatchSize,
    ).toBe(3);
    const lowered = resolveEmbeddingRunBatchSize(plans, {
      tokenBudgetPerBatch: 300,
    });
    expect(lowered.tokenBudget).toBe(300);
    expect(lowered.chunkBatchSize).toBe(3);
  });

  test("an empty plan set still yields the default chunk ceiling", () => {
    const batch = resolveEmbeddingRunBatchSize([]);
    expect(batch.maxChunkTokens).toBe(0);
    expect(batch.tokenBudget).toBe(EMBEDDING_RUN_MAX_TOKENS_PER_BATCH);
    expect(batch.chunkBatchSize).toBe(EMBEDDING_RUN_MAX_CHUNKS_PER_BATCH);
  });
});

// ── Full run ────────────────────────────────────────────────────────────────

describe("full run", () => {
  test("builds every unit and commits a completed checkpoint", async () => {
    const units = defaultUnits();
    const recorder = recordingEmbed({ clock });
    const progress: number[] = [];
    const options = runnerOptions(recorder, units, {
      onProgress: (snapshot) => {
        progress.push(snapshot.progress.embeddedChunks);
      },
    });

    const result = await runEmbeddingBuild(options);

    expect(result.status).toBe("completed");
    expect(result.aborted).toBe(false);
    expect(result.totalUnits).toBe(2);
    expect(result.completedUnits).toBe(2);
    expect(result.failedUnits).toBe(0);
    expect(result.unitFailures).toEqual([]);
    expect(result.reusedChunks).toBe(0);
    expect(result.embeddedChunks).toBe(expectedChunks(units));
    expect(result.elapsedMs).toBeGreaterThan(0);

    for (const runUnit of units) {
      const snapshot = readUnitSnapshot(unitOf(runUnit));
      expect(snapshot).not.toBeNull();
      expect(snapshot?.meta.modelId).toBe(MODEL_ID);
      expect(snapshot?.meta.chunkCount).toBeGreaterThan(0);
      expect(snapshot?.meta.dimensions).toBe(EMBEDDING_FIXTURE_DIMENSIONS);
    }
    expect(
      readUnitSnapshot(unitOf(unitAt(units, 0)))?.records.map(
        (record) => record.parentId,
      ),
    ).toEqual(["msg-1", "msg-2"]);

    const state = await readState();
    expect(state.phase).toBe("completed");
    expect(state.buildId).toBe(result.buildId);
    expect(state.progress.embeddedChunks).toBe(expectedChunks(units));
    expect(state.progress.totalChunks).toBe(expectedChunks(units));
    expect(state.progress.processedConversations).toBe(2);
    expect(state.progress.totalConversations).toBe(2);
    expect(state.coverage.embeddedChars).toBeGreaterThan(0);
    expect(state.coverage.recallableChars).toBe(state.coverage.embeddedChars);
    expect(state.failures).toEqual([]);
    expect(state.startedAt).not.toBeNull();
    expect(state.finishedAt).not.toBeNull();

    expect(result.state?.phase).toBe("completed");
    expect(result.state?.progress.fraction).toBe(1);
    expect(result.state?.coverage.ratio).toBe(1);
    expect(result.state?.eta.remainingChunks).toBe(0);
    expect(result.state?.eta.remainingMs).toBe(0);
    expect(result.state?.rate.sampleCount).toBeGreaterThanOrEqual(2);

    // Progress only moves forward; the terminal tick repeats the total.
    expect(progress.length).toBeGreaterThanOrEqual(4);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index] ?? 0).toBeGreaterThanOrEqual(
        progress[index - 1] ?? 0,
      );
    }
    expect(progress.at(-1)).toBe(expectedChunks(units));

    expect((await inspectEmbeddingBuildLock(spaceDir)).status).toBe("missing");
    expect((await inspectEmbeddingLease(spaceDir)).status).toBe("missing");
  });

  test("reports a positive ETA while chunks remain", async () => {
    const units = defaultUnits();
    const recorder = recordingEmbed({ clock });
    const etas: (number | null)[] = [];
    const result = await runEmbeddingBuild(
      runnerOptions(recorder, units, {
        onProgress: (snapshot) => {
          if (snapshot.phase === "running") {
            etas.push(snapshot.eta.remainingMs);
          }
        },
      }),
    );

    expect(result.status).toBe("completed");
    expect(etas.some((eta) => typeof eta === "number" && eta > 0)).toBe(true);
  });

  test("records memory line spans and the memory unit kind", async () => {
    const unit = memoryUnit("notes-md", TEXT_A);
    const recorder = recordingEmbed();
    const result = await runEmbeddingBuild(runnerOptions(recorder, [unit]));

    expect(result.status).toBe("completed");
    const snapshot = readUnitSnapshot(unit.unit);
    expect(snapshot?.meta.unitKind).toBe("memory");
    expect(snapshot?.meta.unitKey).toBe("notes-md");
    expect(snapshot?.records[0]?.parentLineSpan).toEqual({
      startLine: 1,
      endLine: 3,
    });
  });

  test("empty units complete with a null fraction", async () => {
    const recorder = recordingEmbed();
    const result = await runEmbeddingBuild(runnerOptions(recorder, []));

    expect(result.status).toBe("completed");
    expect(result.totalUnits).toBe(0);
    expect(recorder.calls).toEqual([]);
    const state = await readState();
    expect(state.phase).toBe("completed");
    expect(result.state?.progress.fraction).toBeNull();
    expect(result.state?.coverage.ratio).toBeNull();
  });

  test("a damaged previous generation is rebuilt, not trusted", async () => {
    const unit = conversationUnit("conv-damaged", [["msg-1", TEXT_A]]);
    const unitDir = embeddingVectorUnitDir(unit.unit, { root: dirs.root });
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "current.json"), "{not json", "utf8");

    const recorder = recordingEmbed();
    const result = await runEmbeddingBuild(runnerOptions(recorder, [unit]));

    expect(result.status).toBe("completed");
    expect(recorder.calls.length).toBeGreaterThan(0);
    const snapshot = readUnitSnapshot(unit.unit);
    expect(snapshot?.records.map((record) => record.parentId)).toEqual([
      "msg-1",
    ]);
  });
});

// ── Batch integration ───────────────────────────────────────────────────────

describe("batch sizing from the calibration budget", () => {
  test("keeps every embed call inside the unit's token budget", async () => {
    const throttledIdentity: EmbeddingBuildIdentity = {
      agentId: IDENTITY.agentId,
      spaceId: "space-throttled",
    };
    const throttledDir = join(
      dirs.root,
      throttledIdentity.agentId,
      throttledIdentity.spaceId,
    );
    const unit = conversationUnit(
      "conv-long",
      [["msg-long", LONG_TEXT]],
      throttledIdentity,
    );
    const recorder = recordingEmbed();
    const result = await runEmbeddingBuild({
      identity: throttledIdentity,
      units: [unit],
      embed: recorder.embed,
      modelId: MODEL_ID,
      root: dirs.root,
      spaceDir: throttledDir,
      clock: clock.now,
      budget: fakeBudget({ batchTokensPerSec: 1_200 }),
    });

    expect(result.status).toBe("completed");
    const plan: EmbeddingRunBatchPlan = resolveEmbeddingRunBatchSize(
      unit.plans,
      { batchTokensPerSec: 1_200 },
    );
    expect(plan.tokenBudget).toBe(240);
    expect(recorder.calls.length).toBeGreaterThan(1);
    for (const call of recorder.calls) {
      expect(call.length).toBeLessThanOrEqual(plan.chunkBatchSize);
      const tokens = call.reduce(
        (sum, chunk) => sum + chunk.estimatedTokens,
        0,
      );
      expect(tokens).toBeLessThanOrEqual(plan.tokenBudget);
    }
  });

  test("an explicit batch size shrinks the B3 embed batches", async () => {
    const unit = conversationUnit("conv-long", [["msg-long", LONG_TEXT]]);
    const recorder = recordingEmbed();
    const result = await runEmbeddingBuild(
      runnerOptions(recorder, [unit], { batchSize: 1 }),
    );

    expect(result.status).toBe("completed");
    expect(recorder.calls.length).toBeGreaterThan(1);
    for (const call of recorder.calls) expect(call.length).toBe(1);
  });
});

// ── Failure isolation ───────────────────────────────────────────────────────

describe("unit failure isolation", () => {
  test("a failing unit is recorded and the rest of the build continues", async () => {
    const units = [
      conversationUnit("conv-ok-1", [["msg-1", TEXT_A]]),
      conversationUnit("conv-fail", [["msg-2", TEXT_FAIL]]),
      conversationUnit("conv-ok-2", [["msg-3", TEXT_C]]),
    ];
    const recorder = recordingEmbed({
      failWhen: (text) => text.includes("FAIL_MARK"),
    });
    const result = await runEmbeddingBuild(runnerOptions(recorder, units));

    expect(result.status).toBe("completed");
    expect(result.completedUnits).toBe(2);
    expect(result.failedUnits).toBe(1);
    expect(result.unitFailures).toHaveLength(1);
    expect(result.unitFailures[0]?.unitId).toBe("conv-fail");
    expect(result.unitFailures[0]?.kind).toBe("conversation");
    expect(result.unitFailures[0]?.code).toBe("embed_failed");
    expect(result.unitFailures[0]?.message).toContain("embed refused");

    expect(readUnitSnapshot(unitOf(unitAt(units, 0)))).not.toBeNull();
    expect(readUnitSnapshot(unitOf(unitAt(units, 1)))).toBeNull();
    expect(readUnitSnapshot(unitOf(unitAt(units, 2)))).not.toBeNull();

    const state = await readState();
    expect(state.phase).toBe("completed");
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]?.conversationId).toBe("conv-fail");
    expect(state.failures[0]?.code).toBe("embed_failed");
    expect(state.progress.processedConversations).toBe(3);
    expect(state.progress.embeddedChunks).toBeGreaterThan(0);
  });
});

// ── Cancellation and resume ─────────────────────────────────────────────────

describe("cancellation and resume", () => {
  test("aborting after a unit keeps its generation and checkpoint", async () => {
    const units = defaultUnits();
    const recorder = recordingEmbed({ clock });
    let abort = false;
    const result = await runEmbeddingBuild(
      runnerOptions(recorder, units, {
        isAborted: () => abort,
        onProgress: (snapshot) => {
          if (snapshot.progress.embeddedChunks > 0) abort = true;
        },
      }),
    );

    expect(result.status).toBe("aborted");
    expect(result.aborted).toBe(true);
    expect(result.completedUnits).toBe(1);
    expect(result.totalUnits).toBe(2);
    expect(result.embeddedChunks).toBe(expectedChunks([unitAt(units, 0)]));
    expect(result.state?.phase).toBe("cancelled");

    const first = readUnitSnapshot(unitOf(unitAt(units, 0)));
    expect(first).not.toBeNull();
    expect(first?.records.map((record) => record.parentId)).toEqual([
      "msg-1",
      "msg-2",
    ]);
    expect(readUnitSnapshot(unitOf(unitAt(units, 1)))).toBeNull();

    const state = await readState();
    expect(state.phase).toBe("cancelled");
    expect(state.progress.embeddedChunks).toBe(result.embeddedChunks);
    expect(state.finishedAt).not.toBeNull();
    expect((await inspectEmbeddingBuildLock(spaceDir)).status).toBe("missing");
    expect((await inspectEmbeddingLease(spaceDir)).status).toBe("missing");
  });

  test("a signal that is already aborted writes a cancelled checkpoint", async () => {
    const recorder = recordingEmbed();
    const controller = new AbortController();
    controller.abort();
    const result = await runEmbeddingBuild(
      runnerOptions(recorder, defaultUnits(), { signal: controller.signal }),
    );

    expect(result.status).toBe("aborted");
    expect(result.completedUnits).toBe(0);
    expect(recorder.calls).toEqual([]);
    const state = await readState();
    expect(state.phase).toBe("cancelled");
    expect(state.progress.embeddedChunks).toBe(0);
  });

  test("a resumed run reuses committed vectors instead of re-embedding", async () => {
    const units = defaultUnits();
    const firstRecorder = recordingEmbed({ clock });
    let abort = false;
    const first = await runEmbeddingBuild(
      runnerOptions(firstRecorder, units, {
        isAborted: () => abort,
        onProgress: (snapshot) => {
          if (snapshot.progress.embeddedChunks > 0) abort = true;
        },
      }),
    );
    expect(first.status).toBe("aborted");
    expect(first.completedUnits).toBe(1);

    // Simulate a killed process: the checkpoint still says "running".
    const path = embeddingBuildStatePath(spaceDir);
    const persisted = await readEmbeddingBuildState(path, IDENTITY);
    expect(persisted.status).toBe("ok");
    const resumedFrom = persisted.state.startedAt;
    await writeEmbeddingBuildState(path, {
      ...persisted.state,
      phase: "running",
      finishedAt: null,
    });

    clock.advance(5_000);
    const secondRecorder = recordingEmbed();
    const second = await runEmbeddingBuild(
      runnerOptions(secondRecorder, units),
    );

    expect(second.status).toBe("completed");
    expect(second.buildId).toBe(first.buildId);
    // A resumed run continues the interrupted run's clock instead of
    // pretending it started at the resume moment.
    expect(second.state?.startedAt).toBe(resumedFrom);
    expect(second.completedUnits).toBe(2);
    expect(second.reusedChunks).toBe(expectedChunks([unitAt(units, 0)]));
    expect(second.embeddedChunks).toBe(expectedChunks([unitAt(units, 1)]));
    // The committed unit's chunks never reach the embed callback again.
    expect(secondRecorder.texts).toEqual(expect.arrayContaining([TEXT_C]));
    expect(secondRecorder.texts).not.toEqual(expect.arrayContaining([TEXT_A]));
    expect(secondRecorder.texts).not.toEqual(expect.arrayContaining([TEXT_B]));

    const state = await readState();
    expect(state.phase).toBe("completed");
    expect(state.progress.embeddedChunks).toBe(expectedChunks(units));
    expect(state.finishedAt).not.toBeNull();
  });

  test("mode: full re-embeds committed units", async () => {
    const units = defaultUnits();
    const first = await runEmbeddingBuild(
      runnerOptions(recordingEmbed({ clock }), units),
    );
    expect(first.status).toBe("completed");

    const fullRecorder = recordingEmbed();
    const full = await runEmbeddingBuild(
      runnerOptions(fullRecorder, units, { mode: "full" }),
    );

    expect(full.status).toBe("completed");
    expect(full.reusedChunks).toBe(0);
    expect(full.embeddedChunks).toBe(expectedChunks(units));
    expect(fullRecorder.texts.length).toBe(expectedChunks(units));
  });

  test("re-running a completed build reuses every vector", async () => {
    const units = defaultUnits();
    const first = await runEmbeddingBuild(
      runnerOptions(recordingEmbed({ clock }), units),
    );
    expect(first.status).toBe("completed");
    const firstStartedAt = first.state?.startedAt;

    clock.advance(60_000);
    const secondStartedAt = clock.now();
    const secondRecorder = recordingEmbed();
    const second = await runEmbeddingBuild(
      runnerOptions(secondRecorder, units),
    );

    expect(second.status).toBe("completed");
    expect(secondRecorder.calls).toEqual([]);
    expect(second.reusedChunks).toBe(first.embeddedChunks);
    expect(second.embeddedChunks).toBe(0);
    // A fresh run does not report the previous run's start time.
    expect(second.state?.startedAt).toBe(secondStartedAt);
    expect(second.state?.startedAt).not.toBe(firstStartedAt);
    for (const runUnit of units) {
      const snapshot = readUnitSnapshot(unitOf(runUnit));
      expect(snapshot?.meta.chunkCount).toBeGreaterThan(0);
    }
  });
});

// ── Locking ─────────────────────────────────────────────────────────────────

describe("space lock", () => {
  test("a live lock held by another builder is a typed rejection", async () => {
    const other = await acquireEmbeddingBuildLock(spaceDir, IDENTITY, {
      clock: clock.now,
      pid: 918_273,
      host: "test-host",
      token: "other-builder",
      isPidAlive: () => true,
    });
    expect(other.ok).toBe(true);

    const recorder = recordingEmbed();
    const result = await runEmbeddingBuild(
      runnerOptions(recorder, defaultUnits(), {
        lockEnvironment: {
          clock: clock.now,
          pid: 111,
          host: "test-host",
          token: "mine",
          isPidAlive: (pid) => pid === 918_273,
        },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("lock_held");
    expect(result.error?.message).toContain("Another builder");
    expect(result.state).toBeNull();
    expect(recorder.calls).toEqual([]);
    const read = await readEmbeddingBuildState(
      embeddingBuildStatePath(spaceDir),
      IDENTITY,
    );
    expect(read.status).toBe("missing");
  });

  test("losing the lock mid-run fails the run but keeps the checkpoint", async () => {
    const units = defaultUnits();
    const recorder = recordingEmbed();
    let stolen = false;
    const result = await runEmbeddingBuild(
      runnerOptions(recorder, units, {
        heartbeatIntervalMs: 0,
        onProgress: (snapshot) => {
          if (snapshot.progress.embeddedChunks === 0 || stolen) return;
          stolen = true;
          writeFileSync(
            embeddingBuildLockPath(spaceDir),
            JSON.stringify({
              schemaVersion: 1,
              agentId: IDENTITY.agentId,
              spaceId: IDENTITY.spaceId,
              pid: 424_242,
              host: "test-host",
              token: "thief",
              acquiredAt: clock.now(),
              heartbeatAt: clock.now(),
            }),
            "utf8",
          );
        },
        lockEnvironment: {
          clock: clock.now,
          pid: 555,
          host: "test-host",
          token: "mine",
          isPidAlive: () => true,
        },
      }),
    );

    expect(stolen).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("lock_lost");
    expect(result.completedUnits).toBe(1);
    expect(readUnitSnapshot(unitOf(unitAt(units, 0)))).not.toBeNull();
    const state = await readState();
    expect(state.phase).toBe("failed");
    expect(state.progress.embeddedChunks).toBeGreaterThan(0);
  });

  test("a lock lost between embed batches stops without writing the unit", async () => {
    // One unit with 40 chunks needs two embed batches at the default size, and
    // the unit itself never checkpoints, so only the in-batch heartbeat can
    // notice the theft before the unit is written.
    const longPlan = fakePlan(
      "parent-long",
      Array.from({ length: 40 }, () => 10),
    );
    const units: EmbeddingRunUnit[] = [
      {
        unit: {
          agentId: IDENTITY.agentId,
          spaceId: IDENTITY.spaceId,
          conversationKey: "conv-long",
        },
        plans: [longPlan],
      },
    ];
    let batches = 0;
    const recorder = recordingEmbed({
      onCall: (call) => {
        if (call !== 1) return;
        rmSync(embeddingBuildLockPath(spaceDir), { force: true });
      },
    });
    const recordingEmbedCallback = recorder.embed;
    const embed: EmbeddingEmbedCallback = async (chunks) => {
      batches += 1;
      return await recordingEmbedCallback(chunks);
    };

    const result = await runEmbeddingBuild(
      runnerOptions({ ...recorder, embed }, units, {
        heartbeatIntervalMs: 0,
        lockEnvironment: {
          clock: clock.now,
          pid: 555,
          host: "test-host",
          token: "mine",
          isPidAlive: () => true,
        },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("lock_lost");
    expect(batches).toBe(1);
    expect(result.embeddedChunks).toBe(0);
    expect(readUnitSnapshot(unitOf(unitAt(units, 0)))).toBeNull();
  });
});

// ── Construction ────────────────────────────────────────────────────────────

describe("construction", () => {
  test("an unsafe identity is rejected before any filesystem action", async () => {
    const recorder = recordingEmbed();
    const result = await runEmbeddingBuild(
      runnerOptions(recorder, defaultUnits(), {
        identity: { agentId: "..", spaceId: IDENTITY.spaceId },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_input");
    expect(result.state).toBeNull();
    expect(recorder.calls).toEqual([]);
  });

  test("an empty model id is rejected", async () => {
    const recorder = recordingEmbed();
    const result = await runEmbeddingBuild(
      runnerOptions(recorder, defaultUnits(), { modelId: "" }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_input");
    expect(recorder.calls).toEqual([]);
  });
});
