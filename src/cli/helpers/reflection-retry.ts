/**
 * Exponential backoff for reflection launches that failed to start or finish
 * (F-03 §5.5.7).
 *
 * Scope is deliberately narrow: only startup and settlement failures delay the
 * next attempt. A timeout, a skip (lock busy, already running, memfs off) or a
 * manual request never does — those are the events the requirement excludes,
 * because backing off from them would starve a healthy reflection channel.
 *
 * State is per agent in this process, like the launch reservation: a restart
 * clears the delay and nothing about memory or the transcript is touched.
 */
const INITIAL_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 30 * 60_000;

const retries = new Map<string, { delayMs: number; retryAt: number }>();

function triggerAllowsBackoff(triggerSource: string): boolean {
  return triggerSource !== "manual";
}

/** True while an automatic trigger for this agent is still in its backoff window. */
export function isReflectionRetryDeferred(
  agentId: string,
  triggerSource: string,
  now = Date.now(),
): boolean {
  if (!triggerAllowsBackoff(triggerSource)) return false;
  return now < (retries.get(agentId)?.retryAt ?? 0);
}

/**
 * Record one failed launch/settlement: the next automatic attempt waits 60s,
 * doubling on each consecutive failure up to 30 minutes.
 */
export function recordReflectionFailure(
  agentId: string,
  now = Date.now(),
): number {
  const previous = retries.get(agentId);
  const delayMs = previous
    ? Math.min(previous.delayMs * 2, MAX_RETRY_DELAY_MS)
    : INITIAL_RETRY_DELAY_MS;
  retries.set(agentId, { delayMs, retryAt: now + delayMs });
  return delayMs;
}

/** A successful run clears the window: the next trigger may fire immediately. */
export function clearReflectionRetry(agentId: string): void {
  retries.delete(agentId);
}

/** Test-only: drop every window. */
export function resetReflectionRetries(): void {
  retries.clear();
}
