// src/cli/app/pages/overview/overview-rows.ts

/**
 * Row building for the `+` overview (T-10, W-13).
 *
 * The overview is one page with two levels: the first lists agents, the second
 * the conversations of one agent. This module is the **only** place that turns
 * the frozen data contract (`overview-types.ts`, produced by W-12) into
 * `PageRow`s. The page shell (W-15) owns the frame, the breadcrumb, the
 * keyboard/mouse wiring and the empty/error states; the navigation package
 * (W-17) owns what activating a row actually does.
 *
 * What a level looks like (`《47-1》R-10.2` / `R-10.3`); `▏` is the frame's
 * two-column mark, which is not part of the row:
 *
 * ```text
 * level 1 (agents)                      level 2 (conversations)
 * ▏ New Agent                           ▏ New Session
 * ▏ <name>        <N conv>  <time>      ▏ <title>      <time>  created <time>
 * ▏   <description>                     ▏   <last user message>
 * ▏                                     ▏   <last agent message>
 * ▏ <next agent…>                       ▏
 * ```
 *
 * Three properties are load-bearing:
 *
 * - **The first line is the frame's, not ours.** `page-frame.tsx` composes an
 *   item's first line from `label` / `hint` / `value` / `note` in fixed columns
 *   and clips each cell itself. Only the continuation lines (`item.lines`) are
 *   drawn verbatim, so the row builder must clip every one of them to `width`
 *   (`PageBodyGeometry.width`) — an over-wide continuation wraps and costs a
 *   physical line the frame's window arithmetic never budgeted. `truncateText`
 *   is the tree's one clipper (it asks the terminal's width table rather than
 *   `string-width`'s).
 * - **An item is `1 + lines.length` terminal lines** (W-01's frozen contract,
 *   see `page-model.ts`). The agent item is `lines: [description, ""]` and the
 *   conversation item is `lines: [user, agent, ""]`: the trailing empty string
 *   is not decoration, it *is* the blank line between items. `page-frame.tsx`
 *   paints an empty continuation as one space, so the height stays truthful.
 * - **No wall clock.** Every relative time is anchored on the caller's `nowMs`
 *   — in the page that is `OverviewSnapshot.generatedAtMs` — so a frame is a
 *   pure function of the snapshot and the terminal width. Reading `Date.now()`
 *   here would move rows under a cursor that did not move, and would make the
 *   tests time-zone dependent.
 *
 * Ordering belongs to the data layer: `OverviewSnapshot` is documented as
 * already sorted (agents by descending last activity, each conversation group
 * likewise) because a page that re-sorted on every frame would move the row the
 * cursor is on. The builders below preserve the order they are given and
 * deliberately do not sort.
 */

import type { PageRow } from "@/cli/app/pages/page-model";
import { truncateText } from "@/cli/helpers/truncate-text";
import type {
  OverviewAgentRecord,
  OverviewConversationRecord,
} from "./overview-types";

/** The one placeholder for a value the data layer does not have. */
export const OVERVIEW_EMPTY = "—";

/**
 * The columns an item's continuation line starts with.
 *
 * The frame draws the composed first line as `mark + label`, and the mark is two
 * columns (`  `, or `> ` when the item is focused). A continuation line that
 * started at column 0 would not read as part of the same block, so every
 * continuation line begins with the same two columns and the text lines up under
 * the label.
 */
const ROW_INDENT = "  ";

/** The fixed first row of the agent level (`R-10.2`). */
export const NEW_AGENT_ROW_ID = "overview:new-agent";

/** The fixed first row of the conversation level (`R-10.3`). */
export const NEW_SESSION_ROW_ID = "overview:new-session";

const AGENT_ROW_ID_PREFIX = "overview:agent:";
const CONVERSATION_ROW_ID_PREFIX = "overview:conversation:";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The row id for one agent (level 1).
 *
 * `PageRow` is the frame's vocabulary, not a domain record, so the id is how the
 * page shell knows which agent `Enter` on the row opens. `overviewRowTarget` is
 * the matching reader; nothing else should parse the prefix.
 */
export function agentRowId(agentId: string): string {
  return `${AGENT_ROW_ID_PREFIX}${agentId}`;
}

/** The row id for one conversation (level 2); see `agentRowId`. */
export function conversationRowId(conversationId: string): string {
  return `${CONVERSATION_ROW_ID_PREFIX}${conversationId}`;
}

/** What activating an overview row means, decoded from its id. */
export type OverviewRowTarget =
  | { kind: "new-agent" }
  | { kind: "new-session" }
  | { kind: "agent"; agentId: string }
  | { kind: "conversation"; conversationId: string };

/**
 * Decode an overview row id back to the action the page shell has to take.
 *
 * `null` for an id this module did not build, so a stale cursor (a row kept from
 * an older shape) can never open the wrong agent or conversation.
 */
export function overviewRowTarget(id: string): OverviewRowTarget | null {
  if (id === NEW_AGENT_ROW_ID) return { kind: "new-agent" };
  if (id === NEW_SESSION_ROW_ID) return { kind: "new-session" };
  if (id.startsWith(AGENT_ROW_ID_PREFIX)) {
    const agentId = id.slice(AGENT_ROW_ID_PREFIX.length);
    return agentId === "" ? null : { kind: "agent", agentId };
  }
  if (id.startsWith(CONVERSATION_ROW_ID_PREFIX)) {
    const conversationId = id.slice(CONVERSATION_ROW_ID_PREFIX.length);
    return conversationId === ""
      ? null
      : { kind: "conversation", conversationId };
  }
  return null;
}

/**
 * English, compact relative time, anchored on `nowMs`.
 *
 * `—` when the timestamp is missing or not a number (`R-10.8`: an agent with no
 * activity shows `—`). The scale stops at days: an overview row says how stale
 * the conversation is, and `413d ago` is more honest than `59 weeks ago`.
 *
 * The dream status face (`formatDreamRunTime`) has the same wording but cannot
 * be reused here: it defaults its anchor to `Date.now()` and answers
 * "time unknown" for `null`, while this builder has to stay a pure function of
 * its inputs and say `—`. Keeping the arithmetic local is what preserves both.
 */
export function formatRelativeTime(nowMs: number, atMs: number | null): string {
  if (atMs === null || !Number.isFinite(atMs) || !Number.isFinite(nowMs)) {
    return OVERVIEW_EMPTY;
  }
  // A timestamp in the future is clock skew, not a timestamp from tomorrow.
  const elapsed = Math.max(0, nowMs - atMs);
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

/**
 * The agent row's conversation count, `N+` when the aggregation pass was capped
 * (`R-10.8`, Q-37).
 *
 * `conv` rather than a bare number: the hint column is 11 columns
 * (`page-frame.tsx` `SCOPE_COLUMN`), which fits `999999 conv`, and a lone digit
 * in a dim column reads as an unrelated counter. The count is the aggregate
 * (`totalConversationCount`), not what the snapshot happens to have loaded.
 */
export function formatConversationCount(
  count: number,
  truncated: boolean,
): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  // `0+` would claim unseen conversations exist for an agent showing none; a
  // capped aggregation pass makes the total a lower bound only when there is
  // something to add to. (Lead integration fix, 2026-11-02.)
  return `${safe}${truncated && safe > 0 ? "+" : ""} conv`;
}

/**
 * One line of text, or `—`.
 *
 * A backend description or message snippet can be missing *or* empty, and can
 * contain newlines; a continuation line is one terminal line by contract, so
 * whitespace is folded before the width check.
 */
function oneLineOrEmpty(text: string | null | undefined): string {
  if (typeof text !== "string") return OVERVIEW_EMPTY;
  const squashed = text.replace(/\s+/g, " ").trim();
  return squashed === "" ? OVERVIEW_EMPTY : squashed;
}

/** A continuation line: indented under the item's label, clipped to `width`. */
function continuationLine(text: string, width: number): string {
  return truncateText(`${ROW_INDENT}${text}`, width);
}

export type AgentRowsInput = {
  /** The snapshot's first level, already ordered by the data layer. */
  agents: readonly OverviewAgentRecord[];
  /** The snapshot's `generatedAtMs`; relative times are anchored here. */
  nowMs: number;
  /** `PageBodyGeometry.width`: the columns a row may occupy. */
  width: number;
};

/**
 * The agent level: the fixed `New Agent` row, then one two-line item per agent.
 *
 * The fixed row is a normal selectable item (`kind: "item"`, not disabled): `↑↓`
 * move by item (`R-10.6`), so it has to be one, and its activation is
 * `overviewRowTarget(New Agent) = { kind: "new-agent" }`. With no agents it is
 * the whole body — the empty state itself is the page shell's (`R-10.9`).
 */
export function buildAgentRows(input: AgentRowsInput): readonly PageRow[] {
  const rows: PageRow[] = [
    { kind: "item", id: NEW_AGENT_ROW_ID, label: "New Agent" },
  ];
  if (input.agents.length === 0) return rows;
  // The fixed row has no continuation line of its own to carry the gap, so the
  // gap is a row of its own (a `text` row, the one kind the frame paints as a
  // blank line instead of collapsing it).
  rows.push({ kind: "text", text: "" });
  for (const agent of input.agents) {
    rows.push({
      kind: "item",
      id: agentRowId(agent.agentId),
      label: oneLineOrEmpty(agent.name),
      hint: formatConversationCount(
        agent.totalConversationCount,
        agent.conversationCountTruncated,
      ),
      value: formatRelativeTime(input.nowMs, agent.lastActivityAtMs),
      // `1 + 2` lines: the composed first line, the indented description, and
      // the blank line between this agent and the next (`rowHeight` = 3).
      lines: [
        continuationLine(oneLineOrEmpty(agent.description), input.width),
        "",
      ],
    });
  }
  return rows;
}

export type ConversationRowsInput = {
  /** One agent's conversations, already ordered by the data layer. */
  conversations: readonly OverviewConversationRecord[];
  /** The snapshot's `generatedAtMs`; relative times are anchored here. */
  nowMs: number;
  /** `PageBodyGeometry.width`: the columns a row may occupy. */
  width: number;
};

/**
 * The conversation level: the fixed `New Session` row, then one three-line item
 * per conversation.
 *
 * The first line's cells follow `R-10.3` in order: title (label), latest
 * activity as a relative time (hint), creation time as a relative time
 * (`created …`). Creation is relative for the same reason activity is — the row
 * is read as "how recent is this", and an absolute date would need a time zone
 * the snapshot does not carry. The two are distinguished by the `created`
 * prefix, so the dim hint never reads as the sort key.
 *
 * `New Session` is equivalent to `/new` (`R-10.3`, Q-36); the row only says
 * which action to take — the page shell performs it, same as any other row.
 */
export function buildConversationRows(
  input: ConversationRowsInput,
): readonly PageRow[] {
  const rows: PageRow[] = [
    { kind: "item", id: NEW_SESSION_ROW_ID, label: "New Session" },
  ];
  if (input.conversations.length === 0) return rows;
  rows.push({ kind: "text", text: "" });
  for (const conversation of input.conversations) {
    const created = formatRelativeTime(input.nowMs, conversation.createdAtMs);
    rows.push({
      kind: "item",
      id: conversationRowId(conversation.conversationId),
      label: oneLineOrEmpty(conversation.title),
      hint: formatRelativeTime(input.nowMs, conversation.lastActivityAtMs),
      value: created === OVERVIEW_EMPTY ? OVERVIEW_EMPTY : `created ${created}`,
      // `1 + 3` lines: the composed first line, the two message snippets
      // (indented two columns, `R-10.3`), and the blank line between items
      // (`rowHeight` = 4). A missing snippet keeps its line as `—`, so the row
      // height never depends on whether the lazy preview has loaded.
      lines: [
        continuationLine(
          oneLineOrEmpty(conversation.lastUserMessage),
          input.width,
        ),
        continuationLine(
          oneLineOrEmpty(conversation.lastAgentMessage),
          input.width,
        ),
        "",
      ],
    });
  }
  return rows;
}
