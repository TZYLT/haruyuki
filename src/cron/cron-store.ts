/**
 * Schedule storage (F-05).
 *
 * Owns `schedules.json`: the version-2 file, its normalizer, the version gate,
 * the v1 → v2 migration (with a read-only `crons.v1.json` backup) and the
 * record ⇄ `ScheduleTaskV2` adapters.
 *
 * Why a new file name (Q-46): a binary that predates F-05 only ever reads
 * `crons.json`, so it cannot mistake this file for an empty schedule list and
 * overwrite it. After migration `crons.json` is renamed to `crons.v1.json`,
 * which this module never writes again.
 *
 * Locking lives in `cron-lease.ts` and is deliberately absent here: every
 * mutating caller holds the advisory lock, while reads are lock-free (the old
 * store worked the same way). Keeping the lock out of this module is also what
 * keeps the import graph acyclic (`cron-lease` → `cron-store`).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appHomeRoot } from "@/utils/app-paths";
import {
  type CronRunReason,
  type CronTask,
  DEFAULT_PERMISSION_TIER,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_WAIT_MINUTES,
  type RunOutcome,
  SCHEDULE_FILE_VERSION,
  type ScheduleFileData,
  type ScheduleTaskV2,
  type SignalState,
  type TaskTarget,
} from "./cron-types";

// ── Paths ───────────────────────────────────────────────────────────

const SCHEDULE_FILE_NAME = "schedules.json";
const LEGACY_FILE_NAME = "crons.json";
const LEGACY_BACKUP_FILE_NAME = "crons.v1.json";

function getHaruyukiDir(): string {
  // Through the shared helper, so the scheduler cannot disagree with the rest of
  // the harness about the root.
  return appHomeRoot();
}

/** Live store path: `~/.haruyuki/schedules.json`. */
export function getScheduleFilePath(): string {
  return join(getHaruyukiDir(), SCHEDULE_FILE_NAME);
}

/**
 * Historical store path. Read once (during migration) and then only kept as the
 * name the legacy backup used to have.
 */
export function getLegacyCronFilePath(): string {
  return join(getHaruyukiDir(), LEGACY_FILE_NAME);
}

/** Read-only v1 backup created by the migration. */
export function getCronBackupFilePath(): string {
  return join(getHaruyukiDir(), LEGACY_BACKUP_FILE_NAME);
}

/**
 * Directory of the schedule store. Run logs live next to it (`runs/<taskId>`),
 * so the name is kept for the modules that resolve those paths.
 */
export function getCronFilePath(): string {
  return getScheduleFilePath();
}

/** Store mtime, for change detection. 0 when the file does not exist. */
export function getScheduleFileMtime(): number {
  try {
    return statSync(getScheduleFilePath()).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Historical name for the store read. Kept because the scheduler and the
 * existing tests read through it; the file itself is `schedules.json` now.
 */
export function readCronFile(): ScheduleFileData {
  return readScheduleFile();
}

/** Historical name for the store mtime (see `readCronFile`). */
export function getCronFileMtime(): number {
  return getScheduleFileMtime();
}

// ── Errors ──────────────────────────────────────────────────────────

/**
 * The file was written by a newer build. Reads and writes refuse instead of
 * normalizing it into an empty list, because the next write would then drop
 * tasks this build cannot represent (M-10).
 */
export class ScheduleStoreVersionError extends Error {
  readonly foundVersion: number;
  constructor(foundVersion: number) {
    super(
      `schedules.json has version ${foundVersion}, but this build understands ${SCHEDULE_FILE_VERSION}. Refusing to read or write it. Upgrade Haruyuki or move the file aside.`,
    );
    this.name = "ScheduleStoreVersionError";
    this.foundVersion = foundVersion;
  }
}

/** The legacy file exists but cannot be migrated; it is left untouched. */
export class ScheduleStoreMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleStoreMigrationError";
  }
}

// ── Normalizing ─────────────────────────────────────────────────────

function emptySignalState(): SignalState {
  return { cursor: {} };
}

export function emptyScheduleFile(): ScheduleFileData {
  return {
    version: SCHEDULE_FILE_VERSION,
    scheduler_owner: null,
    scheduler_owners: {},
    signal_state: emptySignalState(),
    tasks: [],
  };
}

function targetFromConversationId(conversationId: string): TaskTarget {
  if (conversationId === "new") return { kind: "new", hidden: false };
  return { kind: "existing", conversation_id: conversationId };
}

function conversationIdFromTarget(target: TaskTarget): string {
  return target.kind === "new" ? "new" : target.conversation_id;
}

/**
 * Fill every field the F-05 code reads, on both the v1 and the v2 side. Records
 * migrated from `crons.json` look exactly like records written by this build.
 */
export function normalizeScheduleTask(task: CronTask): CronTask {
  const conversationId = task.conversation_id ?? "new";
  return {
    ...task,
    conversation_id: conversationId,
    // v1 summary fields
    last_run_at: task.last_run_at ?? null,
    last_run_outcome: task.last_run_outcome ?? null,
    last_run_reason: task.last_run_reason ?? null,
    last_run_error: task.last_run_error ?? null,
    last_missed_at: task.last_missed_at ?? null,
    missed_count: task.missed_count ?? 0,
    failed_count: task.failed_count ?? 0,
    // v2 fields (Q-53: migrated tasks keep the old, unrestricted behaviour)
    type: task.type ?? "prompt",
    payload: task.payload ?? task.prompt,
    target: task.target ?? targetFromConversationId(conversationId),
    permission: task.permission ?? DEFAULT_PERMISSION_TIER,
    catch_up: task.catch_up ?? false,
    timeout_minutes: task.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES,
    wait_minutes: task.wait_minutes ?? DEFAULT_WAIT_MINUTES,
    lease: task.lease ?? null,
    last_consumed_occurrence: task.last_consumed_occurrence ?? null,
    consecutive_failures: task.consecutive_failures ?? 0,
    paused_reason: task.paused_reason ?? null,
  };
}

function normalizeScheduleFileData(data: ScheduleFileData): ScheduleFileData {
  return {
    version: SCHEDULE_FILE_VERSION,
    scheduler_owner: data.scheduler_owner ?? null,
    scheduler_owners:
      data.scheduler_owners && typeof data.scheduler_owners === "object"
        ? data.scheduler_owners
        : {},
    signal_state: normalizeSignalState(data.signal_state),
    tasks: Array.isArray(data.tasks)
      ? data.tasks.map(normalizeScheduleTask)
      : [],
  };
}

function normalizeSignalState(state: SignalState | undefined): SignalState {
  if (!state || typeof state !== "object") return emptySignalState();
  const cursor =
    state.cursor && typeof state.cursor === "object" ? state.cursor : {};
  return { cursor: { ...cursor } };
}

// ── Raw I/O ─────────────────────────────────────────────────────────

interface RawScheduleFile {
  version?: unknown;
  scheduler_owner?: unknown;
  scheduler_owners?: unknown;
  signal_state?: unknown;
  tasks?: unknown;
}

function readRawScheduleFile(): RawScheduleFile | null {
  const path = getScheduleFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as RawScheduleFile;
  } catch {
    // Legacy behaviour: unreadable JSON is treated as an empty schedule list.
    // The file is only rewritten by an explicit mutation, never by a read.
    return null;
  }
}

function assertSupportedVersion(raw: RawScheduleFile): void {
  const version = raw.version;
  if (typeof version === "number" && version > SCHEDULE_FILE_VERSION) {
    throw new ScheduleStoreVersionError(version);
  }
}

function writeScheduleFileUnchecked(data: ScheduleFileData): void {
  const path = getScheduleFilePath();
  const dir = getHaruyukiDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ ...data, version: SCHEDULE_FILE_VERSION }, null, 2),
    { flush: true },
  );
  renameSync(tmp, path);
}

// ── Public read / write ─────────────────────────────────────────────

/**
 * Read the live store, migrating `crons.json` on first contact.
 *
 * A file whose version is newer than this build throws instead of being read as
 * empty: returning an empty list would let the next write erase it.
 */
export function readScheduleFile(): ScheduleFileData {
  const raw = readRawScheduleFile();
  if (raw === null) {
    const migrated = migrateLegacyCronFile();
    return migrated ? migrated.data : emptyScheduleFile();
  }
  assertSupportedVersion(raw);
  return normalizeScheduleFileData(raw as unknown as ScheduleFileData);
}

/** Write the live store. Refuses when the file on disk belongs to a newer build. */
export function writeScheduleFile(data: ScheduleFileData): void {
  const raw = readRawScheduleFile();
  if (raw !== null) assertSupportedVersion(raw);
  writeScheduleFileUnchecked(data);
}

// ── v1 → v2 migration ───────────────────────────────────────────────

export interface MigrationResult {
  data: ScheduleFileData;
  /** Where the untouched v1 file went. */
  backupPath: string;
  taskCount: number;
}

/**
 * Migrate `crons.json` (version 1) to `schedules.json` (version 2).
 *
 * Order matters for rollback: the v2 file is written first and the legacy file
 * is only renamed afterwards, so a failure at any point leaves `crons.json`
 * exactly as it was. Idempotent: a second process racing this one rewrites the
 * same content and finds the legacy file already gone (the rename is best
 * effort) — both end up with the same store.
 *
 * Returns `null` when there is nothing to migrate.
 */
export function migrateLegacyCronFile(): MigrationResult | null {
  const legacyPath = getLegacyCronFilePath();
  if (!existsSync(legacyPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, "utf-8"));
  } catch {
    throw new ScheduleStoreMigrationError(
      `Could not parse ${legacyPath}. The file was left untouched; fix or move it, then retry.`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ScheduleStoreMigrationError(
      `${legacyPath} is not a schedule file. The file was left untouched.`,
    );
  }

  const legacy = parsed as RawScheduleFile;
  const legacyVersion = legacy.version;
  if (typeof legacyVersion === "number" && legacyVersion > 1) {
    throw new ScheduleStoreMigrationError(
      `${legacyPath} has version ${legacyVersion}, not a v1 schedule file. The file was left untouched.`,
    );
  }

  const data: ScheduleFileData = {
    version: SCHEDULE_FILE_VERSION,
    scheduler_owner:
      (legacy.scheduler_owner as ScheduleFileData["scheduler_owner"]) ?? null,
    scheduler_owners:
      legacy.scheduler_owners && typeof legacy.scheduler_owners === "object"
        ? (legacy.scheduler_owners as ScheduleFileData["scheduler_owners"])
        : {},
    signal_state: normalizeSignalState(
      legacy.signal_state as SignalState | undefined,
    ),
    tasks: Array.isArray(legacy.tasks)
      ? (legacy.tasks as CronTask[]).map(normalizeScheduleTask)
      : [],
  };

  writeScheduleFileUnchecked(data);

  const backupPath = getCronBackupFilePath();
  try {
    if (existsSync(backupPath)) rmSync(backupPath, { force: true });
    renameSync(legacyPath, backupPath);
  } catch {
    // A failed rename leaves the v1 file in place next to the new store. It is
    // no longer read; the backup is recreated on the next successful attempt.
  }

  return {
    data: normalizeScheduleFileData(data),
    backupPath,
    taskCount: data.tasks.length,
  };
}

// ── record ⇄ ScheduleTaskV2 ─────────────────────────────────────────

const RUN_REASONS: ReadonlySet<string> = new Set<CronRunReason>([
  "scheduled_time_matched",
  "one_off_due",
  "scheduler_inactive",
  "started_too_late",
  "queue_full",
  "runtime_unavailable",
  "task_cancelled",
  "invalid_cron",
  "scheduler_error",
]);

/**
 * The legacy summary outcome cannot express `success`/`timeout`/`cancelled`
 * (they land in the run log instead). `queued` is in flight, not an outcome.
 */
function toRunOutcome(task: CronTask): RunOutcome | null {
  switch (task.last_run_outcome) {
    case "missed":
    case "skipped":
      return "skipped";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** Frozen-view projection. Fills every default, so callers never see `undefined`. */
export function toScheduleTaskV2(record: CronTask): ScheduleTaskV2 {
  const task = normalizeScheduleTask(record);
  return {
    id: task.id,
    agentId: task.agent_id,
    name: task.name,
    description: task.description,
    type: task.type ?? "prompt",
    target: task.target ?? targetFromConversationId(task.conversation_id),
    payload: task.payload ?? task.prompt,
    cron: task.cron,
    timezone: task.timezone,
    recurring: task.recurring,
    scheduledFor: task.scheduled_for,
    catchUp: task.catch_up ?? false,
    permission: task.permission ?? DEFAULT_PERMISSION_TIER,
    timeoutMinutes: task.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES,
    waitMinutes: task.wait_minutes ?? DEFAULT_WAIT_MINUTES,
    status: task.status,
    pausedReason: task.paused_reason ?? null,
    createdAt: task.created_at,
    lastFiredAt: task.last_fired_at,
    fireCount: task.fire_count,
    lastRunAt: task.last_run_at,
    lastOutcome: toRunOutcome(task),
    lastReason:
      typeof task.last_run_reason === "string" ? task.last_run_reason : null,
    lastError: task.last_run_error,
    consecutiveFailures: task.consecutive_failures ?? 0,
    missedCount: task.missed_count,
    failedCount: task.failed_count,
    lastConsumedOccurrence: task.last_consumed_occurrence ?? null,
    lease: task.lease ?? null,
    jitterOffsetMs: task.jitter_offset_ms,
    firedAt: task.fired_at,
    missedAt: task.missed_at,
  };
}

/**
 * Fold the frozen view back onto its record.
 *
 * `last_run_outcome` / `last_run_reason` are intentionally not written here:
 * the record's enum cannot express the v2 terminal outcomes, and the run log is
 * the authority for them. M2 extends the record when it takes over run
 * accounting.
 */
export function applyScheduleTaskV2(
  base: CronTask,
  view: ScheduleTaskV2,
): CronTask {
  const conversationId = conversationIdFromTarget(view.target);
  return {
    ...base,
    id: view.id,
    agent_id: view.agentId,
    name: view.name,
    description: view.description,
    type: view.type,
    target: view.target,
    payload: view.payload,
    // `prompt` stays the field the legacy prompt wrapper reads.
    prompt: view.type === "prompt" ? view.payload : base.prompt,
    conversation_id: conversationId,
    cron: view.cron,
    timezone: view.timezone,
    recurring: view.recurring,
    scheduled_for: view.scheduledFor,
    catch_up: view.catchUp,
    permission: view.permission,
    timeout_minutes: view.timeoutMinutes,
    wait_minutes: view.waitMinutes,
    status: view.status,
    paused_reason: view.pausedReason,
    created_at: view.createdAt,
    last_fired_at: view.lastFiredAt,
    fire_count: view.fireCount,
    last_run_at: view.lastRunAt,
    last_run_error: view.lastError,
    consecutive_failures: view.consecutiveFailures,
    missed_count: view.missedCount,
    failed_count: view.failedCount,
    last_consumed_occurrence: view.lastConsumedOccurrence,
    lease: view.lease,
    jitter_offset_ms: view.jitterOffsetMs,
    fired_at: view.firedAt,
    missed_at: view.missedAt,
  };
}

// ── Task reads/writes on the frozen view ────────────────────────────

/** All tasks as the frozen view, regardless of status. */
export function listScheduleTasks(): ScheduleTaskV2[] {
  return readScheduleFile().tasks.map(toScheduleTaskV2);
}

export function getScheduleTask(taskId: string): ScheduleTaskV2 | null {
  const record = readScheduleFile().tasks.find((task) => task.id === taskId);
  return record ? toScheduleTaskV2(record) : null;
}

/**
 * Read-modify-write one task through the frozen view.
 *
 * Callers that need atomicity must already hold the advisory lock — this does
 * not acquire it (see `cron-lease.ts`'s `withLock`).
 */
export function updateScheduleTask(
  taskId: string,
  updater: (task: ScheduleTaskV2) => void,
): ScheduleTaskV2 | null {
  const data = readScheduleFile();
  const index = data.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) return null;
  const base = data.tasks[index];
  if (!base) return null;
  const view = toScheduleTaskV2(base);
  updater(view);
  const next = applyScheduleTaskV2(base, view);
  data.tasks[index] = next;
  writeScheduleFile(data);
  return { ...view };
}

/** Keep the exported reason guard next to the enum it validates. */
export function isCronRunReason(value: string | null): value is CronRunReason {
  return value !== null && RUN_REASONS.has(value);
}
