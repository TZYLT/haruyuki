/**
 * Feature ②'s dedup window: which recalled items were already injected, and on
 * which user turn.
 *
 * `N` (`in_context_message_ids`, §5.6) removes everything still in the model's
 * context, so it already covers "do not recall what the model can see". It does
 * not cover this feature's own output: a hit that compaction removed from the
 * context stays absent from `N` forever, so without this window the same old
 * message would be re-injected on every turn. The window is what stops that, for
 * `K` user turns.
 *
 * The window is durable because a restart must not re-inject everything just
 * sent. A turn is a user message — the same count
 * `userTurnsSinceLastTopicMarker` uses — so no new counter is introduced.
 *
 * Ageing is `currentTurn - turn < keepTurns`: an item injected on the current
 * turn is inside the window, and one injected exactly `K` turns ago has aged out.
 */
export type RecallDedupWindow = Record<string, number>;

export type SettledRecallDedup = {
  /** Fingerprints to suppress on this turn, computed before this turn's injections. */
  suppressed: ReadonlySet<string>;
  /** The window that was persisted. */
  window: RecallDedupWindow;
};

/** The store operations the window needs. */
export interface RecallDedupPorts {
  read(conversationId: string, agentId: string): RecallDedupWindow;
  write(
    conversationId: string,
    agentId: string,
    window: RecallDedupWindow,
  ): void;
}

/** The store members this module reads. Narrowed so `LocalStore` keeps its budget. */
export interface RecallDedupStore {
  contextRewrites: {
    readRecallInjectedTurns(
      conversationId: string,
      agentId: string,
    ): RecallDedupWindow;
    setRecallInjectedTurns(
      conversationId: string,
      agentId: string,
      window: RecallDedupWindow,
    ): void;
  };
}

export function recallDedupPorts(store: RecallDedupStore): RecallDedupPorts {
  return {
    read: (conversationId, agentId) =>
      store.contextRewrites.readRecallInjectedTurns(conversationId, agentId),
    write: (conversationId, agentId, window) =>
      store.contextRewrites.setRecallInjectedTurns(
        conversationId,
        agentId,
        window,
      ),
  };
}

/**
 * Drops entries whose recording turn has aged out. `keepTurns = 0` disables the
 * window entirely rather than keeping everything.
 */
export function pruneRecallDedupWindow(
  window: RecallDedupWindow,
  currentTurn: number,
  keepTurns: number,
): RecallDedupWindow {
  const keep = Math.max(0, Math.trunc(keepTurns));
  const pruned: RecallDedupWindow = {};
  if (keep <= 0) return pruned;
  for (const [fingerprint, turn] of Object.entries(window)) {
    if (currentTurn - turn < keep) pruned[fingerprint] = turn;
  }
  return pruned;
}

/**
 * Read, prune, merge, persist — in that order, so `suppressed` never contains an
 * item this very turn just chose.
 *
 * One call rather than a read and a write: the caller needs "what to suppress"
 * before it searches and "what to persist" after it selects, and two round trips
 * through the conversation record could observe different states.
 *
 * `injected` omitted means "only prune" — used by `/recall status` and by a turn
 * that injected nothing.
 */
export function settleRecallDedup(
  ports: RecallDedupPorts,
  input: {
    conversationId: string;
    agentId: string;
    currentTurn: number;
    keepTurns: number;
    injected?: RecallDedupWindow;
  },
): SettledRecallDedup {
  const pruned = pruneRecallDedupWindow(
    ports.read(input.conversationId, input.agentId),
    input.currentTurn,
    input.keepTurns,
  );
  const window = { ...pruned, ...(input.injected ?? {}) };
  // `setRecallInjectedTurns` is already a no-op when the value is unchanged, so
  // this never writes a record that did not move.
  ports.write(input.conversationId, input.agentId, window);
  return { suppressed: new Set(Object.keys(pruned)), window };
}
