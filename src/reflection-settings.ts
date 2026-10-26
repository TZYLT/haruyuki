/**
 * Reflection (sleep-time) settings: the stored shapes and the pure
 * normalization / legacy-migration rules.
 *
 * F-03 replaced the three-way `reflectionTrigger` selector and the
 * `reflectionMerge*` knobs with two independent switches plus a timeout and a
 * delete-on-success flag. The legacy names stay in this file as **read-only
 * migration inputs**: the old keys are still on disk in existing configs and
 * are still accepted on the wire (`protocol_v2`), but nothing writes them any
 * more.
 */

/** Legacy trigger selector. Migrated onto the two switches, never written. */
export type ReflectionTrigger = "off" | "step-count" | "compaction-event";

/** Legacy merge policy. Retired by F-03; ignored when read. */
export type ReflectionMergeMode = "auto" | "explicit";

export const DEFAULT_REFLECTION_ON_COMPACTION = true;
export const DEFAULT_REFLECTION_EVERY_USER_MESSAGES = 0;
/** Suggestion shown when the user turns the message counter on. */
export const SUGGESTED_REFLECTION_EVERY_USER_MESSAGES = 25;
export const DEFAULT_REFLECTION_STEP_COUNT =
  SUGGESTED_REFLECTION_EVERY_USER_MESSAGES;
export const DEFAULT_REFLECTION_TIMEOUT_MINUTES = 3;
export const MIN_REFLECTION_TIMEOUT_MINUTES = 1;
export const MAX_REFLECTION_TIMEOUT_MINUTES = 60;
export const DEFAULT_REFLECTION_DELETE_SESSION_ON_SUCCESS = true;

/**
 * The resolved reflection policy: what the trigger, launcher and settings page
 * all read.
 */
export interface ReflectionSettings {
  /** Run once after every completed compaction (automatic or manual). */
  onCompaction: boolean;
  /** Run every N user messages submitted into the model context; 0 = off. */
  everyUserMessages: number;
  /** Wall-clock cap for one run, automatic and manual alike (1–60). */
  timeoutMinutes: number;
  /** Delete the reflection session once it succeeds (including no-op). */
  deleteSessionOnSuccess: boolean;
  /**
   * @deprecated Derived display alias for the mod surface / app-server wire.
   * `getReflectionSettings` fills it in; nothing is stored under this name.
   */
  trigger?: ReflectionTrigger;
  /** @deprecated Derived display alias; see `trigger`. */
  stepCount?: number;
  /** @deprecated Retired merge policy; always `"auto"` when derived. */
  merge?: ReflectionMergeMode;
  /** @deprecated Retired merge policy; always `""` when derived. */
  mergeInstructions?: string;
}

/** Per-agent (or per-scope) stored copy of {@link ReflectionSettings}. */
export interface StoredReflectionSettings {
  /** Legacy selector, migrated onto the two switches on read. */
  trigger?: ReflectionTrigger;
  /** Legacy step count, paired with `trigger === "step-count"`. */
  stepCount?: number;
  /** Legacy merge policy — read and ignored. */
  merge?: ReflectionMergeMode;
  /** Legacy merge instructions — read and ignored. */
  mergeInstructions?: string;
  onCompaction?: boolean;
  everyUserMessages?: number;
  timeoutMinutes?: number;
  deleteSessionOnSuccess?: boolean;
}

export const DEFAULT_REFLECTION_SETTINGS: ReflectionSettings = {
  onCompaction: DEFAULT_REFLECTION_ON_COMPACTION,
  everyUserMessages: DEFAULT_REFLECTION_EVERY_USER_MESSAGES,
  timeoutMinutes: DEFAULT_REFLECTION_TIMEOUT_MINUTES,
  deleteSessionOnSuccess: DEFAULT_REFLECTION_DELETE_SESSION_ON_SUCCESS,
};

/**
 * Host policy. F-03 removed the Windows gate: the settings switch is the only
 * master switch and every platform runs the same defaults.
 */
export function isAutoReflectionEnabled(): boolean {
  return true;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

export function normalizeReflectionOnCompaction(
  value: unknown,
  fallback: boolean = DEFAULT_REFLECTION_ON_COMPACTION,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeReflectionEveryUserMessages(
  value: unknown,
  fallback: number = DEFAULT_REFLECTION_EVERY_USER_MESSAGES,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function normalizeReflectionTimeoutMinutes(
  value: unknown,
  fallback: number = DEFAULT_REFLECTION_TIMEOUT_MINUTES,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.trunc(value);
  if (rounded < MIN_REFLECTION_TIMEOUT_MINUTES) {
    return MIN_REFLECTION_TIMEOUT_MINUTES;
  }
  if (rounded > MAX_REFLECTION_TIMEOUT_MINUTES) {
    return MAX_REFLECTION_TIMEOUT_MINUTES;
  }
  return rounded;
}

export function normalizeReflectionDeleteSessionOnSuccess(
  value: unknown,
  fallback: boolean = DEFAULT_REFLECTION_DELETE_SESSION_ON_SUCCESS,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Requirement §5.14.3: `off` turns both switches off; `step-count` keeps the
 * message counter (25 when the old value is missing) and stops the compaction
 * trigger; `compaction-event` turns the compaction trigger on and the counter
 * off.
 */
export function legacyTriggerToReflectionSwitches(
  trigger: ReflectionTrigger,
  stepCount?: unknown,
): Pick<ReflectionSettings, "onCompaction" | "everyUserMessages"> {
  switch (trigger) {
    case "off":
      return { onCompaction: false, everyUserMessages: 0 };
    case "compaction-event":
      return { onCompaction: true, everyUserMessages: 0 };
    case "step-count":
      return {
        onCompaction: false,
        everyUserMessages: isPositiveInteger(stepCount)
          ? stepCount
          : SUGGESTED_REFLECTION_EVERY_USER_MESSAGES,
      };
  }
}

/** Requirement §5.13.2's oldest layer: the `memoryReminderInterval` mode. */
export function legacyReminderModeToReflectionSwitches(
  mode: unknown,
): Pick<ReflectionSettings, "onCompaction" | "everyUserMessages"> | null {
  if (typeof mode === "number") {
    return {
      onCompaction: false,
      everyUserMessages: isPositiveInteger(mode)
        ? mode
        : SUGGESTED_REFLECTION_EVERY_USER_MESSAGES,
    };
  }
  if (mode === null) {
    return { onCompaction: false, everyUserMessages: 0 };
  }
  if (mode === "compaction" || mode === "auto-compaction") {
    return { onCompaction: true, everyUserMessages: 0 };
  }
  return null;
}

/**
 * One-time migration of a stored object's legacy keys onto the new names.
 *
 * Pure and replayable: callers can run it on every read. New keys always win;
 * legacy keys are only consulted when the corresponding new key is absent.
 * Returns only the keys that the object actually specified, so it composes in
 * the global → project → local → per-agent chain.
 */
export function migrateLegacyReflectionKeys(
  raw: {
    memoryReminderInterval?: unknown;
    trigger?: unknown;
    stepCount?: unknown;
    onCompaction?: unknown;
    everyUserMessages?: unknown;
    timeoutMinutes?: unknown;
    deleteSessionOnSuccess?: unknown;
  },
  fallback: ReflectionSettings = DEFAULT_REFLECTION_SETTINGS,
): Partial<ReflectionSettings> {
  const resolved: Partial<ReflectionSettings> = {};

  const legacyMode = legacyReminderModeToReflectionSwitches(
    raw.memoryReminderInterval,
  );
  if (legacyMode) {
    resolved.onCompaction = legacyMode.onCompaction;
    resolved.everyUserMessages = legacyMode.everyUserMessages;
  }

  const legacyTrigger =
    raw.trigger === "off" ||
    raw.trigger === "step-count" ||
    raw.trigger === "compaction-event"
      ? raw.trigger
      : undefined;
  if (legacyTrigger !== undefined) {
    if (raw.onCompaction === undefined && raw.everyUserMessages === undefined) {
      const migrated = legacyTriggerToReflectionSwitches(
        legacyTrigger,
        raw.stepCount,
      );
      resolved.onCompaction = migrated.onCompaction;
      resolved.everyUserMessages = migrated.everyUserMessages;
    }
  }

  if (raw.onCompaction !== undefined) {
    resolved.onCompaction = normalizeReflectionOnCompaction(
      raw.onCompaction,
      resolved.onCompaction ?? fallback.onCompaction,
    );
  }
  if (raw.everyUserMessages !== undefined) {
    resolved.everyUserMessages = normalizeReflectionEveryUserMessages(
      raw.everyUserMessages,
      resolved.everyUserMessages ?? fallback.everyUserMessages,
    );
  }
  if (raw.timeoutMinutes !== undefined) {
    resolved.timeoutMinutes = normalizeReflectionTimeoutMinutes(
      raw.timeoutMinutes,
      fallback.timeoutMinutes,
    );
  }
  if (raw.deleteSessionOnSuccess !== undefined) {
    resolved.deleteSessionOnSuccess = normalizeReflectionDeleteSessionOnSuccess(
      raw.deleteSessionOnSuccess,
      fallback.deleteSessionOnSuccess,
    );
  }

  return resolved;
}
