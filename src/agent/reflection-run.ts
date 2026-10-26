/**
 * In-process controller for one reflection run: the authoritative gate, the
 * status machine, the deadline, and the handle used to stop the child.
 *
 * Scope (F-03, route §2.1): this module tracks runs; it does not create forks
 * or spawn processes. The launcher registers a run, attaches the fork and the
 * subagent handle as they resolve, and finishes the run when the child exits.
 *
 * The Map here is the **authoritative** "a reflection is running for this
 * agent" answer for this process (route §2.3, §5.7.4): `checkPermission` is
 * synchronous and cannot read the on-disk memory lock, so the file-tool guard
 * asks `isReflectionRunActive`. Cross-process mutual exclusion stays with the
 * memory-operation lock; this module only decides what *this* process knows.
 *
 * M0 ships the "no deadline" passthrough: a deadline is computed and kept on
 * the state, but no timer is armed and nothing aborts the child yet. The timer,
 * the 10s grace, the abort (including the Windows taskkill semantics) and the
 * backup-then-discard finalisation arrive with the run controller work item.
 */
import { debugLog } from "@/utils/debug";

export type ReflectionRunStatus =
  | "starting"
  | "running"
  | "finishing"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled";

export interface ReflectionRunState {
  /** Stable id for this run; the fork does not exist yet when it is minted. */
  runId: string;
  agentId: string;
  parentConversationId: string;
  /** Set once the fork conversation exists (`attachReflectionFork`). */
  forkConversationId?: string;
  triggerSource: "compaction" | "user-messages" | "manual";
  status: ReflectionRunStatus;
  startedAt: number;
  /** `Number.POSITIVE_INFINITY` when the run has no wall-clock limit. */
  deadlineAt: number;
  taskId?: string;
}

/** The child handle the controller needs to stop a run. */
export interface ReflectionRunTask {
  taskId: string;
  abort: () => void;
}

/**
 * Hard ceiling from the requirement (1–60 minutes). The settings layer
 * validates the user value; clamping here keeps a bad per-agent record from
 * producing a multi-day deadline.
 */
const MAX_TIMEOUT_MINUTES = 60;

/**
 * Finished runs are kept only so a caller that races the completion callback
 * can still read the outcome. Bounded so a long session cannot grow it.
 */
const MAX_FINISHED_RUNS = 16;

const runs = new Map<string, ReflectionRunState>();
const tasks = new Map<string, ReflectionRunTask>();
const activeRunIdByAgent = new Map<string, string>();

function computeDeadline(startedAt: number, timeoutMinutes: number): number {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const minutes = Math.min(timeoutMinutes, MAX_TIMEOUT_MINUTES);
  return startedAt + minutes * 60_000;
}

function mintRunId(agentId: string, startedAt: number): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return `reflection-${agentId}-${startedAt.toString(36)}-${nonce}`;
}

/**
 * Register a run before any expensive work (fork, spawn) happens.
 *
 * Throws when the agent already has an active run: that would mean two callers
 * both passed the `isReflectionRunActive` check, and silently registering the
 * second one would break the single-writer contract the gate relies on.
 */
export function startReflectionRun(input: {
  agentId: string;
  parentConversationId: string;
  triggerSource: ReflectionRunState["triggerSource"];
  timeoutMinutes: number;
}): ReflectionRunState {
  const activeRunId = activeRunIdByAgent.get(input.agentId);
  if (activeRunId !== undefined) {
    throw new Error(
      `reflection_run_active: a reflection run is already registered (${activeRunId})`,
    );
  }

  const startedAt = Date.now();
  const state: ReflectionRunState = {
    runId: mintRunId(input.agentId, startedAt),
    agentId: input.agentId,
    parentConversationId: input.parentConversationId,
    triggerSource: input.triggerSource,
    status: "starting",
    startedAt,
    deadlineAt: computeDeadline(startedAt, input.timeoutMinutes),
  };
  runs.set(state.runId, state);
  activeRunIdByAgent.set(state.agentId, state.runId);
  debugLog(
    "reflection",
    `run ${state.runId} started (${state.triggerSource}, deadline ${describeDeadline(state)})`,
  );
  return state;
}

function describeDeadline(state: ReflectionRunState): string {
  if (!Number.isFinite(state.deadlineAt)) return "none";
  const minutes = Math.max(
    0,
    Math.round((state.deadlineAt - state.startedAt) / 1000),
  );
  return `${minutes}s`;
}

/**
 * Record the fork conversation this run owns. A late call (the run already
 * finished, e.g. after a timeout) is ignored rather than thrown: the fork
 * resolution is an async continuation and must not crash the caller.
 */
export function attachReflectionFork(
  runId: string,
  forkConversationId: string,
): void {
  const run = runs.get(runId);
  if (!run) {
    debugLog("reflection", `ignoring fork attach for unknown run ${runId}`);
    return;
  }
  run.forkConversationId = forkConversationId;
  if (run.status === "starting") run.status = "running";
}

/** Attach the spawned child so a later step can abort it. Same late-call rule. */
export function attachReflectionTask(
  runId: string,
  task: ReflectionRunTask,
): void {
  const run = runs.get(runId);
  if (!run) {
    debugLog("reflection", `ignoring task attach for unknown run ${runId}`);
    return;
  }
  tasks.set(runId, task);
  run.taskId = task.taskId;
  if (run.status === "starting") run.status = "running";
}

/**
 * Terminal transition. Idempotent: a completion callback that runs after the
 * run was already finished is a no-op, not an error.
 */
export async function finishReflectionRun(
  runId: string,
  status: ReflectionRunStatus,
  detail: { backupRef?: string; backupPatch?: string } = {},
): Promise<void> {
  const run = runs.get(runId);
  if (!run) return;

  run.status = status;
  tasks.delete(runId);
  if (activeRunIdByAgent.get(run.agentId) === runId) {
    activeRunIdByAgent.delete(run.agentId);
  }
  // The backup coordinates are carried by the finalisation step that produced
  // them (the run controller work item); M0 has nowhere to put them yet.
  void detail;
  pruneFinishedRuns();
  debugLog("reflection", `run ${runId} finished (${status})`);
}

/** Drop the oldest finished runs once the retained set exceeds its bound. */
function pruneFinishedRuns(): void {
  const finished = [...runs.values()].filter(
    (run) => activeRunIdByAgent.get(run.agentId) !== run.runId,
  );
  const excess = finished.length - MAX_FINISHED_RUNS;
  if (excess <= 0) return;
  for (const run of finished.slice(0, excess)) {
    runs.delete(run.runId);
  }
}

/** Synchronous gate used by the permission checker and the trigger surface. */
export function isReflectionRunActive(agentId: string): boolean {
  return activeRunIdByAgent.has(agentId);
}

/** The active run for an agent, if any. */
export function getActiveReflectionRun(
  agentId: string,
): ReflectionRunState | undefined {
  const runId = activeRunIdByAgent.get(agentId);
  return runId === undefined ? undefined : runs.get(runId);
}

/** Read a run by id, including a recently finished one. */
export function getReflectionRun(
  runId: string,
): ReflectionRunState | undefined {
  return runs.get(runId);
}

/**
 * Test-only: clear every tracked run. Module state otherwise leaks between
 * test files that share the Bun worker.
 */
export function resetReflectionRuns(): void {
  runs.clear();
  tasks.clear();
  activeRunIdByAgent.clear();
}
