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

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appHomeRoot } from "@/utils/app-paths";
import { withLock } from "./cron-lock";
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

/**
 * `schedules.json` exists but is not a schedule file this build can read
 * (truncated JSON, wrong top level, nonsense version). Every read and write
 * refuses and the bytes on disk are left alone: silently treating it as an
 * empty store is how the first mutation would erase the user's tasks (P0-2).
 */
export class ScheduleStoreCorruptError extends Error {
  readonly filePath: string;
  constructor(filePath: string, detail: string) {
    super(
      `${filePath} is not a valid schedule file (${detail}). It was left untouched: every read and write refuses until the file is repaired or moved aside.`,
    );
    this.name = "ScheduleStoreCorruptError";
    this.filePath = filePath;
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

/**
 * Normalize a parsed store. Unknown top-level fields are preserved (F-17): a
 * build that does not understand a field must not drop it on the next write.
 */
function normalizeScheduleFileData(raw: {
  version?: unknown;
  scheduler_owner?: unknown;
  scheduler_owners?: unknown;
  signal_state?: unknown;
  tasks?: unknown;
}): ScheduleFileData {
  const data: Record<string, unknown> = { ...raw };
  data.version = SCHEDULE_FILE_VERSION;
  data.scheduler_owner = raw.scheduler_owner ?? null;
  data.scheduler_owners =
    raw.scheduler_owners && typeof raw.scheduler_owners === "object"
      ? raw.scheduler_owners
      : {};
  data.signal_state = normalizeSignalState(
    raw.signal_state as SignalState | undefined,
  );
  data.tasks = Array.isArray(raw.tasks)
    ? (raw.tasks as CronTask[]).map(normalizeScheduleTask)
    : [];
  return data as unknown as ScheduleFileData;
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

/**
 * Read the raw store. `null` means "the file does not exist" and nothing else:
 * an unreadable or malformed file throws `ScheduleStoreCorruptError`, because
 * treating it as empty is what lets the next write destroy the store (P0-2).
 */
function readRawScheduleFile(): RawScheduleFile | null {
  const path = getScheduleFilePath();
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    throw new ScheduleStoreCorruptError(path, describeError(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ScheduleStoreCorruptError(
      path,
      `malformed JSON (${describeError(error)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScheduleStoreCorruptError(
      path,
      "the top-level value is not an object",
    );
  }
  return parsed as RawScheduleFile;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate the version marker. A missing version means "pre-versioned file" and
 * is accepted (normalized on the next write); anything that is not a positive
 * integer is corruption, not a silent downgrade (F-16).
 */
function assertReadableVersion(raw: RawScheduleFile): void {
  const version = raw.version;
  if (version === undefined) return;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw new ScheduleStoreCorruptError(
      getScheduleFilePath(),
      `version ${JSON.stringify(version)} is not a positive integer`,
    );
  }
  if (version > SCHEDULE_FILE_VERSION) {
    throw new ScheduleStoreVersionError(version);
  }
}

function assertReadableShape(raw: RawScheduleFile): void {
  const path = getScheduleFilePath();
  if (raw.tasks !== undefined) {
    if (!Array.isArray(raw.tasks)) {
      throw new ScheduleStoreCorruptError(path, "tasks is not an array");
    }
    for (const task of raw.tasks) {
      if (!task || typeof task !== "object" || Array.isArray(task)) {
        throw new ScheduleStoreCorruptError(
          path,
          "tasks contains an entry that is not an object",
        );
      }
    }
  }
  for (const field of [
    "scheduler_owner",
    "scheduler_owners",
    "signal_state",
  ] as const) {
    const value = raw[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "object" || Array.isArray(value))
    ) {
      throw new ScheduleStoreCorruptError(path, `${field} is not an object`);
    }
  }
}

/** Unique per writer: two processes must not share one temp file (P0-3). */
function scheduleTmpPath(path: string): string {
  return `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
}

function fsyncParentDirectory(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Best effort: not every filesystem allows opening a directory.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore.
      }
    }
  }
}

function writeFileDurably(path: string, text: string): void {
  const fd = openSync(path, "w");
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeScheduleFileUnchecked(data: ScheduleFileData): void {
  const path = getScheduleFilePath();
  const dir = getHaruyukiDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = scheduleTmpPath(path);
  try {
    writeFileDurably(
      tmp,
      JSON.stringify({ ...data, version: SCHEDULE_FILE_VERSION }, null, 2),
    );
    renameSync(tmp, path);
    fsyncParentDirectory(dir);
  } finally {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // Best effort: a leftover temp file is inert.
    }
  }
}

// ── Public read / write ─────────────────────────────────────────────

/**
 * Read the live store, migrating `crons.json` on first contact.
 *
 * A corrupt or newer-version file throws instead of reading as empty: returning
 * an empty list would let the next write erase it (P0-2, M-10). A legacy file
 * left beside a valid store means an interrupted migration and is backed up on
 * the read path too (F-05, F-19).
 */
export function readScheduleFile(): ScheduleFileData {
  const raw = readRawScheduleFile();
  if (raw === null) {
    const migrated = migrateLegacyCronFile();
    return migrated ? migrated.data : emptyScheduleFile();
  }
  assertReadableVersion(raw);
  assertReadableShape(raw);
  completeInterruptedMigration();
  return normalizeScheduleFileData(raw);
}

/** Write the live store. Refuses when the file on disk is corrupt or newer. */
export function writeScheduleFile(data: ScheduleFileData): void {
  const raw = readRawScheduleFile();
  if (raw !== null) {
    assertReadableVersion(raw);
  } else if (existsSync(getLegacyCronFilePath())) {
    // Writing here would bury the unmigrated tasks under a fresh store.
    throw new ScheduleStoreMigrationError(
      `${getLegacyCronFilePath()} still needs to be migrated to ${getScheduleFilePath()}. Read the store first (the read migrates it), then retry.`,
    );
  }
  writeScheduleFileUnchecked(data);
}

// ── v1 → v2 migration ───────────────────────────────────────────────

export interface MigrationResult {
  data: ScheduleFileData;
  /** Where the untouched v1 file went. */
  backupPath: string;
  taskCount: number;
}

interface LegacyFileSnapshot {
  path: string;
  text: string;
  raw: RawScheduleFile;
}

function readLegacyFile(): LegacyFileSnapshot | null {
  const path = getLegacyCronFilePath();
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    throw new ScheduleStoreMigrationError(
      `Could not read ${path} (${describeError(error)}). The file was left untouched; fix or move it, then retry.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ScheduleStoreMigrationError(
      `Could not parse ${path}. The file was left untouched; fix or move it, then retry.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScheduleStoreMigrationError(
      `${path} is not a schedule file. The file was left untouched.`,
    );
  }
  const raw = parsed as RawScheduleFile;
  const version = raw.version;
  if (version !== undefined) {
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      throw new ScheduleStoreMigrationError(
        `${path} has version ${JSON.stringify(version)}, not a v1 schedule file. The file was left untouched.`,
      );
    }
    if (version > 1) {
      throw new ScheduleStoreMigrationError(
        `${path} has version ${version}, not a v1 schedule file. The file was left untouched.`,
      );
    }
  }
  if (raw.tasks !== undefined && !Array.isArray(raw.tasks)) {
    throw new ScheduleStoreMigrationError(
      `${path} has a tasks field that is not an array. The file was left untouched.`,
    );
  }
  return { path, text, raw };
}

function legacyData(raw: RawScheduleFile): ScheduleFileData {
  return {
    version: SCHEDULE_FILE_VERSION,
    scheduler_owner:
      (raw.scheduler_owner as ScheduleFileData["scheduler_owner"]) ?? null,
    scheduler_owners:
      raw.scheduler_owners && typeof raw.scheduler_owners === "object"
        ? (raw.scheduler_owners as ScheduleFileData["scheduler_owners"])
        : {},
    signal_state: normalizeSignalState(
      raw.signal_state as SignalState | undefined,
    ),
    tasks: Array.isArray(raw.tasks)
      ? (raw.tasks as CronTask[]).map(normalizeScheduleTask)
      : [],
  };
}

/**
 * Copy the legacy bytes to the read-only `crons.v1.json` backup, verify the
 * copy, and only then remove the legacy file. The previous backup is replaced
 * by a rename after the new copy is durable, so a failure never leaves the
 * machine without a backup (F-06).
 */
function backUpLegacyFile(snapshot: LegacyFileSnapshot): string {
  const backupPath = getCronBackupFilePath();
  const tmp = scheduleTmpPath(backupPath);
  try {
    writeFileDurably(tmp, snapshot.text);
    if (readFileSync(tmp, "utf-8") !== snapshot.text) {
      throw new Error("the backup copy does not match the source bytes");
    }
    renameSync(tmp, backupPath);
    fsyncParentDirectory(getHaruyukiDir());
  } catch (error) {
    throw new ScheduleStoreMigrationError(
      `Could not write the read-only backup ${backupPath} (${describeError(error)}). ${snapshot.path} was left in place; fix the backup path and retry.`,
    );
  } finally {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // Best effort.
    }
  }
  try {
    rmSync(snapshot.path, { force: true });
  } catch {
    // The verified backup exists, so a failed removal only leaves an inert
    // duplicate; the next read retries the completion step.
  }
  return backupPath;
}

/**
 * Migrate under the advisory lock. Crash-safe and idempotent: the v2 store is
 * written first (unique temp + rename), then the backup is created and
 * verified, then the legacy file is removed. A crash at any point leaves the
 * legacy file readable, and the next read completes the backup instead of
 * re-migrating (P0-3).
 */
function migrateLegacyUnderLock(): MigrationResult | null {
  const snapshot = readLegacyFile();
  if (!snapshot) return null;

  if (existsSync(getScheduleFilePath())) {
    // Interrupted migration: the v2 store already won. Only finish the backup;
    // never rewrite a store this build did not write (F-07).
    backUpLegacyFile(snapshot);
    return null;
  }

  const data = legacyData(snapshot.raw);
  writeScheduleFileUnchecked(data);
  const backupPath = backUpLegacyFile(snapshot);
  return {
    data: normalizeScheduleFileData(data),
    backupPath,
    taskCount: data.tasks.length,
  };
}

/**
 * Migrate `crons.json` (version 1) to `schedules.json` (version 2).
 *
 * Returns `null` when there is nothing to migrate. Throws when the legacy file
 * is unreadable, of a newer version, or when the backup cannot be written: a
 * migration that reports success without a backup is a lie.
 */
export function migrateLegacyCronFile(): MigrationResult | null {
  return withLock(migrateLegacyUnderLock);
}

/**
 * Read-path completion of an interrupted migration (F-05, F-19). A valid v2
 * store plus a leftover `crons.json` means the previous migration died between
 * the store write and the rename; finish the backup so the legacy file stops
 * shadowing the store. Best effort here: the v2 store is authoritative and
 * valid, so a backup failure must not make every read throw — the explicit
 * migration API still reports it.
 */
function completeInterruptedMigration(): void {
  if (!existsSync(getLegacyCronFilePath())) return;
  try {
    migrateLegacyCronFile();
  } catch {
    // Surfaced by `migrateLegacyCronFile()`; reads stay available.
  }
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
  // F-18: a value written through the frozen view round-trips; the legacy enum
  // stays the fallback for records that predate it.
  if (task.last_outcome_v2 !== undefined) return task.last_outcome_v2;
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
      task.last_run_reason_v2 ??
      (typeof task.last_run_reason === "string" ? task.last_run_reason : null),
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
    // F-18: the frozen view is writable; persist the fields it owns instead of
    // dropping them on the next read.
    last_outcome_v2: view.lastOutcome,
    last_run_reason_v2: view.lastReason,
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
