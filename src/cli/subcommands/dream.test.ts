import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markDreamActivity } from "@/agent/dream/dream-activity";
import { runDreamStatus, runDreamSubcommand } from "@/cli/subcommands/dream";
import {
  addTask,
  DREAM_PLACEHOLDER_CRON,
  getScheduleFilePath,
  serializeDreamTaskPayload,
} from "@/cron";
import { settingsManager } from "@/settings-manager";

const TEST_DIR = path.join(import.meta.dir, "__dream_subcommand_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(async () => {
  // `dream run`/`status` initialize the settings singleton themselves; reset it
  // so the global state cannot leak between test files in one worker.
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(async () => {
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

describe("haruyuki dream subcommand", () => {
  test("help exits 0, unknown action exits 2", async () => {
    expect(await runDreamSubcommand(["help"])).toBe(0);
    expect(await runDreamSubcommand(["nope"])).toBe(2);
  });

  test("run without --task is a usage error", async () => {
    expect(await runDreamSubcommand(["run"])).toBe(2);
    expect(await runDreamSubcommand(["run", "--task"])).toBe(2);
    expect(
      await runDreamSubcommand(["run", "--budget", "x", "--task", "a"]),
    ).toBe(2);
    expect(await runDreamSubcommand(["run", "--bogus"])).toBe(2);
  });

  test("run for an unknown task fails cleanly", async () => {
    expect(await runDreamSubcommand(["run", "--task", "nope"])).toBe(1);
  });

  test("run for a non-dream task refuses instead of running it", async () => {
    const { task } = addTask({
      agent_id: "agent-1",
      name: "Prompt",
      description: "",
      cron: "0 9 * * *",
      recurring: true,
      prompt: "hi",
    });
    expect(await runDreamSubcommand(["run", "--task", task.id])).toBe(1);
  });

  test("status is read-only", async () => {
    expect(await runDreamSubcommand(["status"])).toBe(0);
  });
});

// ── Lead fixes: clean store diagnostics + honest status eligibility ──

describe("store errors are diagnostics, not rejections", () => {
  test("dream run on a corrupt store prints one line and exits 1", async () => {
    writeFileSync(getScheduleFilePath(), "{not json");
    await expect(runDreamSubcommand(["run", "--task", "abc"])).resolves.toBe(1);
  });

  test("dream status on a corrupt store exits 1", async () => {
    writeFileSync(getScheduleFilePath(), "{not json");
    await expect(runDreamSubcommand(["status"])).resolves.toBe(1);
  });
});

describe("status eligibility uses the real activity source", () => {
  test("a user-active agent is reported as user_active, not eligible", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      dreamEnabled: true,
      dreamIdleWindows: [{ start: "00:00", end: "23:59" }],
      dreamSilenceMinutes: 30,
      dreamPressureThreshold: 1,
    });
    addDreamTaskForStatus();
    markDreamActivity("agent-status", Date.now());

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
    };
    try {
      expect(runDreamStatus()).toBe(0);
    } finally {
      console.log = original;
    }
    const joined = lines.join("\n");
    expect(joined).toContain("would trigger now: user_active");
    expect(joined).not.toContain("would trigger now: eligible");
  });
});

function addDreamTaskForStatus(): string {
  return addTask({
    agent_id: "agent-status",
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
