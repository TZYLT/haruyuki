import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  addTask,
  clearSignalSources,
  DREAM_PLACEHOLDER_CRON,
  markDreamRunActive,
  registerSignalSource,
  serializeDreamTaskPayload,
} from "@/cron";
import { runSchedulePreflight } from "@/cron/preflight";
import { listSignalSources } from "@/cron/signal";
import { settingsManager } from "@/settings-manager";

const TEST_DIR = path.join(import.meta.dir, "__preflight_dream_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  clearSignalSources();
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  clearSignalSources();
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

function addDreamTask(): string {
  return addTask({
    agent_id: "agent-1",
    name: "Dream",
    description: "",
    cron: DREAM_PLACEHOLDER_CRON,
    timezone: "UTC",
    recurring: true,
    prompt: "",
    payload: serializeDreamTaskPayload({ version: 1 }),
    type: "dream",
    target: { kind: "new", hidden: true },
    timeout_minutes: 0,
    wait_minutes: 0,
  }).task.id;
}

/** A dream source that reports every active dream task due now. */
function registerDueDreamStub(): void {
  registerSignalSource({
    id: "dream",
    evaluate: ({ now, tasks }) => ({
      occurrences: tasks
        .filter((task) => task.type === "dream" && task.status === "active")
        .map((task) => ({
          taskId: task.id,
          occurrence: `dream:${now.toISOString()}`,
          intendedAt: new Date(now.getTime() - 1_000).toISOString(),
        })),
    }),
    nextDueAt: () => null,
  });
}

describe("preflight registers the dream source (F-06 M1)", () => {
  test("reports due for a dream occurrence and registers the source", () => {
    addDreamTask();
    registerDueDreamStub();
    const result = runSchedulePreflight({ now: new Date() });
    expect(result.error).toBeUndefined();
    expect(result.due).toBe(true);
    expect(listSignalSources().some((source) => source.id === "dream")).toBe(
      true,
    );
  });

  test("a configured dream task makes the probe due even at pressure 0", () => {
    addDreamTask();
    settingsManager.updateSettings({
      dreamEnabled: true,
      dreamIdleWindows: [{ start: "00:00", end: "23:59" }],
    });
    // S3 is still a stub returning 0; the preflight deliberately over-approximates
    // so it can decide whether loading the runtime is worth it.
    const result = runSchedulePreflight({ now: new Date() });
    expect(result.due).toBe(true);
  });

  test("nothing configured means nothing due", () => {
    addDreamTask();
    // Settings untouched: `dreamEnabled` defaults to false (explicit config is
    // the hard gate), so the probe must not load the runtime.
    const result = runSchedulePreflight({ now: new Date() });
    expect(result.due).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("a cron task still works alongside the dream source", () => {
    const { task } = addTask({
      agent_id: "agent-1",
      name: "Soon",
      description: "",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "hi",
    });
    const result = runSchedulePreflight({
      now: new Date(Date.parse(task.created_at) + 60_000),
    });
    expect(result.due).toBe(true);
  });
});

// ── Lead fix: a crash-remnant marker must not suppress the probe ────

describe("preflight marker staleness", () => {
  test("an over-age running marker does not block the probe; a fresh one does", async () => {
    addDreamTask();
    settingsManager.updateSettings({
      dreamEnabled: true,
      dreamIdleWindows: [{ start: "00:00", end: "23:59" }],
      // A short configured limit lowers the liveness bound to the 1h floor.
      dreamTimeLimitMinutes: 10,
    });
    const now = Date.now();
    markDreamRunActive("agent-1", "dead-run", new Date(now - 2 * 60 * 60_000));
    expect(runSchedulePreflight({ now: new Date(now) }).due).toBe(true);

    markDreamRunActive("agent-1", "fresh-run", new Date(now - 5 * 60_000));
    expect(runSchedulePreflight({ now: new Date(now) }).due).toBe(false);
  });
});
