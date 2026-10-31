import type { PermissionTier } from "@/cron/cron-types";
import type {
  DreamRunCommand,
  DreamSettingsPatch,
  DreamStatusCommand,
  GetDreamSettingsCommand,
  SetDreamSettingsCommand,
} from "@/types/dream-protocol";
import { DREAM_TIERS, type DreamTier } from "@/types/dream-run-metadata";
import { isAgentRuntimeScope, isObjectRecord } from "./protocol-validation";

const PERMISSION_TIERS: readonly PermissionTier[] = [
  "standard",
  "acceptEdits",
  "unrestricted",
];

function isPermissionTier(value: unknown): value is PermissionTier {
  return (
    typeof value === "string" &&
    (PERMISSION_TIERS as readonly string[]).includes(value)
  );
}

function isIdleWindow(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.start === "string" &&
    /^\d{2}:\d{2}$/.test(value.start) &&
    typeof value.end === "string" &&
    /^\d{2}:\d{2}$/.test(value.end)
  );
}

function isDreamTierRecord(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return DREAM_TIERS.every(
    (tier: DreamTier) =>
      value[tier] === undefined || typeof value[tier] === "boolean",
  );
}

function isDreamSettingsPatch(value: unknown): value is DreamSettingsPatch {
  if (!isObjectRecord(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return false;
  }
  if (
    value.permissionMode !== undefined &&
    !isPermissionTier(value.permissionMode)
  ) {
    return false;
  }
  if (value.idleWindows !== undefined) {
    if (!Array.isArray(value.idleWindows)) return false;
    if (!value.idleWindows.every(isIdleWindow)) return false;
  }
  for (const key of [
    "silenceMinutes",
    "pressureThreshold",
    "maxPerRun",
    "overBudgetApprovals",
  ] as const) {
    const field = value[key];
    if (
      field !== undefined &&
      (!Number.isInteger(field) || (field as number) < 0)
    ) {
      return false;
    }
  }
  if (value.budgetFactor !== undefined) {
    if (typeof value.budgetFactor !== "number") return false;
    if (!(value.budgetFactor > 0)) return false;
  }
  const maxPerDay = value.maxPerDay;
  if (maxPerDay !== undefined && maxPerDay !== null) {
    if (
      typeof maxPerDay !== "number" ||
      !Number.isInteger(maxPerDay) ||
      maxPerDay < 0
    ) {
      return false;
    }
  }
  const timeLimitMinutes = value.timeLimitMinutes;
  if (timeLimitMinutes !== undefined && timeLimitMinutes !== null) {
    if (
      typeof timeLimitMinutes !== "number" ||
      !Number.isInteger(timeLimitMinutes) ||
      timeLimitMinutes <= 0
    ) {
      return false;
    }
  }
  if (value.tiers !== undefined && !isDreamTierRecord(value.tiers)) {
    return false;
  }
  if (
    value.autoTrigger !== undefined &&
    typeof value.autoTrigger !== "boolean"
  ) {
    return false;
  }
  return true;
}

export function isDreamStatusCommand(
  value: unknown,
): value is DreamStatusCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "dream_status" &&
    typeof value.request_id === "string" &&
    value.request_id.length > 0 &&
    isAgentRuntimeScope(value.runtime)
  );
}

export function isDreamRunCommand(value: unknown): value is DreamRunCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "dream_run" &&
    typeof value.request_id === "string" &&
    value.request_id.length > 0 &&
    isAgentRuntimeScope(value.runtime) &&
    (value.trigger === undefined || value.trigger === "manual")
  );
}

export function isGetDreamSettingsCommand(
  value: unknown,
): value is GetDreamSettingsCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "get_dream_settings" &&
    typeof value.request_id === "string" &&
    value.request_id.length > 0 &&
    isAgentRuntimeScope(value.runtime)
  );
}

export function isSetDreamSettingsCommand(
  value: unknown,
): value is SetDreamSettingsCommand {
  if (!isObjectRecord(value)) return false;
  if (
    value.type !== "set_dream_settings" ||
    typeof value.request_id !== "string" ||
    value.request_id.length === 0 ||
    !isAgentRuntimeScope(value.runtime) ||
    !isDreamSettingsPatch(value.settings)
  ) {
    return false;
  }
  return (
    value.scope === undefined ||
    value.scope === "global" ||
    value.scope === "agent"
  );
}
