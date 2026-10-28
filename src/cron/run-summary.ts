/**
 * Startup summary (F-05, R-5.11.2/R-5.11.3).
 *
 * "While you were away the scheduler ran N tasks" — derived from the run log,
 * which is the single record of what happened (R-5.11.4). There is deliberately
 * no second ledger: `appendRunSummaryEntry` exists because the barrel froze the
 * name, but the entry it receives is already in `runs/<taskId>.jsonl`, so it
 * records nothing (see the function comment).
 *
 * "Show once" is a watermark file under the harness root: everything newer than
 * the last `markRunSummarySeen()` is pending. The watermark is resolved on every
 * call (never captured at import) so `HARUYUKI_HOME` relocation keeps working.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { appHomePath } from "@/utils/app-paths";
import { getScheduleFilePath, readScheduleFile } from "./cron-store";
import type { RunOutcome } from "./cron-types";
import {
  type CronRunLogEntry,
  getCronRunLogPath,
  readCronRunLogEntries,
} from "./run-log";

export interface RunSummaryEntry {
  runId: string;
  taskId: string;
  taskName: string;
  outcome: RunOutcome;
  startedAt: string;
  finishedAt: string;
  conversationId?: string;
}

const SEEN_FILE_NAME = "schedule-summary-seen.json";
/** Newest entries kept per task file when deriving the summary. */
const PER_TASK_LIMIT = 200;

function seenFilePath(): string {
  return appHomePath([SEEN_FILE_NAME]);
}

function readSeenThrough(): number {
  try {
    const raw = JSON.parse(readFileSync(seenFilePath(), "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return 0;
    const value = (raw as { seenThrough?: unknown }).seenThrough;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function runsDirectory(): string {
  return path.join(path.dirname(getScheduleFilePath()), "runs");
}

/** Task names for the summary; a deleted task falls back to its id. */
function taskNamesById(): Map<string, string> {
  try {
    return new Map(
      readScheduleFile().tasks.map((task) => [task.id, task.name]),
    );
  } catch {
    return new Map();
  }
}

function outcomeOf(entry: CronRunLogEntry): RunOutcome | null {
  // F-05 runs carry the authoritative outcome (T2 added `runOutcome` to the log
  // for exactly this reason, G-4); the legacy fields are the fallback for lines
  // written before it existed.
  if (entry.runOutcome) return entry.runOutcome;
  if (entry.status === "ok") return "success";
  if (entry.status === "skipped") return "skipped";
  if (entry.status !== "error") return null;
  if (entry.summary === "timeout") return "timeout";
  if (entry.summary === "cancelled") return "cancelled";
  return "failed";
}

/**
 * The log is the only record, so this is intentionally a no-op.
 *
 * Kept because `@/cron` froze the name: hosts that want a summary read the run
 * log through {@link readPendingRunSummary}. Writing the entry here would create
 * the second ledger R-5.11.4 forbids.
 */
export function appendRunSummaryEntry(_entry: RunSummaryEntry): void {
  // No-op by design (see the module comment).
}

/**
 * Runs recorded since the summary was last shown, oldest first.
 *
 * Reads every per-task log rather than the store's tasks, so runs of deleted
 * schedules still show up once. `queued` queue-time entries are excluded: they
 * record an enqueue, not a finished run.
 */
export function readPendingRunSummary(): RunSummaryEntry[] {
  const seenThrough = readSeenThrough();
  const directory = runsDirectory();
  if (!existsSync(directory)) return [];

  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const names = taskNamesById();
  const entries: RunSummaryEntry[] = [];
  for (const file of files) {
    const logPath = path.join(directory, file);
    for (const entry of readCronRunLogEntries(logPath, {
      limit: PER_TASK_LIMIT,
    })) {
      if (entry.ts <= seenThrough) continue;
      if (entry.outcome === "queued") continue;
      const outcome = outcomeOf(entry);
      if (!outcome) continue;
      entries.push({
        runId: entry.runId ?? `${entry.jobId}:${entry.ts}`,
        taskId: entry.jobId,
        taskName: names.get(entry.jobId) ?? entry.jobId,
        outcome,
        startedAt: new Date(entry.runAtMs ?? entry.ts).toISOString(),
        finishedAt: new Date(entry.ts).toISOString(),
        ...(entry.conversationId
          ? { conversationId: entry.conversationId }
          : {}),
      });
    }
  }

  return entries.toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt));
}

/** Mark everything recorded so far as shown (R-5.11.3). */
export function markRunSummarySeen(): void {
  const filePath = seenFilePath();
  const directory = path.dirname(filePath);
  try {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ seenThrough: Date.now() }, null, 2),
      { flush: true },
    );
  } catch {
    // A failed marker write only means the summary shows again next time.
  }
}

/** Path helper for tests and diagnostics. */
export function getRunSummarySeenPath(): string {
  return seenFilePath();
}

/** Per-task log path (re-exported here so a caller need not know run-log). */
export function getRunSummaryLogPath(taskId: string): string {
  return getCronRunLogPath(taskId);
}
