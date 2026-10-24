/**
 * How local compaction settings are validated, merged, and resolved.
 *
 * Kept out of `local-backend.ts` because it is pure policy — no store, no
 * provider, no conversation — and because the backend file is on the size
 * ratchet. Two rules live here:
 *
 * - the local backend converges on `sliding_window` (`all` is gone, D-107):
 *   reading a stored `mode: "all"` falls back to the default instead of
 *   resurrecting a mode the planner no longer implements, while *writing* one is
 *   rejected outright;
 * - a request that changes only the mode drops the agent's custom summary prompt,
 *   because that prompt was written for the previous mode.
 */
import type { ConversationMessageCompactBody } from "@/backend/backend";
import { isRecord } from "@/utils/type-guards";
import {
  LOCAL_DEFAULT_COMPACTION_MODE,
  LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE,
  type LocalCompactionMode,
} from "./compaction";
import type { LocalAgentRecord } from "./local-store";

export type LocalCompactionSettingsRecord = Record<string, unknown>;

export interface ResolvedLocalCompactionSettings {
  mode: LocalCompactionMode;
  prompt?: string | null;
  clipChars?: number | null;
  slidingWindowPercentage: number;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

export function compactionSettingsRecord(
  value: unknown,
): LocalCompactionSettingsRecord | null | undefined {
  if (value === null) return null;
  return isRecord(value) ? { ...value } : undefined;
}

export function localCompactionMode(
  value: unknown,
): LocalCompactionMode | undefined {
  return value === "sliding_window" ? value : undefined;
}

export function validateLocalCompactionSettingsRecord(
  settings: LocalCompactionSettingsRecord,
): void {
  if (settings.mode === undefined || settings.mode === null) return;
  if (!localCompactionMode(settings.mode)) {
    throw new Error(
      `Local backend compaction supports only the "sliding_window" mode (received "${String(
        settings.mode,
      )}").`,
    );
  }
}

export function localCompactionSettingsForStorage(
  settings: LocalCompactionSettingsRecord | null | undefined,
): LocalCompactionSettingsRecord | null | undefined {
  if (settings === undefined || settings === null) return settings;

  const hasLocalSetting =
    hasOwn(settings, "mode") ||
    hasOwn(settings, "prompt") ||
    hasOwn(settings, "clip_chars") ||
    hasOwn(settings, "sliding_window_percentage");
  if (!hasLocalSetting) return undefined;

  return { ...settings };
}

/**
 * Merge a compaction-settings patch into the record already stored on the agent.
 *
 * `updateAgent` is a PATCH: a writer may send only the field it changed (the
 * `/compact config` overlay reports just what the user edited, and an agent editing
 * settings through the self-configuration skill does the same). Writing the
 * patch wholesale would silently drop the compaction model, the summary prompt
 * and the compression rate — the same defect B-1 fixed for conversation-level
 * `model_settings`.
 *
 * A `null` patch still means "clear the record": merging and clearing are two
 * different requests, and only the caller knows which one it made.
 */
export function mergeLocalCompactionSettings(
  current: LocalCompactionSettingsRecord | null | undefined,
  patch: LocalCompactionSettingsRecord | null,
): LocalCompactionSettingsRecord | null {
  if (patch === null) return null;
  return { ...(current ?? {}), ...patch };
}

/** The settings one compaction run uses, with request values winning. */
export function resolveLocalCompactionSettings(
  agent: LocalAgentRecord,
  body?: ConversationMessageCompactBody,
): ResolvedLocalCompactionSettings {
  const bodyRecord = (body ?? {}) as Record<string, unknown>;
  const requestSettings = compactionSettingsRecord(
    bodyRecord.compaction_settings,
  );
  if (requestSettings !== undefined && requestSettings !== null) {
    validateLocalCompactionSettingsRecord(requestSettings);
  }
  const agentSettings = compactionSettingsRecord(agent.compaction_settings);
  const baseSettings =
    agentSettings && agentSettings !== null ? agentSettings : {};
  const mergedSettings =
    requestSettings && requestSettings !== null
      ? { ...baseSettings, ...requestSettings }
      : baseSettings;
  const requestChangedMode =
    requestSettings !== undefined &&
    requestSettings !== null &&
    hasOwn(requestSettings, "mode");
  const requestChangedPrompt =
    requestSettings !== undefined &&
    requestSettings !== null &&
    hasOwn(requestSettings, "prompt");
  if (
    requestChangedMode &&
    !requestChangedPrompt &&
    agentSettings &&
    agentSettings !== null &&
    agentSettings.mode !== requestSettings.mode
  ) {
    delete mergedSettings.prompt;
  }

  const mode =
    localCompactionMode(mergedSettings.mode) ?? LOCAL_DEFAULT_COMPACTION_MODE;
  return {
    mode,
    prompt:
      typeof mergedSettings.prompt === "string" ||
      mergedSettings.prompt === null
        ? mergedSettings.prompt
        : undefined,
    clipChars:
      typeof mergedSettings.clip_chars === "number" ||
      mergedSettings.clip_chars === null
        ? mergedSettings.clip_chars
        : undefined,
    slidingWindowPercentage:
      typeof mergedSettings.sliding_window_percentage === "number"
        ? mergedSettings.sliding_window_percentage
        : LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE,
  };
}
