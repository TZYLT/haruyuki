/**
 * "This turn was started by the scheduler" (F-05 §2.5, Q-55).
 *
 * The listener host writes its own ledger row (`cron-host.ts`). The TUI cannot:
 * the turn runs from React state, not from the scheduler's async call, so by the
 * time `cli/app/usage-record.ts` decides what to append, the runner's stack is
 * long gone. The TUI runner therefore leaves a context here when it enqueues and
 * the turn writer *consumes* it once, which is what tags that turn's row
 * `source: "cron"` plus the run id instead of `interactive`.
 *
 * Deliberately a tiny mutable registry rather than an `AsyncLocalStorage`: the
 * value has to cross the `addToMessageQueue` → React-state → submit-handler
 * boundary, which no async context survives.
 *
 * F-05 M2 F5: entries are **sharded by conversation**, not one global slot. A
 * single slot let a second run (or a foreign turn on another conversation)
 * consume the wrong context, tagging a user turn `source: "cron"` with someone
 * else's run id and settling that run as a success. Each conversation has at
 * most one scheduled turn at a time (turns are serialised per conversation), so
 * a per-conversation slot is the natural grain; a context with no
 * `conversationId` lives in a shared slot and is only consumed when it is the
 * sole pending entry.
 *
 * Consuming is also the terminal signal: the TUI runner waits on
 * {@link awaitScheduledRunTurn}, so a scheduled run reports the turn's real
 * ending instead of "the prompt was queued" (R-5.9).
 *
 * Lives in `usage/` because the consumer (the ledger writer) is here and
 * `usage/` may not import `cli/` or `websocket/`.
 */

export interface ScheduledRunContext {
  /** Stable id of this scheduler run — joins the run log and the ledger. */
  runId: string;
  /** Task the run belongs to. */
  taskId: string;
  /** What produced the spend. Command runs are recorded by their own body. */
  source: "cron" | "command";
  agentId?: string;
  conversationId?: string;
}

/** How a scheduled turn ended, as the ledger writer reports it. */
export type ScheduledRunTurnOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

/**
 * What the turn writer consumed: the run's identity plus the turn's real
 * outcome, so the ledger row can carry `outcome` and not only `runId`
 * (F-05 M2 F12).
 */
export interface ConsumedScheduledRunContext extends ScheduledRunContext {
  outcome: ScheduledRunTurnOutcome;
}

type Waiter = (outcome: ScheduledRunTurnOutcome) => void;

/** Slot for contexts that do not name a conversation. */
const SHARED_SLOT = "";

/** conversationId (or the shared slot) → the scheduled context awaiting a turn. */
const pending = new Map<string, ScheduledRunContext>();
/** runId → the runners currently waiting for that turn's ending. */
const waiters = new Map<string, Set<Waiter>>();

function slotOf(context: ScheduledRunContext): string {
  const conversationId = context.conversationId?.trim();
  return conversationId ? conversationId : SHARED_SLOT;
}

function cloneContext(context: ScheduledRunContext): ScheduledRunContext {
  return { ...context };
}

/** The only pending context, or `null` when there are none or several. */
function singlePending(): ScheduledRunContext | null {
  if (pending.size !== 1) return null;
  const only = pending.values().next().value;
  return only ? cloneContext(only) : null;
}

/** Mark the next turn of this context's conversation as scheduler-initiated. */
export function setScheduledRunContext(context: ScheduledRunContext): void {
  pending.set(slotOf(context), cloneContext(context));
}

/**
 * Read without clearing (Statusline/debug reads; writers must consume).
 *
 * With a `conversationId`, reads that conversation's slot only. Without one,
 * answers only when exactly one context is pending: guessing among several is
 * exactly the mis-attribution this registry exists to prevent.
 */
export function peekScheduledRunContext(
  conversationId?: string | null,
): ScheduledRunContext | null {
  const scoped = conversationId?.trim();
  if (scoped) {
    const found = pending.get(scoped);
    return found ? cloneContext(found) : null;
  }
  return singlePending();
}

/**
 * Read and clear — call exactly once per turn, from the ledger writer.
 *
 * `conversationId` scopes the consumption: a turn on conversation X can only
 * consume the context left for X. Without it, only the sole pending context is
 * consumed; with several pending, `null` means "this turn is not provably a
 * scheduled turn", and the writer must record it as interactive.
 *
 * Resolves every waiter for the consumed run. `outcome` is the turn's real
 * ending when the caller knows it (the TUI turn writer does); it defaults to
 * `completed`, and is also what the caller receives back.
 */
export function consumeScheduledRunContext(input?: {
  outcome?: ScheduledRunTurnOutcome;
  conversationId?: string | null;
}): ConsumedScheduledRunContext | null {
  const outcome = input?.outcome ?? "completed";
  const scoped = input?.conversationId?.trim();
  let current: ScheduledRunContext | null = null;
  if (scoped) {
    current = pending.get(scoped) ?? null;
    if (current) pending.delete(scoped);
  } else if (pending.size === 1) {
    const [slot, value] = pending.entries().next().value ?? [];
    if (slot !== undefined && value) {
      current = value;
      pending.delete(slot);
    }
  }
  if (!current) return null;
  settleWaiters(current.runId, outcome);
  return { ...current, outcome };
}

/**
 * Drop a context that will never be consumed; its waiters see `cancelled`.
 *
 * With a `conversationId`, drops that conversation's slot. Without one, drops
 * the sole pending context (and never another conversation's).
 */
export function clearScheduledRunContext(conversationId?: string | null): void {
  const scoped = conversationId?.trim();
  let current: ScheduledRunContext | null = null;
  if (scoped) {
    current = pending.get(scoped) ?? null;
    if (current) pending.delete(scoped);
  } else if (pending.size === 1) {
    const [slot, value] = pending.entries().next().value ?? [];
    if (slot !== undefined && value) {
      current = value;
      pending.delete(slot);
    }
  }
  if (current) {
    settleWaiters(current.runId, "cancelled");
  }
}

/**
 * Wait for the scheduled turn to end.
 *
 * Resolves when the context is consumed (with the writer's outcome) or cleared
 * (cancelled), and on `signal` abort (cancelled). No timer lives here: the run's
 * deadline is the runner's `timeout_minutes`, so this promise may sit until one
 * of those three things happens.
 */
export function awaitScheduledRunTurn(input: {
  runId: string;
  signal: AbortSignal;
}): Promise<{ outcome: ScheduledRunTurnOutcome }> {
  if (input.signal.aborted) {
    return Promise.resolve({ outcome: "cancelled" });
  }

  return new Promise<{ outcome: ScheduledRunTurnOutcome }>((resolve) => {
    let settled = false;

    const settle = (outcome: ScheduledRunTurnOutcome): void => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      const forRun = waiters.get(input.runId);
      if (forRun) {
        forRun.delete(settle);
        if (forRun.size === 0) waiters.delete(input.runId);
      }
      resolve({ outcome });
    };

    const onAbort = (): void => settle("cancelled");

    input.signal.addEventListener("abort", onAbort, { once: true });
    const forRun = waiters.get(input.runId) ?? new Set<Waiter>();
    forRun.add(settle);
    waiters.set(input.runId, forRun);
  });
}

/** Resolve every waiter of one run exactly once. */
function settleWaiters(runId: string, outcome: ScheduledRunTurnOutcome): void {
  const forRun = waiters.get(runId);
  if (!forRun) return;
  // Copy first: each `settle` removes itself from the live set.
  for (const waiter of [...forRun]) {
    waiter(outcome);
  }
  waiters.delete(runId);
}

/**
 * Tests only: forget every pending context and every waiter.
 *
 * Pending waiters are resolved as `cancelled` rather than dropped, so a test
 * cannot leave an unhandled promise behind while proving the registry is empty.
 */
export function __testResetScheduledRunContext(): void {
  pending.clear();
  for (const runId of [...waiters.keys()]) {
    settleWaiters(runId, "cancelled");
  }
  waiters.clear();
}

/** Tests only: how many runners are waiting (leak check). */
export function __testScheduledRunWaiterCount(): number {
  let total = 0;
  for (const forRun of waiters.values()) total += forRun.size;
  return total;
}

/** Tests only: how many contexts are pending (sharding leak check). */
export function __testScheduledRunPendingCount(): number {
  return pending.size;
}
