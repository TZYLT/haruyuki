/**
 * The scheduled-run context registry (F-05 M2 F5/F12).
 *
 * The TUI cannot tag a scheduled turn's ledger row from the runner's stack, so
 * the runner leaves a context here. These tests pin the two properties the
 * listener-side correlation also depends on: a context is **sharded by
 * conversation** (a second run, or a foreign turn, can no longer consume the
 * wrong one), and consuming reports the turn's outcome back to the writer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  __testResetScheduledRunContext,
  __testScheduledRunPendingCount,
  __testScheduledRunWaiterCount,
  awaitScheduledRunTurn,
  clearScheduledRunContext,
  consumeScheduledRunContext,
  peekScheduledRunContext,
  type ScheduledRunContext,
  setScheduledRunContext,
} from "@/usage/scheduled-run-context";

afterEach(() => {
  __testResetScheduledRunContext();
});

function context(
  overrides: Partial<ScheduledRunContext> = {},
): ScheduledRunContext {
  return {
    runId: "run-1",
    taskId: "task-1",
    source: "cron",
    agentId: "agent-1",
    conversationId: "conv-1",
    ...overrides,
  };
}

describe("scheduled run context sharding", () => {
  test("a consume scoped by conversation only takes that conversation's context", () => {
    setScheduledRunContext(
      context({ runId: "run-a", conversationId: "conv-a" }),
    );
    setScheduledRunContext(
      context({ runId: "run-b", conversationId: "conv-b" }),
    );

    const consumed = consumeScheduledRunContext({
      conversationId: "conv-b",
      outcome: "failed",
    });
    expect(consumed?.runId).toBe("run-b");
    expect(consumed?.outcome).toBe("failed");
    // The other conversation's run is untouched.
    expect(peekScheduledRunContext("conv-a")?.runId).toBe("run-a");
    expect(__testScheduledRunPendingCount()).toBe(1);
  });

  test("an unscoped consume abstains when several contexts are pending", () => {
    setScheduledRunContext(
      context({ runId: "run-a", conversationId: "conv-a" }),
    );
    setScheduledRunContext(
      context({ runId: "run-b", conversationId: "conv-b" }),
    );

    // Ambiguous: a user turn must not be tagged with someone else's run.
    expect(consumeScheduledRunContext()).toBeNull();
    expect(__testScheduledRunPendingCount()).toBe(2);
  });

  test("an unscoped consume takes the sole pending context", () => {
    setScheduledRunContext(context({ conversationId: undefined }));
    const consumed = consumeScheduledRunContext();
    expect(consumed?.runId).toBe("run-1");
    expect(consumed?.outcome).toBe("completed");
    expect(consumeScheduledRunContext()).toBeNull();
  });

  test("a second run on the same conversation replaces the pending context", () => {
    setScheduledRunContext(context({ runId: "run-old" }));
    setScheduledRunContext(context({ runId: "run-new" }));
    expect(__testScheduledRunPendingCount()).toBe(1);
    expect(
      consumeScheduledRunContext({ conversationId: "conv-1" })?.runId,
    ).toBe("run-new");
  });

  test("a scoped clear leaves other conversations alone", () => {
    setScheduledRunContext(
      context({ runId: "run-a", conversationId: "conv-a" }),
    );
    setScheduledRunContext(
      context({ runId: "run-b", conversationId: "conv-b" }),
    );
    clearScheduledRunContext("conv-a");
    expect(peekScheduledRunContext("conv-a")).toBeNull();
    expect(peekScheduledRunContext("conv-b")?.runId).toBe("run-b");
  });
});

describe("scheduled run context outcomes", () => {
  test("consuming reports the writer's outcome to the waiting runner", async () => {
    setScheduledRunContext(context({ runId: "run-x" }));
    const wait = awaitScheduledRunTurn({
      runId: "run-x",
      signal: new AbortController().signal,
    });
    consumeScheduledRunContext({ outcome: "cancelled" });
    expect(await wait).toEqual({ outcome: "cancelled" });
    expect(__testScheduledRunWaiterCount()).toBe(0);
  });

  test("clearing resolves that run's waiters as cancelled", async () => {
    setScheduledRunContext(context({ runId: "run-y" }));
    const wait = awaitScheduledRunTurn({
      runId: "run-y",
      signal: new AbortController().signal,
    });
    clearScheduledRunContext();
    expect(await wait).toEqual({ outcome: "cancelled" });
  });

  test("an aborted signal resolves the wait as cancelled", async () => {
    const controller = new AbortController();
    const wait = awaitScheduledRunTurn({
      runId: "run-z",
      signal: controller.signal,
    });
    controller.abort();
    expect(await wait).toEqual({ outcome: "cancelled" });
  });
});
