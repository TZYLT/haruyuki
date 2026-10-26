import { afterEach, describe, expect, test } from "bun:test";
import {
  getReflectionSettings,
  persistReflectionSettingsForAgent,
  shouldFireUserMessageTrigger,
} from "@/cli/helpers/memory-reminder";
import { settingsManager } from "@/settings-manager";

const originalGetLocalProjectSettings = settingsManager.getLocalProjectSettings;
const originalGetProjectSettings = settingsManager.getProjectSettings;
const originalGetSettings = settingsManager.getSettings;
const originalLoadLocalProjectSettings =
  settingsManager.loadLocalProjectSettings;
const originalUpdateLocalProjectSettings =
  settingsManager.updateLocalProjectSettings;
const originalUpdateSettings = settingsManager.updateSettings;

function stubSettings(
  globalSettings: Record<string, unknown>,
  localSettings: Record<string, unknown> = {},
  projectSettings: Record<string, unknown> = {},
): void {
  (settingsManager as typeof settingsManager).getSettings = (() =>
    globalSettings) as unknown as typeof settingsManager.getSettings;
  (settingsManager as typeof settingsManager).getLocalProjectSettings = (() =>
    localSettings) as unknown as typeof settingsManager.getLocalProjectSettings;
  (settingsManager as typeof settingsManager).getProjectSettings = (() =>
    projectSettings) as unknown as typeof settingsManager.getProjectSettings;
}

afterEach(() => {
  (settingsManager as typeof settingsManager).getLocalProjectSettings =
    originalGetLocalProjectSettings;
  (settingsManager as typeof settingsManager).getProjectSettings =
    originalGetProjectSettings;
  (settingsManager as typeof settingsManager).getSettings = originalGetSettings;
  (settingsManager as typeof settingsManager).loadLocalProjectSettings =
    originalLoadLocalProjectSettings;
  (settingsManager as typeof settingsManager).updateLocalProjectSettings =
    originalUpdateLocalProjectSettings;
  (settingsManager as typeof settingsManager).updateSettings =
    originalUpdateSettings;
});

describe("memoryReminder", () => {
  test("defaults match F-03: compaction on, counter off, 3 minute limit, delete on success", () => {
    stubSettings({});

    expect(getReflectionSettings()).toMatchObject({
      onCompaction: true,
      everyUserMessages: 0,
      timeoutMinutes: 3,
      deleteSessionOnSuccess: true,
      // Derived legacy aliases for the mod surface / wire.
      trigger: "compaction-event",
      stepCount: 25,
      merge: "auto",
      mergeInstructions: "",
    });
  });

  test("explicit new keys resolve from the global layer", () => {
    stubSettings({
      reflectionOnCompaction: false,
      reflectionEveryUserMessages: 12,
      reflectionTimeoutMinutes: 10,
      reflectionDeleteSessionOnSuccess: false,
    });

    expect(getReflectionSettings("agent-1")).toMatchObject({
      onCompaction: false,
      everyUserMessages: 12,
      timeoutMinutes: 10,
      deleteSessionOnSuccess: false,
      trigger: "step-count",
      stepCount: 12,
    });
  });

  test("legacy reflectionTrigger / reflectionStepCount migrate onto the two switches", () => {
    stubSettings({ reflectionTrigger: "step-count", reflectionStepCount: 33 });
    expect(getReflectionSettings()).toMatchObject({
      onCompaction: false,
      everyUserMessages: 33,
    });

    stubSettings({ reflectionTrigger: "compaction-event" });
    expect(getReflectionSettings()).toMatchObject({
      onCompaction: true,
      everyUserMessages: 0,
    });

    stubSettings({ reflectionTrigger: "off", reflectionStepCount: 9 });
    expect(getReflectionSettings()).toMatchObject({
      onCompaction: false,
      everyUserMessages: 0,
    });
  });

  test("legacy step-count without a count suggests 25", () => {
    stubSettings({ reflectionTrigger: "step-count" });
    expect(getReflectionSettings().everyUserMessages).toBe(25);
  });

  test("legacy memoryReminderInterval maps the oldest configuration layer", () => {
    stubSettings({ memoryReminderInterval: 5 });
    expect(getReflectionSettings()).toMatchObject({
      onCompaction: false,
      everyUserMessages: 5,
    });

    stubSettings({ memoryReminderInterval: "compaction" });
    expect(getReflectionSettings()).toMatchObject({
      onCompaction: true,
      everyUserMessages: 0,
    });

    stubSettings({ memoryReminderInterval: null });
    expect(getReflectionSettings()).toMatchObject({
      onCompaction: false,
      everyUserMessages: 0,
    });
  });

  test("new keys beat the legacy selector when both exist", () => {
    stubSettings({
      reflectionTrigger: "step-count",
      reflectionStepCount: 9,
      reflectionOnCompaction: true,
      reflectionEveryUserMessages: 0,
    });
    expect(getReflectionSettings()).toMatchObject({
      onCompaction: true,
      everyUserMessages: 0,
    });
  });

  test("local and project overrides beat the global layer", () => {
    stubSettings(
      {
        reflectionOnCompaction: true,
        reflectionEveryUserMessages: 0,
        reflectionTimeoutMinutes: 3,
      },
      {
        reflectionOnCompaction: false,
        reflectionEveryUserMessages: 7,
        reflectionTimeoutMinutes: 9,
      },
      { reflectionEveryUserMessages: 4 },
    );

    expect(getReflectionSettings()).toMatchObject({
      onCompaction: false,
      everyUserMessages: 7,
      timeoutMinutes: 9,
    });
  });

  test("per-agent settings beat every scope, global before local", () => {
    stubSettings(
      {
        reflectionSettingsByAgent: {
          "agent-1": { onCompaction: false, everyUserMessages: 9 },
        },
      },
      {
        reflectionSettingsByAgent: {
          "agent-1": { everyUserMessages: 13 },
        },
      },
    );

    expect(getReflectionSettings("agent-1")).toMatchObject({
      onCompaction: false,
      everyUserMessages: 13,
    });
  });

  test("per-agent legacy triggers migrate too", () => {
    stubSettings({
      reflectionSettingsByAgent: {
        "agent-1": { trigger: "compaction-event", stepCount: 40 },
      },
    });
    expect(getReflectionSettings("agent-1")).toMatchObject({
      onCompaction: true,
      everyUserMessages: 0,
    });
  });

  test("timeout is clamped to 1–60 and invalid values fall back", () => {
    stubSettings({ reflectionTimeoutMinutes: 0 });
    expect(getReflectionSettings().timeoutMinutes).toBe(1);
    stubSettings({ reflectionTimeoutMinutes: 120 });
    expect(getReflectionSettings().timeoutMinutes).toBe(60);
    stubSettings({ reflectionTimeoutMinutes: 4.6 });
    expect(getReflectionSettings().timeoutMinutes).toBe(4);
    stubSettings({ reflectionTimeoutMinutes: "soon" });
    expect(getReflectionSettings().timeoutMinutes).toBe(3);
  });

  test("the user-message trigger fires at the configured count and is off at 0", () => {
    expect(
      shouldFireUserMessageTrigger(10, {
        onCompaction: false,
        everyUserMessages: 5,
        timeoutMinutes: 3,
        deleteSessionOnSuccess: true,
      }),
    ).toBe(true);
    expect(
      shouldFireUserMessageTrigger(4, {
        onCompaction: false,
        everyUserMessages: 5,
        timeoutMinutes: 3,
        deleteSessionOnSuccess: true,
      }),
    ).toBe(false);
    expect(
      shouldFireUserMessageTrigger(10, {
        onCompaction: true,
        everyUserMessages: 0,
        timeoutMinutes: 3,
        deleteSessionOnSuccess: true,
      }),
    ).toBe(false);
  });

  test("persistReflectionSettingsForAgent writes the new keys and per-agent shape", async () => {
    const localUpdates: Array<Record<string, unknown>> = [];
    const globalUpdates: Array<Record<string, unknown>> = [];

    (settingsManager as typeof settingsManager).getLocalProjectSettings = (() =>
      ({
        reflectionSettingsByAgent: {
          "agent-2": { onCompaction: false, everyUserMessages: 5 },
        },
      }) as unknown as ReturnType<
        typeof settingsManager.getLocalProjectSettings
      >) as typeof settingsManager.getLocalProjectSettings;
    (settingsManager as typeof settingsManager).loadLocalProjectSettings =
      (async () =>
        ({}) as ReturnType<
          typeof settingsManager.getLocalProjectSettings
        >) as typeof settingsManager.loadLocalProjectSettings;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        reflectionSettingsByAgent: {
          "agent-3": { onCompaction: true, everyUserMessages: 0 },
        },
      }) as unknown as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;
    (settingsManager as typeof settingsManager).updateLocalProjectSettings = ((
      updates,
    ) => {
      localUpdates.push(updates as Record<string, unknown>);
    }) as typeof settingsManager.updateLocalProjectSettings;
    (settingsManager as typeof settingsManager).updateSettings = ((updates) => {
      globalUpdates.push(updates as Record<string, unknown>);
    }) as typeof settingsManager.updateSettings;

    await persistReflectionSettingsForAgent("agent-1", {
      onCompaction: false,
      everyUserMessages: 11,
      timeoutMinutes: 8,
      deleteSessionOnSuccess: false,
    });

    expect(localUpdates).toHaveLength(1);
    expect(globalUpdates).toHaveLength(1);
    for (const updates of [localUpdates[0], globalUpdates[0]]) {
      expect(updates?.reflectionOnCompaction).toBe(false);
      expect(updates?.reflectionEveryUserMessages).toBe(11);
      expect(updates?.reflectionTimeoutMinutes).toBe(8);
      expect(updates?.reflectionDeleteSessionOnSuccess).toBe(false);
      // The retired keys are not written back.
      expect(updates).not.toHaveProperty("reflectionTrigger");
      expect(updates).not.toHaveProperty("reflectionMerge");
      expect(updates).not.toHaveProperty("memoryReminderInterval");
    }
    expect(localUpdates[0]?.reflectionSettingsByAgent).toEqual({
      "agent-2": { onCompaction: false, everyUserMessages: 5 },
      "agent-1": {
        onCompaction: false,
        everyUserMessages: 11,
        timeoutMinutes: 8,
        deleteSessionOnSuccess: false,
      },
    });
    expect(globalUpdates[0]?.reflectionSettingsByAgent).toEqual({
      "agent-3": { onCompaction: true, everyUserMessages: 0 },
      "agent-1": {
        onCompaction: false,
        everyUserMessages: 11,
        timeoutMinutes: 8,
        deleteSessionOnSuccess: false,
      },
    });
  });
});
