/**
 * F-06 M2 review follow-up · stale `/dream run --budget` cleanup.
 *
 * A crash can leave the one-run budget override on the task record, where every
 * later automatic run would inherit it. Crash recovery clears it through
 * `clearDreamBudgetOverride`; this test drives the real schedule store in a
 * throwaway `HARUYUKI_HOME` so the payload codec and the record write are both
 * covered.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDreamBudgetOverride } from "@/agent/dream/dream-budget-override";
import { emptyScheduleFile, getScheduleTask, writeScheduleFile } from "@/cron";
import type { CronTask } from "@/cron/cron-types";
import { serializeDreamTaskPayload } from "@/cron/dream-task";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;
const root = mkdtempSync(join(tmpdir(), "hryk-dream-override-"));
process.env.HARUYUKI_HOME = root;

afterAll(() => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  rmSync(root, { recursive: true, force: true });
});

const TASK_ID = "dream-task-1";

function dreamTaskRecord(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: TASK_ID,
    agent_id: "agent-a",
    conversation_id: "new",
    name: "Dream",
    description: "",
    cron: "0 0 0 1 1 *",
    timezone: "UTC",
    recurring: true,
    prompt: "",
    status: "active",
    created_at: "2026-10-01T01:00:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 0,
    cancel_reason: null,
    jitter_offset_ms: 0,
    last_run_at: null,
    last_run_outcome: null,
    last_run_reason: null,
    last_run_error: null,
    last_missed_at: null,
    missed_count: 0,
    failed_count: 0,
    scheduled_for: null,
    fired_at: null,
    missed_at: null,
    type: "dream",
    payload: serializeDreamTaskPayload({
      version: 1,
      budgetOverrideTokens: 60_000,
    }),
    target: { kind: "new", hidden: true },
    permission: "acceptEdits",
    catch_up: false,
    timeout_minutes: 0,
    wait_minutes: 10,
    lease: null,
    last_consumed_occurrence: null,
    consecutive_failures: 0,
    paused_reason: null,
    ...overrides,
  };
}

function writeStore(tasks: CronTask[]): void {
  writeScheduleFile({ ...emptyScheduleFile(), tasks });
}

beforeAll(() => {
  writeStore([dreamTaskRecord()]);
});

describe("clearDreamBudgetOverride", () => {
  test("removes the one-run override and leaves the plain payload", () => {
    expect(clearDreamBudgetOverride(TASK_ID)).toBe(true);
    const task = getScheduleTask(TASK_ID);
    expect(task?.payload).toBe(serializeDreamTaskPayload({ version: 1 }));
    expect(JSON.parse(task?.payload ?? "{}")).toEqual({ version: 1 });
  });

  test("is a no-op when the override is already gone", () => {
    expect(clearDreamBudgetOverride(TASK_ID)).toBe(false);
  });

  test("ignores a missing task", () => {
    expect(clearDreamBudgetOverride("no-such-task")).toBe(false);
  });

  test("ignores a non-dream task even with a dream-shaped payload", () => {
    writeStore([
      dreamTaskRecord({
        id: "prompt-task",
        type: "prompt",
        payload: serializeDreamTaskPayload({
          version: 1,
          budgetOverrideTokens: 10_000,
        }),
      }),
    ]);
    expect(clearDreamBudgetOverride("prompt-task")).toBe(false);
    expect(JSON.parse(getScheduleTask("prompt-task")?.payload ?? "{}")).toEqual(
      {
        version: 1,
        budgetOverrideTokens: 10_000,
      },
    );
  });

  test("ignores a malformed dream payload instead of guessing", () => {
    writeStore([dreamTaskRecord({ id: "bad-task", payload: "not-json" })]);
    expect(clearDreamBudgetOverride("bad-task")).toBe(false);
    expect(getScheduleTask("bad-task")?.payload).toBe("not-json");
  });
});
