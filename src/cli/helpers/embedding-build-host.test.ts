/**
 * Tests for the embedding build host (feature 48, package A4).
 *
 * Synthetic and isolated under a fresh OS temp directory (docs/31 §1.2 A2):
 * `HARUYUKI_HOME`/`LETTA_LOCAL_BACKEND_DIR` are redirected and restored. Every
 * provider is fake; no worker, ONNX, network call or real child is started. One
 * integration test runs the real A3/A2/B3 loop with a fake embed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EmbeddingCalibrationBudget } from "@/backend/local/embedding/calibration";
import type { EmbeddingEmbedCallback } from "@/backend/local/embedding-build";
import type {
  EmbeddingBuildIdentity,
  EmbeddingBuildStateSnapshot,
} from "@/backend/local/embedding-build-state";
import {
  embeddingBuildStatePath,
  readEmbeddingBuildState,
  snapshotEmbeddingBuildState,
} from "@/backend/local/embedding-build-state";
import type { EmbeddingChunk } from "@/backend/local/embedding-chunk";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import type { EmbeddingBuildLockInspection } from "@/backend/local/embedding-lock";
import type {
  EmbeddingRunnerOptions,
  EmbeddingRunResult,
  EmbeddingRunUnit,
} from "@/backend/local/embedding-runner";
import {
  cancelEmbeddingBuild,
  createBuiltinEmbedAdapter,
  createEndpointEmbedAdapter,
  EMBEDDING_BUILD_HOST_EXIT_WAIT_MS,
  type EmbeddingBuildHostOptions,
  type EmbeddingBuildHostStartResult,
  type EmbeddingBuildHostTimers,
  type EmbeddingDetachedChild,
  type EmbeddingDetachedSpawner,
  type EmbeddingDetachedSpawnOptions,
  getEmbeddingBuildHostState,
  resetEmbeddingBuildHost,
  shouldKeepAfterExit,
  startEmbeddingBuild,
} from "@/cli/helpers/embedding-build-host";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";

const MODEL_ID = "bge-small-zh-v1.5";

const IDENTITY: EmbeddingBuildIdentity = {
  agentId: "agent-a4",
  spaceId: "space-a4",
};

const MISSING_LOCK: EmbeddingBuildLockInspection = {
  status: "missing",
  record: null,
  heartbeatAgeMs: null,
};

const originalHome = process.env.HARUYUKI_HOME;
const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
let dirs: EmbeddingFixtureDirs;
let spaceDir: string;

// ── Fixtures ────────────────────────────────────────────────────────────────

function restoreHarnessEnv(): void {
  if (originalHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHome;
  if (originalLocalBackendDir === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
  }
}

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs("haru-embedding-host-");
  process.env.HARUYUKI_HOME = dirs.homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = dirs.localBackendDir;
  spaceDir = join(dirs.root, "vectors", IDENTITY.agentId, IDENTITY.spaceId);
  resetEmbeddingBuildHost();
});

afterEach(() => {
  resetEmbeddingBuildHost();
  dirs.cleanup();
  restoreHarnessEnv();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function runResult(
  overrides: Partial<EmbeddingRunResult> = {},
): EmbeddingRunResult {
  return {
    status: "completed",
    aborted: false,
    buildId: "build-test",
    mode: "incremental",
    totalUnits: 1,
    completedUnits: 1,
    failedUnits: 0,
    reusedChunks: 0,
    embeddedChunks: 4,
    elapsedMs: 12,
    state: null,
    unitFailures: [],
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<EmbeddingBuildStateSnapshot> = {},
): EmbeddingBuildStateSnapshot {
  return {
    schemaVersion: 1,
    agentId: IDENTITY.agentId,
    spaceId: IDENTITY.spaceId,
    buildId: "build-test",
    mode: "incremental",
    phase: "running",
    updatedAt: 1_000,
    startedAt: 900,
    finishedAt: null,
    progress: {
      embeddedChunks: 2,
      totalChunks: 4,
      processedConversations: 1,
      totalConversations: 2,
      remainingChunks: 2,
      fraction: 0.5,
    },
    coverage: { embeddedChars: 100, recallableChars: 200, ratio: 0.5 },
    rate: { chunksPerSecond: 2, windowMs: 1_000, sampleCount: 2 },
    eta: { remainingChunks: 2, remainingMs: null },
    failures: [],
    ...overrides,
  };
}

function calibrationBudget(): EmbeddingCalibrationBudget {
  return {
    tier: "small",
    calibrated: true,
    timedOut: false,
    queryBudgetMs: 120,
    threads: 4,
    cpuArena: false,
    gpuRole: "off",
    quantization: "float32",
    rssBytes: 300 * 1024 * 1024,
    diskFreeBytes: 10 * 1024 * 1024 * 1024,
    diskHeadroomOk: true,
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    batchTokensPerSec: 8_800,
    queryExecutionProviders: ["cpu"],
    buildExecutionProviders: ["cpu"],
  };
}

function makeChunk(text: string, chunkIndex = 0): EmbeddingChunk {
  return {
    parentId: "parent-1",
    chunkIndex,
    kind: "prose",
    text,
    startChar: 0,
    endChar: text.length,
    spans: [{ startChar: 0, endChar: text.length }],
    focusChar: 0,
    estimatedTokens: Math.max(1, Math.ceil(text.length / 2)),
  };
}

function makeUnit(conversationKey = "conv-a4"): EmbeddingRunUnit {
  const plan = buildEmbeddingChunkPlan({
    parentId: "parent-1",
    text: "向量构建宿主默认随宿主退出而取消，检查点保留供下次续跑。",
  });
  return {
    unit: {
      agentId: IDENTITY.agentId,
      spaceId: IDENTITY.spaceId,
      conversationKey,
    },
    plans: [plan],
  };
}

const fakeEmbed: EmbeddingEmbedCallback = async (chunks) =>
  chunks.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));

interface RunnerRecorder {
  calls: EmbeddingRunnerOptions[];
  runBuild: (options: EmbeddingRunnerOptions) => Promise<EmbeddingRunResult>;
  settle(index: number, result: EmbeddingRunResult): void;
  fail(index: number, error: unknown): void;
}

function recordingRunner(): RunnerRecorder {
  const calls: EmbeddingRunnerOptions[] = [];
  const pending: Deferred<EmbeddingRunResult>[] = [];
  return {
    calls,
    runBuild: (options) => {
      calls.push(options);
      const entry = deferred<EmbeddingRunResult>();
      pending.push(entry);
      return entry.promise;
    },
    settle: (index, result) => pending[index]?.resolve(result),
    fail: (index, error) => pending[index]?.reject(error),
  };
}

function fakeTimers() {
  const delays: number[] = [];
  const timers: EmbeddingBuildHostTimers = {
    setTimeout: (callback, ms) => {
      delays.push(ms);
      callback();
      return delays.length;
    },
    clearTimeout: () => {},
  };
  return { delays, timers };
}

interface SpawnRecorder {
  calls: Array<{
    command: string;
    args: readonly string[];
    options: EmbeddingDetachedSpawnOptions;
  }>;
  killCalls: string[];
  unrefCalls: () => number;
  spawnDetached: EmbeddingDetachedSpawner;
  pid: number;
}

function spawnRecorder(pid = 4_242): SpawnRecorder {
  const calls: SpawnRecorder["calls"] = [];
  const killCalls: string[] = [];
  let unrefCalls = 0;
  const child: EmbeddingDetachedChild = {
    pid,
    unref: () => {
      unrefCalls += 1;
    },
    kill: (signal) => {
      killCalls.push(signal ?? "SIGTERM");
      return true;
    },
  };
  return {
    calls,
    killCalls,
    unrefCalls: () => unrefCalls,
    pid,
    spawnDetached: (command, args, options) => {
      calls.push({ command, args: [...args], options });
      return child;
    },
  };
}

function baseOptions(
  overrides: Partial<EmbeddingBuildHostOptions> = {},
): EmbeddingBuildHostOptions {
  return {
    lifecycle: "tui",
    identity: IDENTITY,
    modelId: MODEL_ID,
    backend: "builtin",
    embed: fakeEmbed,
    units: [],
    spaceDir,
    isModelInstalled: async () => true,
    inspectLock: async () => MISSING_LOCK,
    runBuild: async () => runResult(),
    ...overrides,
  };
}

function expectStarted(
  result: EmbeddingBuildHostStartResult,
): Extract<EmbeddingBuildHostStartResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected the build to start, got ${result.error.code}`);
  }
  return result;
}

/** The host materialises units (and calls A3) across microtasks, not in start(). */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met in time");
}

async function waitForRunner(recorder: RunnerRecorder): Promise<void> {
  await waitFor(() => recorder.calls.length > 0);
}

// ── Opt-in gate ─────────────────────────────────────────────────────────────

describe("shouldKeepAfterExit (f7: the default is not configurable)", () => {
  test("only the literal boolean true opts in", () => {
    expect(EMBEDDING_BUILD_HOST_EXIT_WAIT_MS).toBe(200);
    expect(shouldKeepAfterExit(true)).toBe(true);
    expect(shouldKeepAfterExit(false)).toBe(false);
    expect(shouldKeepAfterExit(undefined)).toBe(false);
    expect(shouldKeepAfterExit("true")).toBe(false);
    expect(shouldKeepAfterExit(1)).toBe(false);
    expect(shouldKeepAfterExit({})).toBe(false);
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe("startEmbeddingBuild refusals", () => {
  test("refuses a build with no host lifecycle (无宿主不构建)", async () => {
    const result = await startEmbeddingBuild(
      baseOptions({ lifecycle: "none" as unknown as "tui" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no_host");
    expect(result.error.action).toContain("tui");
  });

  test("reports a missing model with an actionable remedy; never downloads it", async () => {
    const runner = recordingRunner();
    const result = await startEmbeddingBuild(
      baseOptions({
        isModelInstalled: async () => false,
        runBuild: runner.runBuild,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("model_missing");
    expect(result.error.action).toContain("/recall embedding setup");
    expect(runner.calls).toHaveLength(0);
  });

  test("maps an unverifiable install check to a typed configuration error", async () => {
    const result = await startEmbeddingBuild(
      baseOptions({
        isModelInstalled: async () => {
          throw new Error("unknown-model: nope");
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_configured");
    expect(result.error.message).toContain("unknown-model");
  });

  test("endpoint backend skips the install marker gate", async () => {
    let installChecks = 0;
    const result = await startEmbeddingBuild(
      baseOptions({
        backend: "endpoint",
        isModelInstalled: async () => {
          installChecks += 1;
          return false;
        },
        runBuild: async () => runResult(),
      }),
    );
    expect(installChecks).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await result.outcome).status).toBe("completed");
  });

  test("refuses a live lock before starting anything", async () => {
    const runner = recordingRunner();
    const result = await startEmbeddingBuild(
      baseOptions({
        inspectLock: async () => ({
          status: "live",
          record: {
            schemaVersion: 1,
            agentId: IDENTITY.agentId,
            spaceId: IDENTITY.spaceId,
            pid: 777,
            host: "other-host",
            token: "token",
            acquiredAt: 1,
            heartbeatAt: 2,
          },
          heartbeatAgeMs: 5,
        }),
        runBuild: runner.runBuild,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("lock_held");
    expect(result.error.message).toContain("777");
    expect(result.error.message).toContain("other-host");
    expect(runner.calls).toHaveLength(0);
    expect(getEmbeddingBuildHostState().phase).toBe("idle");
  });

  test("refuses a second start while one is running", async () => {
    const runner = recordingRunner();
    const first = expectStarted(
      await startEmbeddingBuild(baseOptions({ runBuild: runner.runBuild })),
    );
    await waitForRunner(runner);
    const second = await startEmbeddingBuild(
      baseOptions({ runBuild: runner.runBuild }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("already_running");
    expect(runner.calls).toHaveLength(1);
    runner.settle(0, runResult());
    await first.outcome;
  });

  test("keepAfterExit requires the detached entry command", async () => {
    const result = await startEmbeddingBuild(
      baseOptions({ keepAfterExit: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_configured");
    expect(result.error.message).toContain("detached");
  });
});

// ── In-process lifecycle ────────────────────────────────────────────────────

describe("in-process build lifecycle", () => {
  test("headless run completes and exposes the A3 result and state", async () => {
    const finalSnapshot = snapshot({ phase: "completed", finishedAt: 1_100 });
    const runner = recordingRunner();
    const progress: EmbeddingBuildStateSnapshot[] = [];
    const now = 1_700_000_000_000;
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          lifecycle: "headless",
          runBuild: runner.runBuild,
          clock: () => now,
          onProgress: (value) => progress.push(value),
        }),
      ),
    );
    expect(start.phase).toBe("running");
    expect(getEmbeddingBuildHostState()).toMatchObject({
      phase: "running",
      lifecycle: "headless",
      identity: IDENTITY,
      modelId: MODEL_ID,
    });

    await waitForRunner(runner);
    const runnerOptions = runner.calls[0];
    expect(runnerOptions).toBeDefined();
    if (runnerOptions === undefined) return;
    expect(runnerOptions.identity).toEqual(IDENTITY);
    expect(runnerOptions.spaceDir).toBe(spaceDir);
    expect(runnerOptions.modelId).toBe(MODEL_ID);
    expect(runnerOptions.embed).toBe(fakeEmbed);
    expect(runnerOptions.signal?.aborted).toBe(false);

    runnerOptions.onProgress?.(snapshot({ phase: "running" }));
    expect(progress).toHaveLength(1);
    expect(getEmbeddingBuildHostState().progress?.phase).toBe("running");

    runner.settle(0, runResult({ status: "completed", state: finalSnapshot }));
    const outcome = await start.outcome;
    expect(outcome.status).toBe("completed");
    expect(outcome.error).toBeNull();
    expect(outcome.progress?.phase).toBe("completed");

    const state = getEmbeddingBuildHostState();
    expect(state.phase).toBe("completed");
    expect(state.result?.embeddedChunks).toBe(4);
    expect(state.startedAt).toBe(1_700_000_000_000);
    expect(state.finishedAt).toBe(1_700_000_000_000);
    expect(state.keepAfterExit).toBe(false);
  });

  test("TUI exit cancels the run and waits at most one batch (200 ms)", async () => {
    const runner = recordingRunner();
    const clock = fakeTimers();
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          lifecycle: "tui",
          runBuild: runner.runBuild,
          timers: clock.timers,
        }),
      ),
    );
    await waitForRunner(runner);
    const signal = runner.calls[0]?.signal;
    expect(signal?.aborted).toBe(false);

    const result = await cancelEmbeddingBuild({ reason: "tui_exit" });
    expect(result.cancelled).toBe(true);
    expect(result.settled).toBe(false);
    expect(result.phase).toBe("cancelling");
    expect(clock.delays).toEqual([EMBEDDING_BUILD_HOST_EXIT_WAIT_MS]);
    expect(signal?.aborted).toBe(true);

    // The runner reaches its checkpoint a moment later; the host records it.
    runner.settle(
      0,
      runResult({
        status: "aborted",
        aborted: true,
        state: snapshot({ phase: "cancelled" }),
      }),
    );
    const outcome = await start.outcome;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.error?.code).toBe("aborted");
    expect(getEmbeddingBuildHostState().phase).toBe("cancelled");
  });

  test("cancel settles promptly when the runner stops at a checkpoint", async () => {
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          runBuild: (options) =>
            new Promise<EmbeddingRunResult>((resolve) => {
              options.signal?.addEventListener("abort", () => {
                resolve(
                  runResult({
                    status: "aborted",
                    aborted: true,
                    state: snapshot({ phase: "cancelled" }),
                  }),
                );
              });
            }),
        }),
      ),
    );
    const result = await cancelEmbeddingBuild();
    expect(result.settled).toBe(true);
    expect(result.phase).toBe("cancelled");
    const outcome = await start.outcome;
    expect(outcome.status).toBe("cancelled");
  });

  test("cancel is idempotent and aborts the runner once", async () => {
    const runner = recordingRunner();
    const clock = fakeTimers();
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({ runBuild: runner.runBuild, timers: clock.timers }),
      ),
    );
    await waitForRunner(runner);
    let aborts = 0;
    runner.calls[0]?.signal?.addEventListener("abort", () => {
      aborts += 1;
    });

    const first = await cancelEmbeddingBuild();
    const second = await cancelEmbeddingBuild();
    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(true);
    expect(aborts).toBe(1);
    expect(clock.delays).toEqual([
      EMBEDDING_BUILD_HOST_EXIT_WAIT_MS,
      EMBEDDING_BUILD_HOST_EXIT_WAIT_MS,
    ]);

    runner.settle(0, runResult({ status: "aborted", aborted: true }));
    await start.outcome;
    const after = await cancelEmbeddingBuild();
    expect(after.cancelled).toBe(false);
    expect(after.settled).toBe(true);
  });

  test("websocket listener dispose cancels the build", async () => {
    const runner = recordingRunner();
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          lifecycle: "websocket",
          runBuild: runner.runBuild,
          timers: fakeTimers().timers,
        }),
      ),
    );
    expect(getEmbeddingBuildHostState().lifecycle).toBe("websocket");
    await waitForRunner(runner);
    await cancelEmbeddingBuild({ reason: "listener_dispose" });
    expect(runner.calls[0]?.signal?.aborted).toBe(true);
    runner.settle(0, runResult({ status: "aborted", aborted: true }));
    expect((await start.outcome).status).toBe("cancelled");
  });
});

// ── Detached opt-in ─────────────────────────────────────────────────────────

describe("keepAfterExit detached child", () => {
  test("spawns detached + windowsHide, unrefs, and reports the pid", async () => {
    const spawn = spawnRecorder();
    const detachedCommand = {
      command: "node",
      args: ["haruyuki.js", "recall", "embedding", "build"],
      env: { EMBEDDING_HOST_TEST: "1" },
    };
    let installChecks = 0;
    const result = await startEmbeddingBuild(
      baseOptions({
        keepAfterExit: true,
        detachedCommand,
        embed: undefined,
        units: undefined,
        isModelInstalled: async () => {
          installChecks += 1;
          return true;
        },
        spawnDetached: spawn.spawnDetached,
      }),
    );
    const started = expectStarted(result);
    expect(started.phase).toBe("detached");
    expect(started.detachedPid).toBe(spawn.pid);
    expect(installChecks).toBe(1);

    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    expect(call?.command).toBe("node");
    expect(call?.args).toEqual(["haruyuki.js", "recall", "embedding", "build"]);
    expect(call?.options.detached).toBe(true);
    expect(call?.options.windowsHide).toBe(true);
    expect(call?.options.stdio).toBe("ignore");
    expect(call?.options.env.EMBEDDING_HOST_TEST).toBe("1");
    expect(spawn.unrefCalls()).toBe(1);

    const outcome = await started.outcome;
    expect(outcome.status).toBe("detached");
    expect(outcome.detachedPid).toBe(spawn.pid);
    expect(getEmbeddingBuildHostState()).toMatchObject({
      phase: "detached",
      keepAfterExit: true,
      detachedPid: spawn.pid,
    });
  });

  test("cancel signals the detached child and is idempotent", async () => {
    const spawn = spawnRecorder();
    expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          keepAfterExit: true,
          detachedCommand: { command: "node", args: ["haruyuki.js"] },
          embed: undefined,
          units: undefined,
          spawnDetached: spawn.spawnDetached,
        }),
      ),
    );
    const first = await cancelEmbeddingBuild();
    expect(first).toMatchObject({ cancelled: true, phase: "cancelled" });
    expect(spawn.killCalls).toEqual(["SIGTERM"]);
    const second = await cancelEmbeddingBuild();
    expect(second.cancelled).toBe(false);
    expect(spawn.killCalls).toEqual(["SIGTERM"]);
  });

  test("a spawn failure is a typed worker_failed refusal", async () => {
    const result = await startEmbeddingBuild(
      baseOptions({
        keepAfterExit: true,
        detachedCommand: { command: "node", args: ["haruyuki.js"] },
        embed: undefined,
        units: undefined,
        spawnDetached: () => {
          throw new Error("spawn ENOENT");
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("worker_failed");
    expect(result.error.message).toContain("spawn ENOENT");
  });

  test("the detached child owns calibration (the parent does not run it)", async () => {
    let calibrations = 0;
    const spawn = spawnRecorder();
    const started = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          keepAfterExit: true,
          detachedCommand: { command: "node", args: ["haruyuki.js"] },
          embed: undefined,
          units: undefined,
          calibrate: async () => {
            calibrations += 1;
            return calibrationBudget();
          },
          spawnDetached: spawn.spawnDetached,
        }),
      ),
    );
    expect(calibrations).toBe(0);
    const outcome = await started.outcome;
    expect(outcome.calibration?.status).toBe("skipped");
  });
});

// ── Units, calibration and runner overrides ─────────────────────────────────

describe("units provider and calibration budget", () => {
  test("resolves a lazy units provider right before the run", async () => {
    const unit = makeUnit();
    const runner = recordingRunner();
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          units: () => [unit],
          runBuild: runner.runBuild,
        }),
      ),
    );
    await waitForRunner(runner);
    const runnerOptions = runner.calls[0];
    expect(runnerOptions?.units).toHaveLength(1);
    runner.settle(0, runResult());
    await start.outcome;
  });

  test("a failing units provider fails the run with a typed error", async () => {
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          units: () => {
            throw new Error("scan failed");
          },
          runBuild: async () => {
            throw new Error("must not be called");
          },
        }),
      ),
    );
    const outcome = await start.outcome;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("worker_failed");
    expect(outcome.error?.message).toContain("scan failed");
  });

  test("passes a supplied calibration budget to the runner", async () => {
    const budget = calibrationBudget();
    const runner = recordingRunner();
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({ budget, runBuild: runner.runBuild }),
      ),
    );
    await waitForRunner(runner);
    expect(runner.calls[0]?.budget).toBe(budget);
    expect(getEmbeddingBuildHostState().calibration).toEqual({
      status: "used",
      budget,
    });
    runner.settle(0, runResult());
    await start.outcome;
  });

  test("skipCalibration leaves the runner on its defaults", async () => {
    let calibrated = 0;
    const runner = recordingRunner();
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          skipCalibration: true,
          calibrate: async () => {
            calibrated += 1;
            return calibrationBudget();
          },
          runBuild: runner.runBuild,
        }),
      ),
    );
    expect(calibrated).toBe(0);
    await waitForRunner(runner);
    expect(runner.calls[0]?.budget).toBeUndefined();
    expect(getEmbeddingBuildHostState().calibration?.status).toBe("skipped");
    runner.settle(0, runResult());
    await start.outcome;
  });

  test("a failed calibration is reported but never blocks the build", async () => {
    const runner = recordingRunner();
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          calibrate: async () => {
            throw new Error("no GPU");
          },
          runBuild: runner.runBuild,
        }),
      ),
    );
    await waitForRunner(runner);
    expect(runner.calls[0]?.budget).toBeUndefined();
    const calibration = getEmbeddingBuildHostState().calibration;
    expect(calibration?.status).toBe("failed");
    if (calibration?.status === "failed") {
      expect(calibration.message).toContain("no GPU");
    }
    runner.settle(0, runResult());
    expect((await start.outcome).status).toBe("completed");
  });

  test("a rejected runner becomes a typed worker_failed outcome", async () => {
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          runBuild: async () => {
            throw new Error("runner exploded");
          },
        }),
      ),
    );
    const outcome = await start.outcome;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("worker_failed");
    expect(outcome.error?.message).toContain("runner exploded");
  });

  test("A3's lock rejection is surfaced as lock_held after start", async () => {
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          runBuild: async () =>
            runResult({
              status: "failed",
              error: {
                code: "lock_held",
                message: "another builder owns the space",
              },
            }),
        }),
      ),
    );
    const outcome = await start.outcome;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("lock_held");
  });
});

// ── Status reading / reset ──────────────────────────────────────────────────

describe("status and teardown", () => {
  test("returns an idle state before any build", () => {
    expect(getEmbeddingBuildHostState()).toMatchObject({
      phase: "idle",
      lifecycle: null,
      identity: null,
      modelId: null,
      progress: null,
    });
  });

  test("reset cancels the in-flight outcome and clears host state", async () => {
    const runner = recordingRunner();
    const start = expectStarted(
      await startEmbeddingBuild(baseOptions({ runBuild: runner.runBuild })),
    );
    await waitForRunner(runner);
    resetEmbeddingBuildHost();
    expect(getEmbeddingBuildHostState().phase).toBe("idle");
    const outcome = await start.outcome;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.error?.code).toBe("aborted");
    expect(runner.calls[0]?.signal?.aborted).toBe(true);

    // A new start after the reset works (the generation guard is what allows it).
    const second = await startEmbeddingBuild(
      baseOptions({ runBuild: async () => runResult() }),
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect((await second.outcome).status).toBe("completed");
  });

  test("wires the real A3/A2/B3 loop and reads the checkpoint back", async () => {
    const progress: EmbeddingBuildStateSnapshot[] = [];
    let embeddedChunks = 0;
    const start = expectStarted(
      await startEmbeddingBuild(
        baseOptions({
          lifecycle: "headless",
          units: [makeUnit("conv-real")],
          embed: async (chunks) => {
            embeddedChunks += chunks.length;
            return chunks.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
          },
          runBuild: undefined,
          onProgress: (value) => progress.push(value),
        }),
      ),
    );
    const outcome = await start.outcome;
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.embeddedChunks).toBeGreaterThan(0);
    expect(embeddedChunks).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)?.phase).toBe("completed");

    const read = await readEmbeddingBuildState(
      embeddingBuildStatePath(spaceDir),
      { agentId: IDENTITY.agentId, spaceId: IDENTITY.spaceId },
    );
    expect(read.status).toBe("ok");
    const stored = snapshotEmbeddingBuildState(read.state);
    expect(stored.phase).toBe("completed");
    expect(stored.progress.embeddedChunks).toBeGreaterThan(0);
    expect(stored.progress.fraction).toBe(1);
  });
});

// ── Adapters ────────────────────────────────────────────────────────────────

describe("embed adapters (C3 / C6 → A3)", () => {
  test("builtin adapter forwards text/vectors and rejects bad batches", async () => {
    const texts: string[][] = [];
    const vectors = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const embed = createBuiltinEmbedAdapter({
      embedBatched: async (batch) => {
        texts.push([...batch]);
        return { vectors, cancelled: false };
      },
    });
    expect(
      await embed([makeChunk("第一块"), makeChunk("第二块", 1)]),
    ).toHaveLength(2);
    expect(texts).toEqual([["第一块", "第二块"]]);

    const cancelled = createBuiltinEmbedAdapter({
      embedBatched: async () => ({ vectors: [null], cancelled: true }),
    });
    await expect(cancelled([makeChunk("块")])).rejects.toThrow("cancelled");
    const short = createBuiltinEmbedAdapter({
      embedBatched: async () => ({ vectors: [], cancelled: false }),
    });
    await expect(short([makeChunk("块")])).rejects.toThrow("0 vector");
  });

  test("endpoint adapter forwards text and rejects a count mismatch", async () => {
    const seen: string[][] = [];
    const embed = createEndpointEmbedAdapter({
      embed: async (batch) => {
        seen.push([...batch]);
        return [new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0])];
      },
    });
    expect(await embed([makeChunk("甲"), makeChunk("乙", 1)])).toHaveLength(2);
    expect(seen).toEqual([["甲", "乙"]]);

    const short = createEndpointEmbedAdapter({
      embed: async () => [new Float32Array([1])],
    });
    await expect(short([makeChunk("甲"), makeChunk("乙", 1)])).rejects.toThrow(
      "1 vector",
    );
  });
});
