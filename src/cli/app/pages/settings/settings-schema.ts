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
 *   one** (`/title`, `/toolset`, `/system`, `/context-limit`, `/compaction`,
 *   `/memfs`). They belong in a page whose job is "one place to see every value"
 *   (§12.1b), and a row that says *why* it cannot be changed is information, not
 *   noise.
 * - **Nothing is invented.** A value that cannot be read synchronously is not
 *   rendered as a default.
 *
 * The one thing deliberately absent is the compaction pair (`mode`, `percentage`):
 * both need the agent's backend record and an `updateAgent` round trip, and a
 * read-only pair of "（读不到）" rows would be worse than the `/compaction` face that
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

const REFLECTION_TRIGGER = [
  { value: "off", label: "off" },
  { value: "step-count", label: "step-count" },
  { value: "compaction-event", label: "compaction-event" },
] as const;

const REFLECTION_MERGE = [
  { value: "auto", label: "auto" },
  { value: "explicit", label: "explicit" },
] as const;

const WIDTH_MODES = [
  { value: "auto", label: "auto（探测终端）" },
  { value: "narrow", label: "narrow（1 列）" },
  { value: "wide", label: "wide（2 列）" },
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
  { id: "topic", section: "context", label: "话题与压力" },
  { id: "recall", section: "memory", label: "被动召回" },
  { id: "reflection", section: "memory", label: "反思" },
  { id: "experiments", section: "integrations", label: "实验项" },
];

export const SETTINGS_ITEMS: readonly SettingsItem[] = [
  // ---------------------------------------------------------------- 上下文管理
  {
    id: "topicMarkingEnabled",
    section: "context",
    label: "话题标记",
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
    label: "标记警告阈值",
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
    label: "标记拒绝阈值",
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
    label: "无标记提醒阈值",
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
    label: "软压力比例",
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
    label: "边界回退回合",
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

  // ---------------------------------------------------------------- 模型与推理
  {
    id: "currentModel",
    section: "model",
    label: "当前模型",
    kind: "text",
    scope: "conversation",
    editable: false,
    reason: "用 /model 改",
    read: (ctx) => ctx.modelLabel ?? null,
  },
  {
    id: "currentReasoningEffort",
    section: "model",
    label: "推理档",
    kind: "text",
    scope: "conversation",
    editable: false,
    reason: "Shift+Tab 循环 / /model",
    read: (ctx) => ctx.reasoningEffort ?? null,
  },
  {
    id: "reasoningTabCycleEnabled",
    section: "model",
    label: "Tab 循环推理档",
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
    // persists it together, exactly as `/reasoning-tab` does (`use-submit-handler`).
    write: (ctx, value) => {
      if (ctx.setRuntimeFlag)
        ctx.setRuntimeFlag("reasoningTabCycle", value === "true");
      else
        settingsManager.updateSettings({
          reasoningTabCycleEnabled: value === "true",
        });
    },
  },

  // ---------------------------------------------------------------- 记忆与反思
  {
    id: "recallEnabled",
    section: "memory",
    group: "recall",
    label: "被动召回",
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
    label: "召回超时 (ms)",
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
    label: "去重窗口 (回合)",
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
    label: "每回合片段数",
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
    label: "单片段字数",
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
    label: "总字数预算",
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
    label: "分数下限",
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
    label: "槽位分配",
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
    label: "命中行上下文",
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
    label: "召回块显示",
    kind: "select",
    options: RECALL_DISPLAY,
    scope: "global",
    editable: true,
    read: () => readRecallSettings().display,
    write: (_ctx, value) => {
      writeRecall({ recallDisplay: value as "silent" | "summary" | "full" });
    },
  },
  {
    id: "reflectionTrigger",
    section: "memory",
    group: "reflection",
    label: "反思触发",
    kind: "select",
    options: REFLECTION_TRIGGER,
    scope: "agent",
    editable: true,
    read: (ctx) =>
      readSetting(
        () => getReflectionSettings(ctx.agentId, ctx.projectDirectory).trigger,
      ),
    write: async (ctx, value) => {
      await writeReflection(ctx, {
        trigger: value as "off" | "step-count" | "compaction-event",
      });
    },
  },
  {
    id: "reflectionStepCount",
    section: "memory",
    group: "reflection",
    label: "反思步数",
    kind: "number",
    min: 1,
    scope: "agent",
    editable: true,
    read: (ctx) =>
      readSetting(() =>
        String(
          getReflectionSettings(ctx.agentId, ctx.projectDirectory).stepCount,
        ),
      ),
    write: async (ctx, value) => {
      await writeReflection(ctx, { stepCount: Number(value) });
    },
  },
  {
    id: "reflectionMerge",
    section: "memory",
    group: "reflection",
    label: "合入方式",
    kind: "select",
    options: REFLECTION_MERGE,
    scope: "agent",
    editable: true,
    read: (ctx) =>
      readSetting(
        () => getReflectionSettings(ctx.agentId, ctx.projectDirectory).merge,
      ),
    write: async (ctx, value) => {
      await writeReflection(ctx, { merge: value as "auto" | "explicit" });
    },
  },
  {
    id: "reflectionMergeInstructions",
    section: "memory",
    group: "reflection",
    label: "评审指令",
    kind: "text",
    scope: "agent",
    editable: true,
    read: (ctx) =>
      readSetting(
        () =>
          getReflectionSettings(ctx.agentId, ctx.projectDirectory)
            .mergeInstructions,
      ),
    write: async (ctx, value) => {
      await writeReflection(ctx, { mergeInstructions: value });
    },
  },
  {
    id: "memfs",
    section: "memory",
    label: "记忆文件系统",
    kind: "toggle",
    scope: "agent",
    editable: false,
    reason: "用 /memfs 改（本机后端只开）",
    read: (ctx) =>
      booleanOrNull(
        readSetting(() => settingsManager.isMemfsEnabled(ctx.agentId)),
      ),
  },

  // ---------------------------------------------------------------- 界面与显示
  {
    id: "tokenStreaming",
    section: "display",
    label: "令牌流式",
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
    label: "系统提醒可见",
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
    label: "宽字符宽度",
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
    label: "显示压缩记录",
    kind: "toggle",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "启动或 /reload 后才重读",
    read: () =>
      booleanOrNull(
        readSetting(() => settingsManager.getSetting("showCompactions")),
      ),
  },
  {
    id: "windowTitle",
    section: "display",
    label: "终端标题字段",
    kind: "text",
    scope: "global",
    editable: false,
    reason: "用 /title（22 字段有序）",
    read: () =>
      readSetting(() => {
        const items = settingsManager.getSettings().windowTitle?.items;
        return items && items.length > 0
          ? items.join(" ")
          : "（默认 activity agent-name）";
      }),
  },

  // ---------------------------------------------------------------------- 会话
  {
    id: "autoConversationTitles",
    section: "session",
    label: "自动会话标题",
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
    label: "会话上下文注入",
    kind: "toggle",
    scope: "global",
    editable: false,
    reason: "无写入路径（只读）",
    read: () =>
      booleanOrNull(
        readSetting(() => settingsManager.getSetting("sessionContextEnabled")),
      ),
  },
  {
    id: "conversationSwitchAlertEnabled",
    section: "session",
    label: "切换提醒",
    kind: "toggle",
    scope: "global",
    editable: false,
    reason: "无写入路径（只读）",
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
    label: "创建默认 agent",
    kind: "toggle",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "启动期读取（只读）",
    read: () =>
      booleanOrNull(
        readSetting(
          () => settingsManager.getSetting("createDefaultAgents") ?? true,
        ),
      ),
  },

  // ---------------------------------------------------------------- 工具与权限
  {
    id: "toolset",
    section: "tools",
    label: "工具集",
    kind: "text",
    scope: "conversation",
    editable: false,
    reason: "用 /toolset 改",
    read: (ctx) =>
      readSetting(() =>
        settingsManager.getToolsetPreference(ctx.agentId, ctx.conversationId),
      ),
  },
  {
    id: "systemPromptPreset",
    section: "tools",
    label: "系统提示词预设",
    kind: "text",
    scope: "agent",
    editable: false,
    reason: "用 /system 改",
    read: (ctx) =>
      readSetting(
        () =>
          settingsManager.getSystemPromptPreset(ctx.agentId) ?? "（未设置）",
      ),
  },
  {
    id: "pinned",
    section: "tools",
    label: "固定 agent",
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
    label: "worktree 工具",
    kind: "toggle",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "工具声明，需 /recompile（只读）",
    read: () =>
      booleanOrNull(
        readSetting(() => settingsManager.getSetting("includeWorktreeTool")),
      ),
  },

  // ------------------------------------------------------------- 集成与实验
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
          ? `由 ${definition.envVar} 决定（只读）`
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
    label: "通道凭据存储",
    kind: "text",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "env 优先，需重启（只读）",
    read: () =>
      readSetting(
        () => settingsManager.getSetting("channelCredentialsStore") ?? "auto",
      ),
  },
  {
    id: "preferredBackendMode",
    section: "integrations",
    label: "启动后端偏好",
    kind: "text",
    scope: "global",
    editable: false,
    requiresRestart: true,
    reason: "启动期读取，本 fork 只有 local（只读）",
    read: () =>
      readSetting(
        () =>
          settingsManager.getSetting("preferredBackendMode") ?? "（未设置）",
      ),
  },
];

/** The schema item with this id, or `undefined`. */
export function settingItemById(id: string): SettingsItem | undefined {
  return SETTINGS_ITEMS.find((item) => item.id === id);
}
