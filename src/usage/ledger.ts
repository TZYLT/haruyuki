/**
 * The per-turn usage ledger: one JSON line per completed turn, under the
 * harness root (`<haruyuki home>/usage/ledger.jsonl`).
 *
 * Why a separate file instead of the conversation store: the Usage page has to
 * aggregate **across conversations and across days** (the heatmap is roughly
 * four weeks by weekday), and the local store keeps no usage at all — its
 * messages carry `emptyLocalUsage()`. A conversation-scoped store also loses
 * history when a conversation is compacted or deleted; the ledger outlives
 * both. Only numbers are written: no conversation id, no message text.
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
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APP_SUBDIRS,
  type AppHomePathOptions,
  appHomePath,
} from "@/utils/app-paths";
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
  return record;
}

/**
 * Append one record. Resolves `false` instead of throwing when the ledger
 * cannot be written (no home dir, read-only disk, full disk).
 */
export async function appendUsageRecord(
  record: UsageRecord,
  options: { path?: string } = {},
): Promise<boolean> {
  const path = options.path ?? usageLedgerPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
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

async function rewriteUsageLedger(
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
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = parseUsageRecord(line);
    if (record) records.push(record);
  }
  if (options.prune === false) return records;
  const { kept, dropped } = pruneUsageRecords(
    records,
    options.now ?? new Date(),
    options.retentionDays ?? USAGE_RETENTION_DAYS,
  );
  if (dropped > 0) {
    try {
      await rewriteUsageLedger(path, kept);
    } catch {
      // Keep the in-memory answer even if the cleanup could not be persisted.
    }
  }
  return kept;
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
