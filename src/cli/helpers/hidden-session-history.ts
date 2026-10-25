/**
 * Reading a hidden session's transcript for the read-only detail view (F-01,
 * 《45-1》§2.4).
 *
 * The detail view draws one seam and the rows after it: the **last inherited
 * message**, then everything the fork added. The seam is a *projected stored
 * message* id (`inherited_through_message_id`) — not a local message id. The
 * local ids a fork clones never appear in `listConversationMessages`, so a
 * cursor built from them would silently match nothing.
 *
 * Three read paths, one result shape:
 *
 * 1. **boundary** — the record carries `inherited_through_message_id`. Read that
 *    row with `retrieveMessage`, then page the new segment forward with `after`.
 *    If the row cannot be read the read falls back to path 2 rather than failing:
 *    a missing row is evidence that the record is stale, and the legacy path is
 *    the honest answer to a stale cursor.
 * 2. **legacy** — a fork written before the field existed, or one whose boundary
 *    row is gone. Cloned rows keep the parent's timestamps, so the seam is the
 *    newest row whose `date` is older than the conversation's own `created_at`
 *    (§5.3.3). Without that evidence the reader reports `boundaryKnown: false`
 *    and shows the loaded window: it never hides a row on a guess.
 * 3. **standalone** — `context_mode: "standalone"` (dreams, externally created
 *    sessions). Nothing was inherited, so no seam is inferred and no
 *    `retrieveMessage` call is made.
 *
 * Two traps this module exists to absorb:
 *
 * - **An unknown `after`/`before` cursor is silently ignored.** The local store
 *   slices only when it finds the id, so a stale or foreign boundary returns the
 *   *whole* conversation from the start. Every new-segment page is therefore
 *   checked for the boundary row; if it is there the page keeps only the rows
 *   after it (`cursorRecovered`), because "the backend returned the list from the
 *   beginning" is otherwise indistinguishable from "the fork added these rows".
 * - **A page is not the conversation.** The boundary path reads one page and
 *   pages forward on demand; the legacy/standalone paths walk back at most
 *   `HIDDEN_SESSION_LEGACY_MAX_PAGES` pages / `HIDDEN_SESSION_LEGACY_MAX_ROWS`
 *   rows, so opening the view can never pull a whole large transcript (§5.3.1,
 *   《45-1》§2.4). Reaching that cap is reported (`truncatedByBudget`) instead of
 *   being silently rounded down to "that is all there is".
 *
 * Read-only by construction: the injected backend is asked for
 * `retrieveMessage` and `listConversationMessages` only. No parent conversation
 * is read, no message is sent, no conversation state is touched (§5.3.7).
 */
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationContextMode } from "@/types/conversation-provenance";
import { isRecord } from "@/utils/type-guards";

/** Rows per read. The list uses 20; a detail page is roomier on purpose. */
export const HIDDEN_SESSION_HISTORY_PAGE_SIZE = 50;

/**
 * How far the legacy/standalone reads may walk back before they stop.
 *
 * A budget rather than a promise: the whole inherited prefix is never rendered,
 * so the cap only bounds the cost of *deciding* where the seam is and of showing
 * a conversation whose seam cannot be found.
 */
export const HIDDEN_SESSION_LEGACY_MAX_PAGES = 10;
export const HIDDEN_SESSION_LEGACY_MAX_ROWS = 500;

/**
 * One `listConversationMessages` query as this module issues it.
 *
 * Typed here rather than imported so the reader can be handed a fake in tests
 * without implementing the whole `Backend`. A real backend accepts this body: it
 * is a subset of `ConversationMessageListBody & { include_out_of_context: true }`.
 */
export interface HiddenSessionMessageQuery {
  agent_id: string;
  order: "asc" | "desc";
  limit: number;
  before?: string;
  after?: string;
  include_out_of_context: true;
}

/**
 * What a page may be: the local backend answers with an `ArrayPage`, a fake in a
 * test answers with an array. Both are read through `extractHiddenSessionMessages`.
 */
export type HiddenSessionMessagePage =
  | Message[]
  | { getPaginatedItems(): Message[] }
  | { items: Message[] };

/** The two read methods the detail view needs, and nothing else. */
export interface HiddenSessionHistoryBackend {
  retrieveMessage(messageId: string): Promise<unknown>;
  listConversationMessages(
    conversationId: string,
    body?: HiddenSessionMessageQuery,
  ): Promise<HiddenSessionMessagePage>;
}

export type HiddenSessionHistoryMode = "boundary" | "legacy" | "standalone";

export interface HiddenSessionHistoryRequest {
  backend: HiddenSessionHistoryBackend;
  conversationId: string;
  agentId: string;
  /** The conversation record's `created_at`; the legacy seam's only evidence. */
  conversationCreatedAt?: string | null;
  /** `inherited_through_message_id` — the precise seam cursor. */
  boundaryId?: string | null;
  /** `inherited_message_count` — display/fallback only, never the cursor. */
  boundaryCount?: number | null;
  contextMode?: ConversationContextMode | null;
  pageSize?: number;
}

export interface HiddenSessionHistory {
  /** Which read path produced this window. */
  mode: HiddenSessionHistoryMode;
  /** True when `lastInherited` really is the seam (paths 1 and legacy-found). */
  boundaryKnown: boolean;
  /** The seam row itself; `null` when the boundary is unknown or standalone. */
  lastInherited: Message | null;
  /**
   * The rows the view shows below the seam, oldest first.
   *
   * When `boundaryKnown` is false this holds the whole loaded window: an unknown
   * seam is shown in full rather than guessed at.
   */
  newMessages: Message[];
  /** `inherited_message_count` for the header; pass-through, never a slice. */
  inheritedCount: number | null;
  /** Nothing more to load in the direction the read walked. */
  exhausted: boolean;
  /** The `after` cursor came back unhonoured and the page was re-sliced here. */
  cursorRecovered: boolean;
  /** The legacy/standalone walk stopped at its page/row budget. */
  truncatedByBudget: boolean;
  /** Reads issued, for diagnostics and for the tests that pin the budget. */
  pagesRead: number;
}

/** The last-read row's id, used as the next `after`; `null` when done. */
export function nextHiddenSessionAfter(
  history: HiddenSessionHistory,
): string | null {
  if (history.exhausted) return null;
  const last = history.newMessages[history.newMessages.length - 1];
  return last ? last.id : null;
}

function normalizeRequestedPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return HIDDEN_SESSION_HISTORY_PAGE_SIZE;
  if (!Number.isFinite(pageSize) || pageSize < 1) {
    return HIDDEN_SESSION_HISTORY_PAGE_SIZE;
  }
  return Math.trunc(pageSize);
}

/**
 * Which read path a record gets.
 *
 * `standalone` wins over a stray boundary id: a caller that sets both is
 * describing a record that cannot have inherited anything, and showing the
 * whole transcript is the outcome that loses no messages.
 */
export function resolveHiddenSessionMode(input: {
  contextMode?: ConversationContextMode | null;
  boundaryId?: string | null;
}): HiddenSessionHistoryMode {
  if (input.contextMode === "standalone") return "standalone";
  if (hasBoundaryId(input.boundaryId)) return "boundary";
  return "legacy";
}

export function hasBoundaryId(
  boundaryId: string | null | undefined,
): boundaryId is string {
  return typeof boundaryId === "string" && boundaryId.trim().length > 0;
}

/** Read a page into rows; anything that is not a row with an id is dropped. */
export function extractHiddenSessionMessages(page: unknown): Message[] {
  return hiddenSessionPageItems(page).filter(
    (item): item is Message =>
      isRecord(item) && typeof item.id === "string" && item.id.length > 0,
  );
}

function hiddenSessionPageItems(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  if (!isRecord(page)) return [];
  const paginated = page.getPaginatedItems;
  if (typeof paginated === "function") {
    const items = (paginated as (this: unknown) => unknown).call(page);
    return Array.isArray(items) ? items : [];
  }
  return Array.isArray(page.items) ? page.items : [];
}

/** The `date` a stored message carries, or `null` when it has none. */
export function messageDateValue(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const date = message.date;
  return typeof date === "string" && date.length > 0 ? date : null;
}

/** Milliseconds for a timestamp, or `null` when it does not parse. */
export function parseHiddenSessionTimestamp(
  value: string | null | undefined,
): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Keep only the rows after `boundaryId`.
 *
 * `boundaryIndex: -1` means the row was not in the page, so the page was taken
 * at its word. That is the *only* evidence available for the ignored-cursor bug:
 * a page that does not contain the boundary looks exactly like a page that
 * follows it.
 */
export function sliceAfterBoundaryRow<T extends { id: string }>(
  rows: readonly T[],
  boundaryId: string | null | undefined,
): { rows: T[]; boundaryIndex: number } {
  if (!hasBoundaryId(boundaryId)) return { rows: [...rows], boundaryIndex: -1 };
  const boundaryIndex = rows.findIndex((row) => row.id === boundaryId);
  if (boundaryIndex < 0) return { rows: [...rows], boundaryIndex };
  return { rows: rows.slice(boundaryIndex + 1), boundaryIndex };
}

export type LegacyBoundaryInference =
  | { kind: "found"; index: number }
  | { kind: "all-inherited" }
  | { kind: "ambiguous"; reason: LegacyBoundaryInferenceIssue }
  | { kind: "continue" };

export type LegacyBoundaryInferenceIssue =
  | "missing-conversation-created-at"
  | "missing-message-date"
  | "same-millisecond-as-creation";

/**
 * Look for the seam in rows that arrive **newest first**, starting at `from`.
 *
 * `found.index` is the seam's position in that descending list: every row before
 * it is newer than the conversation (so the fork added it) and every row from it
 * on is older (so it was cloned). `continue` means every row scanned so far is
 * newer — the caller has to walk one page further back.
 *
 * A seam is only reported when there is a row on **both** sides of it. A page
 * whose every row predates the conversation is `all-inherited`, not a seam at
 * index 0: a conversation created *after* its own messages (clock skew, an
 * imported transcript) has exactly the same shape, and calling that a seam would
 * hide every row but one. §5.3.3 asks for the opposite — show everything rather
 * than guess.
 *
 * Equality with the creation timestamp is *ambiguous*, not "new", for the same
 * reason: a fork made in the same millisecond as its parent's last message
 * produces rows whose side cannot be told apart.
 */
export function inferLegacyBoundaryIndex(
  rows: readonly unknown[],
  conversationCreatedAt: string | null | undefined,
  from = 0,
): LegacyBoundaryInference {
  const createdMs = parseHiddenSessionTimestamp(conversationCreatedAt);
  if (createdMs === null) {
    return { kind: "ambiguous", reason: "missing-conversation-created-at" };
  }
  for (let index = Math.max(0, from); index < rows.length; index += 1) {
    const rowMs = parseHiddenSessionTimestamp(messageDateValue(rows[index]));
    if (rowMs === null) {
      return { kind: "ambiguous", reason: "missing-message-date" };
    }
    if (rowMs === createdMs) {
      return { kind: "ambiguous", reason: "same-millisecond-as-creation" };
    }
    if (rowMs < createdMs) {
      if (index === 0) return { kind: "all-inherited" };
      return { kind: "found", index };
    }
  }
  return { kind: "continue" };
}

/**
 * Read the view's first window.
 *
 * The boundary path issues exactly two reads (`retrieveMessage` + one page); the
 * legacy and standalone paths walk back until they know where they stand or hit
 * the budget.
 */
export async function readHiddenSessionHistory(
  request: HiddenSessionHistoryRequest,
): Promise<HiddenSessionHistory> {
  const pageSize = normalizeRequestedPageSize(request.pageSize);
  const mode = resolveHiddenSessionMode(request);

  if (mode === "boundary") {
    if (hasBoundaryId(request.boundaryId)) {
      const boundary = await retrieveInheritedBoundary(
        request.backend,
        request.conversationId,
        request.boundaryId,
      );
      if (boundary) {
        return readNewSegmentFromBoundary(request, pageSize, boundary);
      }
    }
    // A boundary the backend cannot resolve is a stale cursor: the legacy walk
    // is the only honest answer left, and it may still find the seam by date.
    return readWindowBackwards(request, pageSize, "legacy");
  }

  return readWindowBackwards(request, pageSize, mode);
}

/**
 * Page the new segment forward: one page per call, `after` being the last row
 * already loaded. Only meaningful for the boundary path — the other two already
 * hold the newest rows (`exhausted` is set once the walk reaches the end).
 */
export async function readMoreHiddenSessionNewMessages(
  request: HiddenSessionHistoryRequest,
  history: HiddenSessionHistory,
): Promise<HiddenSessionHistory> {
  if (history.mode !== "boundary") return history;
  if (history.exhausted) return history;
  const after = nextHiddenSessionAfter(history);
  if (!after) return { ...history, exhausted: true };

  const pageSize = normalizeRequestedPageSize(request.pageSize);
  const rows = extractHiddenSessionMessages(
    await request.backend.listConversationMessages(request.conversationId, {
      agent_id: request.agentId,
      order: "asc",
      limit: pageSize,
      after,
      include_out_of_context: true,
    }),
  );
  const sliced = sliceAfterBoundaryRow(
    rows,
    history.lastInherited?.id ?? request.boundaryId,
  );
  const knownIds = new Set(history.newMessages.map((message) => message.id));
  const fresh = sliced.rows.filter((message) => !knownIds.has(message.id));

  return {
    ...history,
    newMessages: [...history.newMessages, ...fresh],
    // A page that added nothing cannot advance the cursor, so reporting "done"
    // is what keeps the view from re-asking for the same page forever.
    exhausted: fresh.length === 0 || rows.length < pageSize,
    cursorRecovered: history.cursorRecovered || sliced.boundaryIndex >= 0,
    pagesRead: history.pagesRead + 1,
  };
}

async function retrieveInheritedBoundary(
  backend: HiddenSessionHistoryBackend,
  conversationId: string,
  boundaryId: string,
): Promise<Message | null> {
  try {
    const row = await backend.retrieveMessage(boundaryId);
    if (!isRecord(row) || typeof row.id !== "string" || row.id.length === 0) {
      return null;
    }
    // `messagesById` is process-wide, so a stale id can resolve to a row of a
    // different conversation. Paging this conversation from that row would make
    // the cursor unresolvable and silently return the list from the start, which
    // the page guard can only detect when the boundary row is in the page.
    const rowConversationId = row.conversation_id;
    if (
      typeof rowConversationId === "string" &&
      rowConversationId !== conversationId
    ) {
      return null;
    }
    // A log row is a partial wire shape (`Message` is a union of complete ones),
    // so the read result is narrowed to "has an id" and widened to `Message` here.
    return row as unknown as Message;
  } catch {
    return null;
  }
}

async function readNewSegmentFromBoundary(
  request: HiddenSessionHistoryRequest,
  pageSize: number,
  boundary: Message,
): Promise<HiddenSessionHistory> {
  const boundaryId = boundary.id;
  const rows = extractHiddenSessionMessages(
    await request.backend.listConversationMessages(request.conversationId, {
      agent_id: request.agentId,
      order: "asc",
      limit: pageSize,
      after: boundaryId,
      include_out_of_context: true,
    }),
  );
  const sliced = sliceAfterBoundaryRow(rows, boundaryId);
  return {
    mode: "boundary",
    boundaryKnown: true,
    lastInherited: boundary,
    newMessages: sliced.rows,
    inheritedCount: normalizedCount(request.boundaryCount),
    // A short page is the backend's own statement that nothing follows it; a
    // full page may or may not, so the view pages on demand.
    exhausted: rows.length < pageSize,
    cursorRecovered: sliced.boundaryIndex >= 0,
    truncatedByBudget: false,
    pagesRead: 1,
  };
}

/**
 * Walk the transcript backwards from the newest row.
 *
 * Two outcomes matter and both are decided by evidence:
 *
 * - a seam was found → show that row plus the rows above it (the fork's own);
 * - no seam (all-new, all-old, a missing timestamp, or the budget was spent) →
 *   show the whole loaded window and say the boundary is unknown. Ambiguity keeps
 *   paging instead of stopping, so "show everything" means everything the budget
 *   covers rather than an arbitrary prefix.
 */
async function readWindowBackwards(
  request: HiddenSessionHistoryRequest,
  pageSize: number,
  mode: "legacy" | "standalone",
): Promise<HiddenSessionHistory> {
  const rows: Message[] = []; // newest first
  let boundaryIndex: number | null = null;
  let inferenceOpen = mode === "legacy";
  let scannedRows = 0;
  let before: string | undefined;
  let exhausted = false;
  let truncatedByBudget = false;
  let pagesRead = 0;

  while (!exhausted) {
    const page = await request.backend.listConversationMessages(
      request.conversationId,
      {
        agent_id: request.agentId,
        order: "desc",
        limit: pageSize,
        ...(before ? { before } : {}),
        include_out_of_context: true,
      },
    );
    pagesRead += 1;
    const items = extractHiddenSessionMessages(page);
    if (items.length === 0) {
      exhausted = true;
      break;
    }
    rows.push(...items);

    if (inferenceOpen) {
      const verdict = inferLegacyBoundaryIndex(
        rows,
        request.conversationCreatedAt,
        scannedRows,
      );
      if (verdict.kind === "found") {
        boundaryIndex = verdict.index;
        inferenceOpen = false;
      } else if (verdict.kind === "all-inherited") {
        // Every loaded row predates the conversation, so there is no row on the
        // newer side to prove a seam. Keep loading and show the window.
        inferenceOpen = false;
      } else if (verdict.kind === "ambiguous") {
        // Keep loading: the view shows this window in full, so stopping here
        // would render a prefix as if it were the conversation.
        inferenceOpen = false;
      } else {
        scannedRows = rows.length;
      }
    }

    if (boundaryIndex !== null) break;
    if (items.length < pageSize) {
      exhausted = true;
      break;
    }
    if (
      pagesRead >= HIDDEN_SESSION_LEGACY_MAX_PAGES ||
      rows.length >= HIDDEN_SESSION_LEGACY_MAX_ROWS
    ) {
      truncatedByBudget = true;
      break;
    }
    const oldest = rows[rows.length - 1];
    if (!oldest) {
      exhausted = true;
      break;
    }
    before = oldest.id;
  }

  if (mode === "standalone") {
    return {
      mode: "standalone",
      boundaryKnown: false,
      lastInherited: null,
      newMessages: chronological(rows),
      // A standalone conversation inherited nothing, so a stale count from the
      // record would be a claim the view cannot back up.
      inheritedCount: null,
      exhausted,
      cursorRecovered: false,
      truncatedByBudget,
      pagesRead,
    };
  }

  if (boundaryIndex !== null) {
    const boundary = rows[boundaryIndex] ?? null;
    return {
      mode: "legacy",
      boundaryKnown: boundary !== null,
      lastInherited: boundary,
      newMessages: chronological(rows.slice(0, boundaryIndex)),
      inheritedCount: normalizedCount(request.boundaryCount),
      // The walk started at the newest row, so the fork's own segment is
      // complete even though older inherited rows were never read.
      exhausted: true,
      cursorRecovered: false,
      truncatedByBudget: false,
      pagesRead,
    };
  }

  return {
    mode: "legacy",
    boundaryKnown: false,
    lastInherited: null,
    newMessages: chronological(rows),
    inheritedCount: normalizedCount(request.boundaryCount),
    exhausted,
    cursorRecovered: false,
    truncatedByBudget,
    pagesRead,
  };
}

function chronological(rowsNewestFirst: readonly Message[]): Message[] {
  return [...rowsNewestFirst].reverse();
}

function normalizedCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}
