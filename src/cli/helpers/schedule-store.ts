/**
 * The TUI's view of the schedule store (F-05, M3).
 *
 * Three surfaces read the same data and must not each read the disk: the
 * `/schedule` overlay, the rail's "Scheduled tasks" section, and the startup
 * summary.
 * So there is one module-level store here, with the shape the rail's refresh
 * discipline asks for (`src/cli/AGENTS.md`, 45-5 C-27):
 *
 * - **The snapshot is stable.** `refresh` re-reads, derives a cheap signature,
 *   and only publishes a new object when that signature changed. A 30 s timer
 *   that wakes up to the same tasks therefore notifies nobody, and the rail does
 *   not repaint — the "data unchanged, no repaint" half of M-16.
 * - **Refresh is triggered, not ticked.** Subscribers are notified by a file
 *   re-read on three events: mount, a schedule event from the core's own bus
 *   (`src/cron/schedule-events.ts`), and a 30 s low-frequency timer that exists
 *   for the case where a *short-lived* host ran something (a separate process
 *   cannot reach this bus).
 * - **No per-tick state.** The event callback only calls `refresh`, which either
 *   publishes a changed snapshot or does nothing. There is no counter in
 *   `AppCoordinator`.
 *
 * Everything that turns a task into words is a pure function here
 * (`scheduleTaskRows`, `groupRunsByRunId`, `buildRunSummaryLines`,
 * `formatScheduleNotification`), so the frame tests and this file's own unit
 * tests read the same copy.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  type AutostartStatus,
  createCronSignalSource,
  getAutostartStatus,
  getCronRunLogPath,
  isValidCron,
  listScheduleTasks,
  markRunSummarySeen,
  type RunOutcome,
  type RunSummaryEntry,
  readCronRunLogEntries,
  readPendingRunSummary,
  type ScheduleTaskV2,
} from "@/cron";
import type { CronRunLogEntry } from "@/cron/run-log";
import {
  type ScheduleEvent,
  subscribeScheduleEvents,
} from "@/cron/schedule-events";
import { readScheduledRunUsage } from "@/usage/ledger";
import { debugWarn } from "@/utils/debug";
import { formatElapsedLabel } from "./format";
import { DETAIL_COST_DECIMALS, formatCost } from "./usage-format";

// ── Source (the one place that touches the disk) ────────────────────

/**
 * Where the view reads from. Injectable so a test can hold the clock and the
 * tasks still without a temp harness root; the app passes nothing and gets the
 * real store.
 */
export interface ScheduleSource {
  listTasks(): ScheduleTaskV2[];
  /** Next due instant for one task, or `null` when it cannot fire. */
  nextDueAt(task: ScheduleTaskV2, now: Date): Date | null;
  /** The task's newest run-log entries, newest first. */
  readRuns(taskId: string, limit: number): CronRunLogEntry[];
}

let sourceOverride: ScheduleSource | null = null;
let nextDueWarningLogged = false;

/**
 * The cron signal source answers "when is this task due next?" — the same code
 * the scheduler core uses, so the panel and the trigger cannot disagree about a
 * dialect corner (day-of-month steps are normalized there, not here).
 *
 * A task that is not `active` has no next run, an invalid expression never
 * fires, and a one-shot answers from `scheduledFor`. The `catch` is the M1 stub
 * bridge only: while `createCronSignalSource` throws, the panel says "—" instead
 * of failing to open.
 */
function liveNextDueAt(task: ScheduleTaskV2, now: Date): Date | null {
  if (task.status !== "active") return null;
  if (!task.recurring && task.scheduledFor) {
    const at = Date.parse(task.scheduledFor);
    return Number.isFinite(at) ? new Date(at) : null;
  }
  if (!isValidCron(task.cron)) return null;
  try {
    return createCronSignalSource().nextDueAt({ now, tasks: [task] });
  } catch (error) {
    if (!nextDueWarningLogged) {
      nextDueWarningLogged = true;
      debugWarn(
        "schedule",
        `next-due unavailable (M1 signal source pending): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return null;
  }
}

export function liveScheduleSource(): ScheduleSource {
  return {
    listTasks: () => listScheduleTasks(),
    nextDueAt: liveNextDueAt,
    readRuns: (taskId, limit) =>
      readCronRunLogEntries(getCronRunLogPath(taskId), {
        jobId: taskId,
        limit,
      }),
  };
}

/** Tests point the store at their own tasks, clock and run log. */
export function setScheduleSourceForTests(source: ScheduleSource | null): void {
  sourceOverride = source;
  resetScheduleStore();
}

function currentSource(): ScheduleSource {
  return sourceOverride ?? liveScheduleSource();
}

/**
 * Every task, unprojected, through the same injectable source the rows use.
 *
 * `runScheduledTaskViaTuiHost` needs the task (not the row) to resolve a name a
 * user typed; a read failure answers "none", which the caller reports as "not
 * found" rather than crashing a command row.
 */
export function listAllScheduleTasks(): ScheduleTaskV2[] {
  try {
    return currentSource().listTasks();
  } catch (error) {
    debugWarn(
      "schedule",
      `could not list schedules: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

// ── Row model (pure) ────────────────────────────────────────────────

export interface ScheduleTaskRow {
  id: string;
  name: string;
  agentId: string;
  type: ScheduleTaskV2["type"];
  /** The task itself, for a detail view that needs a field the row does not. */
  task: ScheduleTaskV2;
  /** `new (hidden)` or `conversation …6f3a2b1c` (see `conversationRef`). */
  targetLabel: string;
  /** `active`, `auto-paused`, `finished`, `missed`, … */
  statusLabel: string;
  /** `paused(auto_failures)` spelled out; empty when nothing is wrong. */
  failureNote: string;
  permission: ScheduleTaskV2["permission"];
  cron: string;
  timezone: string;
  nextDueAt: Date | null;
  /** `Today 09:00` / `Tomorrow 09:00` / `10-30 09:00` / `—`. */
  nextLabel: string;
  /** The rail's terser form: `09:00` / `10-30` / `—`. */
  nextShort: string;
  lastOutcome: RunOutcome | null;
  lastLabel: string;
  consecutiveFailures: number;
  /** One line for the list, every fact the requirement names (R-5.12.4). */
  listLine: string;
}

const OUTCOME_LABELS: Record<RunOutcome, string> = {
  success: "succeeded",
  failed: "failed",
  skipped: "skipped",
  timeout: "timed out",
  cancelled: "cancelled",
};

/** The label a terminal outcome is shown with, in the panel and the rails. */
export function outcomeLabel(outcome: RunOutcome | null): string {
  return outcome ? OUTCOME_LABELS[outcome] : "—";
}

const PERMISSION_LABELS: Record<ScheduleTaskV2["permission"], string> = {
  standard: "read-only",
  acceptEdits: "read-write",
  unrestricted: "unrestricted",
};

export function permissionLabel(
  permission: ScheduleTaskV2["permission"],
): string {
  return PERMISSION_LABELS[permission];
}

/** `new (hidden)` / `conversation …6f3a2b1c`, the target as one short phrase. */
export function targetLabel(target: ScheduleTaskV2["target"]): string {
  if (target.kind === "new") return target.hidden ? "new (hidden)" : "new";
  if (target.conversation_id === "default") return "default conversation";
  return `conversation ${conversationRef(target.conversation_id)}`;
}

/** The first eight characters of an id, the form every row shows. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Trailing characters `conversationRef` keeps, enough to tell ids apart. */
const CONVERSATION_REF_TAIL = 12;

/**
 * A conversation id shortened for display. `shortId` cannot be used here:
 * every id this fork creates starts with `local-conv-`, so the shared prefix
 * would make two conversations read the same; the tail is what differs.
 */
export function conversationRef(id: string): string {
  return id.length <= CONVERSATION_REF_TAIL
    ? id
    : `…${id.slice(-CONVERSATION_REF_TAIL)}`;
}

function pad2(value: number): string {
  return String(Math.max(0, value)).padStart(2, "0");
}

function clockLabel(at: Date): string {
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

function dayLabel(at: Date, now: Date): string {
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round(
    (startOfDay(at) - startOfDay(now)) / (24 * 60 * 60 * 1000),
  );
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/** `Today 09:00`, or `—` when the task has no next run. */
export function formatNextDue(at: Date | null, now: Date): string {
  if (!at) return "—";
  return `${dayLabel(at, now)} ${clockLabel(at)}`;
}

/**
 * A next run that is already due, as the panel words it.
 *
 * The signal source answers "the next instant the core must act on", so a value
 * in the past is a *pending* occurrence (a late slot, a catch-up), not a future
 * run — printing it bare would read as "scheduled for 09:00" at 09:30. T1's
 * contract is what makes this branch meaningful.
 */
export function formatNextDueOrPending(at: Date | null, now: Date): string {
  if (!at) return "—";
  return at.getTime() <= now.getTime()
    ? `overdue (${formatNextDue(at, now)})`
    : formatNextDue(at, now);
}

/** The rail's budget: today keeps the clock, later days keep the date. */
export function formatNextDueShort(at: Date | null, now: Date): string {
  if (!at) return "—";
  if (at.getTime() <= now.getTime()) return "overdue";
  const day = dayLabel(at, now);
  return day === "Today" ? clockLabel(at) : day;
}

/** An absolute instant (a run's start), which is never "due". */
export function formatRunStamp(at: Date, now: Date): string {
  return `${dayLabel(at, now)} ${clockLabel(at)}`;
}

/** `active`, `paused`, `auto-paused`, `finished`, `missed`, or `cancelled`. */
export function statusLabel(task: ScheduleTaskV2): string {
  if (task.status === "fired") return "finished";
  if (task.status !== "paused") return task.status;
  return task.pausedReason === "auto_failures" ? "auto-paused" : "paused";
}

/** The pause reason spelled out, which is the thing a row must not bury. */
export function failureNote(task: ScheduleTaskV2): string {
  const streak = task.consecutiveFailures;
  if (task.pausedReason === "auto_failures") {
    return streak > 0
      ? `paused after ${streak} consecutive failure(s)`
      : "paused after repeated failures";
  }
  if (task.status !== "active") return "";
  return streak > 0 ? `${streak} consecutive failure(s)` : "";
}

/** One row per task, ordered by next due, tasks with no next run last. */
export function scheduleTaskRows(
  tasks: readonly ScheduleTaskV2[],
  now: Date,
  nextDueAt: (task: ScheduleTaskV2, now: Date) => Date | null,
): ScheduleTaskRow[] {
  const rows = tasks.map((task) => {
    const next = nextDueAt(task, now);
    const row: ScheduleTaskRow = {
      id: task.id,
      name: task.name,
      agentId: task.agentId,
      type: task.type,
      task,
      targetLabel: targetLabel(task.target),
      statusLabel: statusLabel(task),
      failureNote: failureNote(task),
      permission: task.permission,
      cron: task.cron,
      timezone: task.timezone,
      nextDueAt: next,
      nextLabel: formatNextDueOrPending(next, now),
      nextShort: formatNextDueShort(next, now),
      lastOutcome: task.lastOutcome,
      lastLabel: outcomeLabel(task.lastOutcome),
      consecutiveFailures: task.consecutiveFailures,
      listLine: "",
    };
    row.listLine = buildListLine(row);
    return row;
  });
  return rows.toSorted((a, b) => {
    const aAt = a.nextDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bAt = b.nextDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aAt !== bAt) return aAt - bAt;
    return a.name.localeCompare(b.name);
  });
}

/** `Morning report · prompt · new · Today 09:00 · last succeeded · active · read-write`. */
function buildListLine(row: ScheduleTaskRow): string {
  const parts = [
    row.name,
    row.type,
    row.targetLabel,
    row.nextLabel,
    `last ${row.lastLabel}`,
    row.statusLabel,
    permissionLabel(row.permission),
  ];
  if (row.failureNote) parts.push(row.failureNote);
  return parts.join(" · ");
}

// ── Run history (pure) ──────────────────────────────────────────────

export interface ScheduleRunGroup {
  /** Runs keyed by `runId`; entries written before run ids get their own group. */
  key: string;
  runId: string | null;
  /** Newest first. */
  entries: CronRunLogEntry[];
  outcome: RunOutcome | null;
  error: string | null;
  /** Milliseconds between the run's start and its log line, when both exist. */
  durationMs: number | null;
  conversationId: string | null;
  at: number;
}

/**
 * The outcome a run-log line stands for.
 *
 * F-05's runner writes the v2 outcome in `runOutcome`; the older enum
 * (`queued/missed/failed/skipped`) cannot express `success`/`timeout`/`cancelled`
 * and is left unset where it has no word (G-4). So the v2 field wins, and the
 * status/summary pair is the fallback for lines written before it existed —
 * the same reading `run-summary.ts` does, so the panel and the startup block
 * cannot disagree about one run.
 */
function outcomeOf(entry: CronRunLogEntry): RunOutcome | null {
  if (entry.runOutcome) return entry.runOutcome;
  if (entry.status === "ok") return "success";
  if (entry.status === "skipped") return "skipped";
  if (entry.summary === "timeout") return "timeout";
  if (entry.summary === "cancelled") return "cancelled";
  if (entry.status === "error" || entry.outcome === "failed") return "failed";
  return null;
}

/**
 * Group a task's run log by `runId` (R-5.14.1: one run, one row).
 *
 * A legacy entry has no `runId` — before F-05 nothing wrote one — so it becomes
 * its own group rather than being merged into a neighbour. The page is read
 * newest-first and stays that way.
 */
export function groupRunsByRunId(
  entries: readonly CronRunLogEntry[],
): ScheduleRunGroup[] {
  const groups = new Map<string, ScheduleRunGroup>();
  for (const entry of entries) {
    const runId = entry.runId?.trim() ? entry.runId : null;
    const key = runId ?? `legacy:${entry.ts}:${entry.jobId}`;
    const existing = groups.get(key);
    const at = entry.runAtMs ?? entry.ts;
    if (existing) {
      existing.entries.push(entry);
      existing.error = existing.error ?? entry.error ?? null;
      existing.conversationId =
        existing.conversationId ?? entry.conversationId ?? null;
      continue;
    }
    groups.set(key, {
      key,
      runId,
      entries: [entry],
      outcome: outcomeOf(entry),
      error: entry.error ?? null,
      // The runner writes `durationMs`; a line from before it did keeps the
      // start stamp it does have, and a line with neither shows `—`.
      durationMs:
        entry.durationMs ??
        (entry.runAtMs !== undefined
          ? Math.max(0, entry.ts - entry.runAtMs)
          : null),
      conversationId: entry.conversationId ?? null,
      at,
    });
  }
  return [...groups.values()].toSorted((a, b) => b.at - a.at);
}

/** `12s` / `2m 3s`, or `—` when the log has no start stamp. */
export function formatRunDuration(group: ScheduleRunGroup): string {
  return group.durationMs === null ? "—" : formatElapsedLabel(group.durationMs);
}

/**
 * A run's spend, read from the usage ledger by `runId` (R-5.14.2).
 *
 * `cost === null` is "the ledger has no priced row for this run", which the
 * panel paints `—`; it is deliberately not `0`, because a free local model and
 * an unpriced one both spend nothing and only the ledger can tell them apart
 * (`helpers/usage-format.ts`, rule 1). `turns === 0` means the ledger has no row
 * at all for the run.
 */
export interface RunUsageRow {
  turns: number;
  cost: number | null;
}

/** Reads the per-run usage the log view is about to paint. */
export type RunUsageReader = (
  runIds: readonly string[],
) => Promise<ReadonlyMap<string, RunUsageRow>>;

/**
 * The production reader for one page of the run history.
 *
 * It goes through the ledger's own per-run API (`readScheduledRunUsage`), not a
 * second tally here, so the run history and the Usage page cannot disagree about
 * one run. The ledger keeps the two "no number" cases apart and so does this
 * row: `turns === 0` means no ledger row at all, and `cost === null` means the
 * rows were never priced — both paint `—`, never `0` (`helpers/usage-format.ts`,
 * rule 1).
 */
export async function readRunUsageCosts(
  runIds: readonly string[],
): Promise<ReadonlyMap<string, RunUsageRow>> {
  const wanted = [...new Set(runIds.filter((runId) => runId.length > 0))];
  const usage = new Map<string, RunUsageRow>();
  if (wanted.length === 0) return usage;
  try {
    const summaries = await readScheduledRunUsage({ runIds: wanted });
    for (const runId of wanted) {
      const summary = summaries.get(runId);
      usage.set(runId, {
        turns: summary?.turns ?? 0,
        cost:
          summary && summary.turns > 0 && summary.cost
            ? summary.cost.total
            : null,
      });
    }
  } catch (error) {
    // The ledger API is documented as never throwing; this is the belt that
    // keeps a run history painting even if that changes.
    debugWarn(
      "schedule",
      `could not read run usage: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return usage;
}

/** `$ 0.00042`, or `—` when the ledger has no priced row for the run. */
export function formatRunCost(cost: number | null | undefined): string {
  return formatCost(cost === null ? undefined : cost, DETAIL_COST_DECIMALS);
}

/** The cost segment one run-log row shows; `cost —` when there is no row. */
export function formatRunCostLabel(usage: RunUsageRow | undefined): string {
  return `cost ${formatRunCost(usage?.cost ?? null)}`;
}

/** One line per run group: when, result, how long, cost, conversation. */
export function formatRunGroupLine(
  group: ScheduleRunGroup,
  now: Date,
  costLabel?: string,
): string {
  const parts = [
    formatRunStamp(new Date(group.at), now),
    outcomeLabel(group.outcome),
    formatRunDuration(group),
  ];
  if (costLabel !== undefined) parts.push(costLabel);
  if (group.conversationId) {
    parts.push(`conversation ${conversationRef(group.conversationId)}`);
  }
  const error = group.error?.trim().replace(/\s+/g, " ");
  if (error) parts.push(error.length > 48 ? `${error.slice(0, 47)}…` : error);
  return parts.join(" · ");
}

// ── Startup summary (R-5.11.2 / R-5.11.3) ───────────────────────────

export interface RunSummaryCounts {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

function isSkipped(outcome: RunOutcome): boolean {
  return outcome === "skipped";
}

/** Count the pending entries into the three buckets the summary names. */
export function summarizeRunEntries(
  entries: readonly RunSummaryEntry[],
): RunSummaryCounts {
  const counts: RunSummaryCounts = {
    total: entries.length,
    success: 0,
    failed: 0,
    skipped: 0,
  };
  for (const entry of entries) {
    if (entry.outcome === "success") counts.success += 1;
    else if (isSkipped(entry.outcome)) counts.skipped += 1;
    else counts.failed += 1;
  }
  return counts;
}

/**
 * The startup block: one count line, then one line per run (R-5.11.2 itemized).
 *
 * The block is committed through `<Static>`, which never re-renders, so
 * "expandable" cannot be a toggle here. The detail is materialized in the same
 * block instead: **every** pending run gets its own line, so the block is the
 * complete record and `/schedule logs` is the replay path, not the remainder.
 * An earlier cap of six made the block a preview and lost the rest of the
 * report; the pending summary is itself bounded by the runner, so printing it
 * whole cannot be unbounded output.
 *
 * A leading empty string separates the block from whatever the startup output
 * printed before it, so the two call sites can push the lines as they are.
 */
export function buildRunSummaryLines(
  entries: readonly RunSummaryEntry[],
  now: Date,
): string[] {
  if (entries.length === 0) return [];
  const counts = summarizeRunEntries(entries);
  const runWord = counts.total === 1 ? "run" : "runs";
  const lines = [
    `While you were away: ${counts.total} scheduled ${runWord} (${counts.success} succeeded / ${counts.failed} failed / ${counts.skipped} skipped)`,
  ];
  for (const entry of entries) {
    const at = Date.parse(entry.startedAt);
    const when = Number.isFinite(at) ? formatRunStamp(new Date(at), now) : "—";
    const parts = [when, entry.taskName, outcomeLabel(entry.outcome)];
    if (entry.conversationId) {
      parts.push(`conversation ${conversationRef(entry.conversationId)}`);
    }
    lines.push(`  · ${parts.join(" · ")}`);
  }
  return ["", ...lines];
}

let startupSummaryCache: string[] | null = null;

/**
 * Read the pending summary, mark it seen, and hand back its lines.
 *
 * Once per process on purpose: the two startup effects (resumed session, new
 * session) can both run, and the second one must not read an already-consumed
 * summary (it would be empty) nor mark it a second time. The second caller gets
 * the same cached lines.
 */
export function takeStartupScheduleSummaryLines(now = new Date()): string[] {
  if (startupSummaryCache !== null) return startupSummaryCache;
  let entries: RunSummaryEntry[] = [];
  try {
    entries = readPendingRunSummary();
  } catch (error) {
    debugWarn(
      "schedule",
      `startup summary unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    startupSummaryCache = [];
    return startupSummaryCache;
  }
  startupSummaryCache = buildRunSummaryLines(entries, now);
  if (entries.length > 0) {
    try {
      markRunSummarySeen();
    } catch (error) {
      debugWarn(
        "schedule",
        `could not mark the startup summary seen: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return startupSummaryCache;
}

/** Tests start a new process-equivalent. */
export function resetStartupScheduleSummary(): void {
  startupSummaryCache = null;
}

// ── Notifications (R-5.11.1) ────────────────────────────────────────

function eventWhen(event: ScheduleEvent, now: Date): string {
  const at = Date.parse(event.at);
  return Number.isFinite(at) ? formatRunStamp(new Date(at), now) : "—";
}

/**
 * One `task_notification` line per run, success and failure alike.
 *
 * The four facts R-5.11.1 names — task name, result, elapsed time, conversation
 * entry — plus the reason when the run did not simply succeed. The text is a
 * plain display line because it rides `appendTaskNotificationEventsToBuffer`,
 * the path every background task already uses; there is no second XML dialect.
 */
export function formatScheduleNotification(
  event: ScheduleEvent,
  now = new Date(),
): string | null {
  const when = eventWhen(event, now);
  const duration =
    event.durationMs === undefined
      ? null
      : formatElapsedLabel(Math.max(0, event.durationMs));
  const conversation = event.conversationId
    ? `conversation ${conversationRef(event.conversationId)}`
    : null;
  const parts = [when];

  switch (event.kind) {
    case "run-finished": {
      parts.push(
        `Scheduled task "${event.taskName}"`,
        outcomeLabel(event.outcome ?? null),
      );
      if (duration) parts.push(duration);
      if (conversation) parts.push(conversation);
      const error = event.error?.trim().replace(/\s+/g, " ");
      if (event.outcome === "failed" && error) {
        parts.push(error.length > 60 ? `${error.slice(0, 59)}…` : error);
      }
      return parts.join(" · ");
    }
    case "task-paused":
      parts.push(
        `Scheduled task "${event.taskName}" paused`,
        event.pausedReason === "auto_failures"
          ? "auto-paused"
          : "paused manually",
      );
      return parts.join(" · ");
    case "task-missed":
      parts.push(
        `Scheduled task "${event.taskName}" missed a run`,
        event.missedCount === undefined
          ? "not caught up"
          : `${event.missedCount} missed so far`,
      );
      return parts.join(" · ");
    default:
      // `run-started` is a "now running" hint, not a per-run notification: the
      // requirement asks for one line per run, and the finish line is that one.
      return null;
  }
}

// ── Snapshot store ──────────────────────────────────────────────────

export interface ScheduleSnapshot {
  rows: readonly ScheduleTaskRow[];
  /** False until the first read finished — a frame may need to say "loading". */
  loaded: boolean;
  /** The read failed (store version gate, permissions); the frame shows it. */
  error: string | null;
  /** Monotonic, for a face that wants to re-key a list without comparing rows. */
  revision: number;
}

const EMPTY_SNAPSHOT: ScheduleSnapshot = {
  rows: [],
  loaded: false,
  error: null,
  revision: 0,
};

let snapshot: ScheduleSnapshot = EMPTY_SNAPSHOT;
let lastSignature = "";
const listeners = new Set<() => void>();

/** A fixed clock for frame tests; `null` means the wall clock. */
let clockOverride: (() => Date) | null = null;

export function setScheduleClockForTests(clock: (() => Date) | null): void {
  clockOverride = clock;
}

/** The store's now, which a test pins so a row's label is reproducible. */
export function scheduleNow(): Date {
  return clockOverride?.() ?? new Date();
}

export function subscribeScheduleTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getScheduleSnapshot(): ScheduleSnapshot {
  return snapshot;
}

/** The signature that decides "did anything a row shows actually change". */
function signatureOf(
  rows: readonly ScheduleTaskRow[],
  error: string | null,
): string {
  const parts = rows.map((row) =>
    [
      row.id,
      row.name,
      row.statusLabel,
      row.failureNote,
      row.nextDueAt?.toISOString() ?? "",
      row.lastLabel,
      row.type,
      row.permission,
      row.cron,
      row.timezone,
      row.targetLabel,
      row.task.lastRunAt ?? "",
      String(row.task.fireCount),
      String(row.task.missedCount),
      String(row.task.failedCount),
    ].join("|"),
  );
  parts.push(error ?? "");
  return parts.join("\n");
}

/**
 * Re-read the store and publish **only when the derived rows changed**.
 *
 * Synchronous on purpose: the reads are one small JSON parse and one journaled
 * file per task, and the callers are a mount, an event and a 30 s timer — a
 * promise here would buy nothing and let two refreshes publish out of order.
 */
export function refreshScheduleTasks(now = scheduleNow()): ScheduleSnapshot {
  let rows: readonly ScheduleTaskRow[] = [];
  let error: string | null = null;
  try {
    const source = currentSource();
    rows = scheduleTaskRows(source.listTasks(), now, source.nextDueAt);
  } catch (readError) {
    error = readError instanceof Error ? readError.message : String(readError);
  }
  const signature = signatureOf(rows, error);
  if (signature === lastSignature && snapshot.loaded) return snapshot;
  lastSignature = signature;
  snapshot = {
    rows,
    loaded: true,
    error,
    revision: snapshot.revision + 1,
  };
  for (const listener of [...listeners]) listener();
  return snapshot;
}

/**
 * Read once, if the process has not read yet.
 *
 * Called by the submit layer right before it opens a face: the first frame a
 * user sees is then the data, not "Loading…". The read is synchronous on
 * purpose (one small JSON parse plus one journal per task), and it is a no-op
 * once anything has loaded — the rail normally got there first.
 */
export function ensureScheduleTasksLoaded(
  now = scheduleNow(),
): ScheduleSnapshot {
  if (snapshot.loaded) return snapshot;
  return refreshScheduleTasks(now);
}

/** Drop every bit of module state. Tests and process teardown only. */
export function resetScheduleStore(): void {
  snapshot = EMPTY_SNAPSHOT;
  lastSignature = "";
  clockOverride = null;
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshRefCount = 0;
  if (eventUnsubscribe !== null) {
    eventUnsubscribe();
    eventUnsubscribe = null;
  }
}

/** How often a long-lived surface re-reads for a *separate* process's runs. */
export const SCHEDULE_REFRESH_INTERVAL_MS = 30_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshRefCount = 0;
let eventUnsubscribe: (() => void) | null = null;

/**
 * Start (or join) the low-frequency refresh loop.
 *
 * One timer for the whole process, reference counted by the surfaces that need
 * it: the rail and an open overlay both call it, and neither owns the interval.
 * The event subscription is joined at the same time — a long-lived host's own
 * runs arrive that way, and the 30 s timer is only the cross-process fallback.
 */
export function startScheduleRefresh(): () => void {
  refreshRefCount += 1;
  if (refreshRefCount === 1) {
    refreshScheduleTasks();
    eventUnsubscribe = subscribeScheduleEvents(() => {
      refreshScheduleTasks();
    });
    refreshTimer = setInterval(() => {
      refreshScheduleTasks();
    }, SCHEDULE_REFRESH_INTERVAL_MS);
    // A timer must not keep the process alive while the TUI is tearing down.
    refreshTimer.unref?.();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    refreshRefCount = Math.max(0, refreshRefCount - 1);
    if (refreshRefCount > 0) return;
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (eventUnsubscribe !== null) {
      eventUnsubscribe();
      eventUnsubscribe = null;
    }
  };
}

/**
 * The snapshot as React state, with the refresh loop joined for the mount.
 *
 * `useSyncExternalStore` is what keeps the rail honest under C-27: an unchanged
 * snapshot is the same object, so React does not re-render the subtree.
 */
export function useScheduleTasks(options?: {
  autoRefresh?: boolean;
}): ScheduleSnapshot {
  const autoRefresh = options?.autoRefresh ?? true;
  const current = useSyncExternalStore(
    subscribeScheduleTasks,
    getScheduleSnapshot,
    getScheduleSnapshot,
  );
  // Only the boolean is a dependency: the loop joins once per mount, and the
  // snapshot rides `useSyncExternalStore` so an unchanged read notifies nobody.
  useEffect(() => {
    if (!autoRefresh) return;
    return startScheduleRefresh();
  }, [autoRefresh]);
  return current;
}

// ── Autostart (M4, read on demand) ──────────────────────────────────

export interface AutostartView {
  /** `null` when M4 has not been wired in this build or the read threw. */
  registered: boolean | null;
  /**
   * The OS entry exists but points at a launcher this build no longer uses
   * (install path or harness root changed), so it needs re-registration
   * (M4 #11). `true` only when registration itself succeeded.
   */
  stale?: boolean;
  /** One line for the panel's footer or a receipt. */
  label: string;
}

/**
 * Turn one M4 status into the panel's line.
 *
 * Pure, and exported so the stale wording (M4 #11) is tested without shelling
 * out: a registered-but-stale entry is the one state the label must separate —
 * the timer exists and is wrong, which is not "not registered".
 */
export function autostartViewFor(status: AutostartStatus): AutostartView {
  if (status.registered && status.stale) {
    return {
      registered: true,
      stale: true,
      label: `Autostart: registered (needs re-registration${
        status.method ? `, ${status.method}` : ""
      })`,
    };
  }
  return {
    registered: status.registered,
    stale: status.stale,
    label: status.registered
      ? `Autostart: registered (${status.method ?? "unknown method"})`
      : `Autostart: not registered${status.error ? ` (${status.error})` : ""}`,
  };
}

/**
 * Read the OS registration for the panel.
 *
 * On demand and never in the rail: this shells out to `schtasks`/`launchctl`/
 * `systemctl`, which is a subprocess, so a 30 s refresh must not carry it. A
 * throw and a `{registered:false, error}` result both become "not registered":
 * the panel only has to say whether the timer exists. The re-read moments are
 * the face's (mount, view change, store revision), because the entry can be
 * removed behind the panel's back (M3 #16).
 */
export async function readAutostartView(): Promise<AutostartView> {
  try {
    return autostartViewFor(await getAutostartStatus());
  } catch (error) {
    return {
      registered: null,
      label: `Autostart: unknown (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
}

// ── Overlay target bridge ───────────────────────────────────────────

/** Which face `/schedule …` asked for, and the id it named. */
export type ScheduleOverlayTarget =
  | { view: "list"; allAgents?: boolean }
  | { view: "detail" | "logs"; taskId: string }
  | { view: "wizard"; args?: readonly string[] };

let overlayTarget: ScheduleOverlayTarget = { view: "list" };

/**
 * The submit handler can open an overlay but cannot pass it props, so the
 * command parks what it resolved here and the face reads it on mount — the same
 * bridge `topic-trim-request.ts` uses for the compaction picker.
 */
export function setScheduleOverlayTarget(target: ScheduleOverlayTarget): void {
  overlayTarget = target;
}

export function peekScheduleOverlayTarget(): ScheduleOverlayTarget {
  return overlayTarget;
}
