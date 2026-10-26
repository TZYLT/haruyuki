// src/cli/app/pages/settings/settings-schema.ts

import { applyRecallSettingsChange } from "@/cli/commands/recall";
import {
  getSystemRemindersVisible,
  setSystemRemindersVisible,
} from "@/cli/components/transcript-display-state";
import {
  type AmbiguousWidthMode,
  getAmbiguousWidthMode,
  setAmbiguousWidthMode,
} from "@/cli/helpers/char-width";
import {
  getConversationTitleSettings,
  setConversationTitleSettings,
} from "@/cli/helpers/conversation-title";
import {
  getReflectionSettings,
  persistReflectionSettingsForAgent,
} from "@/cli/helpers/memory-reminder";
import { experimentManager } from "@/experiments/manager";
import type { ExperimentId } from "@/experiments/types";
import { readRecallSettings } from "@/recall-settings";
import { updateSettings as updateStoredSettings } from "@/settings";
import { settingsManager } from "@/settings-manager";
import { readTopicSettings } from "@/topic-settings";
import type {
  SettingsContext,
  SettingsGroup,
  SettingsItem,
} from "./settings-model";

/**
 * The settings page's schema: what exists, where it lives, and which existing
 * writer changes it.
 *
 * 《38》§12.1 counted ~45 editable scalars in 16 modules and found no metadata
 * table; this is that table, and its composition is a statement about honesty
 * rather than completeness:
 *
 * - **Editable entries write through the module that already owns the value.** A
 *   global toggle goes through `settingsManager.updateSettings`; a recall knob
 *   goes through `applyRecallSettingsChange`, which moves the settings record, the
 *   transcript's display store and the recall breaker together; the reflection
 *   knobs go through `persistReflectionSettingsForAgent`, which writes both the
 *   local-project and global layers and mirrors the legacy key.
 * - **Entries with no safe writer are listed read-only with the command that has
 *   one** (`/config title`, `/agent toolset`, `/system`, `/context limit`, `/compact config`,
 *   `/memory memfs`). They belong in a page whose job is "one place to see every value"
 *   (§12.1b), and a row that says *why* it cannot be changed is information, not
 *   noise.
 * - **Nothing is invented.** A value that cannot be read synchronously is not
 *   rendered as a default.
 *
 * The one thing deliberately absent is the compaction pair (`mode`, `percentage`):
 * both need the agent's backend record and an `updateAgent` round trip, and a
 * read-only pair of "(unreadable)" rows would be worse than the `/compact config` face that
 * already owns them.
 */

const isOn = (value: boolean | undefined): string =>
  value === true ? "true" : "false";

/** A settings read that must not throw when the manager is not ready. */
function readSetting<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function booleanOrNull(value: boolean | null | undefined): string | null {
  if (typeof value !== "boolean") return null;
  return isOn(value);
}

/** The recollection knobs, as the single writer sees them. */
function writeRecall(update: Parameters<typeof applyRecallSettingsChange>[0]) {
  applyRecallSettingsChange(update);
}

/** One reflection write, keeping the knobs this page does not edit. */
async function writeReflection(
  ctx: SettingsContext,
  patch: Partial<ReturnType<typeof getReflectionSettings>>,
): Promise<void> {
  const current = getReflectionSettings(ctx.agentId, ctx.projectDirectory);
  await persistReflectionSettingsForAgent(
    ctx.agentId,
    { ...current, ...patch },
    { workingDirectory: ctx.projectDirectory },
  );
}

const RECALL_DIVERSITY = [
  { value: "none", label: "none" },
  { value: "file", label: "file" },
  { value: "split", label: "split" },
] as const;

const RECALL_DISPLAY = [
  { value: "silent", label: "silent" },
  { value: "summary", label: "summary" },
  { value: "full", label: "full" },
] as const;

const WIDTH_MODES = [
  { value: "auto", label: "auto (probe terminal)" },
  { value: "narrow", label: "narrow (1 column)" },
  { value: "wide", label: "wide (2 columns)" },
] as const;

const EXPERIMENT_LABELS: Record<string, string> = {
  artifacts: "artifacts",
  desktop_conversation_bootstrap: "conversation bootstrap",
  diffs: "diffs",
  memory_palace: "memory palace",
  tui_cron: "TUI cron",
  ui_v2: "full-screen TUI",
};

/**
 * The experiments this page may switch, in the manager's own order.
 *
 * `conversation_titles` is deliberately missing: `experimentManager.set` forwards
 * it to `autoConversationTitles`, which §12.1e's survey puts in the session
 * section. Two controls over one stored key would overwrite each other, so the
 * page has one and it lives where the setting does.
 */
const EXPERIMENT_IDS: readonly ExperimentId[] = [
  "artifacts",
  "desktop_conversation_bootstrap",
  "diffs",
  "memory_palace",
  "tui_cron",
  "ui_v2",
];

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: "topic", section: "context", label: "Topic & pressure" },
  { id: "recall", section: "memory", label: "Passive recall" },
  { id: "reflection", section: "memory", label: "Reflection" },
  { id: "experiments", section: "integrations", label: "Experiments" },
];

export const SETTINGS_ITEMS: readonly SettingsItem[] = [
  // ---------------------------------------------------------------- Context
  {
    id: "topicMarkingEnabled",
    section: "context",
    label: "Topic marking",
    kind: "toggle",
    scope: "global",
    editable: true,
    requiresRestart: true,
    read: () =>
      booleanOrNull(
        readSetting(() => settingsManager.getSetting("topicMarkingEnabled")),
      ),
    write: (_ctx, value) => {
      settingsManager.updateSettings({ topicMarkingEnabled: value === "true" });
    },
  },
  {
    id: "topicMarkerWarnTurns",
    section: "context",
    group: "topic",
    label: "Marker warn turns",
    kind: "number",
    min: 0,
    scope: "global",
    editable: true,
    read: () => String(readTopicSettings().markerWarnTurns),
    write: (_ctx, value) => {
      settingsManager.updateSettings({ topicMarkerWarnTurns: Number(value) });
    },
  },
  {
    id: "topicMarkerRejectTurns",
    section: "context",
    group: "topic",
    label: "Marker reject turns",
    kind: "number",
    min: 0,
    scope: "global",
    editable: true,
    read: () => String(readTopicSettings().markerRejectTurns),
    write: (_ctx, value) => {
      settingsManager.updateSettings({ topicMarkerRejectTurns: Number(value) });
    },
  },
  {
    id: "topicNudgeTurns",
    section: "context",
    group: "topic",
    label: "No-marker nudge turns",
    kind: "number",
    min: 0,
    scope: "global",
    editable: true,
    read: () => String(readTopicSettings().nudgeTurns),
    write: (_ctx, value) => {
      settingsManager.updateSettings({ topicNudgeTurns: Number(value) });
    },
  },
  {
    id: "topicSoftPressureRatio",
    section: "context",
    group: "topic",
    label: "Soft pressure ratio",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.05,
    scope: "global",
    editable: true,
    read: () => String(readTopicSettings().softPressureRatio),
    write: (_ctx, value) => {
      settingsManager.updateSettings({
        topicSoftPressureRatio: Number(value),
      });
    },
  },
  {
    id: "topicBoundaryRewindTurns",
    section: "context",
    group: "topic",
    label: "Boundary rewind turns",
    kind: "number",
    min: 0,
    max: 3,
    scope: "global",
    editable: true,
    read: () => String(readTopicSettings().boundaryRewindTurns),
    write: (_ctx, value) => {
      settingsManager.updateSettings({
        topicBoundaryRewindTurns: Number(value),
      });
    },
  },

  // ---------------------------------------------------------------- Model & reasoning
  {
    id: "currentModel",
    section: "model",
    label: "Current model",
    kind: "text",
    scope: "conversation",
    editable: false,
    reason: "use /model",
    read: (ctx) => ctx.modelLabel ?? null,
  },
  {
    id: "currentReasoningEffort",
    section: "model",
    label: "Reasoning effort",
    kind: "text",
    scope: "conversation",
    editable: false,
    reason: "shift+tab or /model",
    read: (ctx) => ctx.reasoningEffort ?? null,
  },
  {
    id: "reasoningTabCycleEnabled",
    section: "model",
    label: "Tab cycles reasoning",
    kind: "toggle",
    scope: "global",
    editable: true,
    read: (ctx) =>
      booleanOrNull(
        ctx.runtimeFlags?.reasoningTabCycle ??
          readSetting(() =>
            settingsManager.getSetting("reasoningTabCycleEnabled"),
          ),
      ),
    // The runtime flag is the composer's, not the page's: the shell flips it and
    // persists it together, exactly as `/config reasoning-tab` does (`use-submit-handler`).
    write: (ctx, value) => {
      if (ctx.setRuntimeFlag)
        ctx.setRuntimeFlag("reasoningTabCycle", value === "true");
      else
        settingsManager.updateSettings({
          reasoningTabCycleEnabled: value === "true",
        });
    },
  },

  // ---------------------------------------------------------------- Memory & reflection
  {
    id: "recallEnabled",
    section: "memory",
    group: "recall",
    label: "Passive recall",
    kind: "toggle",
    scope: "global",
    editable: true,
    read: () => isOn(readRecallSettings().enabled),
    write: (_ctx, value) => {
      writeRecall({ recallEnabled: value === "true" });
    },
  },
  {
    id: "recallTimeoutMs",
    section: "memory",
    group: "recall",
    label: "Recall timeout (ms)",
    kind: "number",
    min: 0,
    step: 100,
    scope: "global",
    editable: true,
    read: () => String(readRecallSettings().timeoutMs),
    write: (_ctx, value) => {
      writeRecall({ recallTimeoutMs: Number(value) });
    },
  },
  {
    id: "recallDedupTurns",
    section: "memory",
    group: "recall",
    label: "Dedup window (turns)",
    kind: "number",
    min: 0,
    scope: "global",
    editable: true,
    read: () => String(readRecallSettings().dedupTurns),
    write: (_ctx, value) => {
      writeRecall({ recallDedupTurns: Number(value) });
    },
  },
  {
    id: "recallLimit",
    section: "memory",
    group: "recall",
    label: "Snippets per turn",
    kind: "number",
    min: 0,
    scope: "global",
    editable: true,
    read: () => String(readRecallSettings().limit),
    write: (_ctx, value) => {
      writeRecall({ recallLimit: Number(value) });
    },
  },
  {
    id: "recallExcerptCharacters",
    section: "memory",
    group: "recall",
    label: "Chars per snippet",
    kind: "number",
    min: 0,
    step: 50,
    scope: "global",
    editable: true,
    read: () => String(readRecallSettings().excerptCharacters),
    write: (_ctx, value) => {
      writeRecall({ recallExcerptCharacters: Number(value) });
    },
  },
  {
    id: "recallTotalCharacters",
    section: "memory",
    group: "recall",
    label: "Total char budget",
    kind: "number",
    min: 0,
    step: 100,
    scope: "global",
    editable: true,
    read: () => String(readRecallSettings().totalCharacters),
    write: (_ctx, value) => {
      writeRecall({ recallTotalCharacters: Number(value) });
    },
  },
  {
    id: "recallMinScoreRatio",
    section: "memory",
    group: "recall",
    label: "Minimum score",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.05,
    scope: "global",
    editable: true,
    read: () => String(readRecallSettings().minScoreRatio),
    write: (_ctx, value) => {
      writeRecall({ recallMinScoreRatio: Number(value) });
    },
  },
  {
    id: "recallDiversity",
    section: "memory",
    group: "recall",
    label: "Slot allocation",
    kind: "select",
    options: RECALL_DIVERSITY,
    scope: "global",
    editable: true,
    read: () => readRecallSettings().diversity,
    write: (_ctx, value) => {
      writeRecall({ recallDiversity: value as "none" | "file" | "split" });
    },
  },
  {
    id: "recallExcerptLines",
    section: "memory",
    group: "recall",
    label: "Context lines",
    kind: "number",
    min: 0,
    scope: "global",
    editable: true,
    read: () => String(readRecallSettings().excerptLines),
    write: (_ctx, value) => {
      writeRecall({ recallExcerptLines: Number(value) });
    },
  },
  {
    id: "recallDisplay",
    section: "memory",
    group: "recall",
    label: "Recall block display",
    kind: "select",
    options: RECALL_DISPLAY,
    scope: "global",
    editable: true,
    read: () => readRecallSettings().display,
    write: (_ctx, value) => {
      writeRecall({ recallDisplay: value as "silent" | "summary" | "full" });
    },
  },
  // ---------------------------------------------------------------- Reflection
  // F-03 §5.5.1/§5.14.1: two independent triggers plus the run policy. The old
  // one-of-three selector and the merge knobs are gone from the page; their
  // stored keys are migrated on load.
  {
    id: "reflectionOnCompaction",
    section: "memory",
    group: "reflection",
    label: "Reflection on compaction",
    kind: "toggle",
    scope: "agent",
    editable: true,
    read: (ctx) =>
      booleanOrNull(
        readSetting(
          () =>
            getReflectionSettings(ctx.agentId, ctx.projectDirectory)
              .onCompaction,
        ),
      ),
    write: async (ctx, value) => {
      await writeReflection(ctx, { onCompaction: value === "true" });
    },
  },
  {
    id: "reflectionEveryUserMessages",
    section: "memory",
    group: "reflection",
    label: "Reflection every N user messages (0 = off)",
    kind: "number",
    min: 0,
    scope: "agent",
    editable: true,
    read: (ctx) =>
      readSetting(() =>
        String(
          getReflectionSettings(ctx.agentId, ctx.projectDirectory)
            .everyUserMessages,
        ),
      ),
    write: async (ctx, value) => {
      await writeReflection(ctx, { everyUserMessages: Number(value) });
    },
  },
  {
    id: "reflectionTimeoutMinutes",
    section: "memory",
    group: "reflection",
    label: "Reflection timeout (minutes)",
    kind: "number",
    min: 1,
    max: 60,
    scope: "agent",
    editable: true,
    read: (ctx) =>
      readSetting(() =>
        String(
          getReflectionSettings(ctx.agentId, ctx.projectDirectory)
            .timeoutMinutes,
        ),
      ),
    write: async (ctx, value) => {
      await writeReflection(ctx, { timeoutMinutes: Number(value) });
    },
  },
  {
    id: "reflectionDeleteSessionOnSuccess",
    section: "memory",
    group: "reflection",
    label: "Delete reflection session on success",
    kind: "toggle",
    scope: "agent",
    editable: true,
    read: (ctx) =>
      booleanOrNull(
        readSetting(
          () =>
            getReflectionSettings(ctx.agentId, ctx.projectDirectory)
              .deleteSessionOnSuccess,
        ),
      ),
    write: async (ctx, value) => {
      await writeReflection(ctx, { deleteSessionOnSuccess: value === "true" });
    },
  },
  {
    id: "memfs",
    section: "memory",
    label: "Memory filesystem",
    kind: "toggle",
    scope: "agent",
    editable: false,
    reason: "use /memfs",
    read: (ctx) =>
      booleanOrNull(
        readSetting(() => settingsManager.isMemfsEnabled(ctx.agentId)),
      ),
  },

  // ---------------------------------------------------------------- Display
  {
    id: "tokenStreaming",
    section: "display",
    label: "Token streaming",
    kind: "toggle",
    scope: "global",
    editable: true,
    read: (ctx) =>
      booleanOrNull(
        ctx.runtimeFlags?.tokenStreaming ??
          readSetting(() => settingsManager.getSetting("tokenStreaming")),
      ),
    write: (ctx, value) => {
      if (ctx.setRuntimeFlag)
        ctx.setRuntimeFlag("tokenStreaming", value === "true");
      else settingsManager.updateSettings({ tokenStreaming: value === "true" });
    },
  },
  {
    id: "systemRemindersVisible",
    section: "display",
    label: "System reminders",
    kind: "toggle",
    scope: "session",
    persistence: "session",
    editable: true,
    read: () => isOn(getSystemRemindersVisible()),
    write: (_ctx, value) => {
      setSystemRemindersVisible(value === "true");
    },
  },
  {
    id: "ambiguousCharWidth",
    section: "display",
    label: "Ambiguous width",
    kind: "select",
    options: WIDTH_MODES,
    scope: "global",
    editable: true,
    read: () => getAmbiguousWidthMode(),
    write: async (_ctx, value) => {
      setAmbiguousWidthMode(value as AmbiguousWidthMode);
      // `ambiguousCharWidth` lives in the file-level settings module, not in
      // `Settings`: writing it through `settingsManager.updateSettings` would drop
      // the key (it is not in that interface).
      await updateStoredSettings({
        ambiguousCharWidth: value as AmbiguousWidthMode,
      });
    },
  },
  {
    id: "showCompactions",
    section: "display",
    label: "Show compactions",
    kind: "toggle",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "start or /reload",
    read: () =>
      booleanOrNull(
        readSetting(() => settingsManager.getSetting("showCompactions")),
      ),
  },
  {
    id: "windowTitle",
    section: "display",
    label: "Terminal title fields",
    kind: "text",
    scope: "global",
    editable: false,
    reason: "use /title",
    read: () =>
      readSetting(() => {
        const items = settingsManager.getSettings().windowTitle?.items;
        return items && items.length > 0
          ? items.join(" ")
          : "(default: activity agent-name)";
      }),
  },

  // ---------------------------------------------------------------------- Session
  {
    id: "autoConversationTitles",
    section: "session",
    label: "Auto conversation titles",
    kind: "toggle",
    scope: "global",
    editable: true,
    read: () => isOn(getConversationTitleSettings().enabled),
    write: (_ctx, value) => {
      setConversationTitleSettings(value === "true");
    },
  },
  {
    id: "sessionContextEnabled",
    section: "session",
    label: "Session context",
    kind: "toggle",
    scope: "global",
    editable: false,
    reason: "read-only",
    read: () =>
      booleanOrNull(
        readSetting(() => settingsManager.getSetting("sessionContextEnabled")),
      ),
  },
  {
    id: "conversationSwitchAlertEnabled",
    section: "session",
    label: "Switch alert",
    kind: "toggle",
    scope: "global",
    editable: false,
    reason: "read-only",
    read: () =>
      booleanOrNull(
        readSetting(() =>
          settingsManager.getSetting("conversationSwitchAlertEnabled"),
        ),
      ),
  },
  {
    id: "createDefaultAgents",
    section: "session",
    label: "Create default agents",
    kind: "toggle",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "read at startup",
    read: () =>
      booleanOrNull(
        readSetting(
          () => settingsManager.getSetting("createDefaultAgents") ?? true,
        ),
      ),
  },

  // ---------------------------------------------------------------- Tools & permissions
  {
    id: "toolset",
    section: "tools",
    label: "Toolset",
    kind: "text",
    scope: "conversation",
    editable: false,
    reason: "use /toolset",
    read: (ctx) =>
      readSetting(() =>
        settingsManager.getToolsetPreference(ctx.agentId, ctx.conversationId),
      ),
  },
  {
    id: "systemPromptPreset",
    section: "tools",
    label: "System prompt preset",
    kind: "text",
    scope: "agent",
    editable: false,
    reason: "use /system",
    read: (ctx) =>
      readSetting(
        () => settingsManager.getSystemPromptPreset(ctx.agentId) ?? "(unset)",
      ),
  },
  {
    id: "pinned",
    section: "tools",
    label: "Pinned agent",
    kind: "toggle",
    scope: "agent",
    editable: true,
    read: (ctx) =>
      booleanOrNull(
        readSetting(() => settingsManager.isAgentPinned(ctx.agentId)),
      ),
    write: (ctx, value) => {
      if (value === "true") settingsManager.pinAgent(ctx.agentId);
      else settingsManager.unpinAgent(ctx.agentId);
    },
  },
  {
    id: "includeWorktreeTool",
    section: "tools",
    label: "Worktree tool",
    kind: "toggle",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "needs /recompile",
    read: () =>
      booleanOrNull(
        readSetting(() => settingsManager.getSetting("includeWorktreeTool")),
      ),
  },

  // ------------------------------------------------------------- Integrations & experiments
  ...EXPERIMENT_IDS.map((id): SettingsItem => {
    const definition = experimentManager
      .list()
      .find((entry) => entry.id === id);
    return {
      id: `experiment:${id}`,
      section: "integrations",
      group: "experiments",
      label: EXPERIMENT_LABELS[id] ?? id,
      kind: "toggle",
      scope: "global",
      editable: !definition?.envVar || definition.source !== "env",
      requiresRestart: id === "ui_v2",
      reason:
        definition?.source === "env"
          ? `from ${definition.envVar} (read-only)`
          : undefined,
      read: () => isOn(experimentManager.isEnabled(id)),
      write: (_ctx, value) => {
        experimentManager.set(id, value === "true");
      },
    };
  }),
  {
    id: "channelCredentialsStore",
    section: "integrations",
    label: "Channel credentials store",
    kind: "text",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "env wins; restart",
    read: () =>
      readSetting(
        () => settingsManager.getSetting("channelCredentialsStore") ?? "auto",
      ),
  },
  {
    id: "preferredBackendMode",
    section: "integrations",
    label: "Startup backend",
    kind: "text",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "startup-only",
    read: () =>
      readSetting(
        () => settingsManager.getSetting("preferredBackendMode") ?? "(unset)",
      ),
  },
];

/** The schema item with this id, or `undefined`. */
export function settingItemById(id: string): SettingsItem | undefined {
  return SETTINGS_ITEMS.find((item) => item.id === id);
}
