/**
 * Is a dream run actually live right now? (F-06 M2 review follow-up)
 *
 * The signal state's `running` marker alone is not proof: a crashed run leaves
 * the marker behind, and the recovery path that would clear it is only reached
 * from a host that needs the marker to be clear first. Callers that must decide
 * "may I start / may I write" (T1's launcher re-check, the memory write guard)
 * need one answer that combines the marker, the lease and real process
 * liveness — and that also stops believing a marker nobody could have updated
 * for longer than any run is allowed to last.
 *
 * Liveness = marker present AND a lease for the agent exists AND the lease's
 * owner process is alive AND the marker is not older than
 * `max(1h, (timeLimitMinutes ?? 24h) + 30min)`.
 *
 * A missing lease means "not live": every running dream host writes one before
 * it does anything else, so a marker without a lease is a crash remnant.
 */

import {
  DREAM_MARKER_DEFAULT_LIMIT_MINUTES,
  DREAM_MARKER_LIMIT_GRACE_MINUTES,
  DREAM_MARKER_MIN_STALE_MS,
  dreamRunMarkerStaleAfterMs,
  readDreamSignalState,
} from "@/cron/dream-signal";
import { readDreamSettings } from "@/dream-settings";
import { isDreamLeaseOwnerAlive, readDreamLease } from "./dream-lease";

// The age bound lives in `cron/dream-signal` so the signal source (which cannot
// import this module: this one imports it) and this host-side liveness check
// cannot drift apart. These names are the public form of the same constants.
/** Floor on how long a marker may look live, even for a short-limit run. */
export const DREAM_LIVENESS_MIN_AGE_MS = DREAM_MARKER_MIN_STALE_MS;
/** Grace added to the configured time limit before a marker is called stale. */
export const DREAM_LIVENESS_LIMIT_GRACE_MS =
  DREAM_MARKER_LIMIT_GRACE_MINUTES * 60_000;
/** Assumed limit when the setting is `null` (no limit configured). */
export const DREAM_LIVENESS_DEFAULT_LIMIT_MINUTES =
  DREAM_MARKER_DEFAULT_LIMIT_MINUTES;

/**
 * How old a `running` marker may be before it is treated as a crash remnant
 * even if a process happens to hold that pid.
 */
export function dreamRunMaxAgeMs(timeLimitMinutes: number | null): number {
  return dreamRunMarkerStaleAfterMs({ timeLimitMinutes });
}

/** The current truth for callers that must not start a second run / write. */
export function isDreamRunLive(
  agentId: string,
  now: Date = new Date(),
): boolean {
  const marker = readDreamSignalState(agentId).running;
  if (!marker) return false;
  const lease = readDreamLease(agentId);
  if (!lease) return false;
  if (!isDreamLeaseOwnerAlive(lease)) return false;
  const startedAt = marker.startedAt > 0 ? marker.startedAt : lease.startedAt;
  const maxAgeMs = dreamRunMaxAgeMs(
    readDreamSettings(agentId).timeLimitMinutes,
  );
  return now.getTime() - startedAt <= maxAgeMs;
}
