/**
 * Dream (F-06) run metadata carried on the hidden conversation record.
 *
 * A dream run gets its own record shape rather than reusing F-03's
 * `reflection` field (requirement Q-37 / Q-53, route §2.1): the two features
 * disagree about what a run means — reflection is a fork that may be deleted,
 * a dream run is a kept hidden conversation with a baseline, a budget and a
 * tier plan. Sharing one shape would force every reader to branch on a
 * discriminator that the record does not carry.
 *
 * Living on the conversation record — not a sidecar — is the same choice F-03
 * made and for the same reasons: it disappears with the conversation, the
 * hidden-session viewer can show it, and crash recovery can find a run that
 * never finished. The in-process controller stays the authority for "a run is
 * active"; this record is the durable copy.
 *
 * The shape is frozen at M0 (route §2.3). Tracks may read it; adding a field
 * goes back through the route first.
 */
import { isRecord } from "@/utils/type-guards";

/** The four tiers, in execution priority order (`整理 > 思考 > 任务 > 神游`). */
export type DreamTier = "tidy" | "think" | "task" | "wander";

export const DREAM_TIERS: readonly DreamTier[] = [
  "tidy",
  "think",
  "task",
  "wander",
];

/**
 * Persisted status. Superset of the in-process transitions on purpose:
 * `starting` / `locked` / `baselined` / `spawning` are transient states nobody
 * needs on disk, `running` covers them durably, and `unfinished` is the one
 * only crash recovery can write.
 */
export type DreamRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled"
  | "budget_exhausted"
  | "unfinished";

export const DREAM_RUN_STATUSES: readonly DreamRunStatus[] = [
  "running",
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "budget_exhausted",
  "unfinished",
];

/** What started the run: the idle signal, a user command, or a schedule. */
export type DreamTriggerSource = "idle" | "manual" | "scheduled";

const TRIGGER_SOURCES: readonly DreamTriggerSource[] = [
  "idle",
  "manual",
  "scheduled",
];

export interface DreamRunMetadata {
  /** Stable id minted before the conversation exists; matches the run state. */
  runId: string;
  triggerSource: DreamTriggerSource;
  agentId: string;
  /** The hidden conversation this run writes into (one run = one group). */
  conversationId: string;
  /** Tiers this run planned to reach, in priority order. */
  tierPlan: DreamTier[];
  /** Highest tier reached; `null` while running or when none completed. */
  tierReached: DreamTier | null;
  /** ms since epoch. */
  startedAt: number;
  /** ms since epoch; `null` while the run is still going. */
  endedAt: number | null;
  /** Memory-repo commit the run can be rolled back to (written before spawn). */
  baselineSha: string;
  /** Tokens this run may spend (`min(pressure * factor, maxPerRun)`). */
  budgetTokens: number;
  /** Tokens accounted so far; advanced by the parent from stream events. */
  spentTokens: number;
  /** Wall-clock cap in minutes; `null` means "no limit" (requirement §5.3.4). */
  timeLimitMinutes: number | null;
  status: DreamRunStatus;
  /** Report path inside the agent memory repo; `null` until finishing writes it. */
  reportPath: string | null;
  /** "Where to continue next time", written by an early stop or handoff. */
  handoff: string | null;
}

export function isDreamTier(value: unknown): value is DreamTier {
  return typeof value === "string" && DREAM_TIERS.includes(value as DreamTier);
}

export function isDreamRunStatus(value: unknown): value is DreamRunStatus {
  return (
    typeof value === "string" &&
    DREAM_RUN_STATUSES.includes(value as DreamRunStatus)
  );
}

export function isDreamTriggerSource(
  value: unknown,
): value is DreamTriggerSource {
  return (
    typeof value === "string" &&
    TRIGGER_SOURCES.includes(value as DreamTriggerSource)
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonNegativeTokenCount(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric !== undefined && numeric >= 0 ? numeric : undefined;
}

/**
 * Read the metadata off an arbitrary record (a `conversation.json` body, a
 * list row, a protocol payload).
 *
 * Anything malformed is dropped whole rather than half-read: a run record with
 * a missing id or status cannot be tied to a run, and guessing would make the
 * hidden-session header lie about what happened overnight.
 */
export function readDreamRunMetadata(
  record: unknown,
): DreamRunMetadata | undefined {
  if (!isRecord(record)) return undefined;

  const runId = nonEmptyString(record.runId);
  const agentId = nonEmptyString(record.agentId);
  const conversationId = nonEmptyString(record.conversationId);
  const baselineSha = nonEmptyString(record.baselineSha);
  const triggerSource = isDreamTriggerSource(record.triggerSource)
    ? record.triggerSource
    : undefined;
  const status = isDreamRunStatus(record.status) ? record.status : undefined;
  const startedAt = finiteNumber(record.startedAt);
  const budgetTokens = nonNegativeTokenCount(record.budgetTokens);
  const spentTokens = nonNegativeTokenCount(record.spentTokens);

  if (
    runId === undefined ||
    agentId === undefined ||
    conversationId === undefined ||
    baselineSha === undefined ||
    triggerSource === undefined ||
    status === undefined ||
    startedAt === undefined ||
    budgetTokens === undefined ||
    spentTokens === undefined
  ) {
    return undefined;
  }

  const rawPlan = record.tierPlan;
  if (!Array.isArray(rawPlan) || !rawPlan.every(isDreamTier)) return undefined;
  const tierPlan = [...rawPlan];

  let tierReached: DreamTier | null = null;
  if (record.tierReached !== null) {
    if (!isDreamTier(record.tierReached)) return undefined;
    // A reached tier the plan never contained is a corrupt record, not a
    // display detail: the run controller writes both fields together.
    if (!tierPlan.includes(record.tierReached)) return undefined;
    tierReached = record.tierReached;
  }

  const endedAt = record.endedAt === null ? null : finiteNumber(record.endedAt);
  if (endedAt === undefined) return undefined;

  const timeLimitMinutes =
    record.timeLimitMinutes === null
      ? null
      : finiteNumber(record.timeLimitMinutes);
  if (timeLimitMinutes === undefined) return undefined;
  if (timeLimitMinutes !== null && timeLimitMinutes <= 0) return undefined;

  const reportPath =
    record.reportPath === null ? null : nonEmptyString(record.reportPath);
  if (reportPath === undefined) return undefined;

  const handoff = record.handoff === null ? null : record.handoff;
  if (handoff !== null && typeof handoff !== "string") return undefined;

  return {
    runId,
    triggerSource,
    agentId,
    conversationId,
    tierPlan,
    tierReached,
    startedAt,
    endedAt,
    baselineSha,
    budgetTokens,
    spentTokens,
    timeLimitMinutes,
    status,
    reportPath,
    handoff,
  };
}
