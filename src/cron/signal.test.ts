import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  DueOccurrence,
  ScheduleTaskV2,
  SignalSource,
} from "@/cron/cron-types";
import {
  clearSignalSources,
  evaluateSignals,
  listSignalSources,
  nextSignalDueAt,
  registerSignalSource,
  unregisterSignalSource,
} from "@/cron/signal";

beforeEach(() => {
  // The registry is process-wide: another test file may have registered the
  // built-in source already (Bun shares one module instance across files).
  clearSignalSources();
});

afterEach(() => {
  clearSignalSources();
});

function source(
  id: string,
  occurrences: DueOccurrence[] = [],
  nextDue?: Date | null,
): SignalSource {
  return {
    id,
    evaluate: () => occurrences,
    nextDueAt: () => nextDue ?? null,
  };
}

const state = { cursor: {} };

describe("signal source registry", () => {
  test("a registered source is evaluated and its occurrences are returned", () => {
    registerSignalSource(
      source("test", [
        {
          taskId: "task-1",
          occurrence: "2026-10-28T14:00",
          intendedAt: "2026-10-28T14:00:00.000Z",
        },
      ]),
    );

    expect(listSignalSources()).toHaveLength(1);
    expect(evaluateSignals({ now: new Date(), tasks: [], state })).toEqual([
      {
        taskId: "task-1",
        occurrence: "2026-10-28T14:00",
        intendedAt: "2026-10-28T14:00:00.000Z",
      },
    ]);
  });

  test("the same id replaces instead of duplicating", () => {
    registerSignalSource(source("test"));
    registerSignalSource(source("test"));
    expect(listSignalSources()).toHaveLength(1);
  });

  test("unregister removes a source; every source may contribute occurrences", () => {
    registerSignalSource(
      source("a", [
        {
          taskId: "a",
          occurrence: "1",
          intendedAt: "2026-10-28T14:00:00.000Z",
        },
      ]),
    );
    registerSignalSource(
      source("b", [
        {
          taskId: "b",
          occurrence: "2",
          intendedAt: "2026-10-28T14:01:00.000Z",
        },
      ]),
    );
    expect(evaluateSignals({ now: new Date(), tasks: [], state })).toHaveLength(
      2,
    );

    unregisterSignalSource("a");
    const remaining = evaluateSignals({ now: new Date(), tasks: [], state });
    expect(remaining.map((item) => item.taskId)).toEqual(["b"]);
  });

  test("nextSignalDueAt keeps the earliest time across sources", () => {
    registerSignalSource(
      source("late", [], new Date("2026-10-28T16:00:00.000Z")),
    );
    registerSignalSource(
      source("early", [], new Date("2026-10-28T15:00:00.000Z")),
    );
    registerSignalSource(source("never", [], null));

    expect(
      nextSignalDueAt({ now: new Date("2026-10-28T14:00:00.000Z"), tasks: [] }),
    ).toEqual(new Date("2026-10-28T15:00:00.000Z"));
  });

  test("with no sources there is nothing due", () => {
    expect(evaluateSignals({ now: new Date(), tasks: [], state })).toEqual([]);
    expect(nextSignalDueAt({ now: new Date(), tasks: [] })).toBeNull();
  });
});

describe("M-1: signal sources are pluggable, the core has no feature special case", () => {
  const CORE_FILES = [
    "signal.ts",
    "cron-signal.ts",
    "scheduler-core.ts",
    "preflight.ts",
  ];

  test("no core source mentions a concrete feature signal", () => {
    for (const file of CORE_FILES) {
      const sourceText = readFileSync(
        path.join(import.meta.dir, file),
        "utf-8",
      ).toLowerCase();
      expect({ file, dream: sourceText.includes("dream") }).toEqual({
        file,
        dream: false,
      });
      expect({ file, reflection: sourceText.includes("reflection") }).toEqual({
        file,
        reflection: false,
      });
    }
  });

  test("a new source needs no change to the core", () => {
    const tasks = [{ id: "task-9" }] as ScheduleTaskV2[];
    registerSignalSource(
      source("threshold-like", [
        {
          taskId: "task-9",
          occurrence: "threshold:12000",
          intendedAt: "2026-10-28T14:00:00.000Z",
        },
      ]),
    );
    expect(
      evaluateSignals({ now: new Date(), tasks, state }).map(
        (item) => item.taskId,
      ),
    ).toEqual(["task-9"]);
  });
});
