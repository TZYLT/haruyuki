/**
 * The per-turn usage ledger: one JSON line per completed turn, under the
 * harness root (`<haruyuki home>/usage/ledger.jsonl`).
 *
 * Why a separate file instead of the conversation store: the Usage page has to
 * aggregate **across conversations and across days** (the heatmap is roughly
 * four weeks by weekday), and the local store keeps no usage at all — its
 * messages carry `emptyLocalUsage()`. A conversation-scoped store also loses
 * history when a conversation is compacted or deleted; the ledger outlives
 * both.
 *
 * Since F-03 (§5.16.6) a row may also carry **ids** (`sessionId`,
 * `parentSessionId`), its `source` and its `outcome`; message text, paths and
 * secrets are still never written. That is the one deliberate widening of the
 * original "numbers only" rule, and old rows without it stay readable.
 *
 * Shape and retention are fixed by docs/38 §14.5:
 * - one record per completed turn, aggregated at read time (the heatmap wants
 *   hour buckets, so the record stores its local hour rather than a timestamp
 *   the reader would have to bucket — and a local hour keeps working when the
 *   reader and writer are in different time zones only because both are the
 *   same machine);
 * - `cacheHitRate` and `cost` are computed **when the turn ends** and stored,
 *   never recomputed on display: prices change, and a page that re-priced old
 *   turns would quietly rewrite history every time a model was repriced;
 * - 180 days, pruned lazily on read, because nothing else ever deletes records.
 *
 * Every entry point here is silent on failure. Usage is observability, not a
 * critical path: an unwritable home directory must not break a turn.
 */

import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APP_SUBDIRS,
  type AppHomePathOptions,
  appHomePath,
} from "@/utils/app-paths";
import { debugLog } from "@/utils/debug";
import type { UsageContextBreakdown } from "@/utils/usage-context";
import {
  addUsageCost,
  emptyUsageCost,
  isZeroUsageCost,
  type UsageCost,
} from "@/utils/usage-cost";

/** Days of history kept before the ledger prunes itself on read. */
export const USAGE_RETENTION_DAYS = 180;

/** File name inside the `usage/` subdir of the harness root. */
export const USAGE_LEDGER_FILE_NAME = "ledger.jsonl";

/**
 * How long a writer waits for the ledger lock before dropping its row.
 *
 * F-03 §5.16.3 fixes the cap: an append may wait, but never indefinitely — and
 * a row that cannot be written within the window is dropped with a debug line
 * rather than failing the turn that produced it.
 */
export const USAGE_LOCK_TIMEOUT_MS = 60_000;

/** Where the spend came from (F-03 §5.16.1). Absent reads as `interactive`. */
export type UsageSource =
  | "interactive"
  | "reflection"
  | "dream"
  | "cron"
  | "subagent"
  | "compaction"
  | "other";

const USAGE_SOURCES: readonly UsageSource[] = [
  "interactive",
  "reflection",
  "dream",
  "cron",
  "subagent",
  "compaction",
  "other",
];

/** The source a record without `source` is read as (old ledgers stay readable). */
export const DEFAULT_USAGE_SOURCE: UsageSource = "interactive";

/** How the run that spent the tokens ended (F-03 §5.16.1). */
export type UsageOutcome = "completed" | "timeout" | "failed" | "cancelled";

const USAGE_OUTCOMES: readonly UsageOutcome[] = [
  "completed",
  "timeout",
  "failed",
  "cancelled",
];

function isUsageSource(value: unknown): value is UsageSource {
  return (
    typeof value === "string" &&
    (USAGE_SOURCES as readonly string[]).includes(value)
  );
}

function isUsageOutcome(value: unknown): value is UsageOutcome {
  return (
    typeof value === "string" &&
    (USAGE_OUTCOMES as readonly string[]).includes(value)
  );
}

/** A trimmed, non-empty string, or `undefined` (empty fields are not written). */
function cleanOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The record's effective source: an old row without one is an interactive turn. */
export function usageSourceOf(record: UsageRecord): UsageSource {
  return record.source ?? DEFAULT_USAGE_SOURCE;
}

/** One completed turn. Field names follow docs/38 §14.5. */
export interface UsageRecord {
  /** Local hour the turn ended in, `YYYY-MM-DDTHH`. */
  tsHour: string;
  agentId: string;
  /** Model handle the provider billed. */
  model: string;
  /** Input tokens billed at the miss rate (`prompt` in the spec's wording). */
  prompt: number;
  /** Input tokens billed at the cache-read (hit) rate. */
  cachedInput: number;
  /** Input tokens billed at the cache-write rate. */
  cacheWrite: number;
  completion: number;
  /** Subset of `completion`; kept for display, never added to it. */
  reasoning: number;
  /** Model requests in this turn (one per `usage_statistics` chunk). */
  steps: number;
  wallMs: number;
  apiMs: number;
  /** Context occupancy at the end of the turn, when the provider reported it. */
  contextTokens?: number;
  /**
   * What the request was made of, estimated where the request is assembled.
   *
   * `system` includes memory locally (core memory is compiled into the system
   * prompt, so it cannot be separated afterwards); `messages` is the transcript
   * and `tools` the tool definitions. Estimated at 4 bytes per token, which is
   * the same heuristic the context floor uses.
   */
  contextBreakdown?: UsageContextBreakdown;
  /**
   * Provider-reported cost split by pricing bucket (docs/38 §14.5 wrote
   * `cost?: number`; the four-bucket split is a superset — the detail screen
   * shows how the money splits, and a stored total alone cannot answer that).
   * Absent when the provider reported no cost at all.
   */
  cost?: UsageCost;
  /**
   * `cachedInput / (prompt + cachedInput)`.
   *
   * Not `cachedInput / prompt`: `prompt` above is the *miss* count, because the
   * four buckets are mutually exclusive (docs/38 §14.8). The spec's §14.7
   * wording assumed `prompt` meant all input; this is the ratio it wanted.
   * Output tokens are excluded, per the same decision.
   */
  cacheHitRate?: number;
  /**
   * The user stopped the turn before it finished.
   *
   * Such a turn is still recorded: it spent real tokens, and a ledger that
   * silently drops them under-reports the bill. The flag keeps "turns" honest
   * for anything that wants to separate finished work from interrupted work.
   */
  cancelled?: boolean;
  /**
   * Where the spend came from (F-03 §5.16.1).
   *
   * Absent in rows written before F-03, and read as `interactive` then — the
   * ledger's totals must not change because a column was added.
   */
  source?: UsageSource;
  /** How an automated run ended. Interactive turns carry `cancelled` instead. */
  outcome?: UsageOutcome;
  /** Stable id of one automated run (reflection: the fork's run id). */
  runId?: string;
  /**
   * Conversation the spend happened in.
   *
   * An F-03 privacy-contract change: the ledger used to carry numbers only.
   * Ids are written, message text and paths never are (§5.16.6).
   */
  sessionId?: string;
  /** Source conversation when the recorded run was a fork of another one. */
  parentSessionId?: string;
}

export interface UsageRecordInput {
  /** Defaults to now. Injectable so tests do not drift across an hour boundary. */
  at?: Date;
  agentId: string;
  model: string;
  prompt: number;
  cachedInput: number;
  cacheWrite: number;
  completion: number;
  reasoning?: number;
  steps: number;
  wallMs: number;
  apiMs: number;
  contextTokens?: number;
  contextBreakdown?: UsageContextBreakdown;
  cost?: UsageCost;
  cancelled?: boolean;
  /** See `UsageRecord.source`. `interactive` is written by the TUI's own writer. */
  source?: UsageSource;
  outcome?: UsageOutcome;
  runId?: string;
  sessionId?: string;
  parentSessionId?: string;
}

/** Local hour key, `YYYY-MM-DDTHH`. Sorts lexicographically = chronologically. */
export function usageHourKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}`;
}

/** Local day key, `YYYY-MM-DD`, taken from an hour key or a date. */
export function usageDayKey(value: string | Date): string {
  const hour = typeof value === "string" ? value : usageHourKey(value);
  return hour.slice(0, 10);
}

/** Absolute path of the ledger file. Never spell the home dir name here. */
export function usageLedgerPath(options: AppHomePathOptions = {}): string {
  return join(
    appHomePath([APP_SUBDIRS.usage], options),
    USAGE_LEDGER_FILE_NAME,
  );
}

/** Compute the derived fields (hour, hit rate, cost) and return the record. */
export function buildUsageRecord(input: UsageRecordInput): UsageRecord {
  const at = input.at ?? new Date();
  const reasoning = Math.max(0, input.reasoning ?? 0);
  const totalInput = input.prompt + input.cachedInput;
  const record: UsageRecord = {
    tsHour: usageHourKey(at),
    agentId: input.agentId,
    model: input.model,
    prompt: input.prompt,
    cachedInput: input.cachedInput,
    cacheWrite: input.cacheWrite,
    completion: input.completion,
    reasoning,
    steps: input.steps,
    wallMs: input.wallMs,
    apiMs: input.apiMs,
  };
  if (input.contextTokens !== undefined) {
    record.contextTokens = input.contextTokens;
  }
  if (input.contextBreakdown) {
    record.contextBreakdown = { ...input.contextBreakdown };
  }
  // Rounded to four decimals: this is a display number, and full float tails
  // only bloat the file.
  if (totalInput > 0) {
    record.cacheHitRate =
      Math.round((input.cachedInput / totalInput) * 10_000) / 10_000;
  }
  if (input.cost && !isZeroUsageCost(input.cost)) {
    record.cost = { ...input.cost };
  }
  if (input.cancelled) {
    record.cancelled = true;
  }
  // F-03 §5.16.1. Written conditionally so a row never carries an empty string
  // or a field it has no value for: `{"runId":""}` reads like a real id.
  if (isUsageSource(input.source)) {
    record.source = input.source;
  }
  if (isUsageOutcome(input.outcome)) {
    record.outcome = input.outcome;
  }
  const runId = cleanOptional(input.runId);
  if (runId) record.runId = runId;
  const sessionId = cleanOptional(input.sessionId);
  if (sessionId) record.sessionId = sessionId;
  const parentSessionId = cleanOptional(input.parentSessionId);
  if (parentSessionId) record.parentSessionId = parentSessionId;
  return record;
}

/**
 * Append one record. Resolves `false` instead of throwing when the ledger
 * cannot be written (no home dir, read-only disk, full disk) or when the shared
 * lock cannot be taken within `lockTimeoutMs`.
 */
export async function appendUsageRecord(
  record: UsageRecord,
  options: { path?: string; lockTimeoutMs?: number } = {},
): Promise<boolean> {
  const path = options.path ?? usageLedgerPath();
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch {
    return false;
  }
  return withUsageLedgerLock(
    path,
    options.lockTimeoutMs ?? USAGE_LOCK_TIMEOUT_MS,
    async () => {
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    },
  ).then((outcome) => outcome.locked);
}

/**
 * The lock both writers take.
 *
 * `appendUsageRecord` and `rewriteUsageLedger` must share it: a lazy prune
 * rewrites the whole file from a snapshot it read, so an append that lands
 * between that read and the rename is silently erased. The lock is a sibling
 * file created with `wx` (exclusive create), which is the one primitive that
 * is atomic on both Windows and POSIX.
 *
 * Waiting is bounded (§5.16.3): a lock nobody can take within the timeout is
 * dropped with a debug line. A lock older than the timeout is treated as
 * abandoned (its holder died mid-write) and reaped, otherwise one crashed
 * writer would make every later append wait the full 60s and then drop.
 */
type LockedOutcome<T> = { locked: true; value: T } | { locked: false };

async function withUsageLedgerLock<T>(
  path: string,
  waitMs: number,
  run: () => Promise<T>,
): Promise<LockedOutcome<T>> {
  const lockPath = `${path}.lock`;
  // The deadline is absolute, so polling overhead cannot extend the wait.
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        // Informational only (who holds it); existence is the lock.
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch {
        // A body that cannot be written does not invalidate the lock.
      }
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Not contention — an unwritable directory, a bad path. Waiting will
        // not fix it, and the caller already reports the drop.
        debugLog(
          "usage",
          `ledger lock unavailable at ${lockPath}: ${code ?? "unknown error"}`,
        );
        return { locked: false };
      }
      await reapAbandonedLock(lockPath);
      if (Date.now() >= deadline) {
        debugLog(
          "usage",
          `dropped a ledger write: the lock ${lockPath} was held for ${waitMs}ms`,
        );
        return { locked: false };
      }
      const jitter = 5 + Math.floor(Math.random() * 40);
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }
  try {
    return { locked: true, value: await run() };
  } catch {
    // Best effort: usage is observability, never a critical path.
    return { locked: false };
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      // A missing lock file is already released.
    }
  }
}

/** Remove a lock file left behind by a writer that died mid-write. */
async function reapAbandonedLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < USAGE_LOCK_TIMEOUT_MS) return;
  } catch {
    return;
  }
  try {
    await unlink(lockPath);
  } catch {
    // Another waiter reaped it first — the retry loop simply tries again.
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseUsageRecord(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.tsHour !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value.tsHour) ||
    typeof value.agentId !== "string" ||
    typeof value.model !== "string" ||
    !isFiniteNumber(value.prompt) ||
    !isFiniteNumber(value.cachedInput) ||
    !isFiniteNumber(value.cacheWrite) ||
    !isFiniteNumber(value.completion)
  ) {
    return null;
  }
  const numeric = <K extends keyof UsageRecord>(
    key: K,
    fallback: number,
  ): number => {
    const candidate = value[key as string];
    return isFiniteNumber(candidate) ? candidate : fallback;
  };
  const record: UsageRecord = {
    tsHour: value.tsHour,
    agentId: value.agentId,
    model: value.model,
    prompt: value.prompt,
    cachedInput: value.cachedInput,
    cacheWrite: value.cacheWrite,
    completion: value.completion,
    reasoning: numeric("reasoning", 0),
    steps: numeric("steps", 0),
    wallMs: numeric("wallMs", 0),
    apiMs: numeric("apiMs", 0),
  };
  if (isFiniteNumber(value.contextTokens)) {
    record.contextTokens = value.contextTokens;
  }
  if (isFiniteNumber(value.cacheHitRate)) {
    record.cacheHitRate = value.cacheHitRate;
  }
  if (value.cancelled === true) {
    record.cancelled = true;
  }
  // F-03 §5.16.1: an invalid enum or id is dropped to `undefined` — the row
  // itself must survive, because the numbers in it were still billed.
  if (isUsageSource(value.source)) {
    record.source = value.source;
  }
  if (isUsageOutcome(value.outcome)) {
    record.outcome = value.outcome;
  }
  const runId = cleanOptional(value.runId);
  if (runId) record.runId = runId;
  const sessionId = cleanOptional(value.sessionId);
  if (sessionId) record.sessionId = sessionId;
  const parentSessionId = cleanOptional(value.parentSessionId);
  if (parentSessionId) record.parentSessionId = parentSessionId;
  const breakdown = value.contextBreakdown;
  if (breakdown && typeof breakdown === "object") {
    const parts = breakdown as Record<string, unknown>;
    if (
      isFiniteNumber(parts.system) &&
      isFiniteNumber(parts.messages) &&
      isFiniteNumber(parts.tools)
    ) {
      record.contextBreakdown = {
        system: parts.system,
        messages: parts.messages,
        tools: parts.tools,
      };
    }
  }
  const cost = value.cost;
  if (cost && typeof cost === "object") {
    const buckets = cost as Record<string, unknown>;
    if (
      isFiniteNumber(buckets.input) &&
      isFiniteNumber(buckets.cacheRead) &&
      isFiniteNumber(buckets.cacheWrite) &&
      isFiniteNumber(buckets.output) &&
      isFiniteNumber(buckets.total)
    ) {
      record.cost = {
        input: buckets.input,
        cacheRead: buckets.cacheRead,
        cacheWrite: buckets.cacheWrite,
        output: buckets.output,
        total: buckets.total,
      };
    }
  }
  return record;
}

/** Drop records older than the retention window. Pure; no disk access. */
export function pruneUsageRecords(
  records: readonly UsageRecord[],
  now: Date = new Date(),
  retentionDays: number = USAGE_RETENTION_DAYS,
): { kept: UsageRecord[]; dropped: number } {
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - retentionDays);
  // Both sides are hour keys of the same shape, so a string compare is the
  // date compare. Records exactly on the cutoff hour are kept.
  const cutoffKey = usageHourKey(cutoff);
  const kept = records.filter((record) => record.tsHour >= cutoffKey);
  return { kept, dropped: records.length - kept.length };
}

async function writeUsageLedger(
  path: string,
  records: readonly UsageRecord[],
): Promise<void> {
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, body, "utf8");
  try {
    await rename(tempPath, path);
  } catch {
    // Windows refuses to rename over an existing file; remove it first.
    await writeFile(path, body, "utf8");
  }
}

/**
 * Rewrite the whole file under the shared lock.
 *
 * `produce` runs **inside** the lock. For a prune that means re-reading the
 * file there, so an append that landed between the caller's first read and this
 * rewrite is not erased by the rewrite — the loss the shared lock exists to
 * prevent. Returns the records that were actually persisted, or `locked: false`
 * when the wait ran out (the caller keeps its in-memory answer).
 */
async function rewriteUsageLedger(
  path: string,
  produce: () => Promise<UsageRecord[]> | UsageRecord[],
  lockTimeoutMs: number = USAGE_LOCK_TIMEOUT_MS,
): Promise<{ locked: boolean; records?: UsageRecord[] }> {
  const outcome = await withUsageLedgerLock(path, lockTimeoutMs, async () => {
    const records = await produce();
    await writeUsageLedger(path, records);
    return records;
  });
  if (!outcome.locked) return { locked: false };
  return { locked: true, records: outcome.value };
}

/**
 * Parse every line of the ledger file; malformed lines are skipped.
 *
 * `null` (not `[]`) when the file cannot be read at all: a missing file and an
 * unreadable one are the same "nothing to prune" for a caller, but only the
 * missing case may be replaced with a fresh file — turning a transient read
 * error into an empty file would delete the ledger.
 */
async function readUsageLedgerFile(
  path: string,
): Promise<UsageRecord[] | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return null;
  }
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = parseUsageRecord(line);
    if (record) records.push(record);
  }
  return records;
}

export interface ReadUsageLedgerOptions {
  path?: string;
  /** Defaults to now; injectable for retention tests. */
  now?: Date;
  retentionDays?: number;
  /**
   * Rewrite the file when the prune dropped records. On by default: the prune
   * is called "lazy" because reading is the only moment anything looks at the
   * old lines at all.
   */
  prune?: boolean;
  /** How long the prune's rewrite waits for the shared ledger lock. */
  lockTimeoutMs?: number;
}

/**
 * Read every record, oldest first, pruning past the retention window.
 * A missing file, a malformed line, or an unreadable home all degrade to
 * "fewer records", never to an error.
 */
export async function readUsageLedger(
  options: ReadUsageLedgerOptions = {},
): Promise<UsageRecord[]> {
  const path = options.path ?? usageLedgerPath();
  const records = (await readUsageLedgerFile(path)) ?? [];
  if (options.prune === false) return records;
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? USAGE_RETENTION_DAYS;
  const { kept, dropped } = pruneUsageRecords(records, now, retentionDays);
  if (dropped === 0) return kept;
  // The rewrite re-reads the file **under the lock**: reading first and then
  // rewriting from that snapshot would erase every append that landed in
  // between — the exact loss the shared lock exists to prevent. The first read
  // is the cheap check that a prune is even needed.
  const outcome = await rewriteUsageLedger(
    path,
    async () => {
      const current = await readUsageLedgerFile(path);
      // Unreadable (not missing): do not replace a file we could not read.
      if (!current) throw new Error("usage ledger unreadable");
      return pruneUsageRecords(current, now, retentionDays).kept;
    },
    options.lockTimeoutMs ?? USAGE_LOCK_TIMEOUT_MS,
  );
  // Keep the in-memory answer even if the cleanup could not be persisted.
  return outcome.locked ? (outcome.records ?? kept) : kept;
}

/** Summed usage over some bucket (an hour, a day, a model). */
export interface UsageTotals {
  /** Records folded in; the overview's "turns". */
  turns: number;
  prompt: number;
  cachedInput: number;
  cacheWrite: number;
  completion: number;
  reasoning: number;
  steps: number;
  wallMs: number;
  apiMs: number;
  cost: UsageCost;
}

function addRecordToTotals(totals: UsageTotals, record: UsageRecord): void {
  totals.turns += 1;
  totals.prompt += record.prompt;
  totals.cachedInput += record.cachedInput;
  totals.cacheWrite += record.cacheWrite;
  totals.completion += record.completion;
  totals.reasoning += record.reasoning;
  totals.steps += record.steps;
  totals.wallMs += record.wallMs;
  totals.apiMs += record.apiMs;
  addUsageCost(totals.cost, record.cost);
}

function emptyTotals(): UsageTotals {
  return {
    turns: 0,
    prompt: 0,
    cachedInput: 0,
    cacheWrite: 0,
    completion: 0,
    reasoning: 0,
    steps: 0,
    wallMs: 0,
    apiMs: 0,
    cost: emptyUsageCost(),
  };
}

function aggregateBy(
  records: readonly UsageRecord[],
  keyOf: (record: UsageRecord) => string,
): Map<string, UsageTotals> {
  const buckets = new Map<string, UsageTotals>();
  for (const record of records) {
    const key = keyOf(record);
    let totals = buckets.get(key);
    if (!totals) {
      totals = emptyTotals();
      buckets.set(key, totals);
    }
    addRecordToTotals(totals, record);
  }
  return buckets;
}

/** Hour buckets keyed by `YYYY-MM-DDTHH` (the heatmap's granularity). */
export function aggregateUsageByHour(
  records: readonly UsageRecord[],
): Map<string, UsageTotals> {
  return aggregateBy(records, (record) => record.tsHour);
}

/** Day buckets keyed by `YYYY-MM-DD` (the detail screen's 14-day table). */
export function aggregateUsageByDay(
  records: readonly UsageRecord[],
): Map<string, UsageTotals> {
  return aggregateBy(records, (record) => usageDayKey(record.tsHour));
}

/** Per-model buckets keyed by the billed model handle. */
export function aggregateUsageByModel(
  records: readonly UsageRecord[],
): Map<string, UsageTotals> {
  return aggregateBy(records, (record) => record.model);
}

/**
 * Per-source buckets keyed by `source` (F-03 §5.16.5).
 *
 * Old rows have no `source` and are keyed as `interactive`, which is exactly
 * how they were spent: one ledger, one total, and the automated rows are
 * separable only where a writer tagged them.
 */
export function aggregateUsageBySource(
  records: readonly UsageRecord[],
): Map<UsageSource, UsageTotals> {
  return aggregateBy(records, usageSourceOf) as Map<UsageSource, UsageTotals>;
}
