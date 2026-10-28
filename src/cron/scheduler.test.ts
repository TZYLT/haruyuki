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

test("unleased scoped retry clears jitter timers and does not fire", () => {
  let heartbeat: (() => void) | undefined;
  let jitterFire: (() => void) | undefined;
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let clearedJitter = false;

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
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    if (Number(args[1] ?? 0) === 30_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        jitterFire = handler as () => void;
      }
    }
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((
    handle: Parameters<typeof realClearTimeout>[0],
  ) => {
    if (jitterFire) clearedJitter = true;
    realClearTimeout(handle);
  }) as typeof clearTimeout;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const { task } = addTask(
    makeInput({
      agent_id: "agent-local-jitter",
      cron: "* * * * *",
    }),
  );
  updateTask(task.id, (t) => {
    t.jitter_offset_ms = 30_000;
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
    expect(jitterFire).toBeTypeOf("function");
    expect(getTask(task.id)?.last_run_outcome).toBeNull();

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

    jitterFire?.();
    expect(getTask(task.id)?.last_run_outcome).toBeNull();
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

test("jitter fire logs lock errors without terminating the listener", () => {
  let jitterFire: (() => void) | undefined;
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
    if (Number(args[1] ?? 0) === 30_000 && typeof args[0] === "function") {
      jitterFire = args[0] as () => void;
    }
    return handle;
  }) as typeof setTimeout;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const { task } = addTask(
    makeInput({ agent_id: "agent-local-jitter-lock", cron: "* * * * *" }),
  );
  updateTask(task.id, (t) => {
    t.jitter_offset_ms = 30_000;
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
    expect(jitterFire).toBeTypeOf("function");
    __testThrowNextRefreshSchedulerLease();
    jitterFire?.();
    expect(isSchedulerRunning()).toBe(true);
    expect(
      logged.some((line) =>
        line.includes(
          "Jitter fire lease check error: Failed to acquire crons.lock",
        ),
      ),
    ).toBe(true);
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
