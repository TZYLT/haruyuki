// src/cli/app/pages/settings/settings-gaps-schema.ts

/**
 * The settings page's "gaps" table (T-04, R-04.1/R-04.2).
 *
 * 《47-1》T-04 found four values the page was missing even though
 * `settings-manager` owns them (hooks, the project/local window-title layers,
 * `listenerEnvName`), and five user-facing knobs that belong to other modules
 * (compaction, per-agent MCP, worktree provisioning, console font, max
 * context). The panel's job for the second group is not to grow a second
 * editor: it shows the effective value with its scope and the command that
 * owns it, so the reader knows "it is not here, it is there".
 *
 * Two rules come from the page's own contract and shape this file:
 *
 * - **Reads are synchronous and cheap.** Every row reads an initialized
 *   singleton or an in-memory snapshot. Nothing here opens a file or asks the
 *   backend — the worktree row is the one exception the implementation plan
 *   names (§1.4 #1): its config is read from disk by the worktree tool itself,
 *   so the row explains where the file is instead of pretending to show it.
 * - **A read-only row still answers "where do I change this?".** `jump` is the
 *   slash command the row hands to the composer on `Enter` (Q-48: prefill, never
 *   execute). A row with neither a writer nor a jump stays disabled and says
 *   why in its note.
 *
 * Split from `settings-schema.ts` for the reason the Dream section is: twelve
 * rows and their small formatters are a section of their own, and the 1,000-line
 * ceiling is where a reader stops holding the table in one pass. The parent file
 * only spreads {@link SETTINGS_GAPS_GROUPS} / {@link SETTINGS_GAPS_ITEMS}.
 */

import { getConsoleFontGuardStatus } from "@/cli/helpers/console-font-bun";
import { formatCompact } from "@/cli/helpers/format";
import { resolveWindowTitleConfig } from "@/cli/helpers/window-title-config";
import { summarizeHooks } from "@/hooks/loader";
import { settingsManager } from "@/settings-manager";
import type { SettingsGroup, SettingsItem } from "./settings-model";

/**
 * A read that must never throw in the page's render path.
 *
 * The settings manager throws before it is initialized (a test mounting the
 * page, a shell that never loaded project settings). The page's rule is that a
 * value it cannot read says so instead of showing a default the runtime is not
 * using, so a throw becomes `null` and the row paints `(unreadable)`.
 */
function readOrNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** `N` hooks as "Ng · Np · Nl", the compact three-layer summary. */
function hooksSummaryText(workingDirectory: string): string | null {
  const summary = readOrNull(() => summarizeHooks(workingDirectory));
  if (!summary) return null;
  const text = `${summary.global}g · ${summary.project}p · ${summary.local}l`;
  return summary.disabled ? `${text} (off)` : text;
}

/** One stored window-title item list, as the row paints it. */
function titleItemsText(items: readonly string[] | undefined): string {
  if (items === undefined) return "(default)";
  return items.length === 0 ? "(none)" : items.join(" ");
}

/**
 * The project layer's effective window title: the project's own list, or the
 * layer it inherits from when the project has not configured one.
 */
function projectTitleText(workingDirectory: string): string | null {
  return readOrNull(() => {
    const project =
      settingsManager.getProjectSettings(workingDirectory)?.windowTitle?.items;
    if (project !== undefined) return titleItemsText(project);
    const global = settingsManager.getSettings().windowTitle?.items;
    return titleItemsText(global);
  });
}

/**
 * The local layer's effective window title (`local > project > global`).
 *
 * The resolver is the same one the title writer uses, so this row cannot show
 * a value that differs from the title the user actually sees.
 */
function localTitleText(workingDirectory: string): string | null {
  return readOrNull(() =>
    titleItemsText(resolveWindowTitleConfig(workingDirectory)),
  );
}

/** The font the guard is holding in force, or the mode when it is not running. */
function consoleFontText(): string | null {
  return readOrNull(() => {
    const status = getConsoleFontGuardStatus();
    const mode =
      typeof status.mode === "object" ? status.mode.pinnedFace : status.mode;
    if (status.mode === "off") return "off";
    if (status.running && status.targetFace !== mode) {
      return `${mode} → ${status.targetFace}`;
    }
    return mode;
  });
}

/** "N servers", or `none`, for the per-agent MCP list. */
function mcpText(agentId: string): string | null {
  return readOrNull(() => {
    const servers = settingsManager.getMcpServers(agentId);
    if (servers.length === 0) return "none";
    return servers.length === 1 ? "1 server" : `${servers.length} servers`;
  });
}

/** The four `/compact config` knobs, as the agent stores them. */
function compactionRows(): SettingsItem[] {
  const settingsOf = (ctx: Parameters<SettingsItem["read"]>[0]) =>
    ctx.agentState?.compaction_settings ?? null;
  return [
    {
      id: "compactionMode",
      section: "context",
      group: "compaction",
      label: "Compaction mode",
      kind: "text",
      scope: "agent",
      editable: false,
      jump: "/compact config",
      read: (ctx) => settingsOf(ctx)?.mode ?? "(default)",
    },
    {
      id: "compactionPrompt",
      section: "context",
      group: "compaction",
      label: "Compaction prompt",
      kind: "text",
      scope: "agent",
      editable: false,
      jump: "/compact config",
      read: (ctx) => settingsOf(ctx)?.prompt ?? "(mode default)",
    },
    {
      id: "compactionClipChars",
      section: "context",
      group: "compaction",
      label: "Compaction clip chars",
      kind: "text",
      scope: "agent",
      editable: false,
      jump: "/compact config",
      read: (ctx) => {
        const clip = settingsOf(ctx)?.clip_chars;
        return typeof clip === "number" ? String(clip) : "(no clip)";
      },
    },
    {
      id: "compactionKeepPercentage",
      section: "context",
      group: "compaction",
      label: "Compaction keep %",
      kind: "text",
      scope: "agent",
      editable: false,
      jump: "/compact config",
      read: (ctx) => {
        const percentage = settingsOf(ctx)?.sliding_window_percentage;
        return typeof percentage === "number"
          ? `${Math.round(percentage * 100)}%`
          : "(default)";
      },
    },
  ];
}

export const SETTINGS_GAPS_GROUPS: readonly SettingsGroup[] = [
  { id: "compaction", section: "context", label: "Compaction" },
  { id: "windowTitleLayers", section: "display", label: "Window title layers" },
];

/**
 * Twelve rows in total: one writable (`listenerEnvName`, the only value with no
 * other entry point), ten read-only + jump, and the worktree row that explains
 * its file instead of claiming a value it cannot read synchronously.
 */
export const SETTINGS_GAPS_ITEMS: readonly SettingsItem[] = [
  ...compactionRows(),

  // ------------------------------------------------------------ Model
  {
    id: "maxContext",
    section: "model",
    label: "Max context",
    kind: "text",
    scope: "model",
    editable: false,
    jump: "/context limit",
    read: (ctx) =>
      typeof ctx.contextWindowSize === "number"
        ? `${formatCompact(ctx.contextWindowSize)} tokens`
        : null,
  },

  // ------------------------------------------------------------ Display
  {
    id: "windowTitleProject",
    section: "display",
    group: "windowTitleLayers",
    label: "Window title (project)",
    kind: "text",
    scope: "project",
    editable: false,
    jump: "/config title",
    read: (ctx) => projectTitleText(ctx.projectDirectory),
  },
  {
    id: "windowTitleLocal",
    section: "display",
    group: "windowTitleLayers",
    label: "Window title (local)",
    kind: "text",
    scope: "local",
    editable: false,
    jump: "/config title",
    read: (ctx) => localTitleText(ctx.projectDirectory),
  },
  {
    id: "consoleFont",
    section: "display",
    label: "Console font",
    kind: "text",
    scope: "global",
    editable: false,
    jump: "/config console-font",
    read: () => consoleFontText(),
  },

  // ------------------------------------------------------------ Tools
  {
    id: "hooksSummary",
    section: "tools",
    label: "Hooks (g/p/l)",
    kind: "text",
    scope: "global",
    editable: false,
    jump: "/config hooks",
    read: (ctx) => hooksSummaryText(ctx.projectDirectory),
  },
  {
    id: "mcpServers",
    section: "tools",
    label: "MCP servers (per agent)",
    kind: "text",
    scope: "agent",
    editable: false,
    jump: "/config mcp",
    read: (ctx) => mcpText(ctx.agentId),
  },
  {
    id: "worktreeProjectConfig",
    section: "tools",
    label: "Worktree provisioning",
    kind: "text",
    scope: "project",
    editable: false,
    reason: "edit on disk",
    // §1.4 #1: the worktree tool reads this block straight from the project
    // file, so the row names the file rather than showing a value the page
    // would have to re-read from disk on every frame.
    read: () => ".haruyuki/settings.json",
  },

  // ------------------------------------------------------------ Integrations
  {
    id: "listenerEnvName",
    section: "integrations",
    label: "Listener environment",
    kind: "text",
    scope: "local",
    editable: true,
    // The only entry point for this value: `/connect` uses it but has no
    // sub-command that names it, so the page owns the edit.
    read: (ctx) =>
      settingsManager.getListenerEnvName(ctx.projectDirectory) ?? "",
    write: (ctx, value) => {
      settingsManager.setListenerEnvName(value, ctx.projectDirectory);
    },
  },
];
