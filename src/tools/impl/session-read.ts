/**
 * `SessionRead` — read a conversation back as cleaned visible text (F-06
 * R-5.4.2, Q-33 / Q-50).
 *
 * The topic index (F-04) has gaps, and the fallback used to be "open the
 * transcript". That hands the model a storage format and skips every budget, so
 * the requirement replaces it with this tool: conversation and message range,
 * optional keyword, a character budget and paging, returning only what a person
 * saw — no reasoning, no tool arguments, no tool output, no harness reminders.
 *
 * Two absolute rules:
 *
 * 1. **Hidden sessions are refused whole.** `hidden: true` covers reflection,
 *    dream and subagent conversations; F-01's read-only boundary says no tool
 *    reads them, so this one refuses with an explicit message instead of
 *    returning an empty page. `is_subagent` and origin `reflection`/`dream` are
 *    refused too, so the guarantee does not depend on a single flag being set.
 * 2. **Ordinary conversations are open to every agent.** The requirement keeps
 *    the tool in the regular toolset: reading a normal conversation is the
 *    supported replacement for reading the transcript file.
 *
 * Read-only: the only backend calls are `retrieveConversation` and
 * `listConversationMessages`.
 */
import { getConversationId } from "@/agent/context";
import {
  projectVisibleMessages,
  type VisibleMessageText,
} from "@/agent/message-text";
import { getBackend } from "@/backend";
import { getRuntimeContext } from "@/runtime-context";
import {
  type ConversationOrigin,
  readConversationProvenance,
} from "@/types/conversation-provenance";
import { isRecord } from "@/utils/type-guards";

const TOOL_NAME = "SessionRead";

/** Character budget when the caller does not name one. */
export const SESSION_READ_DEFAULT_MAX_CHARS = 8_000;
/** Smallest accepted `max_chars`; the header and paging note must fit. */
export const SESSION_READ_MIN_MAX_CHARS = 400;
/** Largest accepted `max_chars`. */
export const SESSION_READ_MAX_MAX_CHARS = 20_000;
/** Most stored rows read per call; the budget is applied after cleaning. */
export const SESSION_READ_MAX_SCAN_MESSAGES = 5_000;
/**
 * Room kept for the footer while blocks are added. The footer is short and
 * fixed-shape, so a constant is honest; if it ever exceeds this, the final cut
 * below still holds the hard `max_chars` promise.
 */
const FOOTER_RESERVE_CHARS = 200;
/** Smallest partial first block worth returning when the budget is tiny. */
const MIN_PARTIAL_BLOCK_CHARS = 120;

export interface SessionReadArgs {
  conversation_id?: unknown;
  message_start?: unknown;
  message_end?: unknown;
  query?: unknown;
  max_chars?: unknown;
  offset?: unknown;
}

/**
 * The two backend reads this tool needs, and nothing else.
 *
 * Typed narrowly so a test passes a fake without implementing `Backend`, the
 * same seam `hidden-session-history.ts` uses. The real `Backend` satisfies it.
 */
export interface SessionReadBackend {
  retrieveConversation(conversationId: string): Promise<unknown>;
  listConversationMessages(
    conversationId: string,
    body?: { order?: "asc" | "desc"; limit?: number },
  ): Promise<unknown>;
}

/** Injection seams for tests; production callers pass nothing. */
export interface SessionReadDeps {
  backend?: SessionReadBackend;
  /** Current conversation when the caller omits `conversation_id`. */
  conversationId?: string;
}

export interface SessionReadResult {
  content: string;
  status: "success" | "error";
}

/** One visible message plus its 1-based position in the cleaned list. */
interface IndexedVisibleMessage extends VisibleMessageText {
  index: number;
}

/** What a page renders, after range/query/offset are applied. */
export interface SessionReadPage {
  conversationId: string;
  totalVisibleMessages: number;
  /** Messages left after the range and keyword filters. */
  matchingMessages: number;
  /** Index of the next unread message within the filtered list, if any. */
  nextOffset: number | null;
  content: string;
}

function error(content: string): SessionReadResult {
  return { content, status: "error" };
}

function positiveInteger(
  value: unknown,
): { value: number } | { error: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { error: "must be a whole number of 1 or more" };
  }
  return { value };
}

function nonNegativeInteger(
  value: unknown,
): { value: number } | { error: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { error: "must be a whole number of 0 or more" };
  }
  return { value };
}

function extractPageItems(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  if (!isRecord(page)) return [];
  const paginated = page.getPaginatedItems;
  if (typeof paginated === "function") {
    const items = (paginated as (this: unknown) => unknown).call(page);
    return Array.isArray(items) ? items : [];
  }
  return Array.isArray(page.items) ? page.items : [];
}

/** Origins whose conversations are maintenance surfaces, never readable here. */
const HIDDEN_ORIGINS: ReadonlySet<ConversationOrigin> =
  new Set<ConversationOrigin>(["reflection", "dream", "background"]);

/**
 * Whether a conversation record must be refused.
 *
 * `hidden: true` is the requirement's rule; `is_subagent` and a maintenance
 * origin are checked as well, because an old or hand-written record may carry
 * one without the other, and the boundary must not depend on which producer
 * wrote the record.
 */
export function isHiddenConversationRecord(record: unknown): boolean {
  if (!isRecord(record)) return true;
  if (record.hidden === true) return true;
  if (record.is_subagent === true) return true;
  return HIDDEN_ORIGINS.has(readConversationProvenance(record).origin);
}

function resolveConversationId(
  args: SessionReadArgs,
  deps: SessionReadDeps,
): string | null {
  if (args.conversation_id !== undefined) {
    if (typeof args.conversation_id !== "string") return null;
    const trimmed = args.conversation_id.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (deps.conversationId) return deps.conversationId;
  const runtimeConversationId = getRuntimeContext()?.conversationId;
  if (
    typeof runtimeConversationId === "string" &&
    runtimeConversationId.length > 0
  ) {
    return runtimeConversationId;
  }
  try {
    return getConversationId();
  } catch {
    return null;
  }
}

function filterMessages(
  messages: readonly IndexedVisibleMessage[],
  rangeStart: number,
  rangeEnd: number,
  query: string | undefined,
): IndexedVisibleMessage[] {
  const needle = query?.toLowerCase();
  return messages.filter((message) => {
    if (message.index < rangeStart || message.index > rangeEnd) return false;
    if (needle === undefined) return true;
    return message.text.toLowerCase().includes(needle);
  });
}

function renderBlock(message: IndexedVisibleMessage): string {
  return `[${message.index}] ${message.role}:\n${message.text}`;
}

/**
 * Render one page under a hard character budget.
 *
 * The header and footer are counted against the budget; the body is filled with
 * whole blocks while they fit, and the first block is truncated when even one
 * message is larger than the remaining room (a reader with a 400-character
 * budget still deserves to see the first few lines). `nextOffset` is the
 * filtered-list position of the next unread message, so a caller pages by
 * repeating the same query/range with the reported offset.
 */
export function renderSessionReadPage(input: {
  conversationId: string;
  visible: readonly IndexedVisibleMessage[];
  selected: readonly IndexedVisibleMessage[];
  offset: number;
  maxChars: number;
  query?: string;
}): SessionReadPage {
  const { conversationId, visible, selected, offset, maxChars, query } = input;
  const header = [
    `Conversation ${conversationId} · ${visible.length} visible message${visible.length === 1 ? "" : "s"}`,
    query === undefined
      ? null
      : `keyword: "${query}" (${selected.length} matching)`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  let content = header;
  let emitted = 0;
  let index = offset;
  let truncatedMidMessage = false;
  while (index < selected.length) {
    const message = selected[index];
    if (message === undefined) break;
    const block = renderBlock(message);
    const remaining = maxChars - FOOTER_RESERVE_CHARS - content.length;
    if (block.length + 1 <= remaining) {
      content += `\n\n${block}`;
      emitted += 1;
      index += 1;
      continue;
    }
    if (emitted === 0 && remaining >= MIN_PARTIAL_BLOCK_CHARS) {
      content += `\n\n${block.slice(0, Math.max(1, remaining - 1))}…`;
      emitted = 1;
      truncatedMidMessage = true;
      index += 1;
    }
    break;
  }

  const more = index < selected.length;
  const footerLines = [
    more
      ? `(showing ${emitted} of ${selected.length} matching messages; next offset=${index})`
      : `(${emitted} of ${selected.length} matching messages shown)`,
  ];
  if (truncatedMidMessage) {
    footerLines.push(
      "(the last message above was cut at the character budget)",
    );
  }
  content += `\n\n${footerLines.join("\n")}`;
  if (content.length > maxChars) {
    content = `${content.slice(0, Math.max(1, maxChars - 1))}…`;
  }

  return {
    conversationId,
    totalVisibleMessages: visible.length,
    matchingMessages: selected.length,
    nextOffset: more ? index : null,
    content,
  };
}

/**
 * Read one conversation as cleaned visible text.
 *
 * Argument refusals are `status: "error"` results the model can correct; a
 * backend read failure is reported the same way (the model called a tool with a
 * bad conversation id, not a harness bug).
 */
export async function session_read(
  args: SessionReadArgs,
  deps: SessionReadDeps = {},
): Promise<SessionReadResult> {
  const conversationId = resolveConversationId(args, deps);
  if (conversationId === null) {
    return error(
      `${TOOL_NAME}: no conversation to read. Pass \`conversation_id\`, or call it from inside a conversation so the current one is the default.`,
    );
  }

  const start = positiveInteger(args.message_start);
  if (start !== undefined && "error" in start) {
    return error(
      `${TOOL_NAME}: \`message_start\` ${start.error} (1 is the first visible message).`,
    );
  }
  const end = positiveInteger(args.message_end);
  if (end !== undefined && "error" in end) {
    return error(
      `${TOOL_NAME}: \`message_end\` ${end.error} (it is inclusive).`,
    );
  }
  if (start !== undefined && end !== undefined && end.value < start.value) {
    return error(
      `${TOOL_NAME}: \`message_end\` (${end.value}) is before \`message_start\` (${start.value}); the range is inclusive and must not be inverted.`,
    );
  }
  const offsetInput = nonNegativeInteger(args.offset);
  if (offsetInput !== undefined && "error" in offsetInput) {
    return error(`${TOOL_NAME}: \`offset\` ${offsetInput.error}.`);
  }
  const offset = offsetInput?.value ?? 0;

  let query: string | undefined;
  if (args.query !== undefined) {
    if (typeof args.query !== "string") {
      return error(`${TOOL_NAME}: \`query\` must be a string when provided.`);
    }
    const trimmed = args.query.trim();
    if (trimmed.length > 0) query = trimmed;
  }

  let maxChars = SESSION_READ_DEFAULT_MAX_CHARS;
  if (args.max_chars !== undefined) {
    if (
      typeof args.max_chars !== "number" ||
      !Number.isInteger(args.max_chars) ||
      args.max_chars < SESSION_READ_MIN_MAX_CHARS ||
      args.max_chars > SESSION_READ_MAX_MAX_CHARS
    ) {
      return error(
        `${TOOL_NAME}: \`max_chars\` must be a whole number between ${SESSION_READ_MIN_MAX_CHARS} and ${SESSION_READ_MAX_MAX_CHARS}; it defaults to ${SESSION_READ_DEFAULT_MAX_CHARS}.`,
      );
    }
    maxChars = args.max_chars;
  }

  const backend: SessionReadBackend = deps.backend ?? getBackend();

  let conversationRecord: unknown;
  try {
    conversationRecord = await backend.retrieveConversation(conversationId);
  } catch {
    return error(
      `${TOOL_NAME}: conversation "${conversationId}" was not found.`,
    );
  }
  if (!isRecord(conversationRecord)) {
    return error(
      `${TOOL_NAME}: conversation "${conversationId}" was not found.`,
    );
  }
  if (isHiddenConversationRecord(conversationRecord)) {
    return error(
      `${TOOL_NAME}: conversation "${conversationId}" is hidden. Hidden sessions — reflection, dream and subagent runs — are read-only maintenance surfaces and cannot be read with this tool; only ordinary conversations can be read.`,
    );
  }

  let page: unknown;
  try {
    page = await backend.listConversationMessages(conversationId, {
      order: "asc",
      limit: SESSION_READ_MAX_SCAN_MESSAGES,
    });
  } catch {
    return error(
      `${TOOL_NAME}: could not read the messages of conversation "${conversationId}".`,
    );
  }

  const visible: IndexedVisibleMessage[] = projectVisibleMessages(
    extractPageItems(page),
  ).map((message, position) => ({ ...message, index: position + 1 }));

  if (visible.length === 0) {
    return {
      content: `Conversation ${conversationId} has no visible text messages.`,
      status: "success",
    };
  }

  const rangeStart = start?.value ?? 1;
  if (rangeStart > visible.length) {
    return error(
      `${TOOL_NAME}: \`message_start\` is ${rangeStart}, but conversation "${conversationId}" has only ${visible.length} visible message${visible.length === 1 ? "" : "s"}.`,
    );
  }
  const rangeEnd = Math.min(end?.value ?? visible.length, visible.length);
  const selected = filterMessages(visible, rangeStart, rangeEnd, query);

  if (selected.length === 0) {
    return {
      content: query
        ? `SessionRead: no message in ${conversationId} between ${rangeStart} and ${rangeEnd} contains "${query}".`
        : `SessionRead: no visible messages between ${rangeStart} and ${rangeEnd} of ${conversationId}.`,
      status: "success",
    };
  }
  if (offset >= selected.length) {
    return error(
      `${TOOL_NAME}: \`offset\` is ${offset}, but only ${selected.length} message${selected.length === 1 ? "" : "s"} match; the last page starts at offset ${Math.max(0, selected.length - 1)}.`,
    );
  }

  const rendered = renderSessionReadPage({
    conversationId,
    visible,
    selected,
    offset,
    maxChars,
    ...(query !== undefined ? { query } : {}),
  });
  return { content: rendered.content, status: "success" };
}
