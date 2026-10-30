/**
 * Dream pressure reader (F-06 M2, route §2.3.5 S3).
 *
 * `src/dream-budget-math.ts` owns the formula; this module owns the inputs —
 * the agent's usage interval plus the memFS delta — and must stay synchronous
 * because `DreamSignalDeps.readPressure` is called inside a scheduler tick.
 *
 * Inputs, per requirement R-5.2.3:
 *
 * - **主信号** = conversation consumption since the last completed dream run,
 *   read from the usage ledger. Dream's own spend is excluded: it is the run's
 *   cost, not the conversation growth that decides whether a run is due.
 * - **加分项** = memFS increment. The user's ruling left the coefficient to
 *   later calibration ("具体系数仍留实测校准，不阻塞实现"), so the weight here is
 *   an explicit, documented placeholder: uncommitted memory files count as
 *   `DREAM_MEMFS_BONUS_TOKENS_PER_FILE` pressure each, capped so rot can
 *   nudge the trigger but never substitute for real conversation pressure.
 *
 * Both inputs are best effort: an unreadable ledger or a missing memory repo
 * contributes `0` rather than throwing into a scheduler tick.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  computeDreamPressure,
  type DreamUsageParts,
} from "@/dream-budget-math";
import {
  type UsageRecord,
  usageHourKey,
  usageLedgerPath,
  usageSourceOf,
} from "@/usage/ledger";
import { appHomePath } from "@/utils/app-paths";

/** Provisional memFS bonus weight per dirty memory file (see module header). */
export const DREAM_MEMFS_BONUS_TOKENS_PER_FILE = 500;
/** Extra files beyond this do not add pressure: the bonus stays a nudge. */
export const DREAM_MEMFS_BONUS_MAX_FILES = 20;
/** Re-check the memory worktree at most this often (git spawn is not free). */
const MEMFS_BONUS_CACHE_MS = 60_000;

const PRESSURE_MARKER_VERSION = 1;

function pressureFileSegment(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "unknown-agent";
}

/** `<harness home>/dream/pressure/<agent>.json` — never a literal `.haruyuki`. */
export function getDreamPressureMarkerPath(agentId: string): string {
  return appHomePath([
    "dream",
    "pressure",
    `${pressureFileSegment(agentId)}.json`,
  ]);
}

interface DreamPressureMarker {
  version: 1;
  agentId: string;
  /** Epoch ms the last *completed* run ended; `null` = never completed. */
  lastRunEndedAt: number | null;
}

/** Read the "since last completed run" boundary; `null` when none. */
export function readDreamPressureMarker(agentId: string): number | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getDreamPressureMarkerPath(agentId), "utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as Record<string, unknown>).lastRunEndedAt;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Move the pressure baseline forward. Called by the run controller for the two
 * terminal states that *consumed* the pressure: `succeeded` and
 * `budget_exhausted` (a failed/cancelled/timed-out run does not count as "the
 * agent looked at this period"). Never throws.
 */
export function recordDreamPressureBaseline(
  agentId: string,
  endedAt: number,
): void {
  if (!Number.isFinite(endedAt) || endedAt <= 0) return;
  try {
    const path = getDreamPressureMarkerPath(agentId);
    mkdirSync(dirname(path), { recursive: true });
    const payload: DreamPressureMarker = {
      version: PRESSURE_MARKER_VERSION,
      agentId,
      lastRunEndedAt: Math.round(endedAt),
    };
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(payload)}\n`);
    renameSync(temp, path);
  } catch {
    // Advisory: a read-only home only costs an extra trigger, not a crash.
  }
}

// ── Ledger interval (synchronous) ───────────────────────────────────

interface LedgerCacheEntry {
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
}

const ledgerCache = new Map<string, LedgerCacheEntry>();

function parseLedgerLine(line: string): UsageRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Partial<UsageRecord>;
    if (typeof record.agentId !== "string") return undefined;
    if (typeof record.completion !== "number") return undefined;
    return record as UsageRecord;
  } catch {
    // One corrupt line must not hide the rest of the interval.
    return undefined;
  }
}

/** Read the ledger synchronously, reusing the last parse while the file is idle. */
function readLedgerSync(): UsageRecord[] {
  const path = usageLedgerPath();
  let mtimeMs: number;
  let size: number;
  try {
    const stats = statSync(path);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    ledgerCache.delete(path);
    return [];
  }
  const cached = ledgerCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.records;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of raw.split("\n")) {
    const record = parseLedgerLine(line);
    if (record) records.push(record);
  }
  ledgerCache.set(path, { mtimeMs, size, records });
  return records;
}

export interface DreamPressureBreakdown {
  /** Conversation pressure (the ledger interval). */
  usagePressure: number;
  /** memFS increment bonus (provisional weight). */
  memfsBonus: number;
  /** Sum the signal compares against `pressureThreshold`. */
  pressure: number;
  /** The interval start used; `null` for "since the beginning of the ledger". */
  since: number | null;
}

function sumUsageParts(records: readonly UsageRecord[]): DreamUsageParts {
  const parts: DreamUsageParts = {
    outputTokens: 0,
    uncachedReadTokens: 0,
    cachedReadTokens: 0,
  };
  for (const record of records) {
    parts.outputTokens += record.completion;
    parts.uncachedReadTokens += record.prompt + record.cacheWrite;
    parts.cachedReadTokens += record.cachedInput;
  }
  return parts;
}

/**
 * Ledger rows that belong to the pressure interval: this agent, after the last
 * completed run, excluding dream's own spend.
 *
 * The ledger stores hour keys rather than instants, so the boundary is the hour
 * the last run ended in. That can over-count up to 59 minutes once per run; the
 * signal's threshold (75k) makes that rounding immaterial.
 */
export function readDreamPressureRecords(
  agentId: string,
  since: number | null,
  records: readonly UsageRecord[] = readLedgerSync(),
): UsageRecord[] {
  const sinceHourKey =
    since !== null && since > 0 ? usageHourKey(new Date(since)) : null;
  return records.filter((record) => {
    if (record.agentId !== agentId) return false;
    if (usageSourceOf(record) === "dream") return false;
    if (sinceHourKey !== null && record.tsHour < sinceHourKey) return false;
    return true;
  });
}

interface MemfsBonusCacheEntry {
  at: number;
  bonus: number;
}

const memfsBonusCache = new Map<string, MemfsBonusCacheEntry>();

/** Dirty memory files since the last commit, as a provisional pressure bonus. */
export function readDreamMemfsBonus(agentId: string, now = Date.now()): number {
  const cached = memfsBonusCache.get(agentId);
  if (cached && now - cached.at < MEMFS_BONUS_CACHE_MS) return cached.bonus;
  let bonus = 0;
  try {
    const memoryDir = getScopedMemoryFilesystemRoot(agentId);
    const stdout = execFileSync(
      "git",
      ["-C", memoryDir, "status", "--porcelain"],
      {
        encoding: "utf-8",
        timeout: 2_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const files = stdout.split("\n").filter((line) => line.trim().length > 0);
    const counted = Math.min(files.length, DREAM_MEMFS_BONUS_MAX_FILES);
    bonus = counted * DREAM_MEMFS_BONUS_TOKENS_PER_FILE;
  } catch {
    // No memory repo / no git / sandbox denial: no bonus, not an error.
    bonus = 0;
  }
  memfsBonusCache.set(agentId, { at: now, bonus });
  return bonus;
}

/** Full breakdown, exposed for `/dream status` and for focused tests. */
export function readDreamPressureBreakdown(
  agentId: string,
  now: Date = new Date(),
): DreamPressureBreakdown {
  try {
    const since = readDreamPressureMarker(agentId);
    const interval = readDreamPressureRecords(agentId, since);
    const usagePressure = computeDreamPressure(sumUsageParts(interval));
    const memfsBonus = readDreamMemfsBonus(agentId, now.getTime());
    return {
      usagePressure,
      memfsBonus,
      pressure: usagePressure + memfsBonus,
      since,
    };
  } catch {
    return { usagePressure: 0, memfsBonus: 0, pressure: 0, since: null };
  }
}

/** Current dream pressure for an agent; `0` when there is no usage to read. */
export function readDreamPressure(agentId: string, now?: Date): number {
  return readDreamPressureBreakdown(agentId, now ?? new Date()).pressure;
}
