/**
 * The one definition of "what a person actually saw" in a conversation (F-06
 * C-36 / R-5.4.2).
 *
 * `SessionRead` returns cleaned visible text instead of raw stored messages:
 * an assistant message can carry reasoning and tool calls, a tool result is
 * machine output, and injected reminder/alert/notification blocks are harness
 * plumbing rather than conversation. Two faces need that projection — the read
 * tool (`tools/impl/session-read.ts`) and the TUI's transcript projection — and
 * `tools/` may not import `cli/`, so the rule lives here in `agent/`.
 *
 * The wire shape is `@letta-ai/letta-client`'s `Message` (the local backend's
 * stored messages project onto it): `message_type` says which row this is, and
 * `content` is either a string or an array of content parts. The projection is
 * pure: no I/O, no backend, no model.
 *
 * Rules (the table is the same one the F-04 recall projection applies):
 *
 * - `user_message` and `assistant_message` keep their **text** parts;
 *   reasoning rows, tool-call rows and tool-result rows are dropped whole, and
 *   `thinking` / image / other non-text parts are dropped part by part.
 * - `summary_message` (a compaction's summary) is kept: it is the visible text
 *   that replaced older rows, not machine output.
 * - Injected blocks (`<system-reminder>`, `<system-alert>`,
 *   `<task-notification>`) are removed from every text, because the reader
 *   wants the user's words, not the harness's notifications. Only a **paired**
 *   block is removed, so a message that quotes an opening tag keeps the quote.
 * - A message that is left with no text is dropped, not rendered as an empty
 *   row. Reasoning this way is why the tool can say "N visible messages".
 */

export type VisibleMessageRole = "user" | "assistant" | "summary";

/** One cleaned, visible message; the unit both faces render. */
export interface VisibleMessageText {
  role: VisibleMessageRole;
  text: string;
}

/**
 * Injected context blocks that are harness plumbing, not conversation.
 *
 * Kept in step with `backend/local/topic-recall.ts`'s pattern (that module
 * cannot be imported from here without pulling the transcript layer in, and
 * duplicating the tag list is cheaper than a dependency inversion for one
 * regex). The tags themselves are the contract; keep the two in step when one
 * adds a wrapper.
 */
const INJECTED_BLOCK_PATTERN =
  /<(system-reminder|system-alert|task-notification)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Normalize a text run: line endings, injected blocks, trailing spaces and
 * runs of blank lines. Returns `""` when nothing visible is left.
 *
 * Only **paired** blocks are removed. The pattern tolerates attributes, extra
 * whitespace and any case (`<SYSTEM-REMINDER kind="note">`), because a future
 * producer may add an attribute and a cleaner that stops matching would leak
 * harness plumbing into "visible text". A message that merely quotes an
 * opening tag with no closing tag (`<system-reminder>` in a bug report, say)
 * keeps the quote, which is the same rule the F-04 recall projection applies.
 */
export function cleanVisibleText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INJECTED_BLOCK_PATTERN, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Text of one content field: a plain string, or the `text` parts of the SDK's
 * content union. Non-text parts are dropped rather than rendered as `[type]`:
 * a reader asking for "visible text" does not want `[toolCall]` markers, and
 * image bytes are not text at all.
 */
export function visibleTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : undefined;
    if (text === undefined || text.length === 0) continue;
    // A typed part that is not `text` is reasoning, a tool call, an image or a
    // future non-text payload; its `text` field (if any) is not the message.
    const type = record.type;
    if (typeof type === "string" && type !== "text") continue;
    parts.push(text);
  }
  return parts.join("\n");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Project one stored message to its visible text, or `null` when it has none.
 *
 * Exported because the TUI projection and the tool share the rule; the rows
 * themselves (roles, timestamps, folding) stay in each face.
 */
export function visibleMessageText(
  message: unknown,
): VisibleMessageText | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  const messageType = stringField(record.message_type);
  const role = stringField(record.role);

  if (
    messageType === "reasoning_message" ||
    messageType === "hidden_reasoning_message"
  ) {
    return null;
  }
  if (
    messageType === "tool_call_message" ||
    messageType === "approval_request_message" ||
    messageType === "tool_return_message"
  ) {
    return null;
  }

  let projected: VisibleMessageText | null = null;
  if (messageType === "summary_message") {
    projected = { role: "summary", text: stringField(record.summary) };
  } else if (messageType === "user_message") {
    projected = { role: "user", text: visibleTextFromContent(record.content) };
  } else if (messageType === "assistant_message") {
    projected = {
      role: "assistant",
      text: visibleTextFromContent(record.content),
    };
  } else if (messageType === "") {
    // A producer that does not write `message_type` still writes `role`; the
    // fallback is deliberately narrow so an unknown row is not guessed into a
    // role it does not have.
    if (role === "user" || role === "assistant") {
      projected = {
        role,
        text: visibleTextFromContent(record.content),
      };
    }
  }

  if (projected === null) return null;
  const text = cleanVisibleText(projected.text);
  return text.length === 0 ? null : { role: projected.role, text };
}

/** Project a whole transcript; rows with no visible text are omitted. */
export function projectVisibleMessages(
  messages: readonly unknown[],
): VisibleMessageText[] {
  const projected: VisibleMessageText[] = [];
  for (const message of messages) {
    const visible = visibleMessageText(message);
    if (visible !== null) projected.push(visible);
  }
  return projected;
}
