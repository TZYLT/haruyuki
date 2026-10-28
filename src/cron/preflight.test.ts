import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask, updateTask } from "@/cron/cron-file";
import { runSchedulePreflight } from "@/cron/preflight";

const TEST_DIR = path.join(import.meta.dir, "__preflight_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

function addRecord(
  overrides: Parameters<typeof addTask>[0] extends infer T
    ? Partial<T>
    : never = {},
) {
  const { task } = addTask({
    agent_id: "agent-local-preflight",
    name: "Preflight task",
    description: "",
    cron: "* * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "hello",
    ...overrides,
  });
  updateTask(task.id, (record) => {
    record.created_at = "2026-10-20T00:00:00.000Z";
    record.jitter_offset_ms = 0;
  });
  return task;
}

const NOW = new Date("2026-10-28T14:05:20.000Z");

describe("runSchedulePreflight", () => {
  test("an empty store is not due", () => {
    expect(runSchedulePreflight({ now: NOW })).toEqual({
      due: false,
      nextDueAt: null,
    });
  });

  test("a task whose next slot is in the future is not due, and reports when it is", () => {
    const task = addRecord({ cron: "0 9 * * *" });
    updateTask(task.id, (record) => {
      record.last_consumed_occurrence = "2026-10-28T09:00|UTC";
    });
    const result = runSchedulePreflight({ now: NOW });
    expect(result.due).toBe(false);
    expect(result.nextDueAt).toEqual(new Date("2026-10-29T09:00:00.000Z"));
  });

  test("a matching minute is due", () => {
    addRecord();
    expect(runSchedulePreflight({ now: NOW })).toMatchObject({ due: true });
  });

  test("a consumed occurrence is no longer due", () => {
    const task = addRecord();
    updateTask(task.id, (record) => {
      record.last_consumed_occurrence = "2026-10-28T14:05|UTC";
    });
    const result = runSchedulePreflight({ now: NOW });
    expect(result.due).toBe(false);
    expect(result.nextDueAt).toEqual(new Date("2026-10-28T14:06:00.000Z"));
  });

  test("a paused task keeps the host asleep", () => {
    const task = addRecord();
    updateTask(task.id, (record) => {
      record.status = "paused";
      record.paused_reason = "manual";
    });
    expect(runSchedulePreflight({ now: NOW })).toEqual({
      due: false,
      nextDueAt: null,
    });
  });
});

describe("C-24: the light path never loads the heavy runtime", () => {
  // Modules the short-lived host must not need before it knows something is due.
  const HEAVY = [
    "/backend/api",
    "/backend/local/",
    "/providers/",
    "/tools/impl",
    "/tools/manager",
    "/agent/conversation",
    "/websocket/listener",
  ];

  function loaded(): string[] {
    return Object.keys((require.cache ?? {}) as Record<string, unknown>).map(
      (key) => key.replace(/\\/g, "/"),
    );
  }

  test("running the preflight adds none of them", () => {
    addRecord();
    const before = new Set(loaded());
    runSchedulePreflight({ now: NOW });
    const added = loaded().filter((entry) => {
      if (before.has(entry)) return false;
      return HEAVY.some((segment) => entry.includes(segment));
    });
    expect(added).toEqual([]);
  });

  test("the light path is fast enough for a 60s wake", () => {
    addRecord();
    addRecord({ agent_id: "agent-local-preflight-2", cron: "0 9 * * *" });
    addRecord({ agent_id: "agent-local-preflight-3", cron: "*/5 * * * *" });
    const startedAt = performance.now();
    for (let index = 0; index < 5; index += 1) {
      runSchedulePreflight({ now: NOW });
    }
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("the CLI subcommand keeps them behind a dynamic import", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "..", "cli", "subcommands", "schedule.ts"),
      "utf-8",
    );
    const staticImports = source
      .split("\n")
      .filter((line) => line.startsWith("import "))
      .join("\n");
    for (const specifier of [
      "@/backend",
      "@/providers",
      "@/tools",
      "@/agent/",
      "@/websocket/listener",
    ]) {
      expect(staticImports).not.toContain(`from "${specifier}`);
    }
    // The heavy paths must still be reachable, just dynamically.
    expect(source).toContain('import("@/websocket/listener/lifecycle")');
    expect(source).toContain('import("@/cron/scheduler-core")');
  });
});
