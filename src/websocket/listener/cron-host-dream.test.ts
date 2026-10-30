/**
 * Listener host delegation for dream tasks (F-06 M1, route C-16).
 *
 * Before F-06 the listener ignored `deferredTaskIds` entirely. This file pins
 * the two halves that changed: the runner refuses to run a dream in-process
 * (`canRun === false`, so the core leaves the occurrence alone) and implements
 * the frozen `runDream` seam by spawning the short-lived `dream run --task`
 * child exactly once per occurrence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { ScheduleTaskV2 } from "@/cron/cron-types";
import { createListenerCronRunner } from "@/websocket/listener/cron-host";
import { LocalListenerTransport } from "@/websocket/listener/transport";
import type { StartListenerOptions } from "@/websocket/listener/types";

const TEST_DIR = path.join(import.meta.dir, "__cron_host_dream_test_tmp__");
const originalHome = process.env.HARUYUKI_HOME;

const opts: StartListenerOptions = {
  connectionId: "conn-dream-test",
  wsUrl: "wss://example.test/ws",
  deviceId: "device-dream-test",
  connectionName: "cron-host-dream-test",
  onConnected: () => {},
  onDisconnected: () => {},
  onError: () => {},
  onLog: () => {},
};

function task(overrides: Partial<ScheduleTaskV2> = {}): ScheduleTaskV2 {
  return {
    id: "dream01",
    agentId: "agent-1",
    name: "Dream",
    description: "",
    type: "dream",
    target: { kind: "new", hidden: true },
    payload: "",
    cron: "0 0 1 1 *",
    timezone: "UTC",
    recurring: true,
    scheduledFor: null,
    catchUp: false,
    permission: "acceptEdits",
    timeoutMinutes: 0,
    waitMinutes: 0,
    status: "active",
    pausedReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
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
    ...overrides,
  };
}

interface Spawned {
  taskId: string;
  exit: () => void;
}

function runnerWith(spawned: Spawned[]) {
  return createListenerCronRunner({
    transport: new LocalListenerTransport(),
    opts,
    processQueuedTurn: async () => {},
    activeRuntime: () => null,
    spawnDreamRun: (taskId, onExit) => {
      spawned.push({ taskId, exit: onExit });
      return { pid: 9001 };
    },
  });
}

function runDreamInput(dream: ScheduleTaskV2) {
  return {
    task: dream,
    runId: "run-dream-1",
    occurrence: "delegated:test",
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (originalHome) process.env.HARUYUKI_HOME = originalHome;
  else delete process.env.HARUYUKI_HOME;
});

describe("listener dream delegation", () => {
  test("canRun refuses dream tasks and keeps prompt tasks", () => {
    const runner = runnerWith([]);
    expect(runner.canRun?.(task())).toBe(false);
    expect(
      runner.canRun?.(
        task({ type: "prompt", target: { kind: "new", hidden: false } }),
      ),
    ).toBe(true);
  });

  test("runDream spawns one detached child and never runs in-process", async () => {
    const spawned: Spawned[] = [];
    const runner = runnerWith(spawned);
    const result = await runner.runDream?.(runDreamInput(task()));
    expect(result?.outcome).toBe("success");
    expect(spawned.map((entry) => entry.taskId)).toEqual(["dream01"]);
  });

  test("a live child blocks a second spawn for the same task", async () => {
    const spawned: Spawned[] = [];
    const runner = runnerWith(spawned);
    await runner.runDream?.(runDreamInput(task()));
    const second = await runner.runDream?.(runDreamInput(task()));
    expect(second?.outcome).toBe("skipped");
    expect(spawned).toHaveLength(1);
    // Only after the child exits may the next tick delegate again.
    spawned[0]?.exit();
    const third = await runner.runDream?.(runDreamInput(task()));
    expect(third?.outcome).toBe("success");
    expect(spawned).toHaveLength(2);
  });

  test("a spawn failure is reported, and does not keep the in-flight guard", async () => {
    const spawned: Spawned[] = [];
    const runner = createListenerCronRunner({
      transport: new LocalListenerTransport(),
      opts,
      processQueuedTurn: async () => {},
      activeRuntime: () => null,
      spawnDreamRun: (taskId, onExit) => {
        spawned.push({ taskId, exit: onExit });
        return spawned.length === 1 ? null : { pid: 1 };
      },
    });
    const first = await runner.runDream?.(runDreamInput(task()));
    expect(first?.outcome).toBe("failed");
    const retry = await runner.runDream?.(runDreamInput(task()));
    expect(retry?.outcome).toBe("success");
    expect(spawned).toHaveLength(2);
  });
});
