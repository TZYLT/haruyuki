import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addTask, getTask, updateTask } from "@/cron/cron-file";
import {
  __testFailNextRefreshSchedulerLease,
  __testThrowNextRefreshSchedulerLease,
  claimSchedulerLease,
} from "@/cron/cron-lease";
import { readCronFile } from "@/cron/cron-store";
import type { AddTaskInput, CronTask } from "@/cron/cron-types";
import {
  CRON_SCHEDULER_SCOPE_ENV,
  isSchedulerRunning,
  setSchedulerTaskRunner,
  startScheduler,
  stopScheduler,
} from "@/cron/scheduler";
import type { ListenerTransport } from "@/websocket/listener/transport";
import type { StartListenerOptions } from "@/websocket/listener/types";

// ── Test setup ──────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__scheduler_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;
const origCronScope = process.env[CRON_SCHEDULER_SCOPE_ENV];
const origSandboxId = process.env.HARUYUKI_MANAGED_CLOUD_RUNTIME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  delete process.env[CRON_SCHEDULER_SCOPE_ENV];
  delete process.env.HARUYUKI_MANAGED_CLOUD_RUNTIME;
});

afterEach(() => {
  __testFailNextRefreshSchedulerLease(false);
  __testThrowNextRefreshSchedulerLease(false);
  stopScheduler();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
  if (origCronScope) process.env[CRON_SCHEDULER_SCOPE_ENV] = origCronScope;
  else delete process.env[CRON_SCHEDULER_SCOPE_ENV];
  if (origSandboxId) process.env.HARUYUKI_MANAGED_CLOUD_RUNTIME = origSandboxId;
});

test("routes scheduler lease failures through the listener logger", () => {
  writeFileSync(
    path.join(TEST_DIR, "schedules.json"),
    JSON.stringify({
      version: 1,
      scheduler_owner: {
        pid: process.ppid,
        token: "held-by-another-process",
        started_at: new Date().toISOString(),
      },
      tasks: [] satisfies CronTask[],
    }),
  );
  const logged: string[] = [];
  const onLog = mock((message: string) => {
    logged.push(message);
  });
  const opts: StartListenerOptions = {
    connectionId: "conn-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-test",
    connectionName: "listener-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
    onLog,
  };

  startScheduler({} as ListenerTransport, opts, async () => {}, 3);

  expect(onLog).toHaveBeenCalledTimes(2);
  expect(logged[0]).toContain(
    "[Cron] Failed to claim scheduler lease after 4 attempts",
  );
  expect(logged[1]).toBe(
    "[Cron] Another process may hold the lease. Restart Haruyuki to retry.",
  );
});

test("startScheduler does not arm intervals after the initial tick loses the lease", () => {
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    return handle;
  }) as typeof setInterval;

  try {
    __testFailNextRefreshSchedulerLease();
    const logged: string[] = [];
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-lease-loss",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-lease-loss",
        connectionName: "listener-lease-loss",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
        onLog: (message: string) => {
          logged.push(message);
        },
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(false);
    expect(armed).toHaveLength(0);
    expect(logged.some((line) => line.includes("Scheduler lease lost"))).toBe(
      true,
    );
  } finally {
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("scoped startScheduler heartbeats the mixed-version tombstone between fire ticks", () => {
  const delays: number[] = [];
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    delays.push(Number(args[1] ?? 0));
    return handle;
  }) as typeof setInterval;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-tombstone",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-tombstone",
        connectionName: "listener-tombstone",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    expect(delays).toEqual(expect.arrayContaining([1_000, 60_000]));
    expect(delays).toHaveLength(3);
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("tombstone heartbeat logs lock errors without treating them as lease loss", () => {
  let heartbeat: (() => void) | undefined;
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 1_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        heartbeat = handler as () => void;
      }
    }
    return handle;
  }) as typeof setInterval;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const logged: string[] = [];
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-heartbeat-lock",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-heartbeat-lock",
        connectionName: "listener-heartbeat-lock",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
        onLog: (message: string) => {
          logged.push(message);
        },
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    expect(heartbeat).toBeTypeOf("function");
    __testThrowNextRefreshSchedulerLease();
    heartbeat?.();

    expect(isSchedulerRunning()).toBe(true);
    expect(
      logged.some((line) =>
        line.includes(
          "Tombstone heartbeat error: Failed to acquire crons.lock",
        ),
      ),
    ).toBe(true);
    expect(logged.some((line) => line.includes("Scheduler lease lost"))).toBe(
      false,
    );
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("scoped heartbeat restores a stripped row beside the sibling tombstone", () => {
  let heartbeat: (() => void) | undefined;
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 1_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        heartbeat = handler as () => void;
      }
    }
    return handle;
  }) as typeof setInterval;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const cloudToken = claimSchedulerLease("cloud");
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-sibling-tombstone",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-sibling-tombstone",
        connectionName: "listener-sibling-tombstone",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    const before = readCronFile();
    expect(before.scheduler_owner?.token).toBe(cloudToken);
    writeFileSync(
      path.join(TEST_DIR, "schedules.json"),
      JSON.stringify({
        version: 1,
        scheduler_owner: before.scheduler_owner,
        tasks: [],
      }),
    );

    heartbeat?.();

    expect(isSchedulerRunning()).toBe(true);
    const after = readCronFile();
    expect(after.scheduler_owners.local).toEqual(
      expect.objectContaining({ pid: process.pid }),
    );
    expect(after.scheduler_owner?.token).toBe(cloudToken);
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("scoped heartbeat does not restore beside a live all-owner", () => {
  let heartbeat: (() => void) | undefined;
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 1_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        heartbeat = handler as () => void;
      }
    }
    return handle;
  }) as typeof setInterval;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const logged: string[] = [];
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-all-owner",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-all-owner",
        connectionName: "listener-all-owner",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
        onLog: (message: string) => {
          logged.push(message);
        },
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    writeFileSync(
      path.join(TEST_DIR, "schedules.json"),
      JSON.stringify({
        version: 1,
        scheduler_owner: {
          pid: process.pid,
          token: "legacy-all-owner",
          started_at: new Date().toISOString(),
        },
        tasks: [],
      }),
    );

    heartbeat?.();

    expect(isSchedulerRunning()).toBe(true);
    expect(readCronFile().scheduler_owners).toEqual({});
    expect(
      logged.some((line) => line.includes("Scheduler lease lost; retrying")),
    ).toBe(true);
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("a jitter-pending run arms a real delay timer, and losing the lease clears it", async () => {
  let heartbeat: (() => void) | undefined;
  const delays: Array<{ delay: number; handler: () => void }> = [];
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let clearedJitter = false;

  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 1_000 && typeof args[0] === "function") {
      heartbeat = args[0] as () => void;
    }
    return handle;
  }) as typeof setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    const delay = Number(args[1] ?? 0);
    if (typeof args[0] === "function" && delay > 0 && delay < 60_000) {
      delays.push({ delay, handler: args[0] as () => void });
    }
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((
    handle: Parameters<typeof realClearTimeout>[0],
  ) => {
    if (delays.length > 0) clearedJitter = true;
    realClearTimeout(handle);
  }) as typeof clearTimeout;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const { task } = addTask(
    makeInput({ agent_id: "agent-local-jitter", cron: "* * * * *" }),
  );
  updateTask(task.id, (t) => {
    // Just under one tick, so the jittered instant is always still ahead.
    t.jitter_offset_ms = 59_999;
    t.created_at = new Date(Date.now() - 3_600_000).toISOString();
  });
  const runs: string[] = [];
  setSchedulerTaskRunner({
    host: "long-lived",
    async run(input) {
      runs.push(input.task.id);
      return { outcome: "success" };
    },
    cancel() {},
  });

  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-jitter-unleased",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-jitter-unleased",
        connectionName: "listener-jitter-unleased",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && delays.length === 0) {
      await Bun.sleep(10);
    }
    expect(delays.length).toBeGreaterThan(0);
    expect(delays[0]?.delay).toBeLessThan(60_000);

    // A live all-scope owner appears: the scoped lease is lost, the pending
    // jitter timer is cleared, and firing it must not run the task.
    const current = readCronFile();
    writeFileSync(
      path.join(TEST_DIR, "schedules.json"),
      JSON.stringify({
        version: 1,
        scheduler_owner: {
          pid: process.pid,
          token: "legacy-all-owner",
          started_at: new Date().toISOString(),
        },
        tasks: current.tasks,
      }),
    );

    heartbeat?.();
    expect(isSchedulerRunning()).toBe(true);
    expect(clearedJitter).toBe(true);

    delays[0]?.handler();
    await Bun.sleep(20);
    expect(runs).toEqual([]);
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("a lock error on the jitter wake is logged without terminating the host", async () => {
  const delays: Array<() => void> = [];
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    const delay = Number(args[1] ?? 0);
    if (typeof args[0] === "function" && delay > 0 && delay < 60_000) {
      delays.push(args[0] as () => void);
    }
    return handle;
  }) as typeof setTimeout;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const { task } = addTask(
    makeInput({ agent_id: "agent-local-jitter-lock", cron: "* * * * *" }),
  );
  updateTask(task.id, (t) => {
    t.jitter_offset_ms = 59_999;
    t.created_at = new Date(Date.now() - 3_600_000).toISOString();
  });
  const runs: string[] = [];
  setSchedulerTaskRunner({
    host: "long-lived",
    async run() {
      runs.push("ran");
      return { outcome: "success" };
    },
    cancel() {},
  });
  const logged: string[] = [];
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-jitter-lock",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-jitter-lock",
        connectionName: "listener-jitter-lock",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
        onLog: (message: string) => {
          logged.push(message);
        },
      },
      async () => {},
    );
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && delays.length === 0) {
      await Bun.sleep(10);
    }
    expect(delays.length).toBeGreaterThan(0);

    __testThrowNextRefreshSchedulerLease();
    delays[0]?.();
    await Bun.sleep(20);

    expect(isSchedulerRunning()).toBe(true);
    expect(
      logged.some((line) =>
        line.includes("Lease check error: Failed to acquire crons.lock"),
      ),
    ).toBe(true);
    expect(runs).toEqual([]);
    expect(getTask(task.id)?.last_run_outcome).toBeNull();
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

// ── P1-7: overlapping ticks ─────────────────────────────────────────

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("a tick never overlaps a running one; the wake is queued and runs after", async () => {
  const armed: ReturnType<typeof setInterval>[] = [];
  const tickHandlers: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 60_000 && typeof args[0] === "function") {
      tickHandlers.push(args[0] as () => void);
    }
    return handle;
  }) as typeof setInterval;

  for (const [index, name] of ["First", "Second"].entries()) {
    const { task } = addTask(
      makeInput({
        name,
        agent_id: `agent-local-overlap-${index}`,
        cron: "* * * * *",
      }),
    );
    updateTask(task.id, (record) => {
      record.created_at = new Date(Date.now() - 3_600_000).toISOString();
      record.jitter_offset_ms = 0;
    });
  }

  const releases: Array<() => void> = [];
  let runs = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  setSchedulerTaskRunner({
    host: "long-lived",
    async run() {
      runs += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => releases.push(resolve));
      concurrent -= 1;
      return { outcome: "success" };
    },
    cancel() {},
  });

  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-overlap",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-overlap",
        connectionName: "listener-overlap",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );
    expect(isSchedulerRunning()).toBe(true);
    await waitFor(() => releases.length === 1);
    expect(tickHandlers.length).toBeGreaterThan(0);

    // Two wakes while the first run is still in flight: they must queue, not
    // start a second concurrent run.
    tickHandlers[0]?.();
    await Bun.sleep(20);
    tickHandlers[0]?.();
    await Bun.sleep(20);
    expect(runs).toBe(1);
    expect(maxConcurrent).toBe(1);

    releases[0]?.();
    await waitFor(() => releases.length === 2);
    expect(maxConcurrent).toBe(1);
    releases[1]?.();
    await Bun.sleep(30);
    expect(runs).toBe(2);
    expect(maxConcurrent).toBe(1);
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) clearInterval(handle);
  }
});

// ── M1 #13: tracked lease-retry timers ──────────────────────────────

test("stopScheduler cancels a pending lease retry and a stale callback stays dead", () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const retries: Array<() => void> = [];
  const cleared: unknown[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    if (Number(args[1] ?? 0) === 30_000 && typeof args[0] === "function") {
      retries.push(args[0] as () => void);
    }
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((
    handle: Parameters<typeof realClearTimeout>[0],
  ) => {
    cleared.push(handle);
    realClearTimeout(handle);
  }) as typeof clearTimeout;

  writeFileSync(
    path.join(TEST_DIR, "schedules.json"),
    JSON.stringify({
      version: 1,
      scheduler_owner: {
        pid: process.ppid,
        token: "held-by-another-process",
        started_at: new Date().toISOString(),
      },
      tasks: [] satisfies CronTask[],
    }),
  );

  try {
    startScheduler({} as ListenerTransport, {
      connectionId: "conn-retry",
      wsUrl: "wss://example.test/ws",
      deviceId: "device-retry",
      connectionName: "listener-retry",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    });
    expect(isSchedulerRunning()).toBe(false);
    expect(retries).toHaveLength(1);
    const retry = retries[0];
    expect(retry).toBeTypeOf("function");

    stopScheduler();
    expect(cleared.length).toBeGreaterThanOrEqual(1);

    // Even if the timer callback was already queued, it must not revive a
    // stopped host.
    retry?.();
    expect(isSchedulerRunning()).toBe(false);
    expect(retries).toHaveLength(1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

// ── Helper ──────────────────────────────────────────────────────────

function makeInput(overrides: Partial<AddTaskInput> = {}): AddTaskInput {
  return {
    agent_id: "agent-test-001",
    conversation_id: "default",
    name: "Test task",
    description: "A test cron task",
    prompt: "echo hello",
    cron: "*/5 * * * *",
    recurring: true,
    ...overrides,
  };
}
