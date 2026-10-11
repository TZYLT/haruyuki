export type SharedReminderMode =
  | "interactive"
  | "headless-one-shot"
  | "headless-bidirectional"
  | "listen"
  | "subagent";

export type SharedReminderId =
  | "session-context"
  | "conversation-bootstrap"
  | "agent-info"
  | "secrets-info"
  | "mcp-servers-info"
  | "permission-mode"
  | "memory-git-sync"
  | "command-io"
  | "toolset-change"
  | "disk-space"
  | "topic-nudge"
  | "recall";

export interface SharedReminderDefinition {
  id: SharedReminderId;
  description: string;
  modes: SharedReminderMode[];
}

export const SHARED_REMINDER_CATALOG: ReadonlyArray<SharedReminderDefinition> =
  [
    {
      id: "session-context",
      description: "First-turn device/git/cwd context",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "conversation-bootstrap",
      description: "First-turn prior-conversation bootstrap context",
      modes: ["interactive"],
    },
    {
      id: "agent-info",
      description: "Agent identity (ID, name, server, memory dir)",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "secrets-info",
      description: "Available secret names for $SECRET_NAME substitution",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "mcp-servers-info",
      description: "MCP servers with tools available through haruyuki mcp",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "permission-mode",
      description: "Permission mode reminder",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "memory-git-sync",
      description: "Queued post-turn memory git sync status",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "command-io",
      description: "Recent slash command input/output context",
      modes: ["interactive"],
    },
    {
      id: "toolset-change",
      description: "Client-side toolset change context",
      modes: ["interactive"],
    },
    {
      id: "disk-space",
      description: "Low disk space warning in managed Cloud sandboxes",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "topic-nudge",
      description: "One-shot reminder to mark a topic boundary (local backend)",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    // Last on purpose: the catalog's order is the order of the parts prepended to
    // the user's content, and this is the only one that is *about* the words in
    // that content, so it sits closest to them.
    //
    // No `subagent` mode. Recalled context is for a turn the user asked for; a
    // subagent prompt is somebody else's job description (《26》§6.4).
    {
      id: "recall",
      description: "Recalled passages from past conversations and memory files",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
  ];

export const SHARED_REMINDER_IDS = SHARED_REMINDER_CATALOG.map(
  (entry) => entry.id,
);

const SHARED_REMINDER_BY_ID = new Map<
  SharedReminderId,
  SharedReminderDefinition
>(SHARED_REMINDER_CATALOG.map((entry) => [entry.id, entry]));

export function reminderEnabledInMode(
  id: SharedReminderId,
  mode: SharedReminderMode,
): boolean {
  return SHARED_REMINDER_BY_ID.get(id)?.modes.includes(mode) ?? false;
}
