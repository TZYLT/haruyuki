/**
 * The listener's in-memory store of prepared compactions: `compaction_prepare`
 * → `compaction_commit` | `compaction_cancel`.
 *
 * User ruling 2026-10-31 (§0.2 ruling 4): the pending preview is process-local.
 * A restart or a reconnect that lands in another process drops it and `commit`
 * answers `prepare_expired`; the desktop prepares again. Nothing here is
 * persisted, so there is no resume/snapshot/"half-compacted" state to repair.
 *
 * Two properties make this more than a map:
 *
 * 1. **One pending preview per conversation.** A second `prepare` supersedes the
 *    first, and the old id stops working the moment the new preparation starts
 *    (not when it succeeds), so a client picker can never commit a preview the
 *    desktop has already replaced.
 *
 * 2. **Exactly one ledger row per summarizer call (§5.14).** The tokens are
 *    spent inside `prepare`, before any pick is known, so the row cannot be
 *    written there: its outcome (`completed`/`failed`/`cancelled`) is not
 *    decided until the preview is committed, cancelled, superseded, or expires.
 *    Every path that removes an entry settles it here, and removal happens
 *    *before* the awaited ledger write, so two paths cannot settle one entry.
 *
 * Expiry is enforced twice, for two different failure modes: a timer drops and
 * settles the entry at the TTL (so a client that walks away still leaves an
 * accounted-for spend), and every store access also treats an over-age entry as
 * expired (so a timer that never ran — a blocked event loop, a test clock —
 * cannot hand out a preview the TTL has already invalidated). The timer is
 * `unref`'d: a pending preview must not keep the process alive.
 */
import { randomUUID } from "node:crypto";
import type { LocalCompactionFacts } from "@/agent/compaction-execute";
import type {
  CompactionPreview,
  CompactPick,
} from "@/backend/local/compaction-preview";
import { recordCompactionUsage } from "@/usage/compaction-usage";

/** How long a prepared preview stays committable. */
export const COMPACTION_PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * What `commit`/`cancel` say for an id that is unknown, expired, superseded, or
 * already consumed, in every path. It has to tell a desktop what to do next:
 * there is no recovery except preparing the preview again.
 */
export const COMPACTION_PREPARE_EXPIRED_TEXT =
  "prepare_expired: this compaction preview is no longer pending (it expired, was cancelled, or was already committed). Run compaction_prepare again to get a fresh preview.";

/** The three outcomes a summarizer attempt can end in (§5.14). */
export type ListenerCompactionSpendOutcome =
  | "completed"
  | "cancelled"
  | "failed";

/**
 * One prepared-but-uncommitted compaction.
 *
 * `pick` is the `/compact <n>` identity resolved *before* the summarizer ran,
 * against the table the caller was looking at (§5.6.3). The protocol's
 * `compaction_commit` resolves its own `block_index` against `preview.blocks`
 * instead — the table it was handed by `prepare` — so it leaves this `null`.
 */
export interface CompactionPendingEntry {
  prepareId: string;
  conversationId: string;
  preview: CompactionPreview;
  /** `agent_id` from the prepare request; `null` when the request named none. */
  agentId: string | null;
  pick: CompactPick | null;
  createdAt: number;
}

export interface StoreCompactionPendingInput {
  conversationId: string;
  preview: CompactionPreview;
  agentId?: string | null;
  pick?: CompactPick | null;
}

/** A pending entry removed by its own timer. */
interface StoredCompactionPending extends CompactionPendingEntry {
  timeout: ReturnType<typeof setTimeout> | null;
}

export type TakeCompactionPendingResult =
  | { kind: "taken"; entry: CompactionPendingEntry }
  | { kind: "pending_expired" };

/** Conversations that currently hold a prepared preview, in this process. */
const pendingByConversation = new Map<string, StoredCompactionPending>();

/** Test override; the shipped TTL is {@link COMPACTION_PENDING_TTL_MS}. */
let pendingTtlMs = COMPACTION_PENDING_TTL_MS;

function isExpired(entry: CompactionPendingEntry, at: number): boolean {
  return at - entry.createdAt >= pendingTtlMs || pendingTtlMs <= 0;
}

function clearPendingTimer(entry: StoredCompactionPending): void {
  if (entry.timeout === null) return;
  clearTimeout(entry.timeout);
  entry.timeout = null;
}

function schedulePendingExpiry(
  conversationId: string,
  prepareId: string,
): ReturnType<typeof setTimeout> | null {
  if (pendingTtlMs <= 0) return null;
  const timeout = setTimeout(() => {
    void expirePendingEntry(conversationId, prepareId);
  }, pendingTtlMs);
  // A prepared preview is never a reason to keep the listener alive.
  timeout.unref();
  return timeout;
}

/**
 * Remove an entry the way its timer does, and settle its spend as cancelled.
 *
 * The map delete is synchronous and checked against the id, so a timer that
 * fires after the entry was committed/cancelled/superseded is a no-op.
 */
async function expirePendingEntry(
  conversationId: string,
  prepareId: string,
): Promise<void> {
  const entry = pendingByConversation.get(conversationId);
  if (!entry || entry.prepareId !== prepareId) return;
  pendingByConversation.delete(conversationId);
  clearPendingTimer(entry);
  await recordListenerCompactionSpend(entry, "cancelled");
}

/**
 * Drop the conversation's pending preview, settling its spend as cancelled.
 *
 * `prepare` calls this *before* it starts the summarizer, so a replaced preview
 * is unreachable immediately; the summary call that produced it already spent
 * its tokens, and that spend belongs in the ledger either way.
 *
 * @returns whether an entry was actually dropped.
 */
export async function discardCompactionPending(
  conversationId: string,
): Promise<boolean> {
  const entry = pendingByConversation.get(conversationId);
  if (!entry) return false;
  pendingByConversation.delete(conversationId);
  clearPendingTimer(entry);
  await recordListenerCompactionSpend(entry, "cancelled");
  return true;
}

/**
 * Store a freshly prepared preview and arm its TTL.
 *
 * @precondition the conversation holds no pending entry — `prepare` discards the
 * previous one before it spends on a new summarizer call. The defensive branch
 * below only exists so a caller that skips that step cannot silently drop the
 * old preview's spend; it is awaited so the replacement is installed only after
 * the superseded attempt is accounted for.
 */
export async function storeCompactionPending(
  input: StoreCompactionPendingInput,
): Promise<CompactionPendingEntry> {
  const previous = pendingByConversation.get(input.conversationId);
  if (previous) {
    pendingByConversation.delete(input.conversationId);
    clearPendingTimer(previous);
    await recordListenerCompactionSpend(previous, "cancelled");
  }
  const prepareId = randomUUID();
  const entry: StoredCompactionPending = {
    prepareId,
    conversationId: input.conversationId,
    preview: input.preview,
    agentId: input.agentId ?? null,
    pick: input.pick ?? null,
    createdAt: Date.now(),
    timeout: schedulePendingExpiry(input.conversationId, prepareId),
  };
  pendingByConversation.set(input.conversationId, entry);
  return entry;
}

/**
 * Read the pending preview without consuming it.
 *
 * `commit` uses this to resolve a `block_index` first: an index this preview
 * does not have is a request error, not a reason to throw the preview away (the
 * summarizer was already paid for; the client can retry with another index).
 * Only the consume-once {@link takeCompactionPending} settles anything.
 */
export function peekCompactionPending(
  conversationId: string,
  prepareId: string,
): CompactionPendingEntry | null {
  const entry = pendingByConversation.get(conversationId);
  if (!entry || entry.prepareId !== prepareId) return null;
  return entry;
}

/**
 * Consume the conversation's pending preview exactly once.
 *
 * Unknown id, already-consumed id, superseded id and an over-age entry all
 * answer `pending_expired`; the over-age one is additionally settled as
 * cancelled here, because nothing else will ever see it again.
 */
export async function takeCompactionPending(
  conversationId: string,
  prepareId: string,
): Promise<TakeCompactionPendingResult> {
  const entry = pendingByConversation.get(conversationId);
  if (!entry || entry.prepareId !== prepareId) {
    return { kind: "pending_expired" };
  }
  pendingByConversation.delete(conversationId);
  clearPendingTimer(entry);
  if (isExpired(entry, Date.now())) {
    await recordListenerCompactionSpend(entry, "cancelled");
    return { kind: "pending_expired" };
  }
  return { kind: "taken", entry };
}

/**
 * Drop a pending preview on the client's request.
 *
 * @returns `false` (after settling an expired entry, if it was one) when the id
 * was unknown or had already been consumed — the caller reports
 * `prepare_expired`.
 */
export async function cancelCompactionPending(
  conversationId: string,
  prepareId: string,
): Promise<boolean> {
  const taken = await takeCompactionPending(conversationId, prepareId);
  if (taken.kind !== "taken") return false;
  await recordListenerCompactionSpend(taken.entry, "cancelled");
  return true;
}

/** The executor's facts for a preview: ids and numbers only (§5.16.6). */
export function compactionFactsOfPending(
  entry: CompactionPendingEntry,
): LocalCompactionFacts {
  return {
    model: entry.preview.model,
    agentId: entry.agentId ?? entry.preview.agentId,
    usage: entry.preview.usage,
  };
}

/** Settle one pending entry's spend, exactly once. */
export async function recordListenerCompactionSpend(
  entry: CompactionPendingEntry,
  outcome: ListenerCompactionSpendOutcome,
): Promise<void> {
  await recordListenerCompactionAttempt({
    conversationId: entry.conversationId,
    facts: compactionFactsOfPending(entry),
    outcome,
  });
}

/**
 * Append the row for one listener compaction attempt.
 *
 * This is the listener's single mapping from attempt facts to a ledger row, so
 * the split pipeline, the legacy one-shot wrapper and the pending store cannot
 * disagree about an outcome. An agent nobody can name writes no row: looking it
 * up through `retrieveConversation` would *create* an unknown conversation on
 * the local backend, turning a zero-write failure into a write (§5.9.1).
 */
export async function recordListenerCompactionAttempt(input: {
  conversationId: string;
  facts: LocalCompactionFacts;
  outcome: ListenerCompactionSpendOutcome;
}): Promise<void> {
  const agentId = input.facts.agentId;
  if (agentId === null || agentId.length === 0) return;
  await recordCompactionUsage({
    agentId,
    conversationId: input.conversationId,
    model: input.facts.model,
    promptTokens: input.facts.usage?.promptTokens ?? 0,
    cachedInputTokens: input.facts.usage?.cachedInputTokens ?? 0,
    completionTokens: input.facts.usage?.completionTokens ?? 0,
    wallMs: input.facts.usage?.wallMs ?? 0,
    outcome: input.outcome,
  });
}

/** Tests only: forget every pending preview, cancel its timer, settle nothing. */
export function __testResetCompactionPending(): void {
  for (const entry of pendingByConversation.values()) {
    clearPendingTimer(entry);
  }
  pendingByConversation.clear();
  pendingTtlMs = COMPACTION_PENDING_TTL_MS;
}

/** Tests only: shorten (or disable, with `0`) the TTL without waiting 10 min. */
export function __testSetCompactionPendingTtl(ttlMs: number): void {
  pendingTtlMs = ttlMs;
}

/** Tests only: how many conversations currently hold a pending preview. */
export function __testCompactionPendingCount(): number {
  return pendingByConversation.size;
}
