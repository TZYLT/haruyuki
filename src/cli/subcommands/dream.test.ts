import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { runDreamSubcommand } from "@/cli/subcommands/dream";
import { addTask } from "@/cron";
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
