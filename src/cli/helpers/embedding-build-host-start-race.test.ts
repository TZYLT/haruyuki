/**
 * Admission race in the embedding build host (48-3 §11.7.5-4 / §13.10-3, P3).
 *
 * `startEmbeddingBuild` is `async` and checks `current` **before** its first
 * `await` (the model-install probe and A2's read-only lock preflight). The
 * `RunningBuild` — the thing the guard tests — is only installed after those
 * awaits. Two callers that arrive inside that window therefore both pass the
 * guard: two runners (or two detached children) race for the same index space
 * and the second overwrites `current`, losing the first child's cancel handle.
 *
 * These tests pin the invariant "at most one start is admitted per process";
 * they are the red-first proof for the fix in `embedding-build-host.ts`.
 *
 * Synthetic and isolated under a fresh OS temp directory (docs/31 §1.2 A2):
 * `HARUYUKI_HOME`/`LETTA_LOCAL_BACKEND_DIR` are redirected and restored. Every
 * provider is fake; no worker, ONNX, network call or real child is started.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EmbeddingCalibrationBudget } from "@/backend/local/embedding/calibration";
import type { EmbeddingBuildIdentity } from "@/backend/local/embedding-build-state";
import type { EmbeddingBuildLockInspection } from "@/backend/local/embedding-lock";
import type {
  EmbeddingRunnerOptions,
  EmbeddingRunResult,
} from "@/backend/local/embedding-runner";
import {
  cancelEmbeddingBuild,
  type EmbeddingBuildHostOptions,
  type EmbeddingBuildHostStartResult,
  getEmbeddingBuildHostState,
  resetEmbeddingBuildHost,
  startEmbeddingBuild,
} from "@/cli/helpers/embedding-build-host";
import type {
  EmbeddingDetachedChild,
  EmbeddingDetachedSpawnOptions,
} from "@/cli/helpers/embedding-detached-child";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";

const MODEL_ID = "bge-small-zh-v1.5";

const IDENTITY: EmbeddingBuildIdentity = {
  agentId: "agent-race",
  spaceId: "space-race",
};

const MISSING_LOCK: EmbeddingBuildLockInspection = {
  status: "missing",
  record: null,
  heartbeatAgeMs: null,
};

const DETACHED_COMMAND = {
  command: "haruyuki",
  args: ["recall", "embedding", "build", "--keep-after-exit"],
};

const originalHome = process.env.HARUYUKI_HOME;
const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
let dirs: EmbeddingFixtureDirs;
let spaceDir: string;

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
  dirs = createEmbeddingFixtureDirs("haru-embedding-start-race-");
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
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

/** A gate that is already open: the start runs up to its next real await. */
function resolvedGate(): Deferred<boolean> {
  const gate = deferred<boolean>();
  gate.resolve(true);
  return gate;
}

/** Spin the macrotask queue until a synchronous flag flips. */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met in time");
}

function runResult(): EmbeddingRunResult {
  return {
    status: "completed",
    aborted: false,
    buildId: "build-race",
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
}

const fakeEmbed = async (chunks: readonly unknown[]) =>
  chunks.map(() => new Float32Array(8));

function gatedOptions(
  gate: Deferred<boolean>,
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
    isModelInstalled: () => gate.promise,
    inspectLock: async () => MISSING_LOCK,
    runBuild: async () => runResult(),
    ...overrides,
  };
}

function admitted(results: readonly EmbeddingBuildHostStartResult[]): number {
  return results.filter((result) => result.ok).length;
}

describe("startEmbeddingBuild admission (启动窗口竞态)", () => {
  test("two starts arriving inside the async preflight admit exactly one build", async () => {
    const gate = deferred<boolean>();
    const calls: EmbeddingRunnerOptions[] = [];
    const options = (): EmbeddingBuildHostOptions =>
      gatedOptions(gate, {
        runBuild: async (runnerOptions) => {
          calls.push(runnerOptions);
          return runResult();
        },
      });

    const first = startEmbeddingBuild(options());
    const second = startEmbeddingBuild(options());
    // Both callers are now parked on the install probe; neither has installed a
    // RunningBuild yet, so the synchronous `current` guard saw nothing.
    gate.resolve(true);
    const results = await Promise.all([first, second]);

    expect(admitted(results)).toBe(1);
    const refused = results.find((result) => !result.ok);
    expect(
      refused !== undefined && !refused.ok ? refused.error.code : null,
    ).toBe("already_running");
    expect(calls).toHaveLength(1);
  });

  test("two detached starts arriving inside the async preflight spawn exactly one child", async () => {
    const gate = deferred<boolean>();
    const spawns: string[] = [];
    const child: EmbeddingDetachedChild = {
      pid: 4_242,
      unref: () => {},
      kill: () => true,
    };
    const options = (): EmbeddingBuildHostOptions =>
      gatedOptions(gate, {
        keepAfterExit: true,
        detachedCommand: DETACHED_COMMAND,
        spawnDetached: (
          command: string,
          _args: readonly string[],
          _options: EmbeddingDetachedSpawnOptions,
        ) => {
          spawns.push(command);
          return child;
        },
      });

    const first = startEmbeddingBuild(options());
    const second = startEmbeddingBuild(options());
    gate.resolve(true);
    const results = await Promise.all([first, second]);

    expect(admitted(results)).toBe(1);
    // The loser must not leave an orphan child behind: only one spawn may run.
    expect(spawns).toHaveLength(1);
    expect(getEmbeddingBuildHostState().detachedPid).toBe(4_242);
  });

  test("a sequential start after one finished still works (the guard is not sticky)", async () => {
    const ready = deferred<boolean>();
    ready.resolve(true);
    const first = await startEmbeddingBuild(gatedOptions(ready));
    expect(first.ok).toBe(true);
    if (first.ok) await first.outcome;

    const again = deferred<boolean>();
    again.resolve(true);
    const second = await startEmbeddingBuild(gatedOptions(again));
    expect(second.ok).toBe(true);
    if (second.ok) await second.outcome;
  });
});

/**
 * A cancel that lands while the start is still in its async preflight.
 *
 * There is no `RunningBuild` to abort yet, so before the fix `cancel` answered
 * "nothing is running" and the build then started anyway — a user-visible lie.
 * The cancel must be acknowledged ("cancelling") and the start must refuse
 * after its next awaited step, before it spawns a child or claims the lock.
 */
describe("cancel inside the start window (回执竞态)", () => {
  test("cancel during the install probe is acknowledged and the start refuses", async () => {
    const gate = deferred<boolean>();
    const calls: EmbeddingRunnerOptions[] = [];
    const opts = gatedOptions(gate, {
      runBuild: async (runnerOptions) => {
        calls.push(runnerOptions);
        return runResult();
      },
    });

    const started = startEmbeddingBuild(opts);
    const cancelled = await cancelEmbeddingBuild();
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.settled).toBe(false);
    expect(cancelled.phase).toBe("cancelling");

    gate.resolve(true);
    const result = await started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aborted");
    expect(calls).toHaveLength(0);
    expect(getEmbeddingBuildHostState().phase).toBe("idle");
  });

  test("cancel during the lock preflight is acknowledged and the start refuses", async () => {
    const lockGate = deferred<EmbeddingBuildLockInspection>();
    let preflightStarted = false;
    const calls: EmbeddingRunnerOptions[] = [];
    const opts = gatedOptions(resolvedGate(), {
      inspectLock: () => {
        preflightStarted = true;
        return lockGate.promise;
      },
      runBuild: async (runnerOptions) => {
        calls.push(runnerOptions);
        return runResult();
      },
    });
    const started = startEmbeddingBuild(opts);
    await waitUntil(() => preflightStarted);
    const cancelled = await cancelEmbeddingBuild();
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.phase).toBe("cancelling");

    lockGate.resolve(MISSING_LOCK);
    const result = await started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  test("cancel during calibration is acknowledged and the start refuses", async () => {
    const calibrationGate = deferred<EmbeddingCalibrationBudget | null>();
    let calibrationStarted = false;
    const calls: EmbeddingRunnerOptions[] = [];
    const opts = gatedOptions(resolvedGate(), {
      calibrate: () => {
        calibrationStarted = true;
        return calibrationGate.promise;
      },
      runBuild: async (runnerOptions) => {
        calls.push(runnerOptions);
        return runResult();
      },
    });
    const started = startEmbeddingBuild(opts);
    await waitUntil(() => calibrationStarted);
    const cancelled = await cancelEmbeddingBuild();
    expect(cancelled.cancelled).toBe(true);

    calibrationGate.resolve(null);
    const result = await started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  test("the cancel intent does not leak into the next start", async () => {
    const gate = deferred<boolean>();
    const started = startEmbeddingBuild(gatedOptions(gate));
    await Promise.resolve();
    expect((await cancelEmbeddingBuild()).cancelled).toBe(true);
    gate.resolve(true);
    const refused = await started;
    expect(refused.ok).toBe(false);

    // A fresh start after the cancelled one is admitted and runs normally.
    const second = await startEmbeddingBuild(gatedOptions(resolvedGate()));
    expect(second.ok).toBe(true);
    if (second.ok) expect((await second.outcome).status).toBe("completed");
  });
});
