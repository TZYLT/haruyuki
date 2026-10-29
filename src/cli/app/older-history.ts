import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import {
  type Backend,
  type ConversationHistoryPage,
  getBackend,
} from "@/backend";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import { createBuffers } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import { showNotice } from "@/cli/helpers/notice";
import { debugWarn } from "@/utils/debug";
import type { HistoryBlock, WalkIndex } from "./history-blocks";
import { countOnlyItems, evictBlocksBefore } from "./history-eviction";
import { HISTORY_PAGE_LIMIT, RESIDENT_PAGE_BUDGET } from "./history-window";
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
 * 2. **Dedup happens where the two lists meet** (`composed-transcript.ts`), not
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

export const HISTORY_START_NOTICE = "Beginning of this session";
export const HISTORY_CURSOR_NOTICE =
  "Could not load older history: the cursor is stale";

/** How far "reach for older history" got. */
export type OlderHistoryOutcome =
  | "loaded"
  | "busy"
  | "start"
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

/**
 * A backend's log-page read, as this module uses it.
 *
 * The method is optional on `Backend` (`backend.ts`), so the reader is a value that
 * can be absent — which is exactly the case the fetch below has to refuse.
 */
type OlderHistoryLogReader = NonNullable<
  Backend["listConversationHistoryPage"]
>;

/**
 * The reader a page is fetched through. `null` means "no override": the process
 * backend's, when it has one.
 *
 * The wrapper object exists so an override can be `null` — "this backend cannot read
 * the log" — without being indistinguishable from having no override at all.
 */
let logReaderOverride: { reader: OlderHistoryLogReader | null } | null = null;

/** Test seam. */
export function setOlderHistoryLogReaderForTests(
  reader: OlderHistoryLogReader | null,
): void {
  logReaderOverride = { reader };
}

function logReaderForPages(): OlderHistoryLogReader | null {
  if (logReaderOverride) return logReaderOverride.reader;
  const backend = getBackend();
  const read = backend.listConversationHistoryPage;
  return read ? read.bind(backend) : null;
}

/**
 * The rows of a page, once the backend has said which order they are in.
 *
 * The one place the paging read checks what it was handed. A log-ordered page walks
 * backwards to the conversation's first message and prepends correctly; a page the
 * backend *says* is ordered as the in-context list is one whose oldest row is a
 * compaction's summary, and prepending it would put that summary below the rows it
 * replaced — the very position the user never saw. So a page whose stated order is
 * not the log's is refused rather than used, and the caller leaves the walk where it
 * is (`loadPage` logs the refusal; it must not report the conversation's start).
 */
export function logOrderedMessages(page: ConversationHistoryPage): Message[] {
  if (page.order !== "log") {
    throw new Error(
      `older history: the backend answered a ${page.order}-ordered page`,
    );
  }
  return [...page.messages];
}

async function fetchPageFromBackend(
  request: OlderHistoryFetchRequest,
): Promise<Message[]> {
  const readLogPage = logReaderForPages();
  // A backend that cannot read the log cannot page, and it cannot be *asked* to say
  // so: the in-context list is the only thing it would return, and walking that is
  // how "the start of this session" became a lie past a compaction. No backend in this fork
  // is in that position (the local one owns the transcript), so refusing is the
  // honest answer for one that is, rather than a silent fallback that stops early.
  if (!readLogPage) {
    throw new Error(
      "older history: this backend cannot read the transcript log order",
    );
  }
  return logOrderedMessages(
    await readLogPage(request.conversationId, {
      agent_id: request.agentId,
      before: request.before,
      limit: request.limit,
    }),
  );
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
   * The ids of the entries this page actually contributed, after composition dropped
   * the ones the core (or an earlier page) already draws. Re-assembling `page` alone
   * would bring those duplicates back, so the id set is what a re-materialized page
   * is filtered by.
   */
  itemIds: readonly string[];
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
  /**
   * The layout the rows were measured under (see `setOlderHistoryRowsKey`).
   *
   * A page's height is a function of the column count, the terminal height, the
   * transcript's display state and the diffs it draws, and the walk *skips* a page it
   * has a height for. Without this a resize or a `Ctrl+T` would leave every loaded page
   * skipped by a height that describes the layout the user just left, for the rest of
   * the session.
   */
  rowsKey: string | null;
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
let stopped: "start" | "refused" | null = null;
/**
 * Pages whose released messages are being read back, by the cursor they were fetched
 * with. Keeps the residency effect from asking for the same page on every frame while the
 * read is in flight.
 */
const restoring = new Set<string>();
/**
 * How many evicted pages keep their messages (`RESIDENT_PAGE_BUDGET`).
 *
 * A variable so a frame test can exercise the release/re-read path with a handful of
 * pages: the viewport walks at most `MAX_VIEWPORT_ITEMS` items, so a test that has to
 * cross the *real* budget would need more items than one frame can anchor.
 */
let pageBudget = RESIDENT_PAGE_BUDGET;
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
  stopped: "start" | "refused" | null;
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
const EMPTY_BLOCKS: readonly HistoryBlock[] = [];

/**
 * The ledger in the shape the window fitter reads (`history-blocks.ts`): page
 * counts and measured heights, without the pages themselves.
 *
 * Read through the conversation id, like the rows themselves: after a switch the
 * rendered rows already belong to the new conversation while the reset waits for the
 * first page request, and a ledger left unscoped would be fitted against a transcript
 * that is no longer on screen (the walk's total would be the *old* pages' items, the
 * new core would occupy no indices, and the band would draw nothing).
 *
 * Memoised by the ledger's identity, because a caller reads this every frame and a
 * fresh array per call would defeat the memoisation that keeps those frames cheap.
 */
export function getOlderHistoryBlocks(
  conversationIdForRead: string,
): readonly HistoryBlock[] {
  if (conversationIdForRead !== conversationId) return EMPTY_BLOCKS;
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
 * Record the rows the viewport measured for a page, and the layout they belong to.
 *
 * Counts are reported on every frame, so this publishes only when something actually
 * moved (a height, or the layout key it was measured under). A report that rendered
 * every frame would be exactly the redraw the scroll path spent several rounds
 * removing.
 */
export function reportOlderHistoryBlockRows(
  key: string,
  rows: number,
  rowsKey: string | null = null,
): void {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.key !== key) return block;
    if (block.rows === rows && block.rowsKey === rowsKey) return block;
    changed = true;
    return { ...block, rows, rowsKey };
  });
  if (!changed) return;
  blocks = next;
  publish();
}

/**
 * Forget the heights that were measured under a different layout.
 *
 * The viewport calls this with a key describing everything a page's height depends on
 * (columns, terminal rows, the transcript display state, the diffs it can draw). A page
 * whose recorded height belongs to another layout is treated as unmeasured, so the walk
 * measures it again instead of skipping it with a number that describes the layout the
 * user has left. Nothing is evicted by this: an unmeasured page is one the eviction rule
 * refuses to drop.
 *
 * Returns whether anything changed, so a caller can tell a real invalidation from the
 * steady state (which is every frame).
 */
export function setOlderHistoryRowsKey(rowsKey: string): boolean {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.rows === null || block.rowsKey === rowsKey) return block;
    changed = true;
    return { ...block, rows: null, rowsKey: null };
  });
  if (!changed) return false;
  blocks = next;
  publish();
  return true;
}

/**
 * Evict the items of every page older than `index`, keeping their counts.
 *
 * `index` is the first page to **keep**. The rendered array loses exactly the items
 * the eviction reports.
 *
 * **The parked anchor does not move.** Its index is a position in the *walk's* item
 * space, which counts every page — evicted ones included, because a page that is
 * only a count still contributes `itemCount` to the walk and to every index above
 * it. Eviction changes which pages are *drawn*, not the numbering the walk uses, so
 * compensating the anchor here would move the view by exactly the rows that were
 * dropped (measured from the machine as "the transcript goes empty once a page is
 * dropped").
 *
 * Nothing is evicted while every page is resident, which is the state the frame
 * tests weigh: the call is a no-op until the viewport starts asking for a window.
 */
export function evictOlderHistoryBlocksBefore(index: number): void {
  const { blocks: next, droppedItems } = evictBlocksBefore(blocks, index);
  if (next === blocks) return;
  blocks = next;
  items = items.slice(droppedItems);
  releaseOldPageMessages();
  publish();
}

/**
 * Let go of the messages of the pages nobody is going to reach soon.
 *
 * Eviction keeps a page's messages so that walking back into it costs a re-assembly
 * instead of a fetch — which means a long session holds every message it ever paged.
 * Beyond `RESIDENT_PAGE_BUDGET` pages (newest first, since those are nearest the reader's
 * position) a page keeps what makes the walk work without it: `key`, `itemCount`, `rows`
 * and `itemIds`. `page` becomes `null`, and `requestOlderHistoryPages` reads it again when
 * a window lands there.
 *
 * The block itself is never dropped. A page is part of the walk's numbering — dropping it
 * would shift every position above it, which the reader sees as the transcript jumping.
 */
function releaseOldPageMessages(): void {
  const evicted: number[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block !== undefined && block.items === null && block.page !== null) {
      evicted.push(index);
    }
  }
  const releasable = Math.max(0, evicted.length - pageBudget);
  if (releasable === 0) return;
  const releasing = new Set(evicted.slice(0, releasable));
  blocks = blocks.map((block, index) =>
    releasing.has(index) ? { ...block, page: null } : block,
  ) as OlderHistoryBlock[];
}

/**
 * Read the messages of the pages in `[from, to]` whose messages were released.
 *
 * Returns whether the caller has to wait — either because a read is already in flight or
 * because this call started one. `false` means the range needs nothing, which is what the
 * viewport's residency effect keys its eviction decision on.
 */
export function requestOlderHistoryPages(from: number, to: number): boolean {
  const seed = provider?.() ?? null;
  if (!seed) return false;
  const first = Math.max(0, Math.trunc(from));
  const last = Math.min(blocks.length - 1, Math.trunc(to));
  let waiting = false;
  for (let index = first; index <= last; index += 1) {
    const block = blocks[index];
    if (block === undefined || block.page !== null) continue;
    if (restoring.has(block.key)) {
      waiting = true;
      continue;
    }
    restoring.add(block.key);
    void restorePageMessages(block.key, seed).finally(() => {
      restoring.delete(block.key);
    });
    waiting = true;
  }
  return waiting;
}

/**
 * Read one released page back in, keyed by the cursor it was fetched with.
 *
 * The conversation is re-read from the live provider rather than captured, because a
 * switch while the read was in flight means these messages belong to a transcript that is
 * no longer on screen — the same rule the paging path follows.
 */
async function restorePageMessages(
  key: string,
  seed: OlderHistorySeed,
): Promise<void> {
  let page: readonly Message[];
  try {
    page = await fetcher({
      conversationId: seed.conversationId,
      agentId: seed.agentId,
      before: key,
      limit: HISTORY_PAGE_LIMIT,
    });
  } catch (error) {
    debugWarn(
      "history",
      `re-reading the page before ${key} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const current = provider?.() ?? null;
  if (!current || current.conversationId !== seed.conversationId) return;
  const target = blocks.findIndex((block) => block.key === key);
  if (target < 0) return;
  blocks = blocks.map((block, index) =>
    index === target ? { ...block, page } : block,
  );
  publish();
}

/**
 * Put the items of the pages a window needs back into the rendered array.
 *
 * A page whose `rows` the viewport measured is one step for the walk, so a walk
 * *passing over* it needs only its count. A walk that lands **inside** one needs its
 * items: the window's row heights come from measuring them, and the band can only
 * draw what is in the rendered array. An evicted page therefore has to come back
 * before the window can enter it — the page's own messages are still held for
 * exactly this (`page` + `itemIds`), so it costs a re-assembly and no fetch.
 *
 * Evicted pages are always the *oldest* ones, so the materialized pages are always a
 * contiguous prefix in front of the rendered array: this prepends them in order.
 * Returns whether anything changed — the caller re-fits the window on the next
 * render, because the frame it just computed was measured without these rows.
 */
export function materializeOlderHistoryBlocks(
  from: number,
  to: number,
): boolean {
  const first = Math.max(0, Math.trunc(from));
  const last = Math.min(blocks.length - 1, Math.trunc(to));
  if (last < first) return false;

  const restored: StaticItem[] = [];
  const materialized = new Map<number, OlderHistoryBlock>();
  for (let index = first; index <= last; index += 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    // The pages after the first resident one are already in the rendered array.
    if (block.items !== null) break;
    // Released messages have to be read back before this page can be drawn; the
    // caller asks for that with `requestOlderHistoryPages` and re-fits afterwards.
    if (block.page === null) break;
    const contributed = new Set(block.itemIds);
    const page = historyItemsForMessages(block.page).filter((item) =>
      contributed.has(item.id),
    );
    restored.push(...page);
    materialized.set(
      index,
      // A page re-read after being released can hold a different set of entries
      // (the conversation may have been rewritten since). If it does, the items are
      // the truth and the recorded height is not: taking them keeps the band aligned,
      // and dropping `rows` makes the walk measure the page again.
      page.length === block.itemCount
        ? { ...block, items: page }
        : { ...block, items: page, itemCount: page.length, rows: null },
    );
  }
  if (materialized.size === 0) return false;

  blocks = blocks.map((block, index) => materialized.get(index) ?? block);
  items = [...restored, ...items];
  publish();
  return true;
}

/**
 * Items the count-only prefix accounts for: how far a rendered item index sits below
 * its index in the walk. The walk counts every page; the rendered array only the
 * materialized ones.
 *
 * Conversation-scoped for the same reason as the ledger: the prefix describes the
 * loaded pages, and after a switch those pages are not in the rendered array.
 */
export function olderHistoryPrefixItems(conversationIdForRead: string): number {
  if (conversationIdForRead !== conversationId) return 0;
  return countOnlyItems(blocks);
}

/** A range of the viewport's own array: older pages in front, then the core. */
export interface RenderedRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The slice of the viewport's array that covers walk indices `[start, end)`.
 *
 * The conversion the viewport may not do itself: it has one array (materialized pages in
 * front, then the core) and the walk numbers over a second, which counts the pages
 * eviction reduced to counts. Three defects grew in that seam, so the offset lives here,
 * next to the prefix it depends on — with the same scoping rule as the prefix.
 *
 * It is only the *offset* the store can answer: which array the result indexes into is the
 * viewport's business, because the core's items are the viewport's. Reading an item is
 * therefore `items[walkIndex - olderHistoryPrefixItems(conversationId)]` on that side.
 */
export function olderHistoryRenderedRange(
  start: WalkIndex,
  end: WalkIndex,
  conversationIdForRead: string,
): RenderedRange {
  const prefix =
    conversationIdForRead === conversationId ? countOnlyItems(blocks) : 0;
  return {
    from: Math.max(0, start - prefix),
    to: Math.max(0, end - prefix),
  };
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
      {
        key: before,
        page,
        itemIds: fresh.map((item) => item.id),
        items: fresh,
        itemCount: fresh.length,
        rows: null,
        rowsKey: null,
      },
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
  restoring.clear();
  pageBudget = RESIDENT_PAGE_BUDGET;
  logReaderOverride = null;
  listeners.clear();
}

/** Test seam: how many evicted pages keep their messages. */
export function setOlderHistoryPageBudgetForTests(budget: number): void {
  pageBudget = Math.max(0, Math.trunc(budget));
}
