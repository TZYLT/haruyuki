import { describe, expect, test } from "bun:test";
import {
  classifyEmbeddingWorkerFailure,
  DEFAULT_EMBEDDING_WORKER_RESTART_POLICY,
  EmbeddingWorkerWatchdog,
  embeddingWorkerRestartDelayMs,
  resolveEmbeddingWorkerRestartPolicy,
  resolveEmbeddingWorkerTimeoutTier,
} from "./worker-watchdog";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("classifyEmbeddingWorkerFailure", () => {
  test("a non-zero exit is a retriable crash", () => {
    const failure = classifyEmbeddingWorkerFailure("exited", {
      code: 7,
      signal: null,
    });
    expect(failure.reason).toBe("crash-exit");
    expect(failure.retriable).toBe(true);
    expect(failure.exitCode).toBe(7);
  });

  test("a crash signal is retriable", () => {
    const failure = classifyEmbeddingWorkerFailure("exited", {
      code: null,
      signal: "SIGSEGV",
    });
    expect(failure.reason).toBe("crash-signal");
    expect(failure.retriable).toBe(true);
    expect(failure.signal).toBe("SIGSEGV");
  });

  test("owner kills and clean exits are terminal", () => {
    expect(
      classifyEmbeddingWorkerFailure("exited", {
        code: null,
        signal: "SIGKILL",
      }).reason,
    ).toBe("killed");
    expect(
      classifyEmbeddingWorkerFailure("exited", {
        code: null,
        signal: "SIGTERM",
      }).retriable,
    ).toBe(false);
    const clean = classifyEmbeddingWorkerFailure("exited", {
      code: 0,
      signal: null,
    });
    expect(clean.reason).toBe("clean-exit");
    expect(clean.retriable).toBe(false);
  });

  test("spawn and protocol failures are terminal", () => {
    const spawnFailure = classifyEmbeddingWorkerFailure("exited", {
      code: null,
      signal: null,
      error: new Error("ENOENT"),
    });
    expect(spawnFailure.reason).toBe("spawn-failed");
    expect(spawnFailure.retriable).toBe(false);
    expect(classifyEmbeddingWorkerFailure("protocol").retriable).toBe(false);
    expect(classifyEmbeddingWorkerFailure("worker-error").retriable).toBe(
      false,
    );
    expect(classifyEmbeddingWorkerFailure("request-timeout").retriable).toBe(
      false,
    );
    expect(classifyEmbeddingWorkerFailure("aborted").reason).toBe("caller");
  });

  test("a handshake timeout is retriable", () => {
    const failure = classifyEmbeddingWorkerFailure("handshake-timeout");
    expect(failure.reason).toBe("handshake-timeout");
    expect(failure.retriable).toBe(true);
  });
});

describe("restart budget and backoff", () => {
  test("default policy is two restarts with capped exponential backoff", () => {
    expect(DEFAULT_EMBEDDING_WORKER_RESTART_POLICY.maxRestarts).toBe(2);
    const policy = DEFAULT_EMBEDDING_WORKER_RESTART_POLICY;
    expect(embeddingWorkerRestartDelayMs(1, policy)).toBe(250);
    expect(embeddingWorkerRestartDelayMs(2, policy)).toBe(500);
    expect(embeddingWorkerRestartDelayMs(3, policy)).toBe(1_000);
    expect(embeddingWorkerRestartDelayMs(4, policy)).toBe(2_000);
    expect(embeddingWorkerRestartDelayMs(9, policy)).toBe(2_000);
  });

  test("partial policy overrides are clamped, not trusted", () => {
    expect(resolveEmbeddingWorkerRestartPolicy().maxRestarts).toBe(2);
    expect(
      resolveEmbeddingWorkerRestartPolicy({ maxRestarts: -3 }).maxRestarts,
    ).toBe(0);
    expect(
      resolveEmbeddingWorkerRestartPolicy({ baseDelayMs: 0 }).baseDelayMs,
    ).toBe(1);
  });

  test("watchdog schedules one bounded restart per failure, then stops", async () => {
    const watchdog = new EmbeddingWorkerWatchdog({
      restart: { maxRestarts: 2, baseDelayMs: 5, maxDelayMs: 10 },
    });
    const events: number[] = [];
    watchdog.onRestart((event) => events.push(event.attempt));
    let restarts = 0;
    const failure = classifyEmbeddingWorkerFailure("exited", {
      code: 9,
      signal: null,
    });
    watchdog.noteSpawn();
    const first = watchdog.reportFailure(failure, new Error("crash"), () => {
      restarts += 1;
    });
    expect(first?.attempt).toBe(1);
    expect(first?.canRetry).toBe(true);
    expect(watchdog.restartScheduled).toBe(true);
    // A second report while the timer is pending must not double-schedule.
    watchdog.reportFailure(failure, new Error("crash again"), () => {
      restarts += 1;
    });
    expect(events).toEqual([1]);
    await sleep(20);
    expect(restarts).toBe(1);
    expect(watchdog.restartScheduled).toBe(false);

    watchdog.noteSpawn();
    const second = watchdog.reportFailure(failure, new Error("crash"), () => {
      restarts += 1;
    });
    expect(second?.attempt).toBe(2);
    expect(second?.canRetry).toBe(false);
    await sleep(20);
    expect(restarts).toBe(2);

    watchdog.noteSpawn();
    expect(watchdog.restartCount).toBe(2);
    expect(watchdog.canRetry).toBe(false);
    expect(
      watchdog.reportFailure(failure, new Error("crash"), () => {
        restarts += 1;
      }),
    ).toBeNull();
    await sleep(20);
    expect(restarts).toBe(2);
    watchdog.dispose();
  });

  test("cancel clears a pending restart; disabled policy never schedules", async () => {
    const watchdog = new EmbeddingWorkerWatchdog({
      restart: { maxRestarts: 2, baseDelayMs: 5, maxDelayMs: 10 },
    });
    let restarts = 0;
    const failure = classifyEmbeddingWorkerFailure("handshake-timeout");
    watchdog.noteSpawn();
    watchdog.reportFailure(failure, new Error("slow"), () => {
      restarts += 1;
    });
    watchdog.cancel();
    await sleep(20);
    expect(restarts).toBe(0);

    const disabled = new EmbeddingWorkerWatchdog({ restart: false });
    disabled.noteSpawn();
    expect(disabled.canRetry).toBe(false);
    expect(
      disabled.reportFailure(failure, new Error("slow"), () => {
        restarts += 1;
      }),
    ).toBeNull();
    await sleep(20);
    expect(restarts).toBe(0);
  });

  test("terminal failures never schedule a restart", async () => {
    const watchdog = new EmbeddingWorkerWatchdog({
      restart: { maxRestarts: 2, baseDelayMs: 5, maxDelayMs: 10 },
    });
    watchdog.noteSpawn();
    let restarts = 0;
    const terminal = classifyEmbeddingWorkerFailure("protocol");
    expect(
      watchdog.reportFailure(terminal, new Error("desync"), () => {
        restarts += 1;
      }),
    ).toBeNull();
    await sleep(20);
    expect(restarts).toBe(0);
  });
});

describe("first-start timeout tiers", () => {
  test("defaults are wider for a cold first start", () => {
    const cold = resolveEmbeddingWorkerTimeoutTier({ firstStart: true });
    const warm = resolveEmbeddingWorkerTimeoutTier({ firstStart: false });
    expect(cold.firstStart).toBe(true);
    expect(cold.handshakeTimeoutMs).toBeGreaterThan(warm.handshakeTimeoutMs);
    expect(cold.initTimeoutMs).toBeGreaterThan(warm.initTimeoutMs);
    expect(warm.handshakeTimeoutMs).toBe(15_000);
    expect(warm.initTimeoutMs).toBe(120_000);
  });

  test("explicit steady overrides apply to both tiers", () => {
    const cold = resolveEmbeddingWorkerTimeoutTier({
      firstStart: true,
      handshakeTimeoutMs: 1_234,
      initTimeoutMs: 5_678,
    });
    expect(cold.handshakeTimeoutMs).toBe(1_234);
    expect(cold.initTimeoutMs).toBe(5_678);
  });

  test("explicit first-start overrides win only for the cold tier", () => {
    const cold = resolveEmbeddingWorkerTimeoutTier({
      firstStart: true,
      firstStartHandshakeTimeoutMs: 999,
      firstStartInitTimeoutMs: 1_999,
    });
    expect(cold.handshakeTimeoutMs).toBe(999);
    expect(cold.initTimeoutMs).toBe(1_999);
    const warm = resolveEmbeddingWorkerTimeoutTier({ firstStart: false });
    expect(warm.firstStart).toBe(false);
  });
});
