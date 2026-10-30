/**
 * Dream task payload (F-06), stored JSON-encoded in the schedule file's
 * `payload` string for a `type: "dream"` task.
 *
 * The schedule record keeps `payload` as a plain string (M0 does not widen the
 * persisted record shape), so this module owns the encode/decode seam: the
 * scheduler hands the host the decoded payload, and the host never sees the
 * raw string. Keeping the codec here — rather than in `cron-file.ts` — lets the
 * T1 track add validation branches without teaching the store about dream
 * semantics.
 *
 * Frozen shape at M0 (route §2.3): `version: 1` plus an optional per-run budget
 * override from `/dream run --budget <n>`.
 */

export interface DreamTaskPayload {
  /** Bump only with a migration; the decoder rejects anything else. */
  version: 1;
  /**
   * `/dream run --budget <n>` override for this run only. It replaces the
   * resolved `min(pressure * factor, maxPerRun)` for one run and is never
   * persisted back into settings.
   */
  budgetOverrideTokens?: number;
}

export const DREAM_TASK_PAYLOAD_VERSION = 1;

export function serializeDreamTaskPayload(payload: DreamTaskPayload): string {
  return JSON.stringify({
    version: DREAM_TASK_PAYLOAD_VERSION,
    ...(payload.budgetOverrideTokens !== undefined
      ? { budgetOverrideTokens: payload.budgetOverrideTokens }
      : {}),
  } satisfies DreamTaskPayload);
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : undefined;
}

/**
 * Decode a stored payload. A missing payload is the ordinary case (the task was
 * created without an override), so it yields the default. Anything that claims
 * a different version or carries an unusable override is malformed: callers
 * must treat that as a task-level F1 rather than silently running with a
 * guessed budget, which is why this returns `undefined` instead of a default.
 */
export function parseDreamTaskPayload(
  raw: string | null | undefined,
): DreamTaskPayload | undefined {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return { version: DREAM_TASK_PAYLOAD_VERSION };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== DREAM_TASK_PAYLOAD_VERSION) return undefined;

  if (record.budgetOverrideTokens === undefined) {
    return { version: DREAM_TASK_PAYLOAD_VERSION };
  }
  const budgetOverrideTokens = positiveInteger(record.budgetOverrideTokens);
  if (budgetOverrideTokens === undefined) return undefined;
  return { version: DREAM_TASK_PAYLOAD_VERSION, budgetOverrideTokens };
}
