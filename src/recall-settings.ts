/**
 * Feature ②'s tunables (《26》§6.9).
 *
 * The knobs are read from three layers — the reminder provider in `reminders/`,
 * the `/recall` command in `cli/`, and the CLI subcommand — so they are resolved
 * here, once, instead of each reader re-deriving them from raw settings.
 *
 * They live in this module rather than in `settings-manager.ts` because that file
 * is pinned exactly at its size baseline (it may only shrink). The keys are
 * declared on `Settings` by module augmentation below, so `updateSettings` stays
 * typed and the generic settings path — load, persist, defaults — needs no
 * per-key code. `topic-settings.ts` is the same shape.
 *
 * Scope: **global**, by the user's ruling (《26》§10.2 item 7), and for the same
 * reason the topic knobs are: the provider runs on the turn path, where there is
 * no project scope to read, so a per-project override could not be honoured
 * consistently. Adding the three-level form later means the three interfaces plus
 * the collision routing that `AGENTS.md` lists.
 */

import {
  isRecallDisplay,
  RECALL_DISPLAY_DEFAULT,
  type RecallDisplay,
} from "@/reminders/recall-display";
import {
  isRecallDiversity,
  RECALL_DEFAULTS,
  type RecallDiversity,
  type RecallOptions,
} from "@/reminders/recall-port";
import { settingsManager } from "@/settings-manager";

declare module "@/settings-manager" {
  interface Settings {
    /** Feature ② off means "never search", not "search and hide". */
    recallEnabled?: boolean;
    /** Wall-clock budget per turn in ms. `0` = no budget. */
    recallTimeoutMs?: number;
    /** User turns a recalled passage stays suppressed for. `0` = no window. */
    recallDedupTurns?: number;
    /** Passages injected per turn, across both sources. */
    recallLimit?: number;
    /** Characters kept per passage before truncation. */
    recallExcerptCharacters?: number;
    /** Hard ceiling on the injected excerpt text. */
    recallTotalCharacters?: number;
    /** Relative score floor, as a share of the best surviving score. */
    recallMinScoreRatio?: number;
    /** How the slots are shared out; see `RecallDiversity`. */
    recallDiversity?: RecallDiversity;
    /** Memory context: lines on each side of the hit line. */
    recallExcerptLines?: number;
    /** How much of an injected block the transcript shows. */
    recallDisplay?: RecallDisplay;
  }
}

export type RecallSettingKey =
  | "recallEnabled"
  | "recallTimeoutMs"
  | "recallDedupTurns"
  | "recallLimit"
  | "recallExcerptCharacters"
  | "recallTotalCharacters"
  | "recallMinScoreRatio"
  | "recallDiversity"
  | "recallExcerptLines"
  | "recallDisplay";

/** Every knob resolved; the shape the rest of the app consumes. */
export interface ResolvedRecallSettings {
  enabled: boolean;
  timeoutMs: number;
  dedupTurns: number;
  limit: number;
  excerptCharacters: number;
  totalCharacters: number;
  minScoreRatio: number;
  diversity: RecallDiversity;
  excerptLines: number;
  display: RecallDisplay;
}

export const RECALL_SETTING_DEFAULTS: ResolvedRecallSettings = {
  enabled: true,
  timeoutMs: RECALL_DEFAULTS.timeoutMs,
  dedupTurns: RECALL_DEFAULTS.dedupTurns,
  limit: RECALL_DEFAULTS.limit,
  excerptCharacters: RECALL_DEFAULTS.excerptCharacters,
  totalCharacters: RECALL_DEFAULTS.totalCharacters,
  minScoreRatio: RECALL_DEFAULTS.minScoreRatio,
  diversity: RECALL_DEFAULTS.diversity,
  excerptLines: RECALL_DEFAULTS.excerptLines,
  display: RECALL_DISPLAY_DEFAULT,
};

/**
 * A count: `undefined` or unusable falls back to the default, `0` is kept
 * because for every count here it means "off" rather than "unset".
 */
function resolveCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

export function resolveRecallSettings(
  record: Partial<Record<RecallSettingKey, unknown>> | undefined,
): ResolvedRecallSettings {
  if (!record) return { ...RECALL_SETTING_DEFAULTS };
  const diversity = record.recallDiversity;
  const display = record.recallDisplay;
  return {
    // Only an explicit `false` switches recall off: a hand-edited settings file
    // with `"false"` (or anything else non-boolean) must not silently disable a
    // feature the user never turned off.
    enabled: record.recallEnabled !== false,
    timeoutMs: resolveCount(
      record.recallTimeoutMs,
      RECALL_SETTING_DEFAULTS.timeoutMs,
    ),
    dedupTurns: resolveCount(
      record.recallDedupTurns,
      RECALL_SETTING_DEFAULTS.dedupTurns,
    ),
    limit: resolveCount(record.recallLimit, RECALL_SETTING_DEFAULTS.limit),
    excerptCharacters: resolveCount(
      record.recallExcerptCharacters,
      RECALL_SETTING_DEFAULTS.excerptCharacters,
    ),
    totalCharacters: resolveCount(
      record.recallTotalCharacters,
      RECALL_SETTING_DEFAULTS.totalCharacters,
    ),
    // `[0, 1]` rather than `>= 0`: above 1 no score can clear the floor, so the
    // feature would search every turn and silently never inject — a state
    // `/recall ratio` refuses to write, and a reader must not accept what its own
    // writer will not produce.
    minScoreRatio:
      typeof record.recallMinScoreRatio === "number" &&
      Number.isFinite(record.recallMinScoreRatio) &&
      record.recallMinScoreRatio >= 0 &&
      record.recallMinScoreRatio <= 1
        ? record.recallMinScoreRatio
        : RECALL_SETTING_DEFAULTS.minScoreRatio,
    diversity: isRecallDiversity(diversity)
      ? diversity
      : RECALL_SETTING_DEFAULTS.diversity,
    excerptLines: resolveCount(
      record.recallExcerptLines,
      RECALL_SETTING_DEFAULTS.excerptLines,
    ),
    display: isRecallDisplay(display)
      ? display
      : RECALL_SETTING_DEFAULTS.display,
  };
}

/**
 * The knobs as the search itself wants them.
 *
 * `candidateLimit` and `neighbors` are not user-facing (no command reaches
 * them), so they stay at the port defaults — but they travel with the rest so
 * this is the single place that builds a full option record.
 */
export function recallOptionsFromSettings(
  settings: ResolvedRecallSettings,
): RecallOptions {
  return {
    ...RECALL_DEFAULTS,
    limit: settings.limit,
    excerptCharacters: settings.excerptCharacters,
    totalCharacters: settings.totalCharacters,
    minScoreRatio: settings.minScoreRatio,
    diversity: settings.diversity,
    excerptLines: settings.excerptLines,
    dedupTurns: settings.dedupTurns,
    timeoutMs: settings.timeoutMs,
  };
}

/**
 * The knobs as configured. Settings unavailable (early startup, tests without an
 * initialized manager) falls back to the defaults rather than throwing: every
 * reader runs on a path that must not fail because of a preference.
 */
export function readRecallSettings(): ResolvedRecallSettings {
  try {
    return resolveRecallSettings(settingsManager.getSettings());
  } catch {
    return { ...RECALL_SETTING_DEFAULTS };
  }
}

/**
 * One line naming every effective knob.
 *
 * Lives here rather than beside a caller because three surfaces print it — the
 * `/recall` receipt, the settings picker, and `/recall status` — and they are in
 * two layers: the reminders layer may not import a CLI command module, so a line
 * they share has to sit below both. This is also the only place that resolves the
 * knobs, so it is the only place that can describe them without a second opinion.
 */
export function formatRecallSettingsLine(
  settings: ResolvedRecallSettings,
): string {
  return `limit ${settings.limit} · excerpt ${settings.excerptCharacters}/${settings.totalCharacters} chars · ratio ${settings.minScoreRatio} · diversity ${settings.diversity} · dedup ${settings.dedupTurns} turns · timeout ${
    settings.timeoutMs === 0 ? "none" : `${settings.timeoutMs}ms`
  } · display ${settings.display}`;
}
