/**
 * Copy and rows for the topic list (`/topic list`, `/topic list --all`).
 *
 * Pure functions on the backend's structured list so the table, the empty state,
 * and the "the agent's marking channel is off" variant are testable without a
 * backend or a terminal. Nothing here writes; the list commands are read-only.
 */
import type {
  LocalTopicList,
  LocalTopicMarkerView,
} from "@/backend/local/local-topic-trim";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import type { TopicIndexEntry } from "@/backend/local/topic-index";

export const TOPICS_COMMAND_USAGE = [
  "/topic list [--all] | /topic search <kw>",
  "",
  "List the topic blocks of the current context, oldest first.",
  "",
  "USAGE",
  "  /topic list         — blocks that still define the current context",
  "  /topic list --all   — every marker in the conversation, in a full-screen panel",
  "  /topic search <kw>  — search this agent's topics by title or section",
  "  /topic list help    — show this help",
  "",
  "/compact <n> keeps block n and summarizes everything before it. The numbers in",
  "--all are marker positions, not block numbers.",
].join("\n");

/**
 * The two standing notes under `/topic list --all` (§5.11.10) that are about the
 * data rather than about the printed table's own columns.
 *
 * One copy, two readers: the transcript form (`formatTopicMarkerHistory`, which
 * the listener and headless still print) and the full-screen panel's footer. A
 * note that existed only in the printed table would be missing from the face the
 * user actually browses.
 */
export const TOPIC_LIST_ALL_NOTES: readonly string[] = [
  "A trimmed marker stays on disk and keeps its title; it simply no longer defines a block. Removed context is still searchable with /search.",
  "A marker whose boundary lands on the start of the context defines no block of its own, so it shows up under block 1 in /topics.",
];

/**
 * The printed table's third note: it is about the `#n` column above it, which
 * the panel does not draw (its rows are ordered newest first, so a `#1` there
 * would contradict this very sentence).
 */
export const MARKER_POSITION_NOTE =
  "The numbers here are marker positions (marker #1 is the oldest marker), not the block numbers /compact takes.";

/** The trailing block's label: a topic nobody has marked finished yet. */
export const CURRENT_TOPIC_LABEL = "Current topic (not marked finished)";

/**
 * What "absorbed markers" means, printed only when a block has any.
 *
 * The phrase is the one place the block view explains that a marker without a row
 * has not been deleted: its boundary landed on the same point as another marker's
 * (or its anchor message was folded away), so one block has to carry both names.
 */
export const ABSORBED_MARKERS_NOTE = [
  '"absorbed markers" are markers that did not get a row of their own: their',
  "boundary fell on the same point as another marker's, or the message they were",
  "anchored to was folded away by a compaction. They still name their topic — the",
  "block they belong to already has a title, so the later names ride along with it.",
].join("\n");

/** What the user can do when a list has no markers at all. */
export function topicMarkerHint(topicMarkingEnabled: boolean): string {
  if (!topicMarkingEnabled) {
    return "Topic marking is switched off, so only your own /topic markers would appear here.";
  }
  return [
    "Nothing has marked a boundary yet, so the whole context is one block.",
    "  /topic <title>   mark a boundary yourself",
    "  the agent calls TopicMark when it judges a topic finished",
  ].join("\n");
}

/** `2026-10-03T09:31:00.000Z` → `2026-10-03 09:31`; invalid input is kept as is. */
export function shortTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 16).replace("T", " ");
}

export interface TopicBlockRow {
  index: number;
  title: string;
  isCurrent: boolean;
  messageCount: number;
  tokens: number;
  startsAt: string;
  /** How this block's first message was chosen. */
  boundary: string;
}

function columnWidth<T>(
  rows: readonly T[],
  value: (row: T) => string,
  minimum: number,
  maximum: number,
): number {
  return Math.min(
    maximum,
    Math.max(minimum, ...rows.map((row) => value(row).length)),
  );
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width);
}

/**
 * How a block's first message was chosen, in one wording for both readers (the
 * `/topic list` table and the picker's row description).
 *
 * The boundary's author comes from the previous block's marker, which is the
 * marker that ends it. It matters because the agent marks topics on its own
 * (`TopicMark`) — without the author a user who never ran `/topic` sees
 * boundaries they do not remember making.
 */
export function topicBlockBoundaryNote(
  block: TopicBlock,
  previous: TopicBlock | undefined,
): string {
  if (block.index === 1) return "the start of the context";
  const previousTitle = previous?.title ?? CURRENT_TOPIC_LABEL;
  const markedBy = previous?.createdBy
    ? ` marked by the ${previous.createdBy}`
    : "";
  const anchor = block.startMarkerAnchorMessageId ?? "an unknown message";
  const rewound =
    block.rewindTurns === 0
      ? "no rewind"
      : `rewound ${block.rewindTurns} user turn${block.rewindTurns === 1 ? "" : "s"}`;
  return `marker "${previousTitle}"${markedBy} at ${anchor}, ${rewound}`;
}

export function buildTopicBlockRows(list: LocalTopicList): TopicBlockRow[] {
  return list.blocks.map((block, position) => ({
    index: block.index,
    title: block.title ?? CURRENT_TOPIC_LABEL,
    isCurrent: block.title === null,
    messageCount: block.messageCount,
    tokens: block.tokens,
    startsAt: shortTimestamp(block.startsAt),
    boundary: topicBlockBoundaryNote(block, list.blocks[position - 1]),
  }));
}

/** The block table plus the one hint that makes it actionable. */
export function formatTopicBlockList(
  list: LocalTopicList,
  options: { topicMarkingEnabled?: boolean } = {},
): string {
  if (list.contextMessageCount === 0) {
    return "There is nothing in this conversation's context yet.";
  }
  if (list.markers.length === 0) {
    return `No topic markers in this conversation yet.\n\n${topicMarkerHint(
      options.topicMarkingEnabled ?? true,
    )}`;
  }

  const rows = buildTopicBlockRows(list);
  const titleWidth = columnWidth(rows, (row) => row.title, 5, 40);
  const lines = ["Topic blocks in the current context (oldest first):", ""];
  for (const row of rows) {
    const marker = row.index === 1 ? " " : "*";
    lines.push(
      `  ${row.index}${marker} ${pad(row.title.slice(0, titleWidth), titleWidth)}  ` +
        `${String(row.messageCount).padStart(4)} messages  ` +
        `~${String(row.tokens).padStart(6)} tokens  from ${row.startsAt}`,
    );
    lines.push(`      boundary: ${row.boundary}`);
    const block = list.blocks[row.index - 1];
    if (block?.compaction) {
      lines.push(
        "      starts at a compaction summary: the history before it was folded, so the title is an older marker",
      );
    }
    if (block && block.absorbedTitles.length > 0) {
      lines.push(`      absorbed markers: ${block.absorbedTitles.join(", ")}`);
    }
  }
  lines.push("");
  lines.push(
    "/compact <n> keeps block n and summarizes everything before it. Block 1 keeps the whole context, so there is nothing to trim there.",
  );
  lines.push("* = a block you can trim from.");
  if (
    rows.some(
      (row) => (list.blocks[row.index - 1]?.absorbedTitles.length ?? 0) > 0,
    )
  ) {
    lines.push("");
    lines.push(ABSORBED_MARKERS_NOTE);
  }
  return lines.join("\n");
}

export interface TopicMarkerRow {
  index: number;
  title: string;
  createdBy: string;
  createdAt: string;
  status: string;
}

function markerStatus(view: LocalTopicMarkerView): string {
  return view.anchorInContext
    ? "in the current context"
    : "trimmed: its anchor is no longer in the context";
}

export function buildTopicMarkerRows(list: LocalTopicList): TopicMarkerRow[] {
  return list.markers.map((view, position) => ({
    index: position + 1,
    title: view.marker.title,
    createdBy: view.marker.createdBy,
    createdAt: shortTimestamp(view.marker.createdAt),
    status: markerStatus(view),
  }));
}

/** `/topics --all`: every marker, including the ones a trim pushed out. */
export function formatTopicMarkerHistory(
  list: LocalTopicList,
  options: { topicMarkingEnabled?: boolean } = {},
): string {
  if (list.markers.length === 0) {
    return `No topic markers in this conversation.\n\n${topicMarkerHint(
      options.topicMarkingEnabled ?? true,
    )}`;
  }

  const rows = buildTopicMarkerRows(list);
  const titleWidth = columnWidth(rows, (row) => row.title, 5, 40);
  const authorWidth = columnWidth(rows, (row) => row.createdBy, 5, 5);
  const lines = [
    `Every topic marker in this conversation (${rows.length}, oldest first):`,
    "",
  ];
  for (const row of rows) {
    lines.push(
      `  #${row.index}  ${pad(row.title.slice(0, titleWidth), titleWidth)}  ` +
        `${pad(row.createdBy, authorWidth)}  ${row.createdAt}  ${row.status}`,
    );
  }
  lines.push("");
  lines.push(...TOPIC_LIST_ALL_NOTES);
  lines.push(MARKER_POSITION_NOTE);
  return lines.join("\n");
}

/**
 * One topic-index row, as the full-screen panel and the search face show it.
 *
 * The fields are the ones §5.11.10 asks for — title, time, conversation, source —
 * and `line` is the single-line rendering of them: the panel draws one line per
 * row so its height cannot depend on how long a title or a section is.
 */
export interface TopicIndexRow {
  /** The marker id: identity, never the row number (§5.6.1). */
  key: string;
  title: string;
  /** `2026-10-03 09:31`, the same form the block table uses. */
  when: string;
  conversationId: string;
  createdBy: string;
  /** The marker's anchor is no longer in the context. */
  evicted: boolean;
  /** The topic's short record, when a compaction wrote one. */
  section?: string;
  /** Title, time, conversation and source in one line. */
  line: string;
}

/** The conversation a row belongs to, short enough to share a line. */
function conversationLabel(conversationId: string): string {
  if (conversationId === "default") return "default";
  return conversationId.length > 14
    ? `${conversationId.slice(0, 13)}~`
    : conversationId;
}

export function buildTopicIndexRows(
  entries: readonly TopicIndexEntry[],
): TopicIndexRow[] {
  return entries.map((entry) => {
    const when = shortTimestamp(entry.createdAt);
    const conversation = conversationLabel(entry.conversationId);
    const source = entry.evicted
      ? `${entry.createdBy}, trimmed`
      : entry.createdBy;
    return {
      key: entry.topicId,
      title: entry.title,
      when,
      conversationId: entry.conversationId,
      createdBy: entry.createdBy,
      evicted: entry.evicted,
      ...(entry.section === undefined ? {} : { section: entry.section }),
      line: `${entry.title} · ${when} · ${conversation} · ${source}`,
    };
  });
}

/**
 * `/topic search <kw>` outside the TUI: the same rows, printed.
 *
 * The panel is the TUI's answer to this command; a listener or headless run has
 * no face to open, and answering with an empty string would look like "no
 * matches". `limit` is a display budget, not a query one — the index has already
 * answered in full.
 */
export function formatTopicSearchResults(
  keyword: string,
  entries: readonly TopicIndexEntry[],
  options: { limit?: number } = {},
): string {
  const rows = buildTopicIndexRows(entries);
  const scope = keyword.trim();
  if (rows.length === 0) {
    return scope
      ? `No topic markers match "${scope}".`
      : "No topic markers indexed for this agent yet.";
  }
  const limit = options.limit ?? 20;
  const shown = rows.slice(0, Math.max(1, limit));
  const lines = [
    scope
      ? `Topic markers matching "${scope}" (${rows.length}, newest first):`
      : `Topic markers for this agent (${rows.length}, newest first):`,
    "",
    ...shown.map((row) => `  ${row.line}`),
  ];
  if (rows.length > shown.length) {
    lines.push(
      `  ... ${rows.length - shown.length} more; narrow the keyword to see them.`,
    );
  }
  return lines.join("\n");
}
