import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { getBackend } from "@/backend";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import { createBuffers } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import { showNotice } from "@/cli/helpers/notice";
import { debugWarn } from "@/utils/debug";
import type { HistoryBlock } from "./history-blocks";
import { countOnlyItems, evictBlocksBefore } from "./history-eviction";
import type { StaticItem } from "./types";
import {
  scrollTranscriptBy,
  shiftViewportAnchorByItems,
} from "./viewport-scroll";

/**
 * Older transcript history, paged in from the backend by stored message id.
 *
 * The resume path loads the last turn(s) and stops (`check-approval.ts`): the
 * append shell was never meant to print a whole conversation, so it caps the
 * window at 10 primary messages and 40 messages overall. A viewport makes that
 * cap visible as "the transcript ends just above the input", which is what this
 * module lifts: an up-move past the oldest loaded row asks for the next page.
 *
 * Five things this file is careful about, because each one is a silent failure:
 *
 * 1. **Identity is the stored message id.** The cursor is a `StoredMessage.id`
 *    (what `listConversationMessages` returns as `message.id`); a line's own id
 *    may be the otid instead, which is a different id space entirely. Paging by
 *    a line id would either return the newest window or split the transcript.
 * 2. **Dedup happens where the two lists meet** (`composeTranscriptItems`), not
 *    once at load time: the core list keeps committing rows while a page is in
 *    flight, and dedup has to see both sides as they are at render time.
 * 3. **A cursor the backend did not find comes back as the newest window.** The
 *    local store slices only when it finds the id, so a stale cursor silently
 *    returns the tail of the conversation — pages that would duplicate the whole
 *    view and walk the cursor forward. `loadedIds` is how that is caught.
 * 4. **A tool call and its return can straddle a page boundary.** The next cursor
 *    is therefore the *second* oldest message of the page, so the oldest one is
 *    fetched again with its partner; the duplicate that overlap creates is one of
 *    the two cases (2) drops.
 * 5. **Order is chronological, oldest first.** The assembler and the row model
 *    both read history that way, and the backend hands pages back newest first.
 *
 * Not here on purpose: a loading indicator (a local page is one in-memory read),
 * and any change to `BACKFILL_PRIMARY_MESSAGE_LIMIT` / `BACKFILL_MAX_RENDERABLE_MESSAGES`
 * — the cap those constants set is exactly what this module makes obsolete for
 * rendering, and the resume path still uses it for the initial window.
 */

/** Messages asked for per page. */
export const HISTORY_PAGE_LIMIT = 50;

export const HISTORY_START_NOTICE = "已到这次会话的开头";
export const HISTORY_CURSOR_NOTICE = "更早的历史加载失败：游标已失效";

/** How far "reach for older history" got. */
export type OlderHistoryOutcome =
  | "loaded"
  | "busy"
  | "start"
  | "cap"
  | "refused"
  | "unavailable"
  | "failed";

/**
 * Where to page from: the oldest stored message id that is still loaded, plus the
 * two id sets a page has to be judged against.
 */
export interface OlderHistoryCursor {
  before: string;
  /**
   * Ids of every loaded row. A page's copy of one of these is **not** prepended:
   * the core list already draws it, at its own position, assembled with neighbours
   * a slice of history cannot see.
   */
  coreIds: ReadonlySet<string>;
  /**
   * Ids of the loaded rows from the cursor on. Used for one thing: recognising a
   * page that reaches into the loaded range, which means the cursor was not
   * honoured. Both a row's own id and its canonical message id are in here — a
   * row's id is the otid when the message carries one, and a page's messages are
   * keyed by the stored id.
   *
   * It deliberately starts at the cursor rather than covering the whole core: the
   * rows *before* the cursor have no message id to page by, so the next page
   * fetches them again, and a page whose newest row is one of them is correct.
   */
  loadedIds: ReadonlySet<string>;
}

export interface OlderHistorySeed {
  conversationId: string;
  agentId: string;
  cursor: OlderHistoryCursor | null;
}

export interface OlderHistoryFetchRequest {
  conversationId: string;
  agentId: string;
  before: string;
  limit: number;
}

/** Resolves to the page **oldest first**. */
export type OlderHistoryFetcher = (
  request: OlderHistoryFetchRequest,
) => Promise<Message[]>;

function paginatedItems<T>(value: T[] | { getPaginatedItems(): T[] }): T[] {
  return Array.isArray(value) ? value : value.getPaginatedItems();
}

async function fetchPageFromBackend(
  request: OlderHistoryFetchRequest,
): Promise<Message[]> {
  const page = await getBackend().listConversationMessages(
    request.conversationId,
    {
      agent_id: request.agentId,
      limit: request.limit,
      order: "desc",
      before: request.before,
      // The conversation as the user saw it, compaction included. Without this
      // the page is the *projection*, which a compaction has already rewritten:
      // the walk stops at the summary row, and the messages the compaction sent
      // away stay unread even though the log still holds them (F1). A backend
      // that does not know the field answers exactly as it did before.
      include_out_of_context: true,
    },
  );
  // `order: "desc"` hands back the newest first; everything on this side reads
  // history oldest first.
  return [...paginatedItems(page)].reverse();
}

const EMPTY_ITEMS: readonly StaticItem[] = [];

/**
 * The block ledger (`history-blocks.ts`): one entry per page that was paged in,
 * oldest first, in step with `items`.
 *
 * It exists so a deep history can be *walked* without materialising every page — the
 * window fitter skips a whole page by its row count. `rows` stays `null` until the
 * viewport measures it, because only the measuring path knows a page's height, and a
 * page with no count cannot be skipped.
 */
interface OlderHistoryBlock {
  /** The page's identity: the cursor it was fetched before. */
  key: string;
  /**
   * The messages the page came back with. Kept so an evicted page can be
   * materialized again — `historyItemsForMessages` re-assembles it — without going
   * back to the backend for a page it already has.
   */
  page: readonly Message[];
  /**
   * Entries the page contributed, after composition dropped duplicates, or `null`
   * once the page is **evicted**: its rows are then only a count. `itemCount` is
   * kept separately for exactly that state — a page that is not materialized still
   * has to contribute its width to the walk and to every index above it.
   */
  items: readonly StaticItem[] | null;
  /** Entries the page contributed, whatever its materialization state. */
  itemCount: number;
  /** Rows the viewport measured for the whole page, or `null` until it has. */
  rows: number | null;
}

let blocks: readonly OlderHistoryBlock[] = [];

let provider: (() => OlderHistorySeed) | null = null;
let fetcher: OlderHistoryFetcher = fetchPageFromBackend;

let conversationId: string | null = null;
/**
 * The oldest row the *core* list started from when the rows below were paged.
 *
 * A page is only contiguous with the core it was fetched against. When that row
 * moves — another conversation, or a re-backfilled transcript whose window starts
 * somewhere else — the paged rows would leave a hole above the new core, so they
 * are dropped with it rather than kept on a guess.
 */
let seededBefore: string | null = null;
/** Oldest first, so they land in front of the core list as they arrive. */
let items: StaticItem[] = [];
/** The ids in `items`, so a row two pages both produced is prefixed once. */
let loadedRowIds = new Set<string>();
/** The stored message id the next page is fetched before. */
let cursor: string | null = null;
let loading = false;
/** Set once there is nothing more to ask for. */
let stopped: "start" | "cap" | "refused" | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function subscribeToOlderHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The rows paged in for `conversationId` — the snapshot a subscriber re-renders on.
 *
 * Read through the conversation id rather than reset on it: a switch is a render
 * away, and rows from the previous conversation must not be on screen even for that
 * one frame. The reset then happens on the next page request.
 *
 * The reference changes only when rows are actually paged in, so the publishes that
 * only move `loading` or `stopped` cost no render at all.
 */
export function getOlderHistoryItems(
  conversationIdForRead: string,
): readonly StaticItem[] {
  return conversationIdForRead === conversationId ? items : EMPTY_ITEMS;
}

/**
 * Installed by the viewport. Called at request time, not per render: the cursor
 * is derived from the live buffer, which is mutated in place, and walking it on
 * every streaming frame would cost more than the frame.
 */
export function setOlderHistoryProvider(
  next: (() => OlderHistorySeed) | null,
): void {
  provider = next;
}

export interface OlderHistoryState {
  conversationId: string | null;
  itemCount: number;
  cursor: string | null;
  loading: boolean;
  stopped: "start" | "cap" | "refused" | null;
}

export function getOlderHistoryState(): OlderHistoryState {
  return {
    conversationId,
    itemCount: items.length,
    cursor,
    loading,
    stopped,
  };
}

let blocksView: readonly HistoryBlock[] = [];
let blocksViewSource: readonly OlderHistoryBlock[] | null = null;

/**
 * The ledger in the shape the window fitter reads (`history-blocks.ts`): page
 * counts and measured heights, without the pages themselves.
 *
 * Memoised by the ledger's identity, because a caller reads this every frame and a
 * fresh array per call would defeat the memoisation that keeps those frames cheap.
 */
export function getOlderHistoryBlocks(): readonly HistoryBlock[] {
  if (blocksViewSource === blocks) return blocksView;
  blocksView = blocks.map((block) => ({
    key: block.key,
    itemCount: block.itemCount,
    rows: block.rows,
  }));
  blocksViewSource = blocks;
  return blocksView;
}

/**
 * Record the rows the viewport measured for a page.
 *
 * Counts are reported on every frame, so this publishes only when a height actually
 * moved (`withHistoryBlockRows` hands back the same list when it did not). A report
 * that rendered every frame would be exactly the redraw the scroll path spent
 * several rounds removing.
 */
export function reportOlderHistoryBlockRows(key: string, rows: number): void {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.key !== key || block.rows === rows) return block;
    changed = true;
    return { ...block, rows };
  });
  if (!changed) return;
  blocks = next;
  publish();
}

/**
 * Evict the items of every page older than `index`, keeping their counts.
 *
 * `index` is the first page to **keep**. The rendered array loses exactly the items
 * the eviction reports, and the parked anchor names an item *index*, so it moves
 * down by the same amount — dropping one without the other is what a parked view
 * moving on its own looks like (`history-eviction.ts`).
 *
 * Nothing is evicted while every page is resident, which is the state the frame
 * tests weigh: the call is a no-op until the viewport starts asking for a window.
 */
export function evictOlderHistoryBlocksBefore(index: number): void {
  const { blocks: next, droppedItems } = evictBlocksBefore(blocks, index);
  if (next === blocks) return;
  blocks = next;
  items = items.slice(droppedItems);
  publish();
  shiftViewportAnchorByItems(-droppedItems);
}

/**
 * Items the count-only prefix accounts for: how far a rendered item index sits below
 * its index in the walk. The walk counts every page; the rendered array only the
 * materialized ones.
 */
export function olderHistoryPrefixItems(): number {
  return countOnlyItems(blocks);
}

/**
 * Ask for the page above the oldest loaded row, and spend `rows` of the refused
 * move once it arrives.
 *
 * `rows` is what the refused up-move asked for (a wheel notch, a page), so the
 * notch that triggered the load still moves the text instead of being swallowed.
 */
export async function requestOlderHistory(
  rows: number,
): Promise<OlderHistoryOutcome> {
  const seed = provider?.() ?? null;
  if (!seed || !seed.cursor) return "unavailable";

  if (
    seed.conversationId !== conversationId ||
    seed.cursor.before !== seededBefore
  ) {
    // A different conversation, or the core list was rebuilt from a different
    // oldest row: what was paged belongs above a transcript that is gone.
    conversationId = seed.conversationId;
    seededBefore = seed.cursor.before;
    items = [];
    blocks = [];
    loadedRowIds = new Set<string>();
    cursor = seed.cursor.before;
    stopped = null;
    publish();
  }
  if (loading) return "busy";
  if (stopped) return stopped;

  loading = true;
  publish();
  try {
    return await loadPage(seed, rows);
  } finally {
    loading = false;
    publish();
  }
}

function finish(outcome: "start" | "refused"): OlderHistoryOutcome {
  stopped = outcome;
  showNotice(
    outcome === "start" ? HISTORY_START_NOTICE : HISTORY_CURSOR_NOTICE,
  );
  publish();
  return outcome;
}

async function loadPage(
  seed: OlderHistorySeed,
  rows: number,
): Promise<OlderHistoryOutcome> {
  const before = cursor;
  if (!before) return "unavailable";

  let page: Message[];
  try {
    page = await fetcher({
      conversationId: seed.conversationId,
      agentId: seed.agentId,
      before,
      limit: HISTORY_PAGE_LIMIT,
    });
  } catch (error) {
    debugWarn(
      "history",
      `paging before ${before} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }

  if (page.length === 0) return finish("start");

  // A conversation switch while the page was in flight: these rows belong to a
  // transcript that is no longer the one on screen. Read the live seed rather than
  // the captured one, because the switch is what changed it.
  const current = provider?.();
  if (!current || current.conversationId !== seed.conversationId) {
    return "unavailable";
  }

  // A page that reaches into the loaded rows is normally a cursor the backend did
  // not find: it answered with the newest window instead of a slice, and walking
  // that would duplicate the whole view. Only a page that is *entirely* already
  // loaded says that. The raw log legitimately hands back rows the core also holds
  // (the messages a compaction kept sit before the summary in the log), and
  // refusing those would stop the walk at the summary again — the very thing F1
  // removes.
  const newest = page[page.length - 1];
  const loaded = seed.cursor?.loadedIds;
  if (
    newest !== undefined &&
    loaded !== undefined &&
    loaded.has(newest.id) &&
    page.every((message) => loaded.has(message.id))
  ) {
    debugWarn(
      "history",
      `cursor ${before} was not honoured: the page is entirely within the loaded rows`,
    );
    return finish("refused");
  }

  const pageItems = historyItemsForMessages(page);

  // Advance to the *second* oldest message, so the oldest one comes back with the
  // next page: a tool call and its return can straddle the boundary, and only
  // re-fetching the oldest message puts the pair in one page.
  const boundary = page[Math.min(1, page.length - 1)];
  if (boundary) cursor = boundary.id;
  // The backend slices at the cursor, so a short page means the cursor was at the
  // conversation's first message.
  const reachedStart = page.length < HISTORY_PAGE_LIMIT;

  // What actually goes in front of the core list: a row the core already draws is
  // dropped here rather than at composition, because the *anchor* has to be
  // re-based by the number of rows that were really inserted — a page's copy of a
  // core row is not one of them.
  const fresh = pageItems.filter(
    (item) => !loadedRowIds.has(item.id) && !seed.cursor?.coreIds.has(item.id),
  );
  for (const item of fresh) loadedRowIds.add(item.id);

  if (fresh.length > 0) {
    // Items first, then the anchor, with no await between: both notifications
    // land in one render, so the frame that follows has the new rows *and* the
    // re-based position. Between them the view would be shifted by rows that are
    // not in the tree yet.
    items = [...fresh, ...items];
    // One ledger entry per page, at the same moment and in the same order as the
    // items. The count is `fresh.length` — the rows actually inserted, which is also
    // the number the anchor is re-based by just below.
    blocks = [
      { key: before, page, items: fresh, itemCount: fresh.length, rows: null },
      ...blocks,
    ];
    publish();
    shiftViewportAnchorByItems(fresh.length);
    if (rows > 0) scrollTranscriptBy(rows);
  }

  if (reachedStart) return finish("start");
  return "loaded";
}

/**
 * The transcript rows a page of messages draws, oldest first.
 *
 * Built with the same assembler the resume path uses, on a scratch buffer: the
 * live buffer must not be touched (it holds the current turn, and reassembling it
 * would reset the streaming aliases), and one assembler is what keeps a paged row
 * and a resumed row byte-identical for the same message.
 */
export function historyItemsForMessages(
  messages: readonly Message[],
): StaticItem[] {
  const buffers = createBuffers();
  backfillBuffers(buffers, [...messages]);
  const items: StaticItem[] = [];
  for (const id of buffers.order) {
    const line = buffers.byId.get(id);
    if (line) items.push(line);
  }
  return items;
}

/** The lines of a buffer, in transcript order. */
export function transcriptLines(buffers: Buffers): Line[] {
  const lines: Line[] = [];
  for (const id of buffers.order) {
    const line = buffers.byId.get(id);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * The paging cursor for a transcript: the oldest row whose canonical message id
 * is known.
 *
 * Rows before it — a tool call, an event, a status line — have no message id to
 * page by. Paging from a *later* row would return them again, which is fine (the
 * composition dedups them) as long as the range they occupy is not mistaken for
 * "the cursor was not honoured": that is why `loadedIds` starts here and not at
 * the newest row.
 *
 * `null` when no row carries a message id — a fresh conversation with nothing
 * resumed, where there is nothing older to reach for anyway.
 */
export function olderHistoryCursor(
  lines: readonly Line[],
): OlderHistoryCursor | null {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && "messageId" in line && line.messageId) {
      index = i;
      break;
    }
  }
  if (index < 0) return null;
  const cursorLine = lines[index];
  const before =
    cursorLine && "messageId" in cursorLine ? cursorLine.messageId : undefined;
  if (!before) return null;

  const coreIds = new Set<string>();
  const loadedIds = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    coreIds.add(line.id);
    if (i < index) continue;
    loadedIds.add(line.id);
    if ("messageId" in line && line.messageId) loadedIds.add(line.messageId);
  }
  return { before, coreIds, loadedIds };
}

/**
 * The rows both regions draw: older history in front of the core list, each row
 * once.
 *
 * A duplicate is kept from the **core** side, not from the older page: the core
 * was assembled with its own neighbours, so it holds the merged tool result that
 * a page assembled from a slice cannot see. The core's copy also already sits at
 * its own position in the transcript.
 */
export function composeTranscriptItems(
  older: readonly StaticItem[],
  core: readonly StaticItem[],
): StaticItem[] {
  if (older.length === 0) return [...core];
  const coreIds = new Set(core.map((item) => item.id));
  const seen = new Set<string>();
  const composed: StaticItem[] = [];
  for (const item of older) {
    if (coreIds.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    composed.push(item);
  }
  composed.push(...core);
  return composed;
}

/** Test seam. */
export function setOlderHistoryFetcherForTests(
  next: OlderHistoryFetcher | null,
): void {
  fetcher = next ?? fetchPageFromBackend;
}

/** Test seam. */
export function resetOlderHistoryForTests(): void {
  provider = null;
  fetcher = fetchPageFromBackend;
  conversationId = null;
  seededBefore = null;
  items = [];
  blocks = [];
  loadedRowIds = new Set<string>();
  cursor = null;
  loading = false;
  stopped = null;
  listeners.clear();
}
