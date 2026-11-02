/**
 * The TUI's view of a running dream (T-01, 47-2 §1.1/§4.2, R-01.5/R-01.7).
 *
 * A dream run lives in a short-lived child process, so the TUI cannot read it
 * from the in-process subagent snapshot. What crosses the process boundary is
 * the lease (`dream-lease.ts`): the run host writes `tier` / `spentTokens` /
 * `budgetTokens` as it moves between tiers, and this hook polls it for the
 * *current* agent only.
 *
 * Three rules shape the loop:
 *
 * - **Local elapsed time.** The lease carries `startedAt`; the displayed
 *   duration is `clock.now() - startedAt` and ticks locally. It is never read
 *   from a second cross-process call, and it never depends on the heartbeat.
 * - **Liveness is cached for 5 s.** `isDreamRunLive` reads the signal marker,
 *   the lease, the owner process and the settings — far more expensive than a
 *   JSON read. The cache is keyed by run id, so a new run (or a lease that has
 *   just disappeared) bypasses it and is noticed on the next 2 s poll.
 * - **Done lingers 30 s, then clears.** A finished run is shown as `done` for
 *   30 s (R-01.5). An agent switch clears the snapshot synchronously (the effect
 *   reset plus the render guard), and a different run id never inherits the
 *   previous run's done state — the panel must not animate the last agent's run.
 *
 * Everything external is injectable (`deps`): the repository has no fake-timer
 * precedent, so the tests drive the hook with a short real interval plus an
 * injected clock instead of pausing Bun's timers.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type DreamRunLease, readDreamLease } from "@/agent/dream/dream-lease";
import { isDreamRunLive } from "@/agent/dream/dream-liveness";
import type { DreamStatusSnapshot } from "@/cli/display/product-status/dream";

/** How often the lease/liveness pair is read while the TUI is active (R-01.7). */
export const DREAM_STATUS_POLL_INTERVAL_MS = 2_000;
/** How long an `isDreamRunLive` answer is reused for the same run. */
export const DREAM_STATUS_LIVENESS_CACHE_MS = 5_000;
/** How long a finished run stays on the status line (R-01.5). */
export const DREAM_STATUS_DONE_LINGER_MS = 30_000;
/** How often the displayed duration ticks between lease polls. */
export const DREAM_STATUS_ELAPSED_TICK_MS = 1_000;

/** Timer surface, injectable so a test can drive the loop without fake timers. */
export interface DreamRunStatusTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Everything the polling loop reads; production supplies the defaults. */
export interface DreamRunStatusDeps {
  now(): number;
  readLease(agentId: string): DreamRunLease | null;
  isLive(agentId: string, now: Date): boolean;
  timers: DreamRunStatusTimers;
}

/** Overrides for {@link DreamRunStatusDeps}; unset entries keep the defaults. */
export interface DreamRunStatusDepsOverrides {
  now?: () => number;
  readLease?: (agentId: string) => DreamRunLease | null;
  isLive?: (agentId: string, now: Date) => boolean;
  timers?: Partial<DreamRunStatusTimers>;
}

export interface UseDreamRunStatusOptions {
  /** The conversation's current agent; `null` means "no agent yet", so no polling. */
  agentId: string | null;
  /** False while the TUI is not painting (e.g. resizing) — no polling then. */
  active: boolean;
  /** Override the 2 s lease poll (tests only). */
  pollIntervalMs?: number;
  /** Override the 5 s liveness cache (tests only). */
  livenessCacheMs?: number;
  /** Override the 30 s done linger (tests only). */
  doneLingerMs?: number;
  /** Override the 1 s local elapsed tick (tests only). */
  elapsedTickMs?: number;
  deps?: DreamRunStatusDepsOverrides;
}

const DEFAULT_TIMERS: DreamRunStatusTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

const DEFAULT_DEPS: DreamRunStatusDeps = {
  now: () => Date.now(),
  readLease: (agentId) => readDreamLease(agentId),
  isLive: (agentId, now) => isDreamRunLive(agentId, now),
  timers: DEFAULT_TIMERS,
};

function resolveDeps(
  overrides: DreamRunStatusDepsOverrides | undefined,
): DreamRunStatusDeps {
  if (!overrides) return DEFAULT_DEPS;
  return {
    now: overrides.now ?? DEFAULT_DEPS.now,
    readLease: overrides.readLease ?? DEFAULT_DEPS.readLease,
    isLive: overrides.isLive ?? DEFAULT_DEPS.isLive,
    timers: { ...DEFAULT_TIMERS, ...overrides.timers },
  };
}

interface LivenessCacheEntry {
  agentId: string;
  /** The run id this answer was measured for (null = "no lease"). */
  runId: string | null;
  at: number;
  live: boolean;
}

/**
 * Poll the current agent's dream lease and return the segment the
 * product-status line should render, or `null` when there is nothing to show.
 */
export function useDreamRunStatus(
  options: UseDreamRunStatusOptions,
): DreamStatusSnapshot | null {
  const {
    agentId,
    active,
    pollIntervalMs = DREAM_STATUS_POLL_INTERVAL_MS,
    livenessCacheMs = DREAM_STATUS_LIVENESS_CACHE_MS,
    doneLingerMs = DREAM_STATUS_DONE_LINGER_MS,
    elapsedTickMs = DREAM_STATUS_ELAPSED_TICK_MS,
    deps: depsOverrides,
  } = options;

  const [snapshot, setSnapshot] = useState<DreamStatusSnapshot | null>(null);
  // The loop reads the latest published value synchronously; React state alone
  // is one render behind for the next timer tick.
  const snapshotRef = useRef<DreamStatusSnapshot | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const liveCacheRef = useRef<LivenessCacheEntry | null>(null);
  // Re-resolve every render so a test's inline overrides stay current; the
  // effects read it through the ref instead of taking it as a dependency.
  const runtimeRef = useRef<DreamRunStatusDeps>(resolveDeps(depsOverrides));
  runtimeRef.current = resolveDeps(depsOverrides);

  const publish = useCallback((next: DreamStatusSnapshot | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  // An agent switch (or pausing the TUI) invalidates every piece of loop state.
  // The render guard below covers the frame between the prop change and this
  // effect, so the previous agent's status is never painted against the new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentId/active are the intentional reset triggers; the body only clears refs.
  useEffect(() => {
    liveCacheRef.current = null;
    startedAtRef.current = null;
    publish(null);
  }, [agentId, active, publish]);

  // ── Lease + liveness poll ─────────────────────────────────────────────
  useEffect(() => {
    if (!active || agentId === null) return;
    const poll = (): void => {
      const runtime = runtimeRef.current;
      const now = runtime.now();
      let lease: DreamRunLease | null = null;
      try {
        lease = runtime.readLease(agentId);
      } catch {
        // A lease that cannot be read is "no data"; the next poll retries.
        lease = null;
      }
      const runId = lease?.runId ?? null;
      const cached = liveCacheRef.current;
      let live: boolean;
      if (
        cached !== null &&
        cached.agentId === agentId &&
        cached.runId === runId &&
        now - cached.at < livenessCacheMs
      ) {
        live = cached.live;
      } else {
        live = runtime.isLive(agentId, new Date(now));
        liveCacheRef.current = { agentId, runId, at: now, live };
      }

      if (live && lease !== null) {
        startedAtRef.current = lease.startedAt;
        publish({
          runId: lease.runId,
          agentId,
          phase: "running",
          tier: lease.tier ?? null,
          elapsedMs: Math.max(0, now - lease.startedAt),
          spentTokens: lease.spentTokens ?? null,
          budgetTokens: lease.budgetTokens ?? null,
        });
        return;
      }

      const previous = snapshotRef.current;
      if (
        previous !== null &&
        previous.phase === "running" &&
        previous.agentId === agentId
      ) {
        // A different run id already owns the lease: the previous run ended and
        // a new one started between polls. Clear instead of showing the old
        // run's done state over the new run (R-01.5: no serialized done).
        if (lease !== null && lease.runId !== previous.runId) {
          startedAtRef.current = null;
          publish(null);
          return;
        }
        // The run ended (or lost liveness). Freeze what it had and keep the
        // done state for the linger window.
        const startedAt = startedAtRef.current;
        startedAtRef.current = null;
        publish({
          ...previous,
          phase: "done",
          tier: lease?.tier ?? previous.tier,
          spentTokens: lease?.spentTokens ?? previous.spentTokens,
          budgetTokens: lease?.budgetTokens ?? previous.budgetTokens,
          elapsedMs:
            startedAt === null
              ? previous.elapsedMs
              : Math.max(previous.elapsedMs, now - startedAt),
          endedAtMs: now,
        });
        return;
      }

      if (
        previous !== null &&
        previous.phase === "done" &&
        lease !== null &&
        lease.runId !== previous.runId
      ) {
        // A new run has started but is not live yet (lease before marker): the
        // previous run's done must not linger over it.
        publish(null);
      }
    };

    poll();
    const handle = runtimeRef.current.timers.setInterval(poll, pollIntervalMs);
    return () => runtimeRef.current.timers.clearInterval(handle);
  }, [active, agentId, pollIntervalMs, livenessCacheMs, publish]);

  // ── Local elapsed tick + done linger expiry ───────────────────────────
  useEffect(() => {
    if (!active || agentId === null) return;
    const handle = runtimeRef.current.timers.setInterval(() => {
      const previous = snapshotRef.current;
      if (previous === null || previous.agentId !== agentId) return;
      const now = runtimeRef.current.now();
      if (previous.phase === "running") {
        const startedAt = startedAtRef.current;
        if (startedAt === null) return;
        const elapsedMs = Math.max(0, now - startedAt);
        if (elapsedMs !== previous.elapsedMs) {
          publish({ ...previous, elapsedMs });
        }
        return;
      }
      if (
        previous.endedAtMs !== undefined &&
        now - previous.endedAtMs >= doneLingerMs
      ) {
        publish(null);
      }
    }, elapsedTickMs);
    return () => runtimeRef.current.timers.clearInterval(handle);
  }, [active, agentId, elapsedTickMs, doneLingerMs, publish]);

  if (snapshot === null || agentId === null || snapshot.agentId !== agentId) {
    return null;
  }
  return snapshot;
}
