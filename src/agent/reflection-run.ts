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
 * Deadlines (requirement §5.8, route M1c). The clock starts when the child is
 * spawned, not when the run is registered: fork-heavy setup is not the child
 * turn. When the deadline passes the run is flagged `timeout`, then given
 * `GRACE_MS` to finish on its own — a child between tool calls usually exits
 * cleanly within it, and Windows has no SIGINT stage anyway. Only a child still
 * running after the grace is aborted (its handle reaches `taskkill /T /F` on
 * Windows through the subagent process layer). The launcher's completion
 * callback then calls {@link finishReflectionRun}, which is the point where a
 * timed-out run's uncommitted memory changes are backed up and discarded
 * (requirement §5.8.4). A watchdog finalises the run if that callback never
 * arrives.
 *
 * Every timer is `unref()`ed: a pending reflection deadline must never keep the
 * process alive (route M1c).
 */
import { execFile as execFileCb } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  ReflectionRunMetadata,
  ReflectionRunRecordStatus,
} from "@/types/reflection-run-metadata";
import { APP_SUBDIRS, appHomePath } from "@/utils/app-paths";
import { debugLog, debugWarn } from "@/utils/debug";

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
  /** Configured limit; the deadline is re-anchored to the spawn (see `attachReflectionTask`). */
  timeoutMinutes: number;
  /** When the deadline fired; the backup coordinates are named after it. */
  timedOutAt?: number;
  /**
   * Where a timed-out run's uncommitted memory work was preserved before it was
   * discarded (requirement §5.8.4). Also written to the fork's conversation
   * record by {@link finishReflectionRun}.
   */
  backupRef?: string;
  backupPatch?: string;
  /** Set when the backup itself failed; the work tree is then left untouched. */
  backupFailure?: string;
}

/** The child handle the controller needs to stop a run. */
export interface ReflectionRunTask {
  taskId: string;
  abort: () => void;
}

/** Backup coordinates a caller may hand to {@link finishReflectionRun}. */
export interface ReflectionRunFinishDetail {
  backupRef?: string;
  backupPatch?: string;
}

/**
 * Emitted once per run, after the terminal state and the timeout backup are
 * final. This is the **only** completion signal the surfaces subscribe to
 * (F-03 §5.11.2): the launcher's `onComplete`, the controller's timeout
 * watchdog and the launch-failure paths all funnel through
 * {@link finishReflectionRun}, so a notification cannot depend on which of them
 * reported last. Formatting stays with the subscriber: the TUI, headless and
 * the listener each put the text on their own channel.
 */
export interface ReflectionRunFinishedEvent {
  runId: string;
  agentId: string;
  parentConversationId: string;
  forkConversationId?: string;
  triggerSource: ReflectionRunState["triggerSource"];
  status: ReflectionRunStatus;
  /** `true` exactly when the run ended at its wall-clock deadline. */
  timedOut: boolean;
  startedAt: number;
  durationMs: number;
  backupRef?: string;
  backupPatch?: string;
}

export type ReflectionRunFinishedListener = (
  event: ReflectionRunFinishedEvent,
) => void;

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

/** How long a timed-out child gets to finish on its own before it is aborted. */
const DEFAULT_GRACE_MS = 10_000;

/**
 * After an abort, how long the controller waits for the launcher's completion
 * callback before finalising the run itself. Aborting a process tree is
 * asynchronous; this is the ceiling, not the expected wait.
 */
const DEFAULT_ABORT_SETTLE_MS = 30_000;

/** A lock-free git operation inside the memory checkout; local commands only. */
const GIT_TIMEOUT_MS = 30_000;

const BACKUP_REF_PREFIX = "refs/letta-backup/reflection-timeout-";

/** Untracked files are copied, not stashed; keep that copy bounded. */
const MAX_UNTRACKED_BACKUP_FILES = 200;
const MAX_UNTRACKED_BACKUP_BYTES = 1024 * 1024;

const runs = new Map<string, ReflectionRunState>();
const tasks = new Map<string, ReflectionRunTask>();
const activeRunIdByAgent = new Map<string, string>();

type ReflectionTimerKind = "deadline" | "grace" | "settle";

interface ReflectionTimer {
  kind: ReflectionTimerKind;
  timer: ReturnType<typeof setTimeout>;
}

const timers = new Map<string, ReflectionTimer[]>();
/** Finalisation is async; two racing callers must produce one outcome. */
const finalizing = new Set<string>();
/** Surfaces observe completed runs through this one list (see the event type). */
const finishedListeners = new Set<ReflectionRunFinishedListener>();

let timing = {
  graceMs: DEFAULT_GRACE_MS,
  abortSettleMs: DEFAULT_ABORT_SETTLE_MS,
};

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

function isActiveRun(run: ReflectionRunState): boolean {
  return activeRunIdByAgent.get(run.agentId) === run.runId;
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
    timeoutMinutes: input.timeoutMinutes,
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
  const seconds = Math.max(
    0,
    Math.round((state.deadlineAt - state.startedAt) / 1000),
  );
  return `${seconds}s`;
}

function removeRunTimer(
  runId: string,
  timer: ReturnType<typeof setTimeout>,
): void {
  const armed = timers.get(runId);
  if (!armed) return;
  const remaining = armed.filter((entry) => entry.timer !== timer);
  if (remaining.length === 0) timers.delete(runId);
  else timers.set(runId, remaining);
}

function scheduleRunTimer(
  runId: string,
  kind: ReflectionTimerKind,
  delayMs: number,
  fire: () => void,
): void {
  const timer = setTimeout(() => {
    removeRunTimer(runId, timer);
    fire();
  }, delayMs);
  // A pending reflection deadline must never hold the process open.
  timer.unref?.();
  const armed = timers.get(runId) ?? [];
  armed.push({ kind, timer });
  timers.set(runId, armed);
}

function clearRunTimers(runId: string): void {
  const armed = timers.get(runId);
  if (!armed) return;
  for (const { timer } of armed) clearTimeout(timer);
  timers.delete(runId);
}

function clearRunTimersOfKind(runId: string, kind: ReflectionTimerKind): void {
  const armed = timers.get(runId);
  if (!armed) return;
  const remaining: ReflectionTimer[] = [];
  for (const entry of armed) {
    if (entry.kind === kind) {
      clearTimeout(entry.timer);
      continue;
    }
    remaining.push(entry);
  }
  if (remaining.length === 0) timers.delete(runId);
  else timers.set(runId, remaining);
}

/** Arm the wall-clock deadline from the spawn, per requirement §5.8.2. */
function armDeadline(run: ReflectionRunState): void {
  clearRunTimersOfKind(run.runId, "deadline");
  if (!Number.isFinite(run.timeoutMinutes) || run.timeoutMinutes <= 0) {
    run.deadlineAt = Number.POSITIVE_INFINITY;
    return;
  }
  run.deadlineAt = computeDeadline(Date.now(), run.timeoutMinutes);
  const remainingMs = Math.max(0, run.deadlineAt - Date.now());
  debugLog(
    "reflection",
    `run ${run.runId} deadline armed after spawn (${Math.round(remainingMs / 1000)}s)`,
  );
  scheduleRunTimer(run.runId, "deadline", remainingMs, () =>
    handleDeadline(run.runId),
  );
}

/**
 * The deadline passed. Mark the run so the gate keeps blocking (the child still
 * owns the repository) and let the child end on its own for one grace period.
 */
function handleDeadline(runId: string): void {
  const run = runs.get(runId);
  if (!run || !isActiveRun(run)) return;
  if (run.status === "timeout") return;
  run.status = "timeout";
  run.timedOutAt = Date.now();
  debugLog(
    "reflection",
    `run ${runId} hit its deadline; waiting ${timing.graceMs}ms for the child to finish on its own`,
  );
  scheduleRunTimer(runId, "grace", timing.graceMs, () =>
    abortTimedOutRun(runId),
  );
}

/**
 * Still running after the grace period: stop it. Windows has no SIGINT stage —
 * the child's abort signal reaches the subagent process layer, which terminates
 * the whole tree with `taskkill /T /F` (no polite phase to wait for).
 */
function abortTimedOutRun(runId: string): void {
  const run = runs.get(runId);
  if (!run || !isActiveRun(run)) return;
  const task = tasks.get(runId);
  if (!task) {
    debugLog(
      "reflection",
      `run ${runId} timed out but no child handle was attached; finalising`,
    );
    void finalizeTimedOutRun(runId);
    return;
  }
  debugWarn(
    "reflection",
    `run ${runId} still running ${timing.graceMs}ms after its deadline; aborting child ${task.taskId}`,
  );
  try {
    task.abort();
  } catch (error) {
    debugWarn(
      "reflection",
      `failed to abort child ${task.taskId} of run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  scheduleRunTimer(runId, "settle", timing.abortSettleMs, () => {
    void finalizeTimedOutRun(runId);
  });
}

/**
 * Last resort: the completion callback never arrived after the abort. Finalise
 * here so the backup/discard still happens and the single-writer gate is
 * released. The child was aborted a settle period ago; we do not wait forever.
 */
async function finalizeTimedOutRun(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run || !isActiveRun(run)) return;
  debugWarn(
    "reflection",
    `run ${runId} never reported completion after its timeout; finalising from the controller`,
  );
  await finishReflectionRun(runId, "timeout");
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

/**
 * Attach the spawned child so a later step can abort it and start the clock.
 * Same late-call rule: after the run finished there is nothing to arm.
 */
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
  if (isActiveRun(run) && run.status !== "timeout") armDeadline(run);
}

/**
 * Terminal transition. Idempotent: a completion callback that runs after the
 * run was already finished is a no-op, not an error.
 *
 * A run that hit its deadline keeps the `timeout` status even when the child
 * managed to finish during the grace period: the wall-clock promise was broken,
 * and the end notice has to say so (requirement §5.8.8).
 */
export async function finishReflectionRun(
  runId: string,
  status: ReflectionRunStatus,
  detail: ReflectionRunFinishDetail = {},
): Promise<void> {
  const run = runs.get(runId);
  if (!run) return;
  if (!isActiveRun(run)) return;
  if (finalizing.has(runId)) return;
  finalizing.add(runId);
  clearRunTimers(runId);

  let completed = false;
  try {
    const finalStatus: ReflectionRunStatus =
      run.status === "timeout" && status !== "timeout" ? "timeout" : status;
    if (finalStatus !== status) {
      debugLog(
        "reflection",
        `run ${runId} reported ${status} after its timeout; keeping timeout`,
      );
    }
    run.status = finalStatus;

    // Only a run that hit its deadline discards the child's leftovers
    // (requirement §5.8.3). `cancelled` also covers launches that never spawned
    // (lock taken by another process, reservation lost): the tree may then be
    // another writer's, so it is left for the next recovery pass to report.
    if (finalStatus === "timeout") {
      await backupAndDiscardMemoryChanges(run);
    }

    if (detail.backupRef) run.backupRef = detail.backupRef;
    if (detail.backupPatch) run.backupPatch = detail.backupPatch;

    await persistTerminalStatus(run, run.status);
    completed = true;
  } finally {
    tasks.delete(runId);
    if (activeRunIdByAgent.get(run.agentId) === runId) {
      activeRunIdByAgent.delete(run.agentId);
    }
    finalizing.delete(runId);
    pruneFinishedRuns();
    debugLog("reflection", `run ${runId} finished (${run.status})`);
    // Last, so a listener sees the final state and the release is already done.
    if (completed) emitReflectionRunFinished(run);
  }
}

/**
 * Subscribe to finished runs. The returned function unsubscribes; every
 * surface registers at most one listener for its process lifetime.
 */
export function subscribeReflectionRunFinished(
  listener: ReflectionRunFinishedListener,
): () => void {
  finishedListeners.add(listener);
  return () => {
    finishedListeners.delete(listener);
  };
}

function emitReflectionRunFinished(run: ReflectionRunState): void {
  if (finishedListeners.size === 0) return;
  const event: ReflectionRunFinishedEvent = {
    runId: run.runId,
    agentId: run.agentId,
    parentConversationId: run.parentConversationId,
    ...(run.forkConversationId
      ? { forkConversationId: run.forkConversationId }
      : {}),
    triggerSource: run.triggerSource,
    status: run.status,
    timedOut: run.status === "timeout",
    startedAt: run.startedAt,
    durationMs: Math.max(0, Date.now() - run.startedAt),
    ...(run.backupRef ? { backupRef: run.backupRef } : {}),
    ...(run.backupPatch ? { backupPatch: run.backupPatch } : {}),
  };
  for (const listener of [...finishedListeners]) {
    try {
      const result = listener(event) as unknown;
      if (result instanceof Promise) {
        result.catch((error) => {
          debugWarn(
            "reflection",
            `reflection completion listener failed for run ${run.runId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    } catch (error) {
      debugWarn(
        "reflection",
        `reflection completion listener failed for run ${run.runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Keep the durable copy on the fork's conversation record (frozen seam
 * `types/reflection-run-metadata.ts`). A failed write must not fail the run:
 * the in-process map is the gate's authority, the record is the viewer's.
 */
async function persistTerminalStatus(
  run: ReflectionRunState,
  status: ReflectionRunStatus,
): Promise<void> {
  if (!run.forkConversationId) return;
  if (
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "timeout" &&
    status !== "cancelled"
  ) {
    return;
  }
  const metadata: ReflectionRunMetadata = {
    runId: run.runId,
    triggerSource: run.triggerSource,
    parentConversationId: run.parentConversationId,
    startedAt: run.startedAt,
    deadlineAt: Number.isFinite(run.deadlineAt) ? run.deadlineAt : null,
    status: status as ReflectionRunRecordStatus,
    ...(run.backupRef ? { backupRef: run.backupRef } : {}),
    ...(run.backupPatch ? { backupPatch: run.backupPatch } : {}),
  };
  try {
    const { writeReflectionRunMetadata } = await import(
      "@/agent/reflection-run-metadata"
    );
    await writeReflectionRunMetadata({
      conversationId: run.forkConversationId,
      metadata,
    });
  } catch (error) {
    debugWarn(
      "reflection",
      `failed to persist terminal metadata for run ${run.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ── backup / discard of a timed-out work tree (requirement §5.8.3/§5.8.4) ──

interface BackupCoordinates {
  backupDir: string;
  backupRef?: string;
  backupPatch?: string;
  discarded: boolean;
  warnings: string[];
}

const execFile = promisify(execFileCb);

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile(
    "git",
    ["-C", cwd, "-c", "core.quotepath=false", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** `2026-10-26T18-41-22-123Z` — sortable, filesystem- and ref-safe. */
function backupTimestamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

function statusPaths(statusOutput: string): {
  untracked: string[];
  changed: string[];
} {
  const untracked: string[] = [];
  const changed: string[] = [];
  for (const rawLine of statusOutput.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const target = line.slice(3).trim();
    if (!target) continue;
    // Renames report "old -> new"; keep the destination, which is what exists.
    const path = target.includes(" -> ") ? target.split(" -> ").pop() : target;
    if (!path) continue;
    if (code === "??") untracked.push(path);
    else changed.push(path);
  }
  return { untracked, changed };
}

/**
 * Preserve whatever the child left uncommitted, then discard it, so a timed-out
 * run cannot leave the memory repository dirty (requirement §5.8.3 step order).
 *
 * The backup is three things in one directory: a `refs/letta-backup/...` ref
 * pointing at `git stash create`'s commit, a `git diff` patch, and a copy of
 * untracked files (`stash create` does not include those). Nothing is discarded
 * until every artifact needed to reconstruct the work has been written; if the
 * backup fails the work tree is kept and the run is reported as failed.
 */
async function backupAndDiscardMemoryChanges(
  run: ReflectionRunState,
): Promise<void> {
  let memoryDir: string;
  try {
    const { getScopedMemoryFilesystemRoot } = await import(
      "@/agent/memory-filesystem"
    );
    memoryDir = getScopedMemoryFilesystemRoot(run.agentId);
  } catch (error) {
    run.backupFailure = `cannot resolve the memory directory: ${
      error instanceof Error ? error.message : String(error)
    }`;
    debugWarn("reflection", `run ${run.runId}: ${run.backupFailure}`);
    return;
  }
  if (!existsSync(memoryDir)) return;

  let statusOutput: string;
  try {
    statusOutput = (await runGit(memoryDir, ["status", "--porcelain", "-uall"]))
      .stdout;
  } catch (error) {
    run.backupFailure = `git status failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    debugWarn("reflection", `run ${run.runId}: ${run.backupFailure}`);
    return;
  }
  if (statusOutput.trim().length === 0) {
    debugLog("reflection", `run ${run.runId}: no uncommitted memory changes`);
    return;
  }

  const coordinates = await captureBackup(run, memoryDir, statusOutput);
  if (coordinates === null) {
    // Backing up failed: keep the work tree rather than lose it silently.
    run.status = "failed";
    debugWarn(
      "reflection",
      `run ${run.runId}: could not back up uncommitted memory changes; leaving them in place`,
    );
    return;
  }
  run.backupRef = coordinates.backupRef;
  run.backupPatch = coordinates.backupPatch;
  if (!coordinates.discarded) {
    run.status = "failed";
    debugWarn(
      "reflection",
      `run ${run.runId}: backup written to ${coordinates.backupDir}, but discarding the uncommitted changes did not finish (${coordinates.warnings.join("; ")}); the work tree was left as it was`,
    );
    return;
  }
  debugLog(
    "reflection",
    `run ${run.runId}: discarded uncommitted memory changes after backing them up to ${coordinates.backupRef ?? "(no ref)"} and ${coordinates.backupPatch ?? "(no patch)"}${coordinates.warnings.length > 0 ? ` (${coordinates.warnings.join("; ")})` : ""}`,
  );
}

async function captureBackup(
  run: ReflectionRunState,
  memoryDir: string,
  statusOutput: string,
): Promise<BackupCoordinates | null> {
  const stamp = backupTimestamp(run.timedOutAt ?? Date.now());
  const backupDir = appHomePath([
    APP_SUBDIRS.cache,
    "reflection-timeouts",
    run.agentId,
    run.runId,
  ]);
  const warnings: string[] = [];
  let backupRef: string | undefined;
  let patch = "";
  const { untracked, changed } = statusPaths(statusOutput);

  try {
    const { stdout } = await runGit(memoryDir, ["stash", "create"]);
    const sha = stdout.trim();
    if (sha.length > 0) {
      backupRef = `${BACKUP_REF_PREFIX}${stamp}`;
      await runGit(memoryDir, ["update-ref", backupRef, sha]);
    } else {
      // Normal when the only changes are untracked; `stash create` is commit-only.
      warnings.push("git stash create returned no commit");
    }
  } catch (error) {
    debugWarn(
      "reflection",
      `run ${run.runId}: git stash create failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }

  try {
    patch = (await runGit(memoryDir, ["diff", "HEAD", "--binary"])).stdout;
  } catch {
    try {
      patch = (await runGit(memoryDir, ["diff", "--binary"])).stdout;
    } catch (error) {
      warnings.push(
        `git diff failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    mkdirSync(backupDir, { recursive: true });
    const header = [
      `# F-03 reflection timeout backup`,
      `# run: ${run.runId}`,
      `# agent: ${run.agentId}`,
      `# memory dir: ${memoryDir}`,
      `# backup ref: ${backupRef ?? "(none - no tracked changes)"}`,
      `# taken at: ${new Date(run.timedOutAt ?? Date.now()).toISOString()}`,
      `# changed files:`,
      ...changed.map((path) => `#   ${path}`),
      `# untracked files (copied next to this patch under untracked/):`,
      ...(untracked.length > 0
        ? untracked.map((path) => `#   ${path}`)
        : ["#   (none)"]),
      "",
    ].join("\n");
    const patchPath = join(backupDir, `reflection-timeout-${stamp}.patch`);
    writeFileSync(patchPath, `${header}${patch}`, "utf-8");
    copyUntrackedFiles(memoryDir, backupDir, untracked, warnings);
    return {
      backupDir,
      backupRef,
      backupPatch: patchPath,
      discarded: await discardWorkTree(memoryDir, warnings),
      warnings,
    };
  } catch (error) {
    debugWarn(
      "reflection",
      `run ${run.runId}: writing the backup into ${backupDir} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function copyUntrackedFiles(
  memoryDir: string,
  backupDir: string,
  untracked: string[],
  warnings: string[],
): void {
  let copied = 0;
  for (const relative of untracked) {
    if (copied >= MAX_UNTRACKED_BACKUP_FILES) {
      warnings.push(
        `untracked backup stopped after ${MAX_UNTRACKED_BACKUP_FILES} files`,
      );
      return;
    }
    const source = join(memoryDir, relative);
    try {
      const stat = statSync(source);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_UNTRACKED_BACKUP_BYTES) {
        warnings.push(`untracked file too large to copy: ${relative}`);
        continue;
      }
      const target = join(backupDir, "untracked", relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied += 1;
    } catch (error) {
      warnings.push(
        `could not copy untracked ${relative}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function discardWorkTree(
  memoryDir: string,
  warnings: string[],
): Promise<boolean> {
  try {
    // `git restore .` reads the index, so staged changes have to be unstaged
    // first or they would survive the discard (and keep the repo dirty).
    await runGit(memoryDir, ["restore", "--staged", "."]).catch(
      () => undefined,
    );
    await runGit(memoryDir, ["restore", "."]);
    // No `-x`: ignored files are the user's, not the timed-out child's.
    await runGit(memoryDir, ["clean", "-fd"]);
    const remaining = (
      await runGit(memoryDir, ["status", "--porcelain", "-uall"])
    ).stdout;
    if (remaining.trim().length > 0) {
      warnings.push("work tree is still dirty after the discard");
      return false;
    }
    return true;
  } catch (error) {
    warnings.push(
      `discard failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
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
 * The most recent run for an agent, live or finished. The end reminder may
 * arrive without a run id (the completion callback only knows the phase), so
 * this is how it recovers the outcome and the backup coordinates.
 */
export function getLastReflectionRunForAgent(
  agentId: string,
): ReflectionRunState | undefined {
  let latest: ReflectionRunState | undefined;
  for (const run of runs.values()) {
    if (run.agentId !== agentId) continue;
    if (!latest || run.startedAt >= latest.startedAt) latest = run;
  }
  return latest;
}

/**
 * Test-only: shorten the grace and post-abort settle periods so a timeout can
 * be exercised without waiting 10s + 30s. `resetReflectionRuns()` restores them.
 */
export function setReflectionRunTimingForTests(
  overrides: { graceMs?: number; abortSettleMs?: number } | null,
): void {
  timing = {
    graceMs: overrides?.graceMs ?? DEFAULT_GRACE_MS,
    abortSettleMs: overrides?.abortSettleMs ?? DEFAULT_ABORT_SETTLE_MS,
  };
}

/** Test-only: which timers are armed, and whether each keeps the process alive. */
export function getReflectionRunTimerStateForTests(): Array<{
  runId: string;
  kind: ReflectionTimerKind;
  refed: boolean;
}> {
  return [...timers.entries()].flatMap(([runId, armed]) =>
    armed.map(({ kind, timer }) => ({
      runId,
      kind,
      refed: typeof timer.hasRef === "function" ? timer.hasRef() : false,
    })),
  );
}

/**
 * Test-only: clear every tracked run. Module state otherwise leaks between
 * test files that share the Bun worker.
 */
export function resetReflectionRuns(): void {
  for (const runId of [...timers.keys()]) clearRunTimers(runId);
  runs.clear();
  tasks.clear();
  activeRunIdByAgent.clear();
  finalizing.clear();
  finishedListeners.clear();
  timing = {
    graceMs: DEFAULT_GRACE_MS,
    abortSettleMs: DEFAULT_ABORT_SETTLE_MS,
  };
}
