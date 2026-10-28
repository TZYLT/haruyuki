/**
 * Listener host runner tests (M2): the two prompt targets, both command tasks,
 * the run id reaching the queue item, and the ledger/run-log terminal write.
 *
 * Everything effectful is a seam the factory already takes: a throwaway
 * `HARUYUKI_HOME`, an in-memory listener runtime, `LocalListenerTransport`, a
 * stand-in `processQueuedTurn` that emits the listener's own `turn_finished`,
 * and injected conversation/command impls. No real backend is contacted.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { ScheduleTaskV2 } from "@/cron/cron-types";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import type { DequeuedBatch } from "@/queue/queue-runtime";
import { readUsageLedger } from "@/usage/ledger";
import { createListenerCronRunner } from "@/websocket/listener/cron-host";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { setActiveRuntime } from "@/websocket/listener/runtime";
import { notifyStreamObservers } from "@/websocket/listener/stream-observers";
import { LocalListenerTransport } from "@/websocket/listener/transport";
import type {
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "@/websocket/listener/types";

const TEST_DIR = path.join(import.meta.dir, "__cron_host_test_tmp__");
const originalHome = process.env.HARUYUKI_HOME;
const originalDisableScheduler = process.env.HARUYUKI_DISABLE_CRON_SCHEDULER;

const opts: StartListenerOptions = {
  connectionId: "conn-test",
  wsUrl: "wss://example.test/ws",
  deviceId: "device-test",
  connectionName: "cron-host-test",
  onConnected: () => {},
  onDisconnected: () => {},
  onError: () => {},
  onLog: () => {},
};

function task(overrides: Partial<ScheduleTaskV2> = {}): ScheduleTaskV2 {
  return {
    id: "aaaa1111",
    agentId: "agent-1",
    name: "Nightly",
    description: "test",
    type: "prompt",
    target: { kind: "existing", conversation_id: "conv-1" },
    payload: "hello",
    cron: "0 3 * * *",
    timezone: "UTC",
    recurring: true,
    scheduledFor: null,
    catchUp: false,
    permission: "unrestricted",
    timeoutMinutes: 30,
    waitMinutes: 10,
    status: "active",
    pausedReason: null,
    createdAt: "2026-10-28T00:00:00.000Z",
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

/** A turn processor that reports the listener's real terminal event. */
function terminalTurn(
  listener: ListenerRuntime,
  stopReason = "end_turn",
  usage?: Record<string, number>,
) {
  return async (queuedTurn: IncomingMessage, _batch: DequeuedBatch) => {
    notifyStreamObservers(
      listener,
      {
        type: "turn_finished",
        turn_id: "turn-1",
        stop_reason: stopReason,
        ...(usage ? { usage } : {}),
      },
      {
        agent_id: queuedTurn.agentId,
        conversation_id: queuedTurn.conversationId,
      },
    );
  };
}

let listener: ListenerRuntime;
const transport = new LocalListenerTransport();

beforeAll(() => {
  process.env.HARUYUKI_DISABLE_CRON_SCHEDULER = "1";
});

afterAll(() => {
  if (originalHome) process.env.HARUYUKI_HOME = originalHome;
  else delete process.env.HARUYUKI_HOME;
  if (originalDisableScheduler) {
    process.env.HARUYUKI_DISABLE_CRON_SCHEDULER = originalDisableScheduler;
  } else {
    delete process.env.HARUYUKI_DISABLE_CRON_SCHEDULER;
  }
});

afterEach(() => {
  // Deleted here, not only in `afterAll`: the queue pump's chained promise can
  // still touch the store on a microtask after the last assertion.
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
  }
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  listener = createRuntime();
  setActiveRuntime(listener);
});

/**
 * One runner with every seam filled. `created` records conversations the runner
 * asked the backend for, so the `new` target's body is observable.
 */
function makeRunner(
  overrides: Partial<Parameters<typeof createListenerCronRunner>[0]> = {},
  terminal = terminalTurn(listener),
) {
  const created: unknown[] = [];
  const runner = createListenerCronRunner({
    transport,
    opts,
    processQueuedTurn: terminal,
    activeRuntime: () => listener,
    createConversation: async (body) => {
      created.push(body);
      return { id: "conv-new" };
    },
    now: () => Date.parse("2026-10-28T03:00:00.000Z"),
    pollIntervalMs: 5,
    ...overrides,
  });
  return { runner, created };
}

const signal = () => new AbortController().signal;

describe("listener cron runner: prompt tasks", () => {
  test("an existing target enqueues with the run id and finishes (M-13/C-19)", async () => {
    const seen: Array<{ runId?: string; conversationId?: string }> = [];
    const { runner, created } = makeRunner({
      processQueuedTurn: async (queuedTurn, batch) => {
        const item = batch.items[0];
        seen.push({
          runId: item && "runId" in item ? (item.runId as string) : undefined,
          conversationId: queuedTurn.conversationId,
        });
        await terminalTurn(listener)(queuedTurn, batch);
      },
    });

    const result = await runner.run({
      task: task(),
      runId: "run-42",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    expect(result.outcome).toBe("success");
    expect(result.conversationId).toBe("conv-1");
    expect(created).toHaveLength(0);
    expect(seen).toEqual([{ runId: "run-42", conversationId: "conv-1" }]);
  });

  test("a new target creates a visible conversation per run (Q-25)", async () => {
    const { runner, created } = makeRunner(
      { processQueuedTurn: terminalTurn(listener) },
      undefined,
    );
    const result = await runner.run({
      task: task({ target: { kind: "new", hidden: false } }),
      runId: "run-new",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    expect(result.outcome).toBe("success");
    expect(result.conversationId).toBe("conv-new");
    expect(created).toHaveLength(1);
    const body = created[0] as Record<string, unknown>;
    expect(body.agent_id).toBe("agent-1");
    expect(body.tags).toEqual(["origin:schedule"]);
    expect(body.hidden).toBeUndefined();
  });

  test("a hidden new target carries the hidden provenance", async () => {
    const { runner, created } = makeRunner({
      processQueuedTurn: terminalTurn(listener),
    });
    await runner.run({
      task: task({ target: { kind: "new", hidden: true } }),
      runId: "run-hidden",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    expect((created[0] as Record<string, unknown>).hidden).toBe(true);
  });

  test("usage from turn_finished becomes one ledger row keyed by runId", async () => {
    const { runner } = makeRunner({
      processQueuedTurn: terminalTurn(listener, "end_turn", {
        prompt_tokens: 120,
        completion_tokens: 40,
        total_tokens: 160,
        step_count: 3,
        cached_input_tokens: 20,
        cache_write_tokens: 0,
        reasoning_tokens: 5,
      }),
    });

    await runner.run({
      task: task(),
      runId: "run-ledger",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    const records = await readUsageLedger({ prune: false });
    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe("run-ledger");
    expect(records[0]?.source).toBe("cron");
    expect(records[0]?.outcome).toBe("completed");
    expect(records[0]?.sessionId).toBe("conv-1");
    expect(records[0]?.prompt).toBe(120);
    expect(records[0]?.steps).toBe(3);
  });

  test("a turn without usage still writes a row (accepted degradation)", async () => {
    const { runner } = makeRunner({
      processQueuedTurn: terminalTurn(listener),
    });
    await runner.run({
      task: task(),
      runId: "run-degraded",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    const records = await readUsageLedger({ prune: false });
    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe("run-degraded");
    expect(records[0]?.prompt).toBe(0);
    expect(records[0]?.steps).toBe(0);
  });

  test("a failed turn is a failed run, and the run log says so (G-4)", async () => {
    const { runner } = makeRunner({
      processQueuedTurn: terminalTurn(listener, "llm_api_error"),
    });
    const result = await runner.run({
      task: task(),
      runId: "run-failed",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    expect(result.outcome).toBe("failed");

    const entries = readCronRunLogEntries(getCronRunLogPath("aaaa1111"), {
      jobId: "aaaa1111",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("run-failed");
    expect(entries[0]?.runOutcome).toBe("failed");
    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.host).toBe("long-lived");
    expect(entries[0]?.status).toBe("error");
  });

  test("the permission state is restored after the run (Q-51)", async () => {
    const { runner } = makeRunner({
      processQueuedTurn: terminalTurn(listener),
    });
    const runtime =
      (
        listener as unknown as {
          permissionModeByConversation: Map<
            string,
            { mode: string; unattended?: boolean }
          >;
        }
      ).permissionModeByConversation ?? new Map();
    (
      listener as unknown as {
        permissionModeByConversation: Map<
          string,
          { mode: string; unattended?: boolean }
        >;
      }
    ).permissionModeByConversation = runtime;

    await runner.run({
      task: task({ permission: "standard" }),
      runId: "run-perm",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    for (const state of runtime.values()) {
      expect(state.unattended).toBeUndefined();
    }
  });

  test("an aborted run is cancelled and never enqueues", async () => {
    const { runner } = makeRunner();
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run({
      task: task(),
      runId: "run-cancel",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: controller.signal,
    });
    expect(result.outcome).toBe("cancelled");
    expect(listener.streamObservers?.size ?? 0).toBe(0);
  });
});

describe("listener cron runner: command tasks", () => {
  test("compact dispatches to the shared F-04 body and records one row", async () => {
    const { runner } = makeRunner({
      commandContext: {
        resolveLocalBackend: () =>
          ({
            listTopics: () => ({ blocks: [] }),
            prepareCompaction: async () => {
              throw new Error("prepare refused by the stand-in backend");
            },
            applyCompaction: async () => {
              throw new Error("unreachable");
            },
          }) as never,
      },
    });

    const result = await runner.run({
      task: task({ type: "command", payload: "/compact" }),
      runId: "run-compact",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("prepare refused");

    const records = await readUsageLedger({ prune: false });
    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("cron");
    expect(records[0]?.runId).toBe("run-compact");

    const entries = readCronRunLogEntries(getCronRunLogPath("aaaa1111"), {
      jobId: "aaaa1111",
    });
    expect(entries[0]?.runOutcome).toBe("failed");
  });

  test("reflect launches the shared launcher with the scheduled trigger", async () => {
    const launches: Array<{ triggerSource?: string; permissionMode?: string }> =
      [];
    const { runner } = makeRunner({
      commandContext: {
        isMemfsEnabled: () => true,
        launchReflection: (async (options: {
          triggerSource?: string;
          permissionMode?: string;
        }) => {
          launches.push(options);
          return { launched: true, runId: "run-reflect" };
        }) as never,
      },
    });

    const result = await runner.run({
      task: task({
        type: "command",
        payload: "/reflect",
        permission: "standard",
      }),
      runId: "run-reflect",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    expect(result.outcome).toBe("success");
    expect(launches).toHaveLength(1);
    expect(launches[0]?.triggerSource).toBe("scheduled");
    // C-17: the child gets the task's tier, not `unrestricted`.
    expect(launches[0]?.permissionMode).toBe("standard");

    // The reflection child owns its spend, so the host writes no ledger row.
    const records = await readUsageLedger({ prune: false });
    expect(records).toHaveLength(0);

    const entries = readCronRunLogEntries(getCronRunLogPath("aaaa1111"), {
      jobId: "aaaa1111",
    });
    expect(entries[0]?.runOutcome).toBe("success");
    expect(entries[0]?.status).toBe("ok");
  });
});

describe("listener cron runner: host + pre-start failures", () => {
  test("the run log records the deps host (short-lived tick)", async () => {
    const { runner } = makeRunner({
      host: "short-lived",
      processQueuedTurn: terminalTurn(listener),
    });
    const result = await runner.run({
      task: task(),
      runId: "run-short",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    expect(result.outcome).toBe("success");

    const entries = readCronRunLogEntries(getCronRunLogPath("aaaa1111"), {
      jobId: "aaaa1111",
    });
    expect(entries.at(-1)?.host).toBe("short-lived");
  });

  test("no active listener runtime is a thrown F1 preflight failure", async () => {
    const { runner } = makeRunner({ activeRuntime: () => null });
    await expect(
      runner.run({
        task: task(),
        runId: "run-no-runtime",
        occurrence: "2026-10-28T03:00:00.000Z",
        signal: signal(),
      }),
    ).rejects.toMatchObject({ name: "ScheduledTaskPreflightError" });
  });

  test("a conversation that cannot be created is F1, not F2", async () => {
    const { runner } = makeRunner({
      createConversation: async () => {
        throw new Error("no model configured");
      },
    });
    const attempt = runner.run({
      task: task({ target: { kind: "new", hidden: false } }),
      runId: "run-create-fail",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    await expect(attempt).rejects.toMatchObject({
      name: "ScheduledTaskPreflightError",
    });
    await expect(attempt).rejects.toThrow("no model configured");
  });
});
