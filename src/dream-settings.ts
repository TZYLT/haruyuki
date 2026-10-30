/**
 * Dream (F-06) settings: one global layer plus a per-agent map (requirement
 * Q-51, route §2.3).
 *
 * The keys are declared on `Settings` by module augmentation below, exactly
 * like `topic-settings.ts`: `settingsManager.getSetting(...)` stays typed, the
 * generic load / `updateSettings` / persist path needs no per-key code, and the
 * 2205-line (pinned) `settings-manager.ts` is not touched.
 *
 * Why one global layer and not the usual three: a dream run happens while the
 * user is away, so its policy must not depend on which directory the harness
 * happened to start in. Per-agent overrides live in `dreamSettingsByAgent`
 * rather than in `AgentSettings` because agent records are server-scoped and
 * the dream trigger reads them without a server key in its call path.
 *
 * The budget numbers are the user's 2026-10-30 ruling (closes O-1):
 * - pressure = max(output, uncachedRead / 4, cachedRead / 1000), threshold 75,000
 * - budget   = output + uncachedRead / 4 + cachedRead / 200
 * - per-run cap = min(pressure * factor, 100,000), factor 0.8
 * - no daily cap; one over-budget extension may be pre-authorized.
 * The weights live in `dream-budget-math.ts`; only the knob defaults live here.
 */
import type { PermissionTier } from "@/cron/cron-types";
import { settingsManager } from "@/settings-manager";
import { DREAM_TIERS, type DreamTier } from "@/types/dream-run-metadata";

declare module "@/settings-manager" {
  interface Settings {
    /** Master switch; default off, explicit configuration is the hard gate. */
    dreamEnabled?: boolean;
    /** Permission tier a dream child runs under (default `acceptEdits`). */
    dreamPermissionMode?: PermissionTier;
    /** Daily idle windows, each `HH:mm`–`HH:mm`; cross-midnight is legal. */
    dreamIdleWindows?: DreamIdleWindow[];
    /** Minutes of user inactivity required before a run may start. */
    dreamSilenceMinutes?: number;
    /** Pressure score (tokens) that must be reached before a run may start. */
    dreamPressureThreshold?: number;
    /** `budget = pressure * factor`, capped by `dreamMaxPerRun`. */
    dreamBudgetFactor?: number;
    /** Hard per-run token cap; `0` is not a valid value. */
    dreamMaxPerRun?: number;
    /** Hard daily token cap; `null` means "no daily cap" (O-1 ruling). */
    dreamMaxPerDay?: number | null;
    /** Wall-clock cap in minutes; `null` means "no limit". */
    dreamTimeLimitMinutes?: number | null;
    /** Per-tier on/off switches (closed tiers skip without spending budget). */
    dreamTiers?: Partial<Record<DreamTier, boolean>>;
    /** Trigger automatically once configured; `/dream run` is extra. */
    dreamAutoTrigger?: boolean;
    /** Over-budget extensions auto-approved per run (never waits for a user). */
    dreamOverBudgetApprovals?: number;
    /** Per-agent overrides of every knob above. */
    dreamSettingsByAgent?: Record<string, StoredDreamSettings>;
  }
}

/** One idle window; `end` earlier than `start` is a cross-midnight window. */
export interface DreamIdleWindow {
  /** `HH:mm`, 24-hour. */
  start: string;
  /** `HH:mm`, 24-hour. */
  end: string;
}

/**
 * Per-agent override shape. Every field is optional: an override only wins for
 * the fields it actually sets, so a later default change still reaches agents
 * that never touched that knob.
 */
export interface StoredDreamSettings {
  enabled?: boolean;
  permissionMode?: PermissionTier;
  idleWindows?: DreamIdleWindow[];
  silenceMinutes?: number;
  pressureThreshold?: number;
  budgetFactor?: number;
  maxPerRun?: number;
  maxPerDay?: number | null;
  timeLimitMinutes?: number | null;
  tiers?: Partial<Record<DreamTier, boolean>>;
  autoTrigger?: boolean;
  overBudgetApprovals?: number;
}

/** Every knob resolved; the shape the trigger, host, tools and UI consume. */
export interface ResolvedDreamSettings {
  enabled: boolean;
  permissionMode: PermissionTier;
  idleWindows: DreamIdleWindow[];
  silenceMinutes: number;
  pressureThreshold: number;
  budgetFactor: number;
  maxPerRun: number;
  maxPerDay: number | null;
  timeLimitMinutes: number | null;
  tiers: Record<DreamTier, boolean>;
  autoTrigger: boolean;
  overBudgetApprovals: number;
}

export const DEFAULT_DREAM_IDLE_WINDOWS: readonly DreamIdleWindow[] = [
  { start: "22:00", end: "07:00" },
];
export const DEFAULT_DREAM_SILENCE_MINUTES = 30;
/** User ruling 2026-10-30: pressure threshold = 75,000 tokens. */
export const DEFAULT_DREAM_PRESSURE_THRESHOLD = 75_000;
/** User ruling 2026-10-30: budget factor k = 0.8. */
export const DEFAULT_DREAM_BUDGET_FACTOR = 0.8;
/** User ruling 2026-10-30: hard per-run cap = 100,000 tokens. */
export const DEFAULT_DREAM_MAX_PER_RUN = 100_000;
/** User ruling 2026-10-30: no daily cap. */
export const DEFAULT_DREAM_MAX_PER_DAY: null = null;
/** Default permission tier: writable memory, no shell (requirement §5.5.3). */
export const DEFAULT_DREAM_PERMISSION_MODE: PermissionTier = "acceptEdits";
/** User ruling 2026-10-30: one over-budget extension may be auto-approved. */
export const DEFAULT_DREAM_OVER_BUDGET_APPROVALS = 1;

export const DREAM_SETTINGS_DEFAULTS: ResolvedDreamSettings = {
  enabled: false,
  permissionMode: DEFAULT_DREAM_PERMISSION_MODE,
  idleWindows: DEFAULT_DREAM_IDLE_WINDOWS.map((window) => ({ ...window })),
  silenceMinutes: DEFAULT_DREAM_SILENCE_MINUTES,
  pressureThreshold: DEFAULT_DREAM_PRESSURE_THRESHOLD,
  budgetFactor: DEFAULT_DREAM_BUDGET_FACTOR,
  maxPerRun: DEFAULT_DREAM_MAX_PER_RUN,
  maxPerDay: DEFAULT_DREAM_MAX_PER_DAY,
  timeLimitMinutes: null,
  tiers: {
    tidy: true,
    think: true,
    task: true,
    wander: true,
  },
  autoTrigger: true,
  overBudgetApprovals: DEFAULT_DREAM_OVER_BUDGET_APPROVALS,
};

const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPermissionTier(value: unknown): value is PermissionTier {
  return (
    value === "standard" || value === "acceptEdits" || value === "unrestricted"
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = finiteNumber(value);
  if (numeric === undefined) return fallback;
  const rounded = Math.trunc(numeric);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function positiveNumber(value: unknown, fallback: number): number {
  const numeric = finiteNumber(value);
  return numeric !== undefined && numeric > 0 ? numeric : fallback;
}

/**
 * Idle windows: a list of `HH:mm` pairs, at least one of which must be usable.
 * A window whose `start` equals `end` is dropped — it would mean "all day" or
 * "never" depending on the reader, and neither is what the user configured.
 */
export function normalizeDreamIdleWindows(
  value: unknown,
  fallback: readonly DreamIdleWindow[] = DEFAULT_DREAM_IDLE_WINDOWS,
): DreamIdleWindow[] {
  if (!Array.isArray(value)) {
    return fallback.map((window) => ({ ...window }));
  }
  const windows: DreamIdleWindow[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const start = record.start;
    const end = record.end;
    if (typeof start !== "string" || typeof end !== "string") continue;
    if (!HH_MM_RE.test(start) || !HH_MM_RE.test(end)) continue;
    if (start === end) continue;
    windows.push({ start, end });
  }
  return windows.length > 0
    ? windows
    : fallback.map((window) => ({ ...window }));
}

/** `timeLimitMinutes` / `maxPerDay`: `null` is a real value ("no limit"). */
function nullablePositive(
  value: unknown,
  fallback: number | null,
): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return fallback;
  const numeric = finiteNumber(value);
  if (numeric === undefined) return fallback;
  const rounded = Math.trunc(numeric);
  return rounded > 0 ? rounded : fallback;
}

/** Resolve one tier map: missing means default-on; explicit false wins. */
function resolveTiers(
  value: unknown,
  fallback: Record<DreamTier, boolean>,
): Record<DreamTier, boolean> {
  const source =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const tiers = {} as Record<DreamTier, boolean>;
  for (const tier of DREAM_TIERS) {
    const entry = source[tier];
    tiers[tier] = typeof entry === "boolean" ? entry : fallback[tier];
  }
  return tiers;
}

/** Field-by-field merge of the global layer and one agent's override. */
function mergeStored(
  global: StoredDreamSettings,
  override: StoredDreamSettings | undefined,
): StoredDreamSettings {
  if (!override) return global;
  const merged: StoredDreamSettings = { ...global };
  // `undefined` means "not overridden"; `null` is a value for the two nullable
  // knobs and must survive the merge.
  for (const key of Object.keys(override) as Array<keyof StoredDreamSettings>) {
    if (override[key] !== undefined) {
      (merged as Record<string, unknown>)[key] = override[key];
    }
  }
  return merged;
}

function storedFromSettingsRecord(record: unknown): StoredDreamSettings {
  if (typeof record !== "object" || record === null) return {};
  const source = record as Record<string, unknown>;
  const stored: StoredDreamSettings = {};
  if (source.dreamEnabled !== undefined)
    stored.enabled = source.dreamEnabled as boolean;
  if (source.dreamPermissionMode !== undefined) {
    stored.permissionMode = source.dreamPermissionMode as PermissionTier;
  }
  if (source.dreamIdleWindows !== undefined) {
    stored.idleWindows = source.dreamIdleWindows as DreamIdleWindow[];
  }
  if (source.dreamSilenceMinutes !== undefined) {
    stored.silenceMinutes = source.dreamSilenceMinutes as number;
  }
  if (source.dreamPressureThreshold !== undefined) {
    stored.pressureThreshold = source.dreamPressureThreshold as number;
  }
  if (source.dreamBudgetFactor !== undefined) {
    stored.budgetFactor = source.dreamBudgetFactor as number;
  }
  if (source.dreamMaxPerRun !== undefined) {
    stored.maxPerRun = source.dreamMaxPerRun as number;
  }
  if (source.dreamMaxPerDay !== undefined) {
    stored.maxPerDay = source.dreamMaxPerDay as number | null;
  }
  if (source.dreamTimeLimitMinutes !== undefined) {
    stored.timeLimitMinutes = source.dreamTimeLimitMinutes as number | null;
  }
  if (source.dreamTiers !== undefined) {
    stored.tiers = source.dreamTiers as Partial<Record<DreamTier, boolean>>;
  }
  if (source.dreamAutoTrigger !== undefined) {
    stored.autoTrigger = source.dreamAutoTrigger as boolean;
  }
  if (source.dreamOverBudgetApprovals !== undefined) {
    stored.overBudgetApprovals = source.dreamOverBudgetApprovals as number;
  }
  return stored;
}

/**
 * Resolve every knob from a settings record plus one agent's override.
 *
 * Unusable values fall back to the default instead of propagating: a negative
 * silence or a zero budget would make the trigger "never fire", which reads as
 * a bug rather than a preference.
 */
export function resolveDreamSettings(
  record: unknown,
  agentId?: string,
): ResolvedDreamSettings {
  const stored = storedFromSettingsRecord(record);
  const override =
    agentId && typeof record === "object" && record !== null
      ? (record as Record<string, unknown>).dreamSettingsByAgent
      : undefined;
  const agentOverride =
    override && typeof override === "object"
      ? (override as Record<string, StoredDreamSettings>)[agentId ?? ""]
      : undefined;
  const merged = mergeStored(stored, agentOverride);

  const requestedMaxPerDay =
    merged.maxPerDay === undefined
      ? DEFAULT_DREAM_MAX_PER_DAY
      : nullablePositive(merged.maxPerDay, DEFAULT_DREAM_MAX_PER_DAY);

  return {
    enabled: booleanOr(merged.enabled, DREAM_SETTINGS_DEFAULTS.enabled),
    permissionMode: isPermissionTier(merged.permissionMode)
      ? merged.permissionMode
      : DREAM_SETTINGS_DEFAULTS.permissionMode,
    idleWindows: normalizeDreamIdleWindows(merged.idleWindows),
    silenceMinutes: boundedInteger(
      merged.silenceMinutes,
      DREAM_SETTINGS_DEFAULTS.silenceMinutes,
      0,
      24 * 60,
    ),
    pressureThreshold: positiveNumber(
      merged.pressureThreshold,
      DREAM_SETTINGS_DEFAULTS.pressureThreshold,
    ),
    budgetFactor: positiveNumber(
      merged.budgetFactor,
      DREAM_SETTINGS_DEFAULTS.budgetFactor,
    ),
    maxPerRun: boundedInteger(
      merged.maxPerRun,
      DREAM_SETTINGS_DEFAULTS.maxPerRun,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxPerDay: requestedMaxPerDay ?? null,
    timeLimitMinutes:
      nullablePositive(
        merged.timeLimitMinutes,
        DREAM_SETTINGS_DEFAULTS.timeLimitMinutes,
      ) ?? null,
    tiers: resolveTiers(merged.tiers, DREAM_SETTINGS_DEFAULTS.tiers),
    autoTrigger: booleanOr(
      merged.autoTrigger,
      DREAM_SETTINGS_DEFAULTS.autoTrigger,
    ),
    overBudgetApprovals: boundedInteger(
      merged.overBudgetApprovals,
      DREAM_SETTINGS_DEFAULTS.overBudgetApprovals,
      0,
      100,
    ),
  };
}

/**
 * The resolved knobs for one agent. Settings unavailable (early startup, tests
 * without an initialized manager) falls back to the defaults rather than
 * throwing: the trigger runs on a timer path that must not fail because of a
 * preference file.
 */
export function readDreamSettings(agentId?: string): ResolvedDreamSettings {
  try {
    return resolveDreamSettings(settingsManager.getSettings(), agentId);
  } catch {
    return resolveDreamSettings(undefined, agentId);
  }
}

function globalUpdatesFromPatch(
  patch: StoredDreamSettings,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (patch.enabled !== undefined) updates.dreamEnabled = patch.enabled;
  if (patch.permissionMode !== undefined) {
    updates.dreamPermissionMode = patch.permissionMode;
  }
  if (patch.idleWindows !== undefined) {
    updates.dreamIdleWindows = patch.idleWindows;
  }
  if (patch.silenceMinutes !== undefined) {
    updates.dreamSilenceMinutes = patch.silenceMinutes;
  }
  if (patch.pressureThreshold !== undefined) {
    updates.dreamPressureThreshold = patch.pressureThreshold;
  }
  if (patch.budgetFactor !== undefined) {
    updates.dreamBudgetFactor = patch.budgetFactor;
  }
  if (patch.maxPerRun !== undefined) updates.dreamMaxPerRun = patch.maxPerRun;
  if (patch.maxPerDay !== undefined) updates.dreamMaxPerDay = patch.maxPerDay;
  if (patch.timeLimitMinutes !== undefined) {
    updates.dreamTimeLimitMinutes = patch.timeLimitMinutes;
  }
  if (patch.tiers !== undefined) updates.dreamTiers = patch.tiers;
  if (patch.autoTrigger !== undefined) {
    updates.dreamAutoTrigger = patch.autoTrigger;
  }
  if (patch.overBudgetApprovals !== undefined) {
    updates.dreamOverBudgetApprovals = patch.overBudgetApprovals;
  }
  return updates;
}

/**
 * Write a knob patch. Global by default; with `agentId` the fields are merged
 * into that agent's entry in `dreamSettingsByAgent`.
 *
 * Callers pass only the fields the user actually changed — passing the whole
 * resolved object would turn every default into an explicit override and stop
 * future default changes from reaching configured agents.
 */
export function updateDreamSettings(
  patch: StoredDreamSettings,
  agentId?: string,
): void {
  if (!agentId) {
    const updates = globalUpdatesFromPatch(patch);
    // `tiers` is a *map* of four independent switches, not one value: a caller
    // that reports only the tier the user just toggled must not erase the other
    // three back to their defaults (F-06 review: two settings-page toggles in a
    // row used to undo each other).
    if (patch.tiers !== undefined) {
      updates.dreamTiers = {
        ...(settingsManager.getSettings().dreamTiers ?? {}),
        ...patch.tiers,
      };
    }
    settingsManager.updateSettings(updates);
    return;
  }
  const current = settingsManager.getSettings().dreamSettingsByAgent ?? {};
  const existing = current[agentId] ?? {};
  const merged: StoredDreamSettings = { ...existing };
  for (const key of Object.keys(patch) as Array<keyof StoredDreamSettings>) {
    if (patch[key] !== undefined) {
      (merged as Record<string, unknown>)[key] = patch[key];
    }
  }
  // Same merge for the per-agent override: the stored override only carries the
  // tiers a user touched, and a one-tier patch must not drop the others.
  if (patch.tiers !== undefined) {
    merged.tiers = { ...(existing.tiers ?? {}), ...patch.tiers };
  }
  settingsManager.updateSettings({
    dreamSettingsByAgent: { ...current, [agentId]: merged },
  });
}

/**
 * Drop one agent's overrides. The global layer stays as configured; removing
 * the last entry deletes the map itself so the settings file does not keep an
 * empty object around.
 */
export function clearDreamSettingsForAgent(agentId: string): void {
  const current = settingsManager.getSettings().dreamSettingsByAgent;
  if (!current || !(agentId in current)) return;
  const next = { ...current };
  delete next[agentId];
  settingsManager.updateSettings({
    dreamSettingsByAgent: Object.keys(next).length > 0 ? next : undefined,
  });
}
