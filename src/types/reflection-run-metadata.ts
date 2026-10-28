/**
 * Reflection run metadata carried on the **fork conversation record** (F-03
 * §5.3.4, route §1 #5): run id, trigger source, parent, timing and status.
 *
 * Living on the conversation record — not a sidecar — is the requirement's
 * choice: it disappears with the conversation, the hidden-session viewer can
 * show it, and crash recovery can find a run that never finished. The
 * **authority** for "a run is active" stays the in-process map in
 * `agent/reflection-run.ts`; this record is the durable copy.
 *
 * Written by the launcher (status `running`, once the fork exists) and by the
 * run controller (terminal status, plus backup coordinates on a timeout). The
 * shape is frozen here so both owners write the same fields.
 */
import { isRecord } from "@/utils/type-guards";

/**
 * Persisted status. Superset of the runtime status on purpose: `starting` and
 * `finishing` are in-process transitions nobody needs on disk, while
 * `unfinished` is the one only recovery can write (a run a crash abandoned).
 */
export type ReflectionRunRecordStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled"
  | "unfinished";

export type ReflectionRunTriggerSource =
  | "compaction"
  | "user-messages"
  | "manual"
  /** Fired by the scheduler's `reflect` command task (F-05 C-3). */
  | "scheduled";

export interface ReflectionRunMetadata {
  /** Stable id minted before the fork exists; matches the in-process run id. */
  runId: string;
  triggerSource: ReflectionRunTriggerSource;
  /** Conversation this fork was taken from. */
  parentConversationId: string;
  /** ms since epoch. */
  startedAt: number;
  /** ms since epoch; `null` when the run has no wall-clock limit. */
  deadlineAt: number | null;
  status: ReflectionRunRecordStatus;
  /** `refs/letta-backup/<name>` created before discarding uncommitted work. */
  backupRef?: string;
  /** Patch file holding the same discarded work. */
  backupPatch?: string;
}

const TRIGGER_SOURCES: readonly string[] = [
  "compaction",
  "user-messages",
  "manual",
  "scheduled",
];

const RECORD_STATUSES: readonly string[] = [
  "running",
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "unfinished",
];

export function isReflectionRunRecordStatus(
  value: unknown,
): value is ReflectionRunRecordStatus {
  return typeof value === "string" && RECORD_STATUSES.includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Read the metadata off an arbitrary record (a `conversation.json` body, a list
 * row, a protocol payload). Anything malformed is dropped whole rather than
 * half-read: a record with a missing run id cannot be tied to a run, and
 * guessing would make `/maintenance sessions` lie.
 */
export function readReflectionRunMetadata(
  record: unknown,
): ReflectionRunMetadata | undefined {
  if (!isRecord(record)) return undefined;
  const runId = nonEmptyString(record.runId);
  const parentConversationId = nonEmptyString(record.parentConversationId);
  const startedAt = finiteNumber(record.startedAt);
  const triggerSource =
    typeof record.triggerSource === "string" &&
    TRIGGER_SOURCES.includes(record.triggerSource)
      ? (record.triggerSource as ReflectionRunTriggerSource)
      : undefined;
  const status = isReflectionRunRecordStatus(record.status)
    ? record.status
    : undefined;
  if (!runId || !parentConversationId || startedAt === undefined) {
    return undefined;
  }
  if (!triggerSource || !status) return undefined;

  const deadlineAt =
    record.deadlineAt === null ? null : finiteNumber(record.deadlineAt);
  const backupRef = nonEmptyString(record.backupRef);
  const backupPatch = nonEmptyString(record.backupPatch);

  return {
    runId,
    triggerSource,
    parentConversationId,
    startedAt,
    deadlineAt: deadlineAt ?? null,
    status,
    ...(backupRef !== undefined ? { backupRef } : {}),
    ...(backupPatch !== undefined ? { backupPatch } : {}),
  };
}
