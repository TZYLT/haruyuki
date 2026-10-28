import { afterEach, describe, expect, test } from "bun:test";
import type { ScheduleEvent } from "@/cron/schedule-events";
import {
  clearScheduleEventSubscribers,
  emitScheduleEvent,
  scheduleEventSubscriberCount,
  subscribeScheduleEvents,
} from "@/cron/schedule-events";

function event(kind: ScheduleEvent["kind"] = "run-finished"): ScheduleEvent {
  return {
    kind,
    at: "2026-10-28T09:00:00.000Z",
    taskId: "task-1",
    taskName: "Morning briefing",
    agentId: "agent-1",
    runId: "run-1",
    outcome: "success",
  };
}

afterEach(() => {
  clearScheduleEventSubscribers();
});

describe("schedule event bus", () => {
  test("delivers to every current subscriber", () => {
    const seen: string[] = [];
    subscribeScheduleEvents((e) => seen.push(`a:${e.kind}`));
    subscribeScheduleEvents((e) => seen.push(`b:${e.kind}`));

    emitScheduleEvent(event("run-started"));
    emitScheduleEvent(event("run-finished"));

    expect(seen).toEqual([
      "a:run-started",
      "b:run-started",
      "a:run-finished",
      "b:run-finished",
    ]);
  });

  test("unsubscribe stops delivery and is idempotent", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeScheduleEvents((e) =>
      seen.push(e.runId ?? ""),
    );
    emitScheduleEvent(event());
    unsubscribe();
    unsubscribe();
    emitScheduleEvent(event());

    expect(seen).toEqual(["run-1"]);
    expect(scheduleEventSubscriberCount()).toBe(0);
  });

  test("a throwing listener does not starve the others", () => {
    const seen: string[] = [];
    subscribeScheduleEvents(() => {
      throw new Error("listener exploded");
    });
    subscribeScheduleEvents((e) => seen.push(e.taskId));

    expect(() => emitScheduleEvent(event())).not.toThrow();
    expect(seen).toEqual(["task-1"]);
  });

  test("clear drops every subscriber", () => {
    subscribeScheduleEvents(() => {});
    subscribeScheduleEvents(() => {});
    expect(scheduleEventSubscriberCount()).toBe(2);
    clearScheduleEventSubscribers();
    expect(scheduleEventSubscriberCount()).toBe(0);
  });

  test("emitting with no subscribers is a no-op", () => {
    expect(() => emitScheduleEvent(event("task-missed"))).not.toThrow();
  });
});
