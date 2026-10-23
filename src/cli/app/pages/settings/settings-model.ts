// src/cli/app/pages/settings/settings-model.ts

import type { PageRow } from "@/cli/app/pages/page-model";

/**
 * What the settings page is made of, as data.
 *
 * 《38》§12.1 found ~45 editable scalars scattered over 16 modules, with no
 * metadata table anywhere: every entry here is new, and its job is to say *where
 * the value lives* and *which existing writer changes it*. Two rules follow from
 * that survey and shape this module:
 *
 * - **`read` / `write` are the entry** (§12.2). A setting is not listed unless the
 *   page can read its effective value and change it through the path its own slash
 *   command uses — `/stream` both flips the runtime flag and persists the
 *   preference, so a page that only wrote the file would show a value that has no
 *   effect until restart. Entries with no safe write path are `editable: false`
 *   with a `reason`, never silently missing (§12.1e class C).
 * - **The page never invents a stored value** (§12.1e 3). `read` returns the
 *   effective value *as text*, and a failed read is `null` — the row then says so
 *   instead of showing a default the runtime is not using.
 *
 * The screens are pure functions of a snapshot of those reads (`screens.ts` needs
 * no store), which is what lets the layout be tested without a settings manager.
 */
export type SettingsScope =
  | "global"
  | "project"
  | "local"
  | "session"
  | "agent"
  | "conversation"
  | "model";

/** The seven sections 《38》§12.3 ruled on, in the order they are drawn. */
export type SettingsSectionId =
  | "context"
  | "model"
  | "memory"
  | "display"
  | "session"
  | "tools"
  | "integrations";

export type SettingsKind = "toggle" | "select" | "number" | "text";

export type SettingsOption = {
  value: string;
  label: string;
};

/**
 * What a schema entry may read, and what it may write through.
 *
 * The page is a child of the shell, so it does not own AgentCoordinator state; the
 * two runtime flags that live there (`tokenStreaming` and the reasoning Tab cycle)
 * arrive as a callback *and* their current value, because a page that wrote only
 * the settings file would show a value that has no effect until the next start —
 * the trap 《38》§12.1e 3 names. Everything else is read from its own module.
 */
export type SettingsContext = {
  agentId: string;
  conversationId: string;
  /** Where project/local permission rules and reflection settings are written. */
  projectDirectory: string;
  /** The runtime flag values, when the shell supplied them. */
  runtimeFlags?: Partial<Record<RuntimeFlagKey, boolean>>;
  /** Flip a runtime flag through the path its slash command uses. */
  setRuntimeFlag?: (key: RuntimeFlagKey, value: boolean) => void;
  /** The live model label (`/model`'s subject), when the shell supplied it. */
  modelLabel?: string | null;
  /** The live reasoning effort, when the shell supplied it. */
  reasoningEffort?: string | null;
};

/** The two flags the composer owns; a page can only ask the shell to flip them. */
export type RuntimeFlagKey = "tokenStreaming" | "reasoningTabCycle";

/**
 * One editable (or deliberately not editable) scalar.
 *
 * `read` is called on every snapshot, so it must be cheap and synchronous: most
 * settings live in an initialized singleton, and the ones that do not cannot be
 * shown here honestly.
 */
export type SettingsItem = {
  /** Stable id; also the row's identity across snapshots. */
  id: string;
  section: SettingsSectionId;
  /** The sub-screen this item lives on, when it is not on the root screen. */
  group?: string;
  label: string;
  kind: SettingsKind;
  /** `select`: the values `←→` cycles, in order. */
  options?: readonly SettingsOption[];
  /** `number`: the step and the bounds `←→` respects. */
  step?: number;
  min?: number;
  max?: number;
  scope: SettingsScope;
  /** `session` values do not survive a restart (the page says so). */
  persistence?: "disk" | "session";
  /** The value only takes effect after a restart (`/title`'s store, `backend`). */
  requiresRestart?: boolean;
  /** The write can throw away real state; the page confirms first. */
  danger?: boolean;
  /** `false` means the row is drawn dimmed with `reason`, and cannot be edited. */
  editable: boolean;
  reason?: string;
  /** The effective value, as the canonical string the other functions read. */
  read: (ctx: SettingsContext) => string | null;
  /** The same path the slash command uses, side effects included. */
  write?: (ctx: SettingsContext, value: string) => void | Promise<void>;
};

/** A group row on the root screen; `Enter` opens its own screen. */
export type SettingsGroup = {
  id: string;
  section: SettingsSectionId;
  label: string;
};

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "context", label: "Context" },
  { id: "model", label: "Model & reasoning" },
  { id: "memory", label: "Memory & reflection" },
  { id: "display", label: "Display" },
  { id: "session", label: "Session" },
  { id: "tools", label: "Tools & permissions" },
  { id: "integrations", label: "Integrations & experiments" },
];

/** The row id prefix a group row uses; `Enter` on it opens the group's screen. */
export const GROUP_ROW_PREFIX = "group:";

/** The permission screen's rows: its entry row and the rows inside it. */
export const PERMISSION_ROW_PREFIX = "perm:";

/**
 * The scope marker the page prints in its own column.
 *
 * 《38》§12.5 asks for `[G]`／`[P]`／`[L]`／`[env]`／`[session]`, and forbids pretending
 * every setting has three levels: an agent-scoped setting is written to the agent,
 * not to a file of the project's. The first real run asked for the abbreviations to
 * be spelled out (`[G]` → `[Global]`) and for the longest one to be shortened
 * (`[conversation]` → `[conv]`): the column is fixed width, so a label that needs 14
 * cells either starves the value or gets cut.
 */
export function scopeMarker(item: SettingsItem): string {
  if (item.persistence === "session") return "[session]";
  switch (item.scope) {
    case "global":
      return "[Global]";
    case "project":
      return "[Project]";
    case "local":
      return "[Local]";
    case "agent":
      return "[agent]";
    case "conversation":
      return "[conv]";
    case "model":
      return "[model]";
    case "session":
      return "[session]";
  }
}

const TRUE_WORDS = new Set(["true", "1", "on", "yes"]);

/** Whether a canonical value means "on". Unparseable text is shown as it is. */
export function isTruthy(raw: string): boolean {
  return TRUE_WORDS.has(raw.trim().toLowerCase());
}

/**
 * The value as the page draws it.
 *
 * A toggle says On/Off (never `true`), a select says its option's label (never the
 * stored key), and everything else is the value itself. A `null` read says so: an
 * unreadable setting is not "Off".
 */
export function displayValue(item: SettingsItem, raw: string | null): string {
  if (raw === null) return "(unreadable)";
  if (item.kind === "toggle") return isTruthy(raw) ? "On" : "Off";
  if (item.kind === "select") {
    const option = item.options?.find((candidate) => candidate.value === raw);
    return option?.label ?? raw;
  }
  return raw;
}

/**
 * The next canonical value for `←→`, or `null` when the row does not cycle.
 *
 * Toggles flip; selects wrap through their own option list; numbers step and clamp
 * to `min`/`max`; text does not move (it needs the inline editor, §12.4 5).
 */
export function cycleValue(input: {
  item: SettingsItem;
  raw: string;
  direction: 1 | -1;
}): string | null {
  const { item, raw, direction } = input;
  if (item.kind === "toggle") return isTruthy(raw) ? "false" : "true";
  if (item.kind === "select") {
    const options = item.options ?? [];
    if (options.length === 0) return null;
    const index = options.findIndex((option) => option.value === raw);
    const start = index < 0 ? 0 : index;
    const next = (start + direction + options.length) % options.length;
    return options[next]?.value ?? null;
  }
  if (item.kind === "number") {
    const current = Number(raw);
    if (!Number.isFinite(current)) return null;
    const step = item.step ?? 1;
    const next = current + step * direction;
    const bounded = Math.min(
      item.max ?? Number.MAX_SAFE_INTEGER,
      Math.max(item.min ?? Number.MIN_SAFE_INTEGER, next),
    );
    return String(bounded);
  }
  return null;
}

/**
 * Whether a typed value is acceptable before it is written.
 *
 * MVP keeps this to the shape of the row (§12.6 3): a number is a number in range.
 * Anything deeper (a permission glob, a window-title template) is the writer's own
 * checker, which reports at use time and must not be second-guessed here.
 */
export function validateValue(item: SettingsItem, raw: string): string | null {
  if (item.kind === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) return "needs a number";
    if (item.min !== undefined && value < item.min)
      return `must be at least ${item.min}`;
    if (item.max !== undefined && value > item.max)
      return `must be at most ${item.max}`;
  }
  if (item.kind === "select") {
    const options = item.options ?? [];
    if (!options.some((option) => option.value === raw)) {
      return "not one of the options";
    }
  }
  return null;
}

/** The items of a group, in declaration order. */
export function itemsOfGroup(
  items: readonly SettingsItem[],
  group: string,
): SettingsItem[] {
  return items.filter((item) => item.group === group);
}

/**
 * One row for a scalar: the scope in its own column, the value, then the aside.
 *
 * A read-only row puts *why* in `note` — `use /model`, `start or /reload` — which
 * the frame paints in the command accent so the pointer or the eye can tell "this is
 * where you would go instead" from "this is the value". Keeping it out of the value
 * means the value stays a value; keeping it out of the scope column means a narrow
 * terminal cannot cut it into illegibility.
 */
export function settingRow(item: SettingsItem, ctx: SettingsContext): PageRow {
  return {
    kind: "item",
    id: item.id,
    label: item.label,
    value: displayValue(item, item.read(ctx)),
    hint: scopeMarker(item),
    // The schema's `reason` already says where to go instead ("use /model").
    //
    // `requiresRestart` used to be a dead field: assigned by seven schema entries
    // and read by nobody, so flipping `ui_v2` in this page changed a file and not
    // the screen — with no hint that a restart was the missing step. It is drawn
    // in the aside column (accent, like "where to go instead"): the value stays a
    // value, and a narrow terminal cannot cut the marker into illegibility.
    note: item.editable
      ? item.requiresRestart
        ? "restart"
        : undefined
      : (item.reason ?? "read-only"),
    disabled: !item.editable,
  };
}

/**
 * The root screen: section titles with their second-level entries under them
 * (《38》§12.3bis 1 — a category title is a header the cursor skips, not a screen).
 *
 * A group with more than one item becomes a `▸` row that opens its own screen; a
 * group with one item is drawn in place, because a screen for a single row is a
 * keystroke the user pays for and learns nothing from.
 */
export function rootRows(input: {
  sections: readonly SettingsSection[];
  items: readonly SettingsItem[];
  groups: readonly SettingsGroup[];
  ctx: SettingsContext;
  /** How many permission rules are in force, for the `Permissions` row's count. */
  permissionRuleCount?: number;
}): PageRow[] {
  const rows: PageRow[] = [];
  for (const section of input.sections) {
    const items = input.items.filter(
      (item) => item.section === section.id && item.group === undefined,
    );
    const groups = input.groups.filter((group) => group.section === section.id);
    const groupOfOne = (group: SettingsGroup) =>
      itemsOfGroup(input.items, group.id);
    // Nothing to show in this section at all: no empty title either.
    if (items.length === 0 && groups.length === 0) continue;

    rows.push({ kind: "header", text: section.label });

    for (const group of groups) {
      const members = groupOfOne(group);
      if (members.length === 0) continue;
      if (members.length === 1) {
        for (const item of members) rows.push(settingRow(item, input.ctx));
        continue;
      }
      rows.push({
        kind: "item",
        id: `${GROUP_ROW_PREFIX}${group.id}`,
        label: group.label,
        value: `${members.length} items`,
        key: "▸",
      });
    }

    for (const item of items) rows.push(settingRow(item, input.ctx));

    // The permission editor is the page's one new capability and the only entry
    // that is not a scalar (《38》§12.5／§12.6): its rows are rules read from three
    // files, so it is a screen of its own rather than a group of the schema.
    if (section.id === "tools") {
      rows.push({
        kind: "item",
        id: `${PERMISSION_ROW_PREFIX}permission`,
        label: "Permissions",
        value:
          input.permissionRuleCount === undefined
            ? undefined
            : `${input.permissionRuleCount} rules`,
        key: "▸",
      });
    }
  }
  return rows;
}

/**
 * A group's own screen: its items, in declaration order, under a breadcrumb.
 *
 * The permission group is the exception and does not come through here: its rows
 * are rules read from disk (`permissions-screen.ts`), not scalars.
 */
export function groupRows(
  items: readonly SettingsItem[],
  group: string,
  ctx: SettingsContext,
): PageRow[] {
  return itemsOfGroup(items, group).map((item) => settingRow(item, ctx));
}
