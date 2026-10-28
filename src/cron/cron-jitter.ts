/**
 * Schedule jitter (F-05 keeps the v1 policy).
 *
 * Recurring tasks fire slightly late (bounded by a fraction of their period and
 * by one 60s tick); one-shot tasks at :00/:30 fire slightly early so a machine
 * that wakes on the minute does not miss the slot.
 */

import { estimatePeriodMs } from "./parse-interval";

function simpleHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}

/**
 * Compute jitter offset for a task.
 * - Recurring: late jitter, bounded by min(10% of period, 15 min)
 * - One-shot at :00/:30: early jitter up to 90s (negative offset)
 * - Other one-shots: no jitter (0)
 */
export function computeJitter(
  taskId: string,
  cron: string,
  recurring: boolean,
  scheduledFor: Date | null,
  createdAt: Date,
): number {
  if (recurring) {
    const periodMs = estimatePeriodMs(cron);
    if (periodMs <= 0) return 0;
    // Cap recurring jitter to < 60s (one tick interval). The scheduler
    // evaluates once per minute, so cross-minute jitter would be ignored.
    const maxJitter = Math.min(periodMs * 0.1, 59_999);
    return simpleHash(taskId) % Math.max(1, Math.floor(maxJitter));
  }

  // One-shot
  if (!scheduledFor) return 0;

  const min = scheduledFor.getMinutes();
  if (min === 0 || min === 30) {
    const offset = -(simpleHash(taskId) % 90_000);
    // Don't fire before creation time
    if (scheduledFor.getTime() + offset < createdAt.getTime()) return 0;
    return offset;
  }

  return 0;
}
