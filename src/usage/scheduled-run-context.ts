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
 * Deliberately a tiny mutable slot rather than an `AsyncLocalStorage`: the value
 * has to cross the `addToMessageQueue` → React-state → submit-handler boundary,
 * which no async context survives. Turns are serialised per conversation, so one
 * slot is enough — and `consume` clears the slot atomically.
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

type Waiter = (outcome: ScheduledRunTurnOutcome) => void;

let pending: ScheduledRunContext | null = null;
/** runId → the runners currently waiting for that turn's ending. */
const waiters = new Map<string, Set<Waiter>>();

/** Mark the next turn as scheduler-initiated. */
export function setScheduledRunContext(context: ScheduledRunContext): void {
  pending = { ...context };
}

/** Read without clearing (Statusline/debug reads; writers must consume). */
export function peekScheduledRunContext(): ScheduledRunContext | null {
  return pending ? { ...pending } : null;
}

/**
 * Read and clear — call exactly once per turn, from the ledger writer.
 *
 * Resolves every waiter for this run. `outcome` is the turn's real ending when
 * the caller knows it (T3's turn writer does); it defaults to `completed`, the
 * only answer a writer that does not report one can give.
 */
export function consumeScheduledRunContext(input?: {
  outcome?: ScheduledRunTurnOutcome;
}): ScheduledRunContext | null {
  const current = pending;
  pending = null;
  if (current) {
    settleWaiters(current.runId, input?.outcome ?? "completed");
  }
  return current ? { ...current } : null;
}

/** Drop a context that will never be consumed; its waiters see `cancelled`. */
export function clearScheduledRunContext(): void {
  const current = pending;
  pending = null;
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
 * Tests only: forget the pending context and every waiter.
 *
 * Pending waiters are resolved as `cancelled` rather than dropped, so a test
 * cannot leave an unhandled promise behind while proving the registry is empty.
 */
export function __testResetScheduledRunContext(): void {
  pending = null;
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
