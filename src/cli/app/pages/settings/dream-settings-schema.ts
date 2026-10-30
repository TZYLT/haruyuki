/**
 * The settings page's Dream section (F-06 R-5.9.2).
 *
 * One control per stored key, all writing through `updateDreamSettings` — the
 * module that owns the keys — and all on the **global layer**: the per-agent
 * override map stays an API capability rather than a second control over the
 * same knob (Q-51). The page reads the *resolved* value, so an agent override
 * written elsewhere is what it paints; reading the global layer would show a
 * value the runtime is not using.
 *
 * Split from `settings-schema.ts` for the reason that file is a table of every
 * setting: sixteen rows and their four small parsers are a section of their
 * own, and the 1,000-line ceiling is where a reader stops holding the table in
 * one pass.
 */

import {
  formatDreamWindowsInput,
  isDreamConfigured,
  parseDreamWindowsInput,
} from "@/cli/commands/dream";
import {
  type ResolvedDreamSettings,
  readDreamSettings,
  type StoredDreamSettings,
  updateDreamSettings,
} from "@/dream-settings";
import { DREAM_TIERS, type DreamTier } from "@/types/dream-run-metadata";
import type {
  SettingsContext,
  SettingsGroup,
  SettingsItem,
} from "./settings-model";

// R-5.9.2's minimal set, one control per stored key.

/** A toggle's canonical value, the same spelling the page's other rows use. */
const isOn = (value: boolean): string => (value ? "true" : "false");

const DREAM_PERMISSION_OPTIONS = [
  { value: "standard", label: "standard (read-only)" },
  { value: "acceptEdits", label: "acceptEdits (read-write, no shell)" },
  { value: "unrestricted", label: "unrestricted" },
] as const;

const NO_LIMIT = "no limit";

const DREAM_TIER_LABELS: Record<DreamTier, string> = {
  tidy: "Tidy",
  think: "Think",
  task: "Task",
  wander: "Wander",
};

function dreamSettingsFor(ctx: SettingsContext): ResolvedDreamSettings {
  return readDreamSettings(ctx.agentId);
}

function writeDream(patch: StoredDreamSettings): void {
  updateDreamSettings(patch);
}

/** `no limit` (or empty) means `null`; a positive integer means itself. */
function parseNullableTokens(raw: string): number | null | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === NO_LIMIT) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : undefined;
}

function validateNullableTokens(raw: string): string | null {
  return parseNullableTokens(raw) === undefined
    ? `needs a positive whole number, or "${NO_LIMIT}"`
    : null;
}

export const DREAM_SETTINGS_GROUP: SettingsGroup = {
  id: "dream",
  section: "memory",
  label: "Dream",
};

export const DREAM_SETTINGS_ITEMS: readonly SettingsItem[] = [
  // ---------------------------------------------------------------- Dream (F-06)
  // R-5.9.2's minimal set. "Configured" (R-5.9.4's hard gate) is a decision the
  // user has to have made: the two keys the wizard writes, not a resolved
  // default, which is why the setup row says which state the gate is in.
  {
    id: "dreamEnabled",
    section: "memory",
    group: "dream",
    label: "Dream enabled",
    kind: "toggle",
    scope: "global",
    editable: true,
    read: (ctx) => isOn(dreamSettingsFor(ctx).enabled),
    write: (_ctx, value) => {
      writeDream({ enabled: value === "true" });
    },
  },
  {
    id: "dreamPermissionMode",
    section: "memory",
    group: "dream",
    label: "Permission tier",
    kind: "select",
    options: DREAM_PERMISSION_OPTIONS,
    scope: "global",
    editable: true,
    read: (ctx) => dreamSettingsFor(ctx).permissionMode,
    write: (_ctx, value) => {
      writeDream({
        permissionMode: value as "standard" | "acceptEdits" | "unrestricted",
      });
    },
  },
  {
    id: "dreamIdleWindows",
    section: "memory",
    group: "dream",
    label: "Idle windows",
    kind: "text",
    scope: "global",
    editable: true,
    validate: (value) =>
      parseDreamWindowsInput(value) === null
        ? "use HH:MM-HH:MM pairs, comma separated"
        : null,
    read: (ctx) => formatDreamWindowsInput(dreamSettingsFor(ctx).idleWindows),
    write: (_ctx, value) => {
      const windows = parseDreamWindowsInput(value);
      if (windows) writeDream({ idleWindows: windows });
    },
  },
  {
    id: "dreamSilenceMinutes",
    section: "memory",
    group: "dream",
    label: "Silence before a run (minutes)",
    kind: "number",
    min: 0,
    max: 24 * 60,
    step: 5,
    scope: "global",
    editable: true,
    read: (ctx) => String(dreamSettingsFor(ctx).silenceMinutes),
    write: (_ctx, value) => {
      writeDream({ silenceMinutes: Number(value) });
    },
  },
  {
    id: "dreamPressureThreshold",
    section: "memory",
    group: "dream",
    label: "Pressure threshold (tokens)",
    kind: "number",
    min: 1,
    step: 1_000,
    scope: "global",
    editable: true,
    read: (ctx) => String(dreamSettingsFor(ctx).pressureThreshold),
    write: (_ctx, value) => {
      writeDream({ pressureThreshold: Number(value) });
    },
  },
  {
    id: "dreamBudgetFactor",
    section: "memory",
    group: "dream",
    label: "Budget factor (× pressure)",
    kind: "text",
    scope: "global",
    editable: true,
    validate: (value) => {
      const factor = Number(value);
      if (!Number.isFinite(factor)) return "needs a number";
      if (factor <= 0) return "must be greater than 0";
      if (factor > 10) return "must be at most 10";
      return null;
    },
    read: (ctx) => String(dreamSettingsFor(ctx).budgetFactor),
    write: (_ctx, value) => {
      writeDream({ budgetFactor: Number(value) });
    },
  },
  {
    id: "dreamMaxPerRun",
    section: "memory",
    group: "dream",
    label: "Budget per run (tokens)",
    kind: "number",
    min: 1,
    step: 1_000,
    scope: "global",
    editable: true,
    read: (ctx) => String(dreamSettingsFor(ctx).maxPerRun),
    write: (_ctx, value) => {
      writeDream({ maxPerRun: Number(value) });
    },
  },
  {
    id: "dreamMaxPerDay",
    section: "memory",
    group: "dream",
    label: "Daily cap (tokens)",
    kind: "text",
    scope: "global",
    editable: true,
    validate: validateNullableTokens,
    read: (ctx) => {
      const cap = dreamSettingsFor(ctx).maxPerDay;
      return cap === null ? NO_LIMIT : String(cap);
    },
    write: (_ctx, value) => {
      const cap = parseNullableTokens(value);
      if (cap !== undefined) writeDream({ maxPerDay: cap });
    },
  },
  {
    id: "dreamTimeLimitMinutes",
    section: "memory",
    group: "dream",
    label: "Time limit (minutes)",
    kind: "text",
    scope: "global",
    editable: true,
    validate: validateNullableTokens,
    read: (ctx) => {
      const limit = dreamSettingsFor(ctx).timeLimitMinutes;
      return limit === null ? NO_LIMIT : String(limit);
    },
    write: (_ctx, value) => {
      const limit = parseNullableTokens(value);
      if (limit !== undefined) writeDream({ timeLimitMinutes: limit });
    },
  },
  {
    id: "dreamAutoTrigger",
    section: "memory",
    group: "dream",
    label: "Trigger automatically",
    kind: "toggle",
    scope: "global",
    editable: true,
    read: (ctx) => isOn(dreamSettingsFor(ctx).autoTrigger),
    write: (_ctx, value) => {
      writeDream({ autoTrigger: value === "true" });
    },
  },
  {
    id: "dreamOverBudgetApprovals",
    section: "memory",
    group: "dream",
    label: "Over-budget extensions per run",
    kind: "number",
    min: 0,
    max: 100,
    scope: "global",
    editable: true,
    read: (ctx) => String(dreamSettingsFor(ctx).overBudgetApprovals),
    write: (_ctx, value) => {
      writeDream({ overBudgetApprovals: Number(value) });
    },
  },
  ...DREAM_TIERS.map(
    (tier): SettingsItem => ({
      id: `dreamTier-${tier}`,
      section: "memory",
      group: "dream",
      label: `${DREAM_TIER_LABELS[tier]} tier`,
      kind: "toggle",
      scope: "global",
      editable: true,
      read: (ctx) => isOn(dreamSettingsFor(ctx).tiers[tier]),
      // Only the touched tier is written: the resolver fills the rest from the
      // defaults, so a future default change still reaches an agent that only
      // switched one tier.
      write: (_ctx, value) => {
        writeDream({ tiers: { [tier]: value === "true" } });
      },
    }),
  ),
  {
    id: "dreamSetup",
    section: "memory",
    group: "dream",
    label: "First-run setup",
    kind: "text",
    scope: "global",
    editable: false,
    reason: "run /dream on",
    read: (ctx) =>
      isDreamConfigured(ctx.agentId) ? "configured" : "not configured",
  },
];
