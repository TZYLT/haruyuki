import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";

// Retired-setting migration and replay cases, split out of settings-manager.test.ts.
// They cover the global, project and local layers: OBSOLETE_SETTINGS_KEYS are
// dropped on load, the retired reflection selector folds onto the two switches,
// and replaying the migration over the rewritten file is a no-op.

const originalHome = process.env.HOME;
const originalLocalFlag = process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
let testHomeDir: string;
let testProjectDir: string;

beforeEach(async () => {
  // Reset the process-wide singleton before redirecting HOME.
  await settingsManager.reset();

  testHomeDir = await mkdtemp(join(tmpdir(), "haruyuki-migration-home-"));
  testProjectDir = await mkdtemp(join(tmpdir(), "haruyuki-migration-project-"));

  // HOME must point at the temp root before initialize() reads anything.
  process.env.HOME = testHomeDir;
  delete process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
});

afterEach(async () => {
  // Let pending writes settle before restoring HOME, so test writes cannot
  // leak into the real settings file.
  await settingsManager.reset();

  await rm(testHomeDir, { recursive: true, force: true });
  await rm(testProjectDir, { recursive: true, force: true });

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalLocalFlag === undefined) {
    delete process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
  } else {
    process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL = originalLocalFlag;
  }
  if (originalLocalBackendDir === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
  }
});

describe("Settings Manager - Legacy Settings Migration", () => {
  test("Initialize tolerates obsolete keys and strips them on persist", async () => {
    const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".haruyuki");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");

    await writeFile(
      settingsPath,
      JSON.stringify({
        reflectionBehavior: "reminder",
        enableSleeptime: true,
        pinnedConversationsByServer: {
          "api.letta.com": { "agent-1": ["conv-1"] },
        },
        reflectionTrigger: "step-count",
        reflectionStepCount: 12,
      }),
    );

    await settingsManager.initialize();
    const settings = settingsManager.getSettings() as unknown as Record<
      string,
      unknown
    >;
    // F-03 migrates the retired reflection selector onto the two switches.
    expect(settings.reflectionOnCompaction).toBe(false);
    expect(settings.reflectionEveryUserMessages).toBe(12);
    expect(settings).not.toHaveProperty("reflectionBehavior");
    expect(settings).not.toHaveProperty("enableSleeptime");
    expect(settings).not.toHaveProperty("pinnedConversationsByServer");

    settingsManager.updateSettings({ tokenStreaming: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const persisted = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(persisted.reflectionOnCompaction).toBe(false);
    expect(persisted.reflectionEveryUserMessages).toBe(12);
    expect(persisted).not.toHaveProperty("reflectionBehavior");
    expect(persisted).not.toHaveProperty("enableSleeptime");
    expect(persisted).not.toHaveProperty("pinnedConversationsByServer");

    // Replaying the migration on the rewritten file is a no-op: the new keys win.
    await settingsManager.reset();
    await settingsManager.initialize();
    const replayed = settingsManager.getSettings() as unknown as Record<
      string,
      unknown
    >;
    expect(replayed.reflectionOnCompaction).toBe(false);
    expect(replayed.reflectionEveryUserMessages).toBe(12);
  });

  test("Load project settings reads the F-03 reflection knobs and strips merge keys", async () => {
    const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
    const projectDir = await mkdtemp(
      join(tmpdir(), "haruyuki-project-reflect-"),
    );
    const settingsDir = join(projectDir, ".haruyuki");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");

    await writeFile(
      settingsPath,
      JSON.stringify({
        reflectionOnCompaction: false,
        reflectionEveryUserMessages: 7,
        reflectionTimeoutMinutes: 9,
        reflectionDeleteSessionOnSuccess: false,
        reflectionMerge: "explicit",
        reflectionMergeInstructions: "ignore me",
      }),
    );

    const projectSettings =
      await settingsManager.loadProjectSettings(projectDir);
    expect(projectSettings.reflectionOnCompaction).toBe(false);
    expect(projectSettings.reflectionEveryUserMessages).toBe(7);
    expect(projectSettings.reflectionTimeoutMinutes).toBe(9);
    expect(projectSettings.reflectionDeleteSessionOnSuccess).toBe(false);

    // updateProjectSettings persists the new knobs.
    settingsManager.updateProjectSettings(
      { reflectionEveryUserMessages: 12 },
      projectDir,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const persisted = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(persisted.reflectionEveryUserMessages).toBe(12);

    await rm(projectDir, { recursive: true, force: true });
  });

  test("Load local settings tolerates legacy reflectionBehavior key and strips it", async () => {
    const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testProjectDir, ".haruyuki");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.local.json");

    await writeFile(
      settingsPath,
      JSON.stringify({
        lastAgent: "agent-local-legacy",
        reflectionBehavior: "reminder",
        pinnedConversationsByServer: {
          "api.letta.com": { "agent-1": ["conv-1"] },
        },
        reflectionTrigger: "step-count",
        reflectionStepCount: 9,
      }),
    );

    const localSettings =
      await settingsManager.loadLocalProjectSettings(testProjectDir);
    expect(localSettings.lastAgent).toBe("agent-local-legacy");
    // F-03 migrates the retired reflection selector onto the two switches.
    expect(localSettings.reflectionOnCompaction).toBe(false);
    expect(localSettings.reflectionEveryUserMessages).toBe(9);
    expect(localSettings).not.toHaveProperty("reflectionBehavior");
    expect(localSettings).not.toHaveProperty("pinnedConversationsByServer");

    const persisted = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(persisted.reflectionOnCompaction).toBe(false);
    expect(persisted.reflectionEveryUserMessages).toBe(9);
    expect(persisted).not.toHaveProperty("reflectionBehavior");
    expect(persisted).not.toHaveProperty("pinnedConversationsByServer");
  });
});
