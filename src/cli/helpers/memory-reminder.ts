// Reflection (sleep-time) settings: resolution across the three settings
// layers, persistence, legacy migration, and the message-count trigger.
//
// F-03 replaced the old three-way `reflectionTrigger` selector and the merge
// knobs with two independent switches. The chain below is the requirement's
// order: global legacy (`memoryReminderInterval`) → global explicit → project →
// local → per-agent (global then local). New keys always win; the retired keys
// are only consulted when no new key exists.

import {
  DEFAULT_REFLECTION_SETTINGS,
  DEFAULT_REFLECTION_STEP_COUNT,
  migrateLegacyReflectionKeys,
  normalizeReflectionDeleteSessionOnSuccess,
  normalizeReflectionEveryUserMessages,
  normalizeReflectionOnCompaction,
  normalizeReflectionTimeoutMinutes,
  type ReflectionMergeMode,
  type ReflectionSettings,
  type ReflectionTrigger,
  type StoredReflectionSettings,
} from "@/reflection-settings";
import { settingsManager } from "@/settings-manager";

export type {
  ReflectionMergeMode,
  ReflectionSettings,
  ReflectionTrigger,
} from "@/reflection-settings";

export type MemoryReminderMode =
  | number
  | null
  | "compaction"
  | "auto-compaction";

/**
 * The resolved reflection policy plus the retired aliases the mod surface and
 * the app-server wire still read. The aliases are **derived**, never stored:
 * `merge`/`mergeInstructions` are fixed legacy defaults because F-03 removed
 * that policy, and `trigger`/`stepCount` collapse the two switches into the old
 * one-of-three vocabulary for display only.
 */
export interface ResolvedReflectionSettings extends ReflectionSettings {
  /** @deprecated Derived display alias; see {@link getReflectionSettings}. */
  trigger: ReflectionTrigger;
  /** @deprecated Derived display alias; see {@link getReflectionSettings}. */
  stepCount: number;
  /** @deprecated Always `"auto"`: the merge policy was retired. */
  merge: ReflectionMergeMode;
  /** @deprecated Always `""`: the merge policy was retired. */
  mergeInstructions: string;
}

interface ReflectionSettingsCarrier {
  memoryReminderInterval?: unknown;
  reflectionTrigger?: unknown;
  reflectionStepCount?: unknown;
  reflectionOnCompaction?: unknown;
  reflectionEveryUserMessages?: unknown;
  reflectionTimeoutMinutes?: unknown;
  reflectionDeleteSessionOnSuccess?: unknown;
  reflectionSettingsByAgent?: Record<string, StoredReflectionSettings>;
}

function applyCarrierSettings(
  base: ReflectionSettings,
  raw: ReflectionSettingsCarrier | null | undefined,
): ReflectionSettings {
  if (!raw) {
    return base;
  }
  const patch = migrateLegacyReflectionKeys(
    {
      memoryReminderInterval: raw.memoryReminderInterval,
      trigger: raw.reflectionTrigger,
      stepCount: raw.reflectionStepCount,
      onCompaction: raw.reflectionOnCompaction,
      everyUserMessages: raw.reflectionEveryUserMessages,
      timeoutMinutes: raw.reflectionTimeoutMinutes,
      deleteSessionOnSuccess: raw.reflectionDeleteSessionOnSuccess,
    },
    base,
  );
  return { ...base, ...patch };
}

function applyPersistedAgentScopedSettings(
  base: ReflectionSettings,
  raw: StoredReflectionSettings | undefined,
): ReflectionSettings {
  if (!raw) {
    return base;
  }
  const patch = migrateLegacyReflectionKeys(
    {
      trigger: raw.trigger,
      stepCount: raw.stepCount,
      onCompaction: raw.onCompaction,
      everyUserMessages: raw.everyUserMessages,
      timeoutMinutes: raw.timeoutMinutes,
      deleteSessionOnSuccess: raw.deleteSessionOnSuccess,
    },
    base,
  );
  return { ...base, ...patch };
}

function deriveLegacyAliases(
  settings: ReflectionSettings,
): ResolvedReflectionSettings {
  const everyUserMessages = normalizeReflectionEveryUserMessages(
    settings.everyUserMessages,
  );
  let trigger: ReflectionTrigger;
  if (settings.onCompaction) {
    trigger = "compaction-event";
  } else if (everyUserMessages > 0) {
    trigger = "step-count";
  } else {
    trigger = "off";
  }
  return {
    ...settings,
    trigger,
    stepCount:
      everyUserMessages > 0 ? everyUserMessages : DEFAULT_REFLECTION_STEP_COUNT,
    merge: "auto",
    mergeInstructions: "",
  };
}

/**
 * Get effective reflection settings (global → project → local → per-agent).
 *
 * Never throws for an unloaded project/local scope: the settings page and the
 * trigger run before either load on some startup paths, and the global layer is
 * always available.
 */
export function getReflectionSettings(
  agentId?: string,
  workingDirectory: string = process.cwd(),
): ResolvedReflectionSettings {
  const globalSettings =
    settingsManager.getSettings() as unknown as ReflectionSettingsCarrier;

  let projectSettings: ReflectionSettingsCarrier | null = null;
  try {
    projectSettings = settingsManager.getProjectSettings(
      workingDirectory,
    ) as unknown as ReflectionSettingsCarrier;
  } catch {
    projectSettings = null;
  }

  let localSettings: ReflectionSettingsCarrier | null = null;
  try {
    localSettings = settingsManager.getLocalProjectSettings(
      workingDirectory,
    ) as unknown as ReflectionSettingsCarrier;
  } catch {
    localSettings = null;
  }

  let resolved = applyCarrierSettings(
    { ...DEFAULT_REFLECTION_SETTINGS },
    globalSettings,
  );
  resolved = applyCarrierSettings(resolved, projectSettings);
  resolved = applyCarrierSettings(resolved, localSettings);

  if (agentId) {
    resolved = applyPersistedAgentScopedSettings(
      resolved,
      globalSettings.reflectionSettingsByAgent?.[agentId],
    );
    resolved = applyPersistedAgentScopedSettings(
      resolved,
      projectSettings?.reflectionSettingsByAgent?.[agentId],
    );
    resolved = applyPersistedAgentScopedSettings(
      resolved,
      localSettings?.reflectionSettingsByAgent?.[agentId],
    );
  }

  return deriveLegacyAliases(resolved);
}

/**
 * The message-counter trigger: fires when at least `everyUserMessages` user
 * messages have arrived since the last reflected mark. Zero means off.
 */
export function shouldFireUserMessageTrigger(
  messagesSinceLastReflection: number,
  settings: ReflectionSettings = getReflectionSettings(),
): boolean {
  const everyUserMessages = normalizeReflectionEveryUserMessages(
    settings.everyUserMessages,
  );
  return (
    everyUserMessages > 0 && messagesSinceLastReflection >= everyUserMessages
  );
}

type PersistReflectionSettingsOptions = {
  workingDirectory?: string;
  persistLocalProject?: boolean;
  persistGlobal?: boolean;
};

function toStoredReflectionSettings(
  settings: ReflectionSettings,
): Required<
  Pick<
    StoredReflectionSettings,
    | "onCompaction"
    | "everyUserMessages"
    | "timeoutMinutes"
    | "deleteSessionOnSuccess"
  >
> {
  return {
    onCompaction: normalizeReflectionOnCompaction(settings.onCompaction),
    everyUserMessages: normalizeReflectionEveryUserMessages(
      settings.everyUserMessages,
    ),
    timeoutMinutes: normalizeReflectionTimeoutMinutes(settings.timeoutMinutes),
    deleteSessionOnSuccess: normalizeReflectionDeleteSessionOnSuccess(
      settings.deleteSessionOnSuccess,
    ),
  };
}

/**
 * Persist the reflection policy to the local project and/or global settings.
 * Only the new keys are written; the retired keys are left to the load-time
 * migration (which never rewrites them) so an older binary still reads a
 * consistent file.
 */
export async function persistReflectionSettingsForAgent(
  agentId: string,
  settings: ReflectionSettings,
  options: PersistReflectionSettingsOptions = {},
): Promise<void> {
  const {
    workingDirectory = process.cwd(),
    persistLocalProject = true,
    persistGlobal = true,
  } = options;
  const stored = toStoredReflectionSettings(settings);

  if (persistLocalProject) {
    try {
      settingsManager.getLocalProjectSettings(workingDirectory);
    } catch {
      await settingsManager.loadLocalProjectSettings(workingDirectory);
    }

    const localSettings =
      settingsManager.getLocalProjectSettings(workingDirectory);
    settingsManager.updateLocalProjectSettings(
      {
        reflectionOnCompaction: stored.onCompaction,
        reflectionEveryUserMessages: stored.everyUserMessages,
        reflectionTimeoutMinutes: stored.timeoutMinutes,
        reflectionDeleteSessionOnSuccess: stored.deleteSessionOnSuccess,
        reflectionSettingsByAgent: {
          ...(localSettings.reflectionSettingsByAgent ?? {}),
          [agentId]: stored,
        },
      },
      workingDirectory,
    );
  }

  if (persistGlobal) {
    const globalSettings = settingsManager.getSettings();
    settingsManager.updateSettings({
      reflectionOnCompaction: stored.onCompaction,
      reflectionEveryUserMessages: stored.everyUserMessages,
      reflectionTimeoutMinutes: stored.timeoutMinutes,
      reflectionDeleteSessionOnSuccess: stored.deleteSessionOnSuccess,
      reflectionSettingsByAgent: {
        ...(globalSettings.reflectionSettingsByAgent ?? {}),
        [agentId]: stored,
      },
    });
  }
}
