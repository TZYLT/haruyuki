import {
  getReflectionSettings,
  persistReflectionSettingsForAgent,
  type ReflectionSettings,
  type ReflectionTrigger,
} from "@/cli/helpers/memory-reminder";
import { legacyTriggerToReflectionSwitches } from "@/reflection-settings";
import { settingsManager } from "@/settings-manager";

export interface ReflectionOverrides {
  trigger?: ReflectionTrigger;
  stepCount?: number;
}

/**
 * Apply the headless `--reflection-trigger`/`--reflection-step-count` overrides.
 *
 * The flags predate F-03 and still speak the one-of-three vocabulary; they are
 * mapped onto the two switches here so a script can force a trigger for a
 * single headless run without learning the new flag names.
 */
export async function applyHeadlessReflectionOverrides(
  agentId: string,
  overrides: ReflectionOverrides,
): Promise<ReflectionSettings> {
  const current = getReflectionSettings(agentId);
  const migrated = overrides.trigger
    ? legacyTriggerToReflectionSwitches(
        overrides.trigger,
        overrides.stepCount ?? current.everyUserMessages,
      )
    : undefined;
  const merged: ReflectionSettings = {
    ...current,
    ...(migrated ?? {}),
    ...(overrides.stepCount !== undefined &&
    overrides.trigger === undefined &&
    overrides.stepCount > 0
      ? {
          onCompaction: false,
          everyUserMessages: overrides.stepCount,
        }
      : {}),
  };
  if (overrides.trigger === undefined && overrides.stepCount === undefined) {
    return merged;
  }
  const triggersEnabled = merged.onCompaction || merged.everyUserMessages > 0;
  if (!settingsManager.isMemfsEnabled(agentId) && triggersEnabled) {
    throw new Error(
      "Reflection triggers require memfs enabled for this agent.",
    );
  }
  try {
    settingsManager.getLocalProjectSettings();
  } catch {
    await settingsManager.loadLocalProjectSettings();
  }
  await persistReflectionSettingsForAgent(agentId, merged);
  return merged;
}
