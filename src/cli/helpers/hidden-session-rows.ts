/**
 * Turning a hidden session's stored messages into renderable rows (F-01,
 * 《44-1》§5.3.6).
 *
 * Deliberately pure: no Ink, no colours, no backend, no state. The detail
 * component owns the frame, the keys and the scroll window; this module owns only
 * the question "what does one message look like as a line". Keeping that split
 * means the tricky part — an assistant message can carry one tool call or four,
 * a tool return can arrive as `tool_return` or `tool_returns`, arguments can be
 * unparsable JSON — is testable without a terminal.
 *
 * The default view is the collapsed one the requirement describes:
 *
 * - a tool call is one line, `→ tool(args…)`, with the full arguments behind
 *   `detail`;
 * - a tool return is one folded line carrying its status, with the full output
 *   (stdout and stderr) behind `detail` — long results must not be rendered until
 *   the row is expanded, or one call can fill the viewport;
 * - reasoning is **not projected at all** unless the caller asks for it, which is
 *   what makes `r` a pure re-projection of the same messages.
 *
 * A message is never dropped silently: an unrecognized type still yields an
 * `other` row, because a transcript with a hole in it is worse than an ugly row.
 */
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { isRecord } from "@/utils/type-guards";

/**
 * The two markers the requirement names (`→ tool(args…)`, folded results).
 *
 * Exported so the component can substitute a registry glyph without this module
 * depending on one; the row text is otherwise plain ASCII.
 */
export const HIDDEN_SESSION_ROW_MARKERS = {
  toolCall: "→",
  toolResult: "←",
} as const;

/** How much of a tool call's arguments the collapsed line keeps. */
export const HIDDEN_SESSION_ARGUMENT_PREVIEW = 60;
/** How much of a tool return's first line the collapsed line keeps. */
export const HIDDEN_SESSION_RESULT_PREVIEW = 80;

export type HiddenSessionRowKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "system"
  | "summary"
  | "event"
  | "other";

export type HiddenSessionRowStatus = "success" | "error";

export interface HiddenSessionRow {
  /** Stored message id the row came from (several rows may share one message). */
  id: string;
  kind: HiddenSessionRowKind;
  /** Left-hand column: `user`, `assistant`, `tool`, `system`, … */
  role: string;
  /** `MM-DD HH:mm` from the message's own timestamp; empty when it has none. */
  time: string;
  /** The line the collapsed row draws. */
  text: string;
  /** What the expanded row draws; equal to `text` when nothing is folded. */
  detail: string;
  /** True when `detail` holds more than `text` (the row can be expanded). */
  collapsible: boolean;
  /** Tool-call name, when the row is a call. */
  toolName?: string;
  /** Tool-call id, when the row is a call or a return. */
  toolCallId?: string;
  /** Return status, when the row is a tool return. */
  status?: HiddenSessionRowStatus;
}

export interface HiddenSessionRowOptions {
  /** `r` in the detail view: include reasoning rows (default off). */
  showReasoning?: boolean;
}

/**
 * Project every message into zero or more rows, oldest first.
 *
 * Zero rows for a reasoning message is the default view (§5.3.6), not a bug.
 */
export function projectHiddenSessionRows(
  messages: readonly Message[],
  options: HiddenSessionRowOptions = {},
): HiddenSessionRow[] {
  return messages.flatMap((message) =>
    projectHiddenSessionMessage(message, options),
  );
}

/** Project one message; a multi-tool-call message yields one row per call. */
export function projectHiddenSessionMessage(
  message: Message,
  options: HiddenSessionRowOptions = {},
): HiddenSessionRow[] {
  if (!isRecord(message)) return [];
  const id = typeof message.id === "string" ? message.id : "";
  // A row without a stored id cannot be keyed, expanded or related to a hovered
  // row, and every message the log holds has one. Projecting it would produce an
  // anonymous row the component cannot act on.
  if (id.length === 0) return [];
  const time = formatHiddenSessionRowTime(messageDateOf(message));
  const base = { id, time };
  const messageType = stringValue(message.message_type);

  switch (messageType) {
    case "user_message":
      return [textRow(base, "user", "user", contentText(message.content))];
    case "assistant_message":
      return [
        textRow(base, "assistant", "assistant", contentText(message.content)),
      ];
    case "system_message":
      return [textRow(base, "system", "system", contentText(message.content))];
    case "reasoning_message":
      if (!options.showReasoning) return [];
      return [
        textRow(base, "reasoning", "reasoning", stringValue(message.reasoning)),
      ];
    case "hidden_reasoning_message": {
      if (!options.showReasoning) return [];
      const state = stringValue(message.state);
      return [
        textRow(
          base,
          "reasoning",
          "reasoning",
          state ? `(${state} reasoning)` : "(reasoning unavailable)",
        ),
      ];
    }
    case "tool_call_message":
    case "approval_request_message":
      return toolCallRows(base, message);
    case "tool_return_message":
      return toolReturnRows(base, message);
    case "summary_message":
      return [
        textRow(base, "summary", "summary", stringValue(message.summary)),
      ];
    case "event_message": {
      const eventType = stringValue(message.event_type) || "event";
      return [textRow(base, "event", "event", `event: ${eventType}`)];
    }
    default:
      return [otherRow(base, message)];
  }
}

/**
 * One line from arbitrary text: whitespace runs collapse, and anything past
 * `limit` is cut with an ASCII ellipsis (the repo keeps non-ASCII glyphs in the
 * registry, and a preview is not worth an ambiguous-width character).
 */
export function collapseHiddenSessionLine(
  text: string,
  limit = HIDDEN_SESSION_RESULT_PREVIEW,
): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, Math.max(0, limit - 3))}...`;
}

/**
 * `MM-DD HH:mm` from a stored message timestamp.
 *
 * Read off the literal string rather than through a `Date` so the row shows the
 * offset the backend wrote (which is the user's local wall clock) and the
 * formatting is the same on every machine — the tests depend on that.
 */
export function formatHiddenSessionRowTime(
  date: string | null | undefined,
): string {
  if (typeof date !== "string" || date.length === 0) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(date);
  if (!match) return date.slice(0, 16);
  const [, , month, day, hour, minute] = match;
  return `${month}-${day} ${hour}:${minute}`;
}

function textRow(
  base: { id: string; time: string },
  kind: HiddenSessionRowKind,
  role: string,
  text: string,
): HiddenSessionRow {
  // A blank row would read as a hole in the transcript; the placeholder is what
  // the `messages` subcommand uses for the same case.
  const body = text.trim() || "(empty)";
  return {
    ...base,
    kind,
    role,
    text: body,
    detail: body,
    collapsible: false,
  };
}

function otherRow(
  base: { id: string; time: string },
  message: Record<string, unknown>,
): HiddenSessionRow {
  const text =
    contentText(message.content) ||
    jsonish(message.content) ||
    stringValue(message.summary) ||
    stringValue(message.reasoning) ||
    "(no content)";
  return textRow(
    base,
    "other",
    stringValue(message.message_type) || "unknown",
    text,
  );
}

function toolCallRows(
  base: { id: string; time: string },
  message: Record<string, unknown>,
): HiddenSessionRow[] {
  const calls = toolCallsOf(message);
  if (calls.length === 0) {
    return [
      {
        ...base,
        kind: "tool_call",
        role: "tool",
        text: `${HIDDEN_SESSION_ROW_MARKERS.toolCall} (no tool call payload)`,
        detail: "",
        collapsible: false,
      },
    ];
  }
  return calls.map((call) => {
    const detail = prettyArguments(call.arguments);
    const preview = collapseHiddenSessionLine(
      call.arguments,
      HIDDEN_SESSION_ARGUMENT_PREVIEW,
    );
    const text = `${HIDDEN_SESSION_ROW_MARKERS.toolCall} ${call.name}(${preview})`;
    return {
      ...base,
      kind: "tool_call" as const,
      role: "tool",
      text,
      detail: detail || preview,
      collapsible: detail.length > 0 && detail !== preview,
      ...(call.name ? { toolName: call.name } : {}),
      ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
    };
  });
}

function toolReturnRows(
  base: { id: string; time: string },
  message: Record<string, unknown>,
): HiddenSessionRow[] {
  const returns = toolReturnsOf(message);
  if (returns.length === 0) {
    return [
      {
        ...base,
        kind: "tool_result",
        role: "tool",
        text: `${HIDDEN_SESSION_ROW_MARKERS.toolResult} (no tool return payload)`,
        detail: "",
        collapsible: false,
      },
    ];
  }
  return returns.map((result) => {
    const output = result.output.trim();
    const preview = collapseHiddenSessionLine(
      firstNonEmptyLine(output),
      HIDDEN_SESSION_RESULT_PREVIEW,
    );
    const marker = HIDDEN_SESSION_ROW_MARKERS.toolResult;
    const text = preview
      ? `${marker} ${result.status} · ${preview}`
      : `${marker} ${result.status}`;
    return {
      ...base,
      kind: "tool_result" as const,
      role: "tool",
      text,
      detail: output || text,
      collapsible: output.length > 0 && output !== preview,
      status: result.status,
      ...(result.toolCallId ? { toolCallId: result.toolCallId } : {}),
    };
  });
}

interface HiddenSessionToolCall {
  name: string;
  arguments: string;
  toolCallId: string;
}

function toolCallsOf(
  message: Record<string, unknown>,
): HiddenSessionToolCall[] {
  const calls = message.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) {
    return calls.filter(isRecord).map(toToolCall).filter(isToolCall);
  }
  if (isRecord(calls)) return [toToolCall(calls)];
  if (isRecord(message.tool_call)) return [toToolCall(message.tool_call)];
  return [];
}

function toToolCall(call: Record<string, unknown>): HiddenSessionToolCall {
  return {
    name: stringValue(call.name) || "tool",
    arguments: stringValue(call.arguments) || jsonish(call.arguments),
    toolCallId: stringValue(call.tool_call_id),
  };
}

function isToolCall(call: HiddenSessionToolCall): boolean {
  return call.name.length > 0 || call.arguments.length > 0;
}

interface HiddenSessionToolReturn {
  toolCallId: string;
  status: HiddenSessionRowStatus;
  output: string;
}

function toolReturnsOf(
  message: Record<string, unknown>,
): HiddenSessionToolReturn[] {
  const returned = message.tool_returns;
  if (Array.isArray(returned) && returned.length > 0) {
    return returned.filter(isRecord).map((entry) => toToolReturn(entry, entry));
  }
  const hasSingleShape =
    message.tool_return !== undefined ||
    message.func_response !== undefined ||
    message.status !== undefined;
  if (hasSingleShape) return [toToolReturn(message, message)];
  if (Array.isArray(message.stdout) || Array.isArray(message.stderr)) {
    return [toToolReturn({}, message)];
  }
  return [];
}

function toToolReturn(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): HiddenSessionToolReturn {
  const status = returnStatus(entry, message);
  const output = [
    contentText(entry.tool_return ?? message.tool_return),
    contentText(entry.func_response ?? message.func_response),
    contentText(entry.stdout ?? message.stdout),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  const stderr = contentText(entry.stderr ?? message.stderr);
  return {
    toolCallId:
      stringValue(entry.tool_call_id) || stringValue(message.tool_call_id),
    status,
    output: stderr ? `${output}\n${stderr}`.trim() : output,
  };
}

function returnStatus(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): HiddenSessionRowStatus {
  if (entry.is_error === true || message.is_error === true) return "error";
  const status = stringValue(entry.status) || stringValue(message.status);
  return status === "error" ? "error" : "success";
}

function messageDateOf(message: Record<string, unknown>): string | null {
  const date = message.date;
  return typeof date === "string" && date.length > 0 ? date : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Text of message content: a plain string, or the `text` parts of the SDK's
 * content union. Non-text parts collapse to `[type]` so an image-only message
 * still renders as something rather than as an empty row.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!isRecord(part)) continue;
      const text = stringValue(part.text);
      if (text.length > 0) {
        parts.push(text);
        continue;
      }
      const type = stringValue(part.type);
      if (type.length > 0) parts.push(`[${type}]`);
    }
    return parts.join("\n").trim();
  }
  return "";
}

function jsonish(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Tool arguments as the expanded row shows them: pretty JSON when the arguments
 * parse, the raw string otherwise. A call whose arguments are still streaming in
 * therefore renders as the partial text instead of throwing inside a render pass.
 */
function prettyArguments(argumentsText: string): string {
  if (argumentsText.length === 0) return "";
  try {
    return JSON.stringify(JSON.parse(argumentsText), null, 2);
  } catch {
    return argumentsText;
  }
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}
