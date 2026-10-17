/**
 * The numbers that decide how much history a paged transcript fetches, keeps and draws.
 *
 * They used to live apart — the page size in `older-history.ts`, the render cap in
 * `ViewportTranscript.tsx`, the resume window in `src/agent/check-approval.ts` — which
 * hid the one relationship between them and made "how much history is in play" a
 * question you had to answer by grepping three modules.
 *
 * The *resume window* is the agent-side pair
 * (`BACKFILL_PRIMARY_MESSAGE_LIMIT` / `BACKFILL_MAX_RENDERABLE_MESSAGES` in
 * `src/agent/check-approval.ts`): how many messages a resumed conversation renders
 * before any paging happens. They stay there, with the code that applies them, because
 * `cli/` may import `agent/` but not the other way round — this module relates the two
 * by naming the relationship instead of by owning both: **a page has to be at least as
 * wide as the resume window** (`40 <= 50` today), or the first fetch can come back
 * holding nothing but messages the core already has, which reads as a refused page.
 */

/**
 * Messages one paged fetch asks the backend for.
 *
 * Also the "is this the last page" test: a page shorter than this means the transcript
 * started (`older-history.ts`).
 */
export const HISTORY_PAGE_LIMIT = 50;

/**
 * Entries the viewport will assemble in one frame, however tall the window is.
 *
 * A hard ceiling, not a target: a window taller than this draws the newest
 * `MAX_VIEWPORT_ITEMS` entries rather than growing the array without bound.
 */
export const MAX_VIEWPORT_ITEMS = 200;

/**
 * Evicted pages whose **messages** stay in memory, counted from the newest one.
 *
 * Dropping a page's items is cheap to undo — the page's own messages are held for exactly
 * that — so the messages were kept forever, and a session that paged back through a long
 * history kept every message it had ever paged *plus* the core window, whatever the
 * "bounded residency" notes said. Beyond this budget a page keeps its cursor (`key`), its
 * `itemCount`, its measured `rows` and its `itemIds`, and its messages are re-read from
 * the backend when a window comes back into it (one page-sized read on the local path).
 *
 * The pages nearest the core are the ones a reader is most likely to walk back into, so
 * they are the ones kept.
 */
export const RESIDENT_PAGE_BUDGET = 4;
