/**
 * Ledger writer for automated (non-interactive) model spend — reflection now,
 * scheduled runs and dreaming later (F-03 §5.16).
 *
 * The interactive path keeps its own writer; this module exists so a child
 * process that spent tokens on someone else's behalf can record one row tagged
 * with its source, outcome and the two session ids (the requirement's privacy
 * contract change: ids yes, message text never).
 *
 * Three rules shape everything here:
 *
 * - **The child writes its own row.** The parent process does not record
 *   reflection spend on the child's behalf (§5.16.2); the child already holds
 *   the numbers and the turn it ended. The one exception is a run the parent
 *   had to kill at its deadline: nothing else can report that run, so the parent
 *   writes a zero-token marker row ({@link recordTimedOutReflectionRun}) rather
 *   than losing the event from the ledger (requirement §5.16.4).
 * - **Only a tagged child writes.** The harness sets `HARUYUKI_USAGE_SOURCE` /
 *   `HARUYUKI_USAGE_RUN_ID` when it launches an automated run, so an ordinary
 *   subagent (or a nested launch inside a reflection) records nothing and
 *   cannot be mistaken for one.
 * - **A dropped row never fails the run.** The append shares the ledger lock
 *   and gives up after the bounded wait; the drop is logged, not thrown.
 */

import {
  appendUsageRecord,
  buildUsageRecord,
  type UsageOutcome,
  type UsageSource,
} from "@/usage/ledger";
import { debugLog } from "@/utils/debug";
import {
  PARENT_CONVERSATION_ENV,
  USAGE_RUN_ID_ENV,
  USAGE_SOURCE_ENV,
} from "@/utils/subagent-launch-marker";
import type { UsageCost } from "@/utils/usage-cost";

/** Where the spend came from. `interactive` is deliberately absent. */
export type AutomatedUsageSource = Exclude<UsageSource, "interactive">;

export type AutomatedUsageOutcome = UsageOutcome;

/** The sources a child-launched run may claim. */
const AUTOMATED_USAGE_SOURCES: readonly AutomatedUsageSource[] = [
  "reflection",
  "dream",
  "cron",
  "subagent",
  "compaction",
  "other",
];

/** Token counters exactly as the child's own turn reports them. */
export interface AutomatedUsageTokens {
  prompt: number;
  cachedInput: number;
  cacheWrite: number;
  completion: number;
  reasoning: number;
  steps: number;
}

export interface AutomatedUsageInput {
  source: AutomatedUsageSource;
  /** The requirement records failures too: money spent is money spent. */
  outcome: AutomatedUsageOutcome;
  /** Stable id of one automated run (reflection uses the fork run id). */
  runId?: string;
  /** Conversation the spend happened in. */
  sessionId: string;
  /** Source conversation when this run was a fork of another one. */
  parentSessionId?: string;
  agentId: string;
  /** `"unknown"` when the model cannot be resolved; never omitted silently. */
  model: string;
  usage: AutomatedUsageTokens;
  wallMs: number;
  apiMs: number;
  cost?: UsageCost;
  contextTokens?: number;
}

/** Whether `value` is a source a child-launched run may write. */
export function isAutomatedUsageSource(
  value: string | undefined,
): value is AutomatedUsageSource {
  return (
    value !== undefined &&
    (AUTOMATED_USAGE_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * The ledger's outcome for a stream-json result subtype.
 *
 * `success` is a completed run, `interrupted` is a cancellation, and anything
 * else (`error`, or a subtype this build does not know) is a failure — an
 * unrecognised ending must not look like money well spent.
 */
export function automatedUsageOutcomeOf(
  subtype: string,
): AutomatedUsageOutcome {
  if (subtype === "success") return "completed";
  if (subtype === "interrupted") return "cancelled";
  return "failed";
}

/** What a tagged child tells itself about the run it belongs to. */
export interface AutomatedUsageTag {
  source: AutomatedUsageSource;
  runId?: string;
  /** The conversation the run was launched from (the reflection's parent). */
  parentSessionId?: string;
}

/**
 * Read the automated-run tag the parent injected into this child's env.
 *
 * `undefined` means "not an automated child": no row is written here, and the
 * interactive writer (TUI or the parent's own path) owns this spend.
 */
export function readAutomatedUsageTag(
  env: NodeJS.ProcessEnv = process.env,
): AutomatedUsageTag | undefined {
  const source = env[USAGE_SOURCE_ENV]?.trim();
  if (!isAutomatedUsageSource(source)) return undefined;
  const runId = env[USAGE_RUN_ID_ENV]?.trim();
  const parentSessionId = env[PARENT_CONVERSATION_ENV]?.trim();
  return {
    source,
    ...(runId ? { runId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

/**
 * Append one automated usage row. Returns `true` when a row was written and
 * `false` when the record was dropped (lock timeout or an unusable input);
 * a drop never fails the run that produced it.
 */
export async function recordAutomatedUsage(
  input: AutomatedUsageInput,
): Promise<boolean> {
  const record = buildUsageRecord({
    // A missing identity is recorded as such instead of dropping the row: the
    // tokens are real even when the handle is not.
    agentId: input.agentId.trim() || "unknown",
    model: input.model.trim() || "unknown",
    prompt: input.usage.prompt,
    cachedInput: input.usage.cachedInput,
    cacheWrite: input.usage.cacheWrite,
    completion: input.usage.completion,
    reasoning: input.usage.reasoning,
    steps: input.usage.steps,
    wallMs: input.wallMs,
    apiMs: input.apiMs,
    source: input.source,
    outcome: input.outcome,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    sessionId: input.sessionId,
    ...(input.parentSessionId !== undefined
      ? { parentSessionId: input.parentSessionId }
      : {}),
    ...(input.cost !== undefined ? { cost: input.cost } : {}),
    ...(input.contextTokens !== undefined
      ? { contextTokens: input.contextTokens }
      : {}),
  });
  const written = await appendUsageRecord(record);
  if (!written) {
    // A dropped row is an allowed outcome (a ledger write must never break a
    // turn), but silence is what hid spending before: say which run was lost.
    debugLog(
      "usage",
      `dropped automated usage row: source=${input.source} outcome=${input.outcome} run=${input.runId ?? "-"} session=${input.sessionId}`,
    );
  }
  return written;
}

/**
 * What the parent knows about a run it had to kill at its deadline — and the
 * marker row it writes instead of the ending the child never got to report.
 *
 * A timed-out run is the one case the child cannot report: the parent kills it
 * between turns, so no child turn ever ends and no row is written, while the
 * requirement still wants the run to appear in the ledger (§5.16.4). The parent
 * therefore records a **zero-token** row tagged `outcome: "timeout"`: it says
 * the run happened and how long it was held, not how much it spent (the parent
 * never sees the child's counters). A child that managed to finish an earlier
 * turn already wrote that turn's real row; this marker never duplicates its
 * numbers, it only adds the ending.
 */
export interface TimedOutReflectionRunInput {
  runId: string;
  agentId: string;
  /** The fork conversation the run used. */
  sessionId: string;
  /** The conversation the fork came from. */
  parentSessionId?: string;
  /** The child's model as the spawn pipeline reported it. */
  model: string;
  /** How long the run was alive before the kill. */
  wallMs: number;
}

const ZERO_TOKENS: AutomatedUsageTokens = {
  prompt: 0,
  cachedInput: 0,
  cacheWrite: 0,
  completion: 0,
  reasoning: 0,
  steps: 0,
};

/** Record the zero-token marker row for a timed-out reflection run. */
export async function recordTimedOutReflectionRun(
  input: TimedOutReflectionRunInput,
): Promise<boolean> {
  return recordAutomatedUsage({
    source: "reflection",
    outcome: "timeout",
    runId: input.runId,
    sessionId: input.sessionId,
    ...(input.parentSessionId !== undefined
      ? { parentSessionId: input.parentSessionId }
      : {}),
    agentId: input.agentId,
    model: input.model,
    usage: ZERO_TOKENS,
    wallMs: Math.max(0, Math.round(input.wallMs)),
    apiMs: 0,
  });
}

/** One child turn, as the child's own headless entrypoint sees it. */
export interface AutomatedTurnUsageInput {
  /** Defaults to `process.env`; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  agentId: string;
  model: string;
  /** The conversation the turn ran in (the reflection fork). */
  sessionId: string;
  outcome: AutomatedUsageOutcome;
  usage: AutomatedUsageTokens;
  wallMs: number;
  apiMs: number;
  contextTokens?: number;
}

/**
 * Record one finished child turn, if this child is an automated run.
 *
 * Headless calls this at the end of every turn; the tag check inside is what
 * keeps an ordinary headless session (and a second caller writing the same
 * turn) from producing a duplicate row. Returns `false` both when nothing was
 * written and when the row was dropped — the caller has no action either way,
 * because a ledger write must not change what the turn reports.
 */
export async function recordAutomatedTurnUsage(
  input: AutomatedTurnUsageInput,
): Promise<boolean> {
  const tag = readAutomatedUsageTag(input.env);
  if (!tag) return false;
  return recordAutomatedUsage({
    source: tag.source,
    outcome: input.outcome,
    ...(tag.runId !== undefined ? { runId: tag.runId } : {}),
    sessionId: input.sessionId,
    ...(tag.parentSessionId !== undefined
      ? { parentSessionId: tag.parentSessionId }
      : {}),
    agentId: input.agentId,
    model: input.model,
    usage: input.usage,
    wallMs: input.wallMs,
    apiMs: input.apiMs,
    ...(input.contextTokens !== undefined
      ? { contextTokens: input.contextTokens }
      : {}),
  });
}
