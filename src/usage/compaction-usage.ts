/**
 * F-04 compaction usage: the single mapping from a compaction run to a ledger
 * row.
 *
 * Three call sites write that row — the TUI's `/compact`, the listener's
 * `conversation_compact`, and headless `/compact` — so the mapping lives here
 * instead of being copied three times. Two properties matter:
 *
 * - `source: "compaction"` is whitelisted in both `ledger.ts` (as a
 *   `UsageSource`) and `usage/automated.ts`. A source missing from either list
 *   is dropped silently, which is why route M0 added all three entries at once.
 * - Numbers and ids only. The conversation id is written as `sessionId`; message
 *   text and paths never are (§5.16.6).
 *
 * A failed or cancelled run still records. The tokens were spent either way, and
 * a summarizer that burned 40k prompt tokens before the user pressed Esc is
 * exactly the case a usage view exists to explain.
 */
import {
  appendUsageRecord,
  buildUsageRecord,
  type UsageOutcome,
} from "./ledger";

/** The three outcomes a compaction run can end in. */
export type CompactionUsageOutcome = Extract<
  UsageOutcome,
  "completed" | "cancelled" | "failed"
>;

export interface CompactionUsageInput {
  agentId: string;
  /** Written as the ledger's `sessionId`. Ids only, never text. */
  conversationId: string;
  /** The model the summarizer actually ran with, carried by the preview. */
  model: string;
  promptTokens: number;
  cachedInputTokens: number;
  completionTokens: number;
  wallMs: number;
  outcome: CompactionUsageOutcome;
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/**
 * Append one `source:"compaction"` row.
 *
 * Resolves `false` — never throws — when the ledger cannot be written, matching
 * `appendUsageRecord`. Accounting must not be able to break a compaction, and
 * the caller has nothing to recover from anyway.
 */
export async function recordCompactionUsage(
  input: CompactionUsageInput,
  options: { path?: string; lockTimeoutMs?: number } = {},
): Promise<boolean> {
  const wallMs = nonNegative(input.wallMs);
  const record = buildUsageRecord({
    agentId: input.agentId,
    model: input.model,
    prompt: nonNegative(input.promptTokens),
    cachedInput: nonNegative(input.cachedInputTokens),
    cacheWrite: 0,
    completion: nonNegative(input.completionTokens),
    // One summarizer call is one step: there is no agent loop around it.
    steps: 1,
    wallMs,
    // The wall time is the API time here; no local tool work happens between.
    apiMs: wallMs,
    source: "compaction",
    outcome: input.outcome,
    sessionId: input.conversationId,
  });
  return appendUsageRecord(record, options);
}
