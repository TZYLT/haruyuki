/**
 * F-04 T-10: the topic recall projection — "the conversation this marker covers",
 * as cleaned text.
 *
 * ## Why this module exists instead of handing out the transcript
 *
 * A marker stores an `anchorMessageId`, and the file that id points into is
 * storage, not an interface. A model given a path or a message id has learned the
 * on-disk format (that becomes part of the prompt contract) and has skipped every
 * budget. It would also read mostly noise: in one assistant message, reasoning and
 * tool arguments routinely outweigh the text a question is actually about. So the
 * span is recomputed here from the marker sequence, projected down to what a person
 * saw, and cut to a character budget that says what it dropped.
 *
 * The projection is deterministic and pure: it reads files, never writes, never
 * calls a model, and never returns a message id or a path. Two faces share it —
 * `TopicQuery`'s `include: "excerpt" | "full"` and `/topic show` — because two
 * copies of "clean this, then cut it to N characters" would drift, and the point is
 * that the model and the user read the same text.
 *
 * ## Where a span comes from
 *
 * `anchorMessageId` is the message the topic *ended* at, so a span is
 * `[previous marker's end, this marker's end)`. The transcript only ever grows — a
 * compaction rewrites `in_context_message_ids` and appends a summary row, it never
 * deletes a message row — so a marker whose anchor was folded out of the context
 * still reads in full. See {@link markerEndExclusive} for the one place the two
 * producers disagree about whose message the anchor is.
 *
 * ## What is deliberately not here
 *
 * No vector search, no index changes, no "whole conversation" default. The index
 * stays metadata-only; this recomputes from the transcript on every read.
 */
import { join } from "node:path";
import { isRecord } from "@/utils/type-guards";
import { estimateLocalMessagesTokens } from "./local-context-estimate";
import type { LocalMessage, LocalMessageMetadata } from "./local-message";
import {
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  localTranscriptRowsResult,
  readJsonFileOrUndefined,
  readJsonlFileTolerant,
  transcriptMessagesPath,
} from "./local-transcript";
import type { LocalTranscriptTopicEntry } from "./local-transcript-topic-entry";
import {
  isLocalTranscriptTopicEntry,
  type LocalTopicCreatedBy,
} from "./local-transcript-topic-entry";
import { conversationDirectories } from "./transcript-search";

/** Character ceiling for one topic's `excerpt` projection. */
export const TOPIC_RECALL_EXCERPT_MAX_CHARS = 1000;

/** Character ceiling for one topic's `full` projection. */
export const TOPIC_RECALL_FULL_MAX_CHARS = 8000;

/**
 * Floor under any requested ceiling.
 *
 * The header (title, source, timestamp, message count, session) plus a one-line
 * "N more not shown" notice has to fit; a smaller budget would have to clip the
 * header itself, which is the kind of silent cut this module exists to avoid.
 * Every ceiling is therefore `max(TOPIC_RECALL_MIN_MAX_CHARS, requested)`.
 */
export const TOPIC_RECALL_MIN_MAX_CHARS = 600;

/** How many messages `excerpt` keeps from each end of the span. */
export const TOPIC_RECALL_EXCERPT_EDGE_MESSAGES = 3;

/** What an image or attachment becomes: a placeholder, never the payload. */
export const TOPIC_RECALL_IMAGE_PLACEHOLDER = "[image]";

/** Titles are clamped in the header so the header length stays bounded. */
export const TOPIC_RECALL_TITLE_MAX_CHARS = 80;

/** Shortest a per-message cut may get before the message is dropped instead. */
export const TOPIC_RECALL_MIN_BLOCK_CHARS = 80;

const EVICTED_NOTE =
  "note: this marker's anchor is no longer in the context, so the span is read from the transcript, which only ever grows.";

const EMPTY_SPAN_NOTE =
  "note: no messages fall in this span — a later marker landed on the same point as this one, so this topic has no messages of its own.";

const FOLDED_NOTE_WITHOUT_COUNT =
  "(earlier messages of this conversation are folded into this summary)";

/**
 * Injected-context blocks that must never reach a recall body: an automated
 * reminder, the legacy alert wrapper, and a background-task notification.
 *
 * The same tags are stripped by `src/cli/helpers/conversation-title.ts` (for
 * conversation titles) and extracted by `src/utils/task-notifications.ts` (for
 * display). `backend/` cannot import either — both sit above this layer, and
 * `task-notifications.ts` pulls in `agent/` — so the pattern is duplicated here on
 * purpose, with its sources named. Keep the two in step.
 */
const INJECTED_BLOCK_PATTERN =
  /<(system-reminder|system-alert|task-notification)>[\s\S]*?<\/\1>/g;

/** An unmatched tag left behind by a damaged message: dropped, content kept. */
const STRAY_INJECTED_TAG_PATTERN =
  /<\/?(?:system-reminder|system-alert|task-notification)\b[^>]*>/g;

export type TopicRecallTier = "excerpt" | "full";

/** One cleaned message, as both faces print it. */
export interface TopicRecallMessage {
  /** 1-based position within the span. Numbering makes a gap visible. */
  position: number;
  role: "user" | "assistant";
  text: string;
}

/** Everything one marker's span holds, before any budget is applied. */
export interface TopicRecallSpan {
  topicId: string;
  conversationId: string;
  title: string;
  /** The marker's section (F-04's per-topic record), when it carries one. */
  section?: string;
  createdBy: LocalTopicCreatedBy;
  createdAt: string;
  /**
   * The marker's anchor is outside `in_context_message_ids`. The text is complete
   * anyway — only the anchor's *residency* ended, not the message row.
   */
  evicted: boolean;
  /** Cleaned messages of the span, transcript order, already deduplicated. */
  messages: TopicRecallMessage[];
  /** Estimated tokens of the kept messages, for the human-facing outline. */
  estimatedTokens: number;
  /** Timestamp of the span's first and last kept message, ISO, when known. */
  startsAt?: string;
  endsAt?: string;
}

/** The projected text plus the facts both faces need to frame it. */
export interface TopicRecallResult {
  topicId: string;
  conversationId: string;
  title: string;
  createdBy: LocalTopicCreatedBy;
  createdAt: string;
  /** Cleaned messages the span holds. */
  messageCount: number;
  /** Messages the budget left out; the body ends with the count. */
  truncatedMessageCount: number;
  evicted: boolean;
  /**
   * The framing the projection put above the body. Exposed because `/topic
   * show`'s outline reuses it instead of rebuilding a second header.
   */
  header: string;
  /** The message projection alone: `text === header + "\n\n" + body`. */
  body: string;
  /** Exactly what both faces print or compare. Never a path, never a message id. */
  text: string;
  chars: number;
}

export interface TopicRecallInput {
  storageDir: string;
  agentId: string;
  conversationId: string;
  topicId: string;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Text of a message's content parts, with reasoning and tool calls dropped.
 *
 * Written against `unknown` parts rather than the pi-ai union because the three
 * roles carry three different unions, and the structural read is what makes
 * "thinking and toolCall never contribute text" a single rule instead of three.
 */
function contentPartsText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "image") {
      parts.push(TOPIC_RECALL_IMAGE_PLACEHOLDER);
    }
  }
  return parts.join("\n");
}

/**
 * One compaction summary, unpacked.
 *
 * A compaction's summary message is a `role:"user"` message whose `content[0].text`
 * is the *packed* `system_alert` JSON. Printing that verbatim would be pure noise,
 * so the plain body is taken from `metadata.compaction.summary` — the field the
 * rewrite itself wrote — and framed as "N earlier messages are folded here".
 */
function formatCompactionSummary(
  compaction: NonNullable<LocalMessageMetadata["compaction"]>,
): string | null {
  const before = compaction.stats?.messages_count_before;
  const after = compaction.stats?.messages_count_after;
  const folded =
    typeof before === "number" && typeof after === "number" && before > after
      ? before - after
      : undefined;
  const header =
    folded === undefined
      ? FOLDED_NOTE_WITHOUT_COUNT
      : `(here ${folded} earlier message${folded === 1 ? "" : "s"} are folded into this summary)`;
  const summary = normalizeRecallText(compaction.summary);
  return summary === null ? header : `${header}\n${summary}`;
}

/** Collapse the noise in a text run and drop it when nothing is left. */
function normalizeRecallText(text: string): string | null {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(INJECTED_BLOCK_PATTERN, "")
    .replace(STRAY_INJECTED_TAG_PATTERN, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length === 0 ? null : normalized;
}

/**
 * What a recall reader is allowed to see of one message, or `null` for nothing.
 *
 * The table is the ruling from the T-10 decision: user and assistant text stays;
 * reasoning, tool calls and tool results (including orphan results) go; injected
 * reminder/alert/notification blocks go; a compaction summary is unpacked; an image
 * becomes a placeholder.
 */
export function cleanMessageTextForRecall(
  message: LocalMessage,
): string | null {
  if (message.role === "toolResult") return null;
  const compaction = message.metadata?.compaction;
  if (message.role === "user" && compaction !== undefined) {
    return formatCompactionSummary(compaction);
  }
  if (message.role === "user") {
    const raw =
      typeof message.content === "string"
        ? message.content
        : contentPartsText(message.content);
    return normalizeRecallText(raw);
  }
  // Assistant: only the text parts survive `contentPartsText`, which is exactly the
  // "reasoning and toolCall are dropped" rule.
  return normalizeRecallText(contentPartsText(message.content));
}

function formatRecallTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function clampTitle(title: string): string {
  return title.length <= TOPIC_RECALL_TITLE_MAX_CHARS
    ? title
    : `${title.slice(0, TOPIC_RECALL_TITLE_MAX_CHARS - 1)}…`;
}

function truncationNotice(remaining: number): string {
  return `(and ${remaining} more message${remaining === 1 ? "" : "s"} not shown)`;
}

function clampRecallText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * A marker's end as an exclusive index into the message list.
 *
 * The two producers disagree on purpose, and this is the whole reason the branch
 * exists: a user or agent marker anchors on the topic's **last** message, so that
 * message belongs to this span (`index + 1`); a summarizer marker anchors on the
 * **first message of the next topic** — the exact boundary it resolved — so the
 * anchor belongs to the next span (`index`).
 *
 * A missing anchor falls back to the end of the transcript. There is no way to
 * invent a boundary that is not recorded, and reading too much is recoverable
 * while dropping content is not; in practice this only covers legacy markers
 * written with no anchor at all.
 */
function markerEndExclusive(
  marker: LocalTranscriptTopicEntry,
  indexById: ReadonlyMap<string, number>,
  messageCount: number,
): number {
  const anchor = marker.anchorMessageId;
  if (anchor === null) return messageCount;
  const index = indexById.get(anchor);
  if (index === undefined) return messageCount;
  return marker.createdBy === "summarizer" ? index : index + 1;
}

interface RecallConversationRecord {
  conversationDir: string;
  inContextMessageIds?: readonly string[];
}

/**
 * The conversation's directory, found the way the topic index finds it.
 *
 * The directory name is a keyed encoding this module does not own
 * (`LocalStore`'s `conversationKey`), so it is read from `conversation.json` rather
 * than recomputed. A record belonging to another agent is still returned: the
 * caller named an exact conversation id and marker, so this is an address, not a
 * discovery — and an agent-free conversation's `agent_id` legitimately differs from
 * the agent that marked it.
 */
function findRecallConversation(
  storageDir: string,
  conversationId: string,
  agentId: string,
): RecallConversationRecord | undefined {
  let foreignMatch: RecallConversationRecord | undefined;
  for (const conversationDir of conversationDirectories(storageDir)) {
    const raw = readJsonFileOrUndefined<unknown>(
      join(conversationDir, "conversation.json"),
    );
    if (!isRecord(raw) || raw.id !== conversationId) continue;
    const record: RecallConversationRecord = {
      conversationDir,
      ...(isStringArray(raw.in_context_message_ids)
        ? { inContextMessageIds: raw.in_context_message_ids }
        : {}),
    };
    if (raw.agent_id === undefined || raw.agent_id === agentId) return record;
    foreignMatch ??= record;
  }
  return foreignMatch;
}

/**
 * Read one marker's span out of the transcript, or `null` when the marker is not
 * there (the conversation is gone, or the id is wrong).
 *
 * The rows are parsed once and shared: the topic guards are the same
 * `isLocalTranscriptTopicEntry` predicate the chunked marker scan uses, and the
 * message rows go through the store's own `localTranscriptRowsResult`, so this module
 * adds no second set of format assumptions. Only the versioned transcript format is
 * handled: the store refuses to start on an unversioned one and migrates it first.
 */
export function readTopicRecallSpan(
  input: TopicRecallInput,
): TopicRecallSpan | null {
  const conversation = findRecallConversation(
    input.storageDir,
    input.conversationId,
    input.agentId,
  );
  if (!conversation) return null;

  const rows = readJsonlFileTolerant<unknown>(
    transcriptMessagesPath(conversation.conversationDir),
  );
  if (rows.length === 0) return null;

  const markers = rows.filter(isLocalTranscriptTopicEntry);
  const markerIndex = markers.findIndex(
    (marker) => marker.id === input.topicId,
  );
  if (markerIndex < 0) return null;
  const marker = markers[markerIndex];
  if (!marker) return null;

  const ordered = Array.from(
    localTranscriptRowsResult(
      rows,
      LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
    ).messageById.values(),
  );
  // First sighting wins for position: a re-appended message keeps its place in the
  // conversation even though `messageById` holds the newest snapshot of its content.
  const indexById = new Map<string, number>();
  ordered.forEach((message, index) => {
    if (!indexById.has(message.id)) indexById.set(message.id, index);
  });

  const previous = markerIndex > 0 ? markers[markerIndex - 1] : undefined;
  const start = previous
    ? markerEndExclusive(previous, indexById, ordered.length)
    : 0;
  const end = markerEndExclusive(marker, indexById, ordered.length);
  const from = Math.min(Math.max(0, start), ordered.length);
  const to = Math.max(from, Math.min(end, ordered.length));

  const messages: TopicRecallMessage[] = [];
  const kept: LocalMessage[] = [];
  for (const message of ordered.slice(from, to)) {
    const text = cleanMessageTextForRecall(message);
    if (text === null) continue;
    kept.push(message);
    messages.push({
      position: messages.length + 1,
      role: message.role === "assistant" ? "assistant" : "user",
      text,
    });
  }

  const firstAt = kept[0]?.timestamp;
  const lastAt = kept[kept.length - 1]?.timestamp;
  const inContext = conversation.inContextMessageIds;
  const evicted =
    marker.anchorMessageId !== null &&
    inContext !== undefined &&
    !inContext.includes(marker.anchorMessageId);
  const section = marker.summary?.trim();

  return {
    topicId: marker.id,
    conversationId: input.conversationId,
    title: marker.title,
    ...(section !== undefined && section.length > 0 ? { section } : {}),
    createdBy: marker.createdBy,
    createdAt: marker.timestamp,
    evicted,
    messages,
    estimatedTokens: estimateLocalMessagesTokens(kept),
    ...(typeof firstAt === "number" && Number.isFinite(firstAt)
      ? { startsAt: new Date(firstAt).toISOString() }
      : {}),
    ...(typeof lastAt === "number" && Number.isFinite(lastAt)
      ? { endsAt: new Date(lastAt).toISOString() }
      : {}),
  };
}

function resolveMaxChars(
  tier: TopicRecallTier,
  requested: number | undefined,
): number {
  const fallback =
    tier === "excerpt"
      ? TOPIC_RECALL_EXCERPT_MAX_CHARS
      : TOPIC_RECALL_FULL_MAX_CHARS;
  if (requested === undefined) return fallback;
  // An unlimited render is what `/topic show --out` and its overflow copy ask for:
  // a file is not a budget, so it keeps everything.
  if (requested === Number.POSITIVE_INFINITY) return requested;
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.max(TOPIC_RECALL_MIN_MAX_CHARS, Math.floor(requested));
}

/**
 * Which messages a tier displays, and how much of each.
 *
 * `excerpt` keeps the head and the tail of the span — the shape a question about a
 * topic usually needs — and shares the per-message allowance out of the real room
 * left after the header, so one long message cannot swallow the whole excerpt.
 * `full` keeps everything and relies on the budget to cut whole messages.
 */
function selectRecallMessages(
  messages: readonly TopicRecallMessage[],
  tier: TopicRecallTier,
  room: number,
): TopicRecallMessage[] {
  if (tier === "full") return [...messages];
  const edge = TOPIC_RECALL_EXCERPT_EDGE_MESSAGES;
  if (messages.length <= edge * 2) return [...messages];
  const selected = [
    ...messages.slice(0, edge),
    ...messages.slice(messages.length - edge),
  ];
  const allowance = Math.max(
    TOPIC_RECALL_MIN_BLOCK_CHARS,
    Math.floor(room / selected.length) - 24,
  );
  return selected.map((message) => ({
    ...message,
    text: clampRecallText(message.text, allowance),
  }));
}

function formatRecallBlock(message: TopicRecallMessage): string {
  return `${message.position}. ${message.role}:\n${message.text}`;
}

/**
 * Greedily keep whole messages until the room runs out.
 *
 * The truncation notice is reserved *before* a message is accepted, so the body —
 * messages plus notice — never exceeds `room`. Messages are taken from the front, so
 * what survives is the start of the topic, which is the reading order.
 */
function packRecallBlocks(
  selected: readonly TopicRecallMessage[],
  total: number,
  room: number,
): { body: string; shown: number } {
  let body = "";
  let shown = 0;
  for (const message of selected) {
    const block = formatRecallBlock(message);
    const candidate = body.length === 0 ? block : `${body}\n\n${block}`;
    const remaining = total - (shown + 1);
    const reserve =
      remaining > 0 ? `\n\n${truncationNotice(remaining)}`.length : 0;
    if (candidate.length + reserve > room) break;
    body = candidate;
    shown += 1;
  }
  return { body, shown };
}

/**
 * Project a span to text under a budget.
 *
 * `text` is `header + "\n\n" + body` and is what both faces print, so
 * `/topic show` and `TopicQuery` cannot disagree about the same tier. The ceiling is
 * hard: over budget, the body ends with "and N more messages not shown" — a silent
 * cut would let a caller believe it had read the whole topic.
 */
export function renderTopicRecall(input: {
  span: TopicRecallSpan;
  tier: TopicRecallTier;
  maxChars?: number;
}): TopicRecallResult {
  const { span, tier } = input;
  const maxChars = resolveMaxChars(tier, input.maxChars);
  const total = span.messages.length;
  const headerLines = [
    `Topic: ${clampTitle(span.title)}`,
    `${span.createdBy} · ${formatRecallTimestamp(span.createdAt)} · ${total} message${total === 1 ? "" : "s"} · session ${span.conversationId}`,
  ];
  if (span.evicted) headerLines.push(EVICTED_NOTE);
  const header = headerLines.join("\n");

  const room = Math.max(0, maxChars - header.length - 2);
  let body = EMPTY_SPAN_NOTE;
  let shown = 0;
  if (total > 0) {
    const selected = selectRecallMessages(span.messages, tier, room);
    let packed = packRecallBlocks(selected, total, room);
    if (packed.shown === 0) {
      // Even one message is longer than the whole budget: cut the first one rather
      // than answer with an empty body. The ellipsis is explicit, so this is not a
      // silent truncation — and the notice below still reports the rest.
      const first = selected[0];
      if (first) {
        const allowance = Math.max(TOPIC_RECALL_MIN_BLOCK_CHARS, room - 64);
        packed = packRecallBlocks(
          [{ ...first, text: clampRecallText(first.text, allowance) }],
          total,
          room,
        );
      }
    }
    const remaining = total - packed.shown;
    shown = packed.shown;
    if (packed.body.length === 0) {
      // Nothing fitted at all (a budget smaller than one cut message): the notice
      // is the whole body, which still names what is missing.
      body = truncationNotice(remaining);
    } else if (remaining > 0) {
      body = `${packed.body}\n\n${truncationNotice(remaining)}`;
    } else {
      body = packed.body;
    }
  }

  const text = `${header}\n\n${body}`;
  return {
    topicId: span.topicId,
    conversationId: span.conversationId,
    title: span.title,
    createdBy: span.createdBy,
    createdAt: span.createdAt,
    messageCount: total,
    truncatedMessageCount: total - shown,
    evicted: span.evicted,
    header,
    body,
    text,
    chars: text.length,
  };
}

/**
 * The one entry point both faces call: read the span, then project it.
 *
 * `null` means the marker is not in that conversation's transcript — a stale index
 * entry or a deleted conversation, not an empty topic.
 */
export function recallTopicConversation(
  input: TopicRecallInput & {
    tier: TopicRecallTier;
    maxChars?: number;
  },
): TopicRecallResult | null {
  const span = readTopicRecallSpan(input);
  if (!span) return null;
  return renderTopicRecall({
    span,
    tier: input.tier,
    ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
  });
}
