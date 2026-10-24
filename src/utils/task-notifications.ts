import { getConversationId, getCurrentAgentId } from "@/agent/context";
import {
  SYSTEM_ALERT_CLOSE,
  SYSTEM_ALERT_OPEN,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";

/**
 * Task Notification Formatting
 *
 * Formats background task completion notifications as XML.
 * The actual queueing is handled by messageQueueBridge.ts.
 */

// ============================================================================
// Types
// ============================================================================

export interface NotificationScope {
  agentId: string;
  conversationId: string;
}

export interface TaskNotification {
  taskId: string;
  status: "completed" | "failed";
  summary: string;
  result: string;
  outputFile?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
}

// ============================================================================
// XML Escaping
// ============================================================================

/**
 * Escape special XML characters to prevent breaking the XML structure.
 */
function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(str: string): string {
  return str.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Capture the conversation and initiating sender when background work starts.
 *
 * Prefers the scope injected by executeTool, which is the only correct source
 * in listener/desktop mode where several agent scopes share one process, and
 * falls back to the process-global agent context for plain CLI sessions.
 * Returns undefined when neither is available, in which case the caller should
 * still queue the notification unscoped rather than drop it.
 * Keep this snapshot until delivery; a later turn may belong to another user.
 */
export function resolveNotificationScope(parentScope?: {
  agentId: string;
  conversationId: string;
}): NotificationScope | undefined {
  if (parentScope?.agentId) {
    return {
      agentId: parentScope.agentId,
      conversationId: parentScope.conversationId || "default",
    };
  }

  try {
    return {
      agentId: getCurrentAgentId(),
      conversationId: getConversationId() ?? "default",
    };
  } catch {
    return undefined;
  }
}

/**
 * Format a single notification as XML string for queueing.
 */
export function formatTaskNotification(notification: TaskNotification): string {
  // Escape summary and result to prevent XML injection
  const escapedSummary = escapeXml(notification.summary);
  const escapedResult = escapeXml(notification.result);

  const usageLines: string[] = [];
  if (notification.usage?.totalTokens !== undefined) {
    usageLines.push(`total_tokens: ${notification.usage.totalTokens}`);
  }
  if (notification.usage?.toolUses !== undefined) {
    usageLines.push(`tool_uses: ${notification.usage.toolUses}`);
  }
  if (notification.usage?.durationMs !== undefined) {
    usageLines.push(`duration_ms: ${notification.usage.durationMs}`);
  }
  const usageBlock = usageLines.length
    ? `\n<usage>${usageLines.join("\n")}</usage>`
    : "";

  return `<task-notification>
<task-id>${notification.taskId}</task-id>
<status>${notification.status}</status>
<summary>${escapedSummary}</summary>
<result>${escapedResult}</result>${usageBlock}
</task-notification>${notification.outputFile ? `\nFull transcript available at: ${notification.outputFile}` : ""}`;
}

export function formatMonitorEventNotification(notification: {
  taskId: string;
  event: string;
}): string {
  return `<task-notification>
<task-id>${escapeXml(notification.taskId)}</task-id>
<summary>${escapeXml(`Monitor event: "${notification.event}"`)}</summary>
<result>
<event>${escapeXml(notification.event)}</event>
</result>
</task-notification>`;
}

const NOTIFICATION_PATTERN =
  /<task-notification>[\s\S]*?(?:<\/task-notification>|$)(?:\s*Full transcript available at:[^\n]*\n?)?/g;

/** A half-open character range `[start, end)` inside a message. */
type Range = [start: number, end: number];

/**
 * Ranges covered by `<system-reminder>` / legacy `<system-alert>` blocks.
 *
 * A recall block quotes earlier messages verbatim, and one of those messages can
 * be a background-task notification. A notification match that *starts* inside
 * one of these ranges is history being quoted, not something this turn produced.
 * Reading it does two things, both wrong: it paints another conversation's
 * notification as an event row of this one, and — because the quoted entry is
 * truncated and usually has no closing tag — the removal runs to the end of the
 * message, taking the closing `</system-reminder>` and the user's own prose with
 * it. The renderer then sees an unterminated opening tag and shows the raw
 * reminder as literal user text (2026-10-24, "the user message became unexpected
 * content after a restart").
 *
 * An unterminated opening tag covers the rest of the message, which is also how
 * `splitSystemReminderBlocks` reads it: nothing after it is the user's prose.
 * A notification that merely *contains* a reminder (an agent-only notification is
 * delivered as one) still starts outside every range and is handled as before.
 */
function reminderRanges(message: string): Range[] {
  const tags = [
    { open: SYSTEM_REMINDER_OPEN, close: SYSTEM_REMINDER_CLOSE },
    { open: SYSTEM_ALERT_OPEN, close: SYSTEM_ALERT_CLOSE },
  ];
  const found: Range[] = [];
  for (const tag of tags) {
    let cursor = 0;
    while (cursor < message.length) {
      const open = message.indexOf(tag.open, cursor);
      if (open < 0) break;
      const close = message.indexOf(tag.close, open + tag.open.length);
      const end = close < 0 ? message.length : close + tag.close.length;
      found.push([open, end]);
      cursor = end;
    }
  }
  if (found.length <= 1) return found;

  found.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [found[0] as Range];
  for (const range of found.slice(1)) {
    const last = merged[merged.length - 1] as Range;
    if (range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/**
 * The message with every reminder block overwritten by one inert character per
 * code unit, so indices still line up with the original.
 *
 * The extractor searches this copy and reads the matched XML from the original:
 * a `<task-notification>` quoted inside a recall block is invisible to the search
 * (so it can neither become an event row nor swallow the surrounding prose), while
 * a notification that legitimately *contains* a reminder is still found as one
 * match and still recognised as agent-only.
 */
function maskReminders(message: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return message;
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    parts.push(message.slice(cursor, start));
    parts.push("\u0000".repeat(end - start));
    cursor = end;
  }
  parts.push(message.slice(cursor));
  return parts.join("");
}

export function extractTaskNotificationsForDisplay(message: string): {
  notifications: string[];
  cleanedText: string;
} {
  if (!message.includes("<task-notification>")) {
    return { notifications: [], cleanedText: message };
  }

  const quoted = reminderRanges(message);
  const searchable = maskReminders(message, quoted);
  const notifications: string[] = [];
  const removals: Range[] = [];

  NOTIFICATION_PATTERN.lastIndex = 0;
  let match = NOTIFICATION_PATTERN.exec(searchable);
  while (match !== null) {
    // The match was found in the masked copy; read the real XML at the same
    // offsets so the fields (and the agent-only check) see the original text.
    const xml = message.slice(match.index, match.index + match[0].length);
    const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
    const statusMatch = xml.match(/<status>([\s\S]*?)<\/status>/);
    const resultMatch = xml.match(/<result>([\s\S]*?)<\/result>/);
    const result = resultMatch?.[1]?.trim() || "";
    if (!result.includes(SYSTEM_REMINDER_OPEN)) {
      const status = statusMatch?.[1]?.trim();
      let summary = summaryMatch?.[1]?.trim() || "";
      summary = unescapeXml(summary);
      notifications.push(summary || `Agent task ${status || "completed"}`);
    }
    // Removal is taken from the original string: a notification that contains a
    // reminder takes the reminder with it, exactly as the old regex did.
    removals.push([match.index, match.index + match[0].length]);
    match = NOTIFICATION_PATTERN.exec(searchable);
  }
  NOTIFICATION_PATTERN.lastIndex = 0;

  let cleanedText = "";
  let cursor = 0;
  for (const [start, end] of removals) {
    cleanedText += message.slice(cursor, start);
    cursor = end;
  }
  cleanedText += message.slice(cursor);

  return {
    notifications,
    cleanedText: cleanedText
      .replace(/^\s*Full transcript available at:[^\n]*\n?/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

// ============================================================================
// Buffer Helpers
// ============================================================================

/**
 * Append task-notification events to a transcript buffer and flush.
 *
 * This is the pure-function core of App.tsx's `appendTaskNotificationEvents`
 * useCallback. Extracting it here makes the behavioral contract testable:
 * buffer writes MUST be followed by a flush so that notifications from
 * background subagent onComplete callbacks (which run outside React's render
 * cycle) appear immediately instead of waiting for the next unrelated render.
 */
export type NotificationBuffer = Pick<
  import("@/cli/helpers/accumulator").Buffers,
  "byId" | "order"
>;

export function appendTaskNotificationEventsToBuffer(
  summaries: string[],
  buffer: NotificationBuffer,
  generateId: () => string,
  flush?: () => void,
): boolean {
  if (summaries.length === 0) return false;
  for (const summary of summaries) {
    const eventId = generateId();
    buffer.byId.set(eventId, {
      kind: "event",
      id: eventId,
      eventType: "task_notification",
      eventData: {},
      phase: "finished",
      summary,
    });
    buffer.order.push(eventId);
  }
  flush?.();
  return true;
}
