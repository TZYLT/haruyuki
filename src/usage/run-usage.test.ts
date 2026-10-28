/**
 * F-05 ledger pieces: aggregation by run id (R-5.14.2) and the
 * "this turn was scheduler-initiated" context (Q-55).
 *
 * Pure data tests: no ledger file is written here.
 */

import { describe, expect, test } from "bun:test";
import { aggregateUsageByRunId, type UsageRecord } from "@/usage/ledger";
import {
  __testResetScheduledRunContext,
  __testScheduledRunWaiterCount,
  awaitScheduledRunTurn,
  clearScheduledRunContext,
  consumeScheduledRunContext,
  peekScheduledRunContext,
  setScheduledRunContext,
} from "@/usage/scheduled-run-context";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    tsHour: "2026-10-28T03",
    agentId: "agent-1",
    model: "model-x",
    prompt: 100,
    cachedInput: 0,
    cacheWrite: 0,
    completion: 10,
    reasoning: 0,
    steps: 1,
    wallMs: 1000,
    apiMs: 900,
    source: "cron",
    outcome: "completed",
    ...overrides,
  };
}

describe("aggregateUsageByRunId", () => {
  test("buckets rows by run id and sums them", () => {
    const buckets = aggregateUsageByRunId([
      record({ runId: "run-a", prompt: 100, completion: 10 }),
      record({ runId: "run-a", prompt: 50, completion: 5 }),
      record({ runId: "run-b", prompt: 7, completion: 1 }),
    ]);

    expect(buckets.get("run-a")?.turns).toBe(2);
    expect(buckets.get("run-a")?.prompt).toBe(150);
    expect(buckets.get("run-a")?.completion).toBe(15);
    expect(buckets.get("run-b")?.prompt).toBe(7);
  });

  test("rows without a run id belong to no run", () => {
    const buckets = aggregateUsageByRunId([
      record({ source: "interactive" }),
      record({ runId: "run-a" }),
    ]);
    expect([...buckets.keys()]).toEqual(["run-a"]);
  });

  test("a requested run with no rows is an empty bucket, not a missing one", () => {
    const buckets = aggregateUsageByRunId(
      [record({ runId: "run-a" })],
      ["run-a", "run-missing"],
    );
    // `turns === 0` is how the panel tells "no ledger row" (render `—`) from
    // "a run that spent nothing" (render `0`).
    expect(buckets.get("run-missing")).toBeDefined();
    expect(buckets.get("run-missing")?.turns).toBe(0);
    expect(buckets.get("run-a")?.turns).toBe(1);
  });

  test("no requested ids still aggregates every tagged row", () => {
    const buckets = aggregateUsageByRunId([
      record({ runId: "run-a" }),
      record({ runId: "run-b" }),
    ]);
    expect([...buckets.keys()].sort()).toEqual(["run-a", "run-b"]);
  });
});

describe("scheduled run context", () => {
  test("is consumed exactly once", () => {
    clearScheduledRunContext();
    setScheduledRunContext({
      runId: "run-1",
      taskId: "task-1",
      source: "cron",
      conversationId: "conv-1",
    });

    expect(peekScheduledRunContext()?.runId).toBe("run-1");
    expect(consumeScheduledRunContext()?.runId).toBe("run-1");
    expect(consumeScheduledRunContext()).toBeNull();
  });

  test("a cleared context is not consumed", () => {
    setScheduledRunContext({ runId: "run-2", taskId: "t", source: "command" });
    clearScheduledRunContext();
    expect(consumeScheduledRunContext()).toBeNull();
  });

  test("the stored context is a copy", () => {
    const context = { runId: "run-3", taskId: "t", source: "cron" as const };
    setScheduledRunContext(context);
    context.runId = "mutated";
    expect(peekScheduledRunContext()?.runId).toBe("run-3");
    clearScheduledRunContext();
  });
});

describe("awaitScheduledRunTurn", () => {
  test("resolves with the outcome the writer consumed", async () => {
    const runId = "run-wait-1";
    setScheduledRunContext({ runId, taskId: "t", source: "cron" });
    const waiting = awaitScheduledRunTurn({
      runId,
      signal: new AbortController().signal,
    });

    consumeScheduledRunContext({ outcome: "failed" });

    expect(await waiting).toEqual({ outcome: "failed" });
    expect(__testScheduledRunWaiterCount()).toBe(0);
  });

  test("defaults to completed when the writer reports no outcome", async () => {
    const runId = "run-wait-2";
    setScheduledRunContext({ runId, taskId: "t", source: "cron" });
    const waiting = awaitScheduledRunTurn({
      runId,
      signal: new AbortController().signal,
    });
    consumeScheduledRunContext();
    expect(await waiting).toEqual({ outcome: "completed" });
  });

  test("clearing the context resolves the wait as cancelled", async () => {
    const runId = "run-wait-3";
    setScheduledRunContext({ runId, taskId: "t", source: "cron" });
    const waiting = awaitScheduledRunTurn({
      runId,
      signal: new AbortController().signal,
    });
    clearScheduledRunContext();
    expect(await waiting).toEqual({ outcome: "cancelled" });
    expect(__testScheduledRunWaiterCount()).toBe(0);
  });

  test("aborting the signal resolves the wait as cancelled", async () => {
    const runId = "run-wait-4";
    const controller = new AbortController();
    const waiting = awaitScheduledRunTurn({ runId, signal: controller.signal });
    expect(__testScheduledRunWaiterCount()).toBe(1);
    controller.abort();
    expect(await waiting).toEqual({ outcome: "cancelled" });
    expect(__testScheduledRunWaiterCount()).toBe(0);
  });

  test("an already-aborted signal never registers a waiter", () => {
    const controller = new AbortController();
    controller.abort();
    return expect(
      awaitScheduledRunTurn({ runId: "run-wait-5", signal: controller.signal }),
    ).resolves.toEqual({ outcome: "cancelled" });
  });

  test("settles each waiter once, even if the context is consumed twice", async () => {
    const runId = "run-wait-6";
    setScheduledRunContext({ runId, taskId: "t", source: "cron" });
    const signal = new AbortController().signal;
    const first = awaitScheduledRunTurn({ runId, signal });
    const second = awaitScheduledRunTurn({ runId, signal });
    expect(__testScheduledRunWaiterCount()).toBe(2);

    consumeScheduledRunContext({ outcome: "timeout" });
    consumeScheduledRunContext({ outcome: "failed" });

    expect(await first).toEqual({ outcome: "timeout" });
    expect(await second).toEqual({ outcome: "timeout" });
    expect(__testScheduledRunWaiterCount()).toBe(0);
  });

  test("__testReset drops every waiter", async () => {
    const signal = new AbortController().signal;
    const waiting = awaitScheduledRunTurn({ runId: "run-wait-7", signal });
    expect(__testScheduledRunWaiterCount()).toBe(1);

    __testResetScheduledRunContext();

    expect(__testScheduledRunWaiterCount()).toBe(0);
    expect(await waiting).toEqual({ outcome: "cancelled" });
  });
});
