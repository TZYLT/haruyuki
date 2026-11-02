/**
 * The data contract for the `+` overview page (T-10), frozen by W-01.
 *
 * Two packages are written against this shape **in parallel** (47-2 §4.3):
 *
 * - **W-12** (data layer) produces an `OverviewSnapshot` from the backend —
 *   `listAgents` plus one large-limit `listConversations` (hidden excluded, each
 *   agent's `default` conversation included), and lazily fills in the message
 *   snippets;
 * - **W-13** (row building) turns it into `PageRow`s with `lines` — agent rows
 *   and conversation rows, relative times and the `N+` count.
 *
 * This module is **pure types**: no imports, no backend, no runtime values. The
 * page shell (W-15) and the navigation (W-17) consume `PageRow` from
 * `pages/page-model.ts`, not these records; the records stop at the row builder.
 *
 * Owner after W-01: read-only. Additive changes are fine only through the Lead
 * (47-2 §2.4); the fields below are what the two parallel packages compile
 * against.
 */

/**
 * One agent, as the first overview level shows it (R-10.2).
 *
 * `conversationCount` is what the snapshot actually carries, while
 * `totalConversationCount` is the aggregate from the single large-limit pass; when
 * that pass hits its cap the aggregate is a lower bound and the row builder
 * renders `N+`. The two can differ on the first screen — that is the point.
 */
export interface OverviewAgentRecord {
  agentId: string;
  /** Display name; never empty (callers substitute the id if the backend omits). */
  name: string;
  /** The agent's description, or `null` when it has none (`—` in the row). */
  description: string | null;
  /** Visible conversations loaded into this snapshot for the second level. */
  conversationCount: number;
  /** Visible conversation count, possibly a lower bound (see the flag). */
  totalConversationCount: number;
  /**
   * The aggregation pass hit its own limit, so `totalConversationCount` is a
   * lower bound and the count renders as `N+` (R-10.8).
   */
  conversationCountTruncated: boolean;
  /** Newest activity across the agent's visible conversations; `null` if none. */
  lastActivityAtMs: number | null;
}

/**
 * One conversation, as the second overview level shows it (R-10.3).
 *
 * `lastUserMessage` / `lastAgentMessage` are **snippets**, not full messages:
 * `null` means either "no such message" or "not loaded yet" — the preview load
 * is lazy and per conversation (R-10.8), and the row shows an empty second/third
 * line either way. Hidden conversations never appear here (Q-35).
 */
export interface OverviewConversationRecord {
  conversationId: string;
  /** The agent this conversation belongs to (also the second-level key). */
  agentId: string;
  /** The conversation title; the row's first cell. */
  title: string;
  /** Most recent message/activity instant; `null` when the backend has none. */
  lastActivityAtMs: number | null;
  /** Creation instant; `null` when the backend has none. */
  createdAtMs: number | null;
  /** Newest user-message snippet, or `null` (see the type note). */
  lastUserMessage: string | null;
  /** Newest agent-message snippet, or `null` (see the type note). */
  lastAgentMessage: string | null;
}

/**
 * Everything one overview screen renders.
 *
 * Both levels are already ordered by the data layer, because the page must not
 * re-sort on every frame: `agents` by descending `lastActivityAtMs`, each
 * conversation list by descending `lastActivityAtMs`. `generatedAtMs` anchors
 * relative-time rendering and the cache TTL, so the row builder never reads the
 * wall clock inside a render.
 *
 * An empty `snapshot` state is represented by the page, not here (a successful
 * read with no agents is `agents: []`; a failed read is not a snapshot at all).
 */
export interface OverviewSnapshot {
  /** First level: every agent, most recently active first. */
  agents: readonly OverviewAgentRecord[];
  /** Second level: conversation lists keyed by `agentId`. */
  conversations: Readonly<
    Record<string, readonly OverviewConversationRecord[]>
  >;
  /** When the snapshot was produced (relative times and cache TTL anchor). */
  generatedAtMs: number;
}
