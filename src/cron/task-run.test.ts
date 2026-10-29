/**
 * M2 policy tests: command whitelist, permission tiers, unattended approvals,
 * and the wait / timeout / cancel envelope (M-8, M-13).
 *
 * No backend, no child process, no scheduler: the host port and the command
 * seams are injected, which is the whole point of `runScheduledTaskWithHost`.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PERMISSION_TIER,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_WAIT_MINUTES,
  type RunOutcome,
  type ScheduleTaskV2,
} from "@/cron/cron-types";
import {
  FAIL_CLOSED_PERMISSION_TIER,
  isAllowedScheduledCommand,
  isTaskPermissionTier,
  parseScheduledCommand,
  permissionModeForTier,
  resolveTaskPermissionTier,
  resolveUnattendedApproval,
  runScheduledTask,
  runScheduledTaskWithHost,
  type ScheduledReflectionTerminal,
  type ScheduledTaskHostPort,
  TASK_COMMAND_WHITELIST,
} from "@/cron/task-run";

function task(overrides: Partial<ScheduleTaskV2> = {}): ScheduleTaskV2 {
  const base: ScheduleTaskV2 = {
    id: "task1",
    agentId: "agent-1",
    name: "Nightly",
    description: "",
    type: "prompt",
    target: { kind: "existing", conversation_id: "conv-1" },
    payload: "hello",
    cron: "0 3 * * *",
    timezone: "UTC",
    recurring: true,
    scheduledFor: null,
    catchUp: false,
    permission: DEFAULT_PERMISSION_TIER,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    waitMinutes: DEFAULT_WAIT_MINUTES,
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
  };
  return { ...base, ...overrides };
}

function busyHost(overrides: Partial<ScheduledTaskHostPort> = {}): {
  host: ScheduledTaskHostPort;
  calls: { busyChecks: number; prompts: number };
} {
  const calls = { busyChecks: 0, prompts: 0 };
  const host: ScheduledTaskHostPort = {
    isTargetBusy: () => {
      calls.busyChecks += 1;
      return false;
    },
    runPrompt: async () => {
      calls.prompts += 1;
      return { outcome: "success", conversationId: "conv-1" };
    },
    ...overrides,
  };
  return { host, calls };
}

function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

// ── M-13: command whitelist ─────────────────────────────────────────

describe("scheduled command whitelist", () => {
  test("only compact and reflect are allowed", () => {
    expect([...TASK_COMMAND_WHITELIST].sort()).toEqual(["compact", "reflect"]);
    expect(isAllowedScheduledCommand("/compact")).toBe(true);
    expect(isAllowedScheduledCommand("/reflect")).toBe(true);
    expect(isAllowedScheduledCommand("compact")).toBe(true);
    expect(isAllowedScheduledCommand("/clear")).toBe(false);
    expect(isAllowedScheduledCommand("/compact-all")).toBe(false);
    expect(isAllowedScheduledCommand("")).toBe(false);
    expect(isAllowedScheduledCommand("   ")).toBe(false);
  });

  test("/compact 3 passes its argument through verbatim", () => {
    expect(parseScheduledCommand("/compact 3")).toEqual({
      name: "compact",
      args: "3",
    });
    expect(isAllowedScheduledCommand("/compact 3")).toBe(true);
    expect(parseScheduledCommand("/reflect --full")).toEqual({
      name: "reflect",
      args: "--full",
    });
  });

  test("a payload without a command name is rejected", () => {
    expect(parseScheduledCommand("/")).toBeNull();
    expect(parseScheduledCommand("3")).toBeNull();
    expect(parseScheduledCommand("/ compact")).toBeNull();
  });
});

// ── M-8: permissions ────────────────────────────────────────────────

describe("scheduled permission tiers (M-8)", () => {
  test("each tier maps onto exactly one existing permission mode", () => {
    expect(permissionModeForTier("standard")).toBe("standard");
    expect(permissionModeForTier("acceptEdits")).toBe("acceptEdits");
    expect(permissionModeForTier("unrestricted")).toBe("unrestricted");
  });

  test("strict is not a selectable tier", () => {
    expect(isTaskPermissionTier("strict")).toBe(false);
    expect(isTaskPermissionTier("standard")).toBe(true);
    expect(isTaskPermissionTier(undefined)).toBe(false);
    expect(() => permissionModeForTier("strict" as never)).toThrow();
  });

  test("an unreadable stored tier fails closed to standard (F13)", () => {
    // Creation default is `unrestricted`, but a record that cannot be parsed
    // must not run at the most permissive tier.
    expect(FAIL_CLOSED_PERMISSION_TIER).toBe("standard");
    expect(
      resolveTaskPermissionTier(task({ permission: undefined as never })),
    ).toBe("standard");
    expect(
      resolveTaskPermissionTier(task({ permission: "strict" as never })),
    ).toBe("standard");
    expect(resolveTaskPermissionTier(task({ permission: "acceptEdits" }))).toBe(
      "acceptEdits",
    );
    expect(
      resolveTaskPermissionTier(task({ permission: "unrestricted" })),
    ).toBe("unrestricted");
  });

  test("any ask is denied with the unattended reason (Q-51)", () => {
    expect(resolveUnattendedApproval("ask")).toEqual({
      decision: "deny",
      reason: "unattended",
    });
    expect(resolveUnattendedApproval("alwaysAsk")).toEqual({
      decision: "deny",
      reason: "unattended",
    });
    expect(resolveUnattendedApproval("allow")).toEqual({ decision: "allow" });
    expect(resolveUnattendedApproval("deny")).toEqual({ decision: "deny" });
  });
});

// ── Command execution ───────────────────────────────────────────────

describe("command tasks", () => {
  test("a prompt task is refused by the command body", async () => {
    const result = await runScheduledTask({
      task: task({ type: "prompt" }),
      runId: "run-1",
      signal: neverAborts(),
    });
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("host runner");
  });

  test("a non-whitelisted command is an F1 preflight failure", async () => {
    let compactCalls = 0;
    const attempt = runScheduledTask(
      {
        task: task({ type: "command", payload: "/clear" }),
        runId: "run-1",
        signal: neverAborts(),
      },
      {
        resolveLocalBackend: () => {
          compactCalls += 1;
          return null;
        },
      },
    );
    await expect(attempt).rejects.toMatchObject({
      name: "ScheduledTaskPreflightError",
    });
    await expect(attempt).rejects.toThrow("not allowed");
    expect(compactCalls).toBe(0);
  });

  test("a command task without an existing conversation is F1", async () => {
    const attempt = runScheduledTask(
      {
        task: task({
          type: "command",
          payload: "/compact",
          target: { kind: "new", hidden: false },
        }),
        runId: "run-1",
        signal: neverAborts(),
      },
      {},
    );
    await expect(attempt).rejects.toMatchObject({
      name: "ScheduledTaskPreflightError",
    });
    await expect(attempt).rejects.toThrow("existing target conversation");
  });

  test("compact without a local backend is F1, not a silent skip", async () => {
    const attempt = runScheduledTask(
      {
        task: task({ type: "command", payload: "/compact 3" }),
        runId: "run-1",
        signal: neverAborts(),
      },
      { resolveLocalBackend: () => null },
    );
    await expect(attempt).rejects.toMatchObject({
      name: "ScheduledTaskPreflightError",
    });
    await expect(attempt).rejects.toThrow("local backend");
  });

  test("reflect hands the task's tier to the launcher (C-17)", async () => {
    const launches: Array<{ permissionMode?: string }> = [];
    const result = await runScheduledTask(
      {
        task: task({
          type: "command",
          payload: "/reflect",
          permission: "acceptEdits",
        }),
        runId: "run-1",
        signal: neverAborts(),
      },
      {
        isMemfsEnabled: () => true,
        launchReflection: (async (options: { permissionMode?: string }) => {
          launches.push(options);
          return { launched: true, runId: "run-1" };
        }) as never,
      },
    );
    expect(result.outcome).toBe("success");
    expect(launches).toHaveLength(1);
    // `scheduled` is the trigger; the mode is the task's, not `unrestricted`.
    expect(launches[0]?.permissionMode).toBe("acceptEdits");
  });
  test("a cancelled compact writes a cancelled ledger row (F11)", async () => {
    const controller = new AbortController();
    const outcomes: string[] = [];
    const result = await runScheduledTask(
      {
        task: task({ type: "command", payload: "/compact" }),
        runId: "run-cancel-compact",
        signal: controller.signal,
      },
      {
        resolveLocalBackend: () =>
          ({
            listTopics: () => ({ blocks: [] }),
            prepareCompaction: async () => {
              controller.abort();
              throw new Error("provider aborted");
            },
            applyCompaction: async () => {
              throw new Error("unreachable");
            },
          }) as never,
        appendUsage: async (record) => {
          outcomes.push(String((record as { outcome?: unknown }).outcome));
          return true;
        },
      },
    );
    expect(result.outcome).toBe("cancelled");
    // One outcome for both the row and the run result.
    expect(outcomes).toEqual(["cancelled"]);
  });
});

// ── F7: reflect waits for the subprocess terminal state ─────────────

describe("scheduled reflect terminal state", () => {
  function reflectContext(
    wait: (input: {
      runId: string;
      signal: AbortSignal;
    }) => Promise<ScheduledReflectionTerminal>,
  ) {
    return {
      isMemfsEnabled: () => true,
      launchReflection: (async () => ({
        launched: true,
        runId: "reflection-run-1",
      })) as never,
      waitForReflectionTerminal: wait,
    };
  }

  test("a failed child makes the run failed, not a spawn-time success", async () => {
    const result = await runScheduledTask(
      {
        task: task({ type: "command", payload: "/reflect" }),
        runId: "run-reflect-failed",
        signal: neverAborts(),
      },
      reflectContext(async () => "failed"),
    );
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("reflection");
  });

  test("the run stays pending until the child reaches a terminal state", async () => {
    let release: (terminal: ScheduledReflectionTerminal) => void = () => {};
    const attempt = runScheduledTask(
      {
        task: task({ type: "command", payload: "/reflect" }),
        runId: "run-reflect-pending",
        signal: neverAborts(),
      },
      reflectContext(
        () =>
          new Promise<ScheduledReflectionTerminal>((resolve) => {
            release = resolve;
          }),
      ),
    );
    let settled = false;
    void attempt.then(() => {
      settled = true;
    });
    // Let the launcher's promise and the wait subscription land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release("succeeded");
    await expect(attempt).resolves.toMatchObject({ outcome: "success" });
  });

  test("a timed-out child is a timeout", async () => {
    const result = await runScheduledTask(
      {
        task: task({ type: "command", payload: "/reflect" }),
        runId: "run-reflect-timeout",
        signal: neverAborts(),
      },
      reflectContext(async () => "timeout"),
    );
    expect(result.outcome).toBe("timeout");
  });

  test("an unknown run is the registered degradation (launch reported)", async () => {
    const result = await runScheduledTask(
      {
        task: task({ type: "command", payload: "/reflect" }),
        runId: "run-reflect-unknown",
        signal: neverAborts(),
      },
      reflectContext(async () => "unknown"),
    );
    expect(result.outcome).toBe("success");
  });
});

// ── Wait / timeout / cancel ─────────────────────────────────────────

describe("run envelope", () => {
  test("waits while the target is busy, then runs once", async () => {
    let busy = 2;
    const sleeps: number[] = [];
    const { host, calls } = busyHost({
      isTargetBusy: () => {
        busy -= 1;
        return busy >= 0;
      },
    });
    const result = await runScheduledTaskWithHost({
      task: task({ waitMinutes: 10 }),
      runId: "run-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: neverAborts(),
      host,
      now: () => 0,
      pollIntervalMs: 30_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.outcome).toBe("success");
    expect(calls.prompts).toBe(1);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === 30_000)).toBe(true);
  });

  test("a busy target past wait_minutes is skipped (F3), not failed", async () => {
    let clock = 0;
    const { host, calls } = busyHost({ isTargetBusy: () => true });
    const result = await runScheduledTaskWithHost({
      task: task({ waitMinutes: 1 }),
      runId: "run-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: neverAborts(),
      host,
      now: () => clock,
      pollIntervalMs: 30_000,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result.outcome).toBe("skipped");
    expect(result.error).toContain("busy");
    expect(calls.prompts).toBe(0);
  });

  test("a run over timeout_minutes times out", async () => {
    const { host } = busyHost({
      runPrompt: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ outcome: "failed" as RunOutcome }),
          );
        }),
    });
    const result = await runScheduledTaskWithHost({
      task: task({ timeoutMinutes: 0.001 }),
      runId: "run-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: neverAborts(),
      host,
      pollIntervalMs: 1,
    });
    expect(result.outcome).toBe("timeout");
  });

  test("timeout_minutes 0 means unlimited: no timer is scheduled", async () => {
    // A 0 that reached `setTimeout` would fire on the next tick and abort.
    const result = await runScheduledTaskWithHost({
      task: task({ timeoutMinutes: 0 }),
      runId: "run-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: neverAborts(),
      host: busyHost().host,
      pollIntervalMs: 1,
    });
    expect(result.outcome).toBe("success");
  });

  test("cancelling the outer signal reports cancelled", async () => {
    const controller = new AbortController();
    const { host } = busyHost({
      runPrompt: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ outcome: "cancelled" as RunOutcome }),
          );
        }),
    });
    const pending = runScheduledTaskWithHost({
      task: task(),
      runId: "run-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: controller.signal,
      host,
      pollIntervalMs: 1,
    });
    controller.abort();
    expect((await pending).outcome).toBe("cancelled");
  });

  test("an already-aborted signal never starts the run", async () => {
    const controller = new AbortController();
    controller.abort();
    const { host, calls } = busyHost();
    const result = await runScheduledTaskWithHost({
      task: task(),
      runId: "run-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: controller.signal,
      host,
    });
    expect(result.outcome).toBe("cancelled");
    expect(calls.prompts).toBe(0);
  });

  test("command tasks skip the wait and go straight to the body", async () => {
    const { host, calls } = busyHost({ isTargetBusy: () => true });
    const attempt = runScheduledTaskWithHost({
      task: task({ type: "command", payload: "/clear" }),
      runId: "run-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: neverAborts(),
      host,
    });
    // The whitelist refusal now surfaces as the F1 typed error, not a string.
    await expect(attempt).rejects.toMatchObject({
      name: "ScheduledTaskPreflightError",
    });
    expect(calls.busyChecks).toBe(0);
    expect(calls.prompts).toBe(0);
  });

  test("the host's own outcome is preserved", async () => {
    const { host } = busyHost({
      runPrompt: async () => ({ outcome: "skipped", error: "no work" }),
    });
    const result = await runScheduledTaskWithHost({
      task: task(),
      runId: "run-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: neverAborts(),
      host,
    });
    expect(result.outcome).toBe("skipped");
    expect(result.error).toBe("no work");
  });

  test("a command task times out under timeout_minutes (F3/P1-4)", async () => {
    let bodyAborted = false;
    const result = await runScheduledTaskWithHost({
      task: task({
        type: "command",
        payload: "/reflect",
        timeoutMinutes: 0.001, // 60ms
      }),
      runId: "run-command-timeout",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: neverAborts(),
      host: busyHost().host,
      commandContext: {
        isMemfsEnabled: () => true,
        launchReflection: (async () => ({
          launched: true,
          runId: "reflection-run-1",
        })) as never,
        waitForReflectionTerminal: ({ signal: bodySignal }) => {
          if (bodySignal.aborted) {
            bodyAborted = true;
            return Promise.resolve<ScheduledReflectionTerminal>("cancelled");
          }
          return new Promise<ScheduledReflectionTerminal>((resolve) => {
            bodySignal.addEventListener(
              "abort",
              () => {
                bodyAborted = true;
                resolve("cancelled");
              },
              { once: true },
            );
          });
        },
      },
    });
    expect(result.outcome).toBe("timeout");
    expect(bodyAborted).toBe(true);
  });

  test("cancelling the outer signal aborts a command body (F3/P1-4)", async () => {
    const controller = new AbortController();
    let bodyAborted = false;
    const pending = runScheduledTaskWithHost({
      task: task({ type: "command", payload: "/reflect", timeoutMinutes: 0 }),
      runId: "run-command-cancel",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: controller.signal,
      host: busyHost().host,
      commandContext: {
        isMemfsEnabled: () => true,
        launchReflection: (async () => ({
          launched: true,
          runId: "reflection-run-1",
        })) as never,
        waitForReflectionTerminal: ({ signal: bodySignal }) => {
          if (bodySignal.aborted) {
            bodyAborted = true;
            return Promise.resolve<ScheduledReflectionTerminal>("cancelled");
          }
          return new Promise<ScheduledReflectionTerminal>((resolve) => {
            bodySignal.addEventListener(
              "abort",
              () => {
                bodyAborted = true;
                resolve("cancelled");
              },
              { once: true },
            );
          });
        },
      },
    });
    controller.abort();
    expect((await pending).outcome).toBe("cancelled");
    expect(bodyAborted).toBe(true);
  });
});
