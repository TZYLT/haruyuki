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
  "/topic list [--all|--context] | /topic search <kw> | /topic show <#n|title>",
  "",
  "List the topic blocks of the current context, oldest first.",
  "",
  "USAGE",
  "  /topic list           — blocks that still define the current context",
  "  /topic list --all     — every marker this agent has recorded, newest first",
  "  /topic list --context — this conversation's markers, in context order",
  "  /topic search <kw>    — search this agent's topics by title or section",
  "  /topic show <#n|title> — print the conversation a marker covers",
  "  /topic list help      — show this help",
  "",
  "In the terminal the three lists open one full-screen panel: Tab switches the",
  "view, arrows/PgUp/PgDn scroll, Enter opens a row, q closes.",
  "",
  "/compact <n> keeps block n and summarizes everything before it. The numbers in",
  "--context are marker numbers in write order (what /topic show takes), not block",
  "numbers.",
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
  "A marker whose boundary lands on the start of the context defines no block of its own, so it shows up under block 1 in /topic list.",
];

/**
 * The `--context` view has two orders in it, and they are not the same order:
 * the rows follow the context, the numbers follow the transcript. Saying so is
 * cheaper than renumbering, which would rename every marker `/topic show`
 * accepts.
 */
export const CONTEXT_ORDER_NOTE =
  "Rows are in context order — where each topic sits in the context — while #n is the marker's write order (what /topic show takes), not a /compact block number. So the numbers need not run 1, 2, 3 down the list.";

/** The trailing block's label: a topic nobody has marked finished yet. */
export const CURRENT_TOPIC_LABEL = "Current topic (not marked finished)";

/**
 * `/topic list --all` printed as text (the channels with no full-screen face).
 *
 * Same rows as the panel — `buildTopicIndexRows` is the one row model — so the
 * text and the panel cannot disagree about a marker's title, time or source. No
 * `#n` column on purpose: this list is newest first, and a `#1` here would name a
 * different marker than the `--context` table's `#1`.
 */
export function formatTopicIndexList(
  entries: readonly TopicIndexEntry[],
): string {
  if (entries.length === 0) {
    return "No topic markers are indexed for this agent yet. Topics exist only where someone marked one — the TopicMark tool or the user's /topic command.";
  }
  const rows = buildTopicIndexRows(entries);
  return [
    `Every topic marker this agent has recorded (${rows.length}, newest first):`,
    "",
    ...rows.map((row) => `  ${row.line}`),
    "",
    ...TOPIC_LIST_ALL_NOTES,
  ].join("\n");
}

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

/** Why a block whose first message is a compaction summary is titled by an older marker. */
export const COMPACTION_START_NOTE =
  "starts at a compaction summary: the history before it was folded, so the title is an older marker";

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
  /** Creation time of the block's first message (content start). */
  startsAt: string;
  /**
   * When this topic was tagged: the ending marker's write time, or — for the
   * still-open block — when its content starts. The two cases read differently
   * on purpose, because a block's content can predate its marker by days.
   */
  tagLine: string;
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

/**
 * The time half of a block row: when the topic was tagged, or when the open
 * topic's content starts.
 *
 * It deliberately is not "when the block's content starts" in the tagged case.
 * A compaction summary is stamped at fold time while the retained messages keep
 * their own (older) dates, so a block that starts at a summary would print a
 * time *newer* than the content after it — the row would look out of order even
 * though the list is in context order.
 */
export function topicBlockTagLine(block: TopicBlock): string {
  return block.taggedAt === undefined
    ? `open since ${shortTimestamp(block.startsAt)}`
    : `tagged at ${shortTimestamp(block.taggedAt)}`;
}

export function buildTopicBlockRows(list: LocalTopicList): TopicBlockRow[] {
  return list.blocks.map((block, position) => ({
    index: block.index,
    title: block.title ?? CURRENT_TOPIC_LABEL,
    isCurrent: block.title === null,
    messageCount: block.messageCount,
    tokens: block.tokens,
    startsAt: shortTimestamp(block.startsAt),
    tagLine: topicBlockTagLine(block),
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
        `~${String(row.tokens).padStart(6)} tokens  ${row.tagLine}`,
    );
    lines.push(`      boundary: ${row.boundary}`);
    const block = list.blocks[row.index - 1];
    if (block?.compaction) {
      lines.push(`      ${COMPACTION_START_NOTE}`);
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
  /** The marker's number: its write order, 1-based. What `/topic show` takes. */
  index: number;
  /** The marker id: identity, never the row number (§5.6.1). */
  key: string;
  title: string;
  createdBy: string;
  createdAt: string;
  status: string;
  /** The anchor's position in the context, or null once it left it. */
  anchorIndex: number | null;
}

function markerStatus(view: LocalTopicMarkerView): string {
  return view.anchorIndex !== null
    ? "in the current context"
    : "trimmed: its anchor is no longer in the context";
}

/**
 * The `--context` order: by the marker's position in the context, then by write
 * order.
 *
 * A marker whose anchor was folded away sorts before every surviving one: a
 * compaction only ever takes a *prefix* of the context, so a folded anchor is
 * older than everything that was retained. That is what puts a summarizer's
 * marker where its topic actually sits, instead of where its row happened to be
 * appended.
 *
 * Ties keep write order, which is also the numbering, so a marker and the one
 * that absorbed its boundary still read left to right.
 */
export function orderTopicMarkerRows(
  rows: readonly TopicMarkerRow[],
): TopicMarkerRow[] {
  return [...rows].sort(
    (left, right) =>
      (left.anchorIndex ?? -1) - (right.anchorIndex ?? -1) ||
      left.index - right.index,
  );
}

/** Marker rows in **context order**, numbered in **write order**. */
export function buildTopicMarkerRows(list: LocalTopicList): TopicMarkerRow[] {
  const written = list.markers.map((view, position) => ({
    index: position + 1,
    key: view.marker.id,
    title: view.marker.title,
    createdBy: view.marker.createdBy,
    createdAt: shortTimestamp(view.marker.createdAt),
    status: markerStatus(view),
    anchorIndex: view.anchorIndex,
  }));
  return orderTopicMarkerRows(written);
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
    `Every topic marker in this conversation (${rows.length}, context order):`,
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
  lines.push(CONTEXT_ORDER_NOTE);
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
