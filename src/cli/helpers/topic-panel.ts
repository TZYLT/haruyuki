/**
 * Row models for the one topic panel: `/topic list` (blocks), `--context`
 * (this conversation's markers) and `--all` (this agent's index).
 *
 * The three views used to be three faces — one printed block table, one printed
 * marker table, and one full-screen index. They answer one question each about
 * the same data, so they now share a chrome, a row shape and a key table, and
 * this module is the single place that turns the data into rows. Keeping it
 * pure means the panel's frame test can assert on rows instead of on a backend,
 * and the printed forms (`topic-list.ts`) can keep reusing the same models.
 *
 * Two ordering rules are load-bearing:
 *
 * - **Blocks are in context order**, oldest first — the order `/compact <n>`
 *   numbers them in.
 * - **Marker rows are in context order too, but numbered in write order** (user
 *   ruling, 2026-10-28: fix the order, do not renumber). The number is what
 *   `/topic show` takes, so it has to stay the transcript's order; see
 *   `orderTopicMarkerRows`.
 */

import type { LocalTopicList } from "@/backend/local/local-topic-trim";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import type { TopicIndexEntry } from "@/backend/local/topic-index";
import {
  buildTopicBlockRows,
  buildTopicIndexRows,
  buildTopicMarkerRows,
  COMPACTION_START_NOTE,
  shortTimestamp,
  TOPIC_LIST_ALL_NOTES,
  topicBlockBoundaryNote,
  topicBlockTagLine,
} from "./topic-list";

export type TopicPanelView = "blocks" | "context" | "all";

/** Tab order. Blocks first because it is the view `/topic list` opens. */
export const TOPIC_PANEL_VIEWS: readonly TopicPanelView[] = [
  "blocks",
  "context",
  "all",
];

/** The command spelled in the frame header, one per view. */
export function topicPanelCommand(view: TopicPanelView): string {
  switch (view) {
    case "blocks":
      return "/topic list";
    case "context":
      return "/topic list --context";
    case "all":
      return "/topic list --all";
  }
}

/** The frame's title: what the visible rows are. */
export function topicPanelTitle(view: TopicPanelView): string {
  switch (view) {
    case "blocks":
      return "Topic blocks (context order)";
    case "context":
      return "This conversation's markers (context order)";
    case "all":
      return "Every marker this agent has recorded (newest first)";
  }
}

/**
 * The standing notes under a view. Exactly two per view, because the frame's
 * row budget is measured from a constant footer (see `CHROME_ROWS` in the
 * component): a view whose footer grew would resize the window mid-session.
 */
export function topicPanelNotes(view: TopicPanelView): readonly string[] {
  switch (view) {
    case "blocks":
      return [
        "/compact <n> keeps block n and summarizes everything before it.",
        "Block 1 keeps the whole context, so there is nothing to trim there.",
      ];
    case "context":
      // The panel's footer is one clipped line per note, so this is the short
      // form of `CONTEXT_ORDER_NOTE` (the printed table carries the long one).
      return [
        "Rows: context order · #n: write order (what /topic show takes).",
        TOPIC_LIST_ALL_NOTES[0] ?? "",
      ];
    case "all":
      return TOPIC_LIST_ALL_NOTES;
  }
}

/** How a view counts its rows ("3 blocks", "3 markers"). */
export function topicPanelCount(view: TopicPanelView, count: number): string {
  const noun =
    view === "blocks"
      ? count === 1
        ? "block"
        : "blocks"
      : count === 1
        ? "marker"
        : "markers";
  return `${count} ${noun}`;
}

/** How a view says "there is nothing here". */
export function topicPanelEmpty(view: TopicPanelView): {
  message: string;
  hint: string;
} {
  switch (view) {
    case "blocks":
      return {
        message: "No topic markers in this conversation's context yet.",
        hint: "Mark one with /topic <title>, or let the agent call TopicMark when a topic ends.",
      };
    case "context":
      return {
        message: "No topic markers in this conversation yet.",
        hint: "Mark one with /topic <title>, or let the agent call TopicMark when a topic ends.",
      };
    case "all":
      return {
        message: "No topic markers in this agent's conversations yet.",
        hint: "Mark one with /topic <title>, or let the agent call TopicMark when a topic ends.",
      };
  }
}

/**
 * One row of any view.
 *
 * `label` and `description` are one terminal line together (the row renderer
 * clips them), `detail` is what Enter opens: the facts that do not fit on the
 * row and would otherwise be lost now that the table is not printed.
 */
export interface TopicPanelRow {
  /** Identity: a marker id, a boundary message id, or a topic id. */
  key: string;
  label: string;
  description?: string;
  detail: readonly string[];
}

/** The one-line summary of a block the panel and the picker share. */
export function topicBlockMeta(block: TopicBlock): string {
  return `${block.messageCount} messages · ~${block.tokens} tokens · ${topicBlockTagLine(block)}`;
}

function blockDetail(
  block: TopicBlock,
  previous: TopicBlock | undefined,
): string[] {
  const lines = [
    `boundary: ${topicBlockBoundaryNote(block, previous)}`,
    `content starts at ${shortTimestamp(block.startsAt)}`,
  ];
  if (block.compaction) lines.push(COMPACTION_START_NOTE);
  if (block.absorbedTitles.length > 0) {
    lines.push(`absorbed markers: ${block.absorbedTitles.join(", ")}`);
  }
  if (block.summary !== undefined && block.summary.trim().length > 0) {
    lines.push(`topic summary: ${block.summary.replace(/\s+/g, " ").trim()}`);
  }
  return lines;
}

/** `/topic list`: one row per block, oldest first, numbered as `/compact` is. */
export function buildTopicBlockPanelRows(
  list: LocalTopicList,
): TopicPanelRow[] {
  // `buildTopicBlockRows` owns the copy (the printed table reads it too), so a
  // wording change lands in both faces at once.
  const rows = buildTopicBlockRows(list);
  return rows.map((row, position) => {
    const block = list.blocks[position];
    return {
      key: block?.markerId ?? block?.boundaryMessageId ?? `block-${row.index}`,
      label: `${row.index}. ${row.title}`,
      description: block ? topicBlockMeta(block) : row.tagLine,
      detail: block ? blockDetail(block, list.blocks[position - 1]) : [],
    };
  });
}

/**
 * `/topic list --context`: one row per marker, in the order the topics sit in
 * the context, labelled with the marker's write-order number.
 *
 * The detail says which block the marker ends (or which block absorbed it), so
 * the two numbering schemes are never left implicit.
 */
export function buildTopicContextPanelRows(
  list: LocalTopicList,
): TopicPanelRow[] {
  const endingBlock = new Map<string, TopicBlock>();
  const absorbingBlock = new Map<string, TopicBlock>();
  for (const block of list.blocks) {
    if (block.markerId !== null) endingBlock.set(block.markerId, block);
    for (const title of block.absorbedTitles) {
      if (!absorbingBlock.has(title)) absorbingBlock.set(title, block);
    }
  }

  return buildTopicMarkerRows(list).map((row) => {
    const ends = endingBlock.get(row.key);
    const absorbed = ends ? undefined : absorbingBlock.get(row.title);
    const detail = [
      `#${row.index} is the marker's write order, which /topic show takes.`,
      row.anchorIndex === null
        ? "anchor: no longer in the context — a compaction folded it away"
        : `anchor: message ${row.anchorIndex + 1} of ${list.contextMessageCount} in the context`,
      ends
        ? `ends block ${ends.index}`
        : absorbed
          ? `absorbed into block ${absorbed.index}`
          : "defines no block of its own",
    ];
    if (absorbed) {
      detail.push(
        "absorbed: another marker's boundary landed on the same point, or its anchor was folded away.",
      );
    }
    if (ends?.summary !== undefined && ends.summary.trim().length > 0) {
      detail.push(`topic summary: ${ends.summary.replace(/\s+/g, " ").trim()}`);
    }
    return {
      key: row.key,
      label: `#${row.index}  ${row.title}`,
      description: `${row.createdBy} · ${row.createdAt} · ${row.status}`,
      detail,
    };
  });
}

/** `/topic list --all`: the per-agent index, newest first. */
export function buildTopicIndexPanelRows(
  entries: readonly TopicIndexEntry[],
): TopicPanelRow[] {
  return buildTopicIndexRows(entries).map((row) => ({
    key: row.key,
    // One line per row: the whole point of the panel is that the table no
    // longer has to fit every column into the scrollback.
    label: row.line,
    detail: [
      `${row.createdBy}${row.evicted ? " · trimmed" : ""} · conversation ${row.conversationId}`,
      row.section ??
        "No section was recorded for this topic. A section is written when a compaction folds the topic in.",
    ],
  }));
}

/** The rows of whichever view is on screen. */
export function buildTopicPanelRows(
  view: TopicPanelView,
  data: {
    list: LocalTopicList;
    entries: readonly TopicIndexEntry[];
  },
): TopicPanelRow[] {
  switch (view) {
    case "blocks":
      return buildTopicBlockPanelRows(data.list);
    case "context":
      return buildTopicContextPanelRows(data.list);
    case "all":
      return buildTopicIndexPanelRows(data.entries);
  }
}
