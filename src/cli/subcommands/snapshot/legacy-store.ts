/**
 * The pre-migration schedule store (`crons.json`) is a snapshot edge case.
 *
 * A machine that has not run a schedule command since the upgrade still keeps
 * its tasks in `crons.json`; `schedules.json` does not exist yet. The exporter
 * only walks the v2 include row, so without this module such a package silently
 * ships no tasks at all (M5 #3). The import side has the mirror problem: a
 * leftover `crons.json` on the target would be resurrected by a downgrade, so a
 * v2 restore retires it (M5 #5).
 *
 * Every read here enforces the store version gate (M5 #16): a `schedules.json`
 * written by a newer build is refused instead of parsed, rewritten and packed.
 */

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_FILE_VERSION } from "@/cron/cron-types";
import type { ScopeEntry, ScopeRoots } from "./scope";
import { snapshotError } from "./types";

/** Live pre-migration store; read-only handling only. */
export const LEGACY_CRON_FILE_NAME = "crons.json";
/** Read-only v1 backup the migration writes; a retired live store moves here. */
export const LEGACY_CRON_BACKUP_FILE_NAME = "crons.v1.json";
/** Package path of the v2 store. */
export const PACKAGED_SCHEDULES_PATH = "home/schedules.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuse a store this build does not understand. A missing version is the
 * pre-versioned v1 form, and v1/v2 are accepted; anything else is corruption or
 * a newer build, and neither may be rewritten by a snapshot (M5 #16).
 */
export function assertSnapshotStoreVersion(
  data: Record<string, unknown>,
  fileName: string,
  filePath: string,
): void {
  const version = data.version;
  if (version === undefined) return;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > SCHEDULE_FILE_VERSION
  ) {
    throw snapshotError(
      "io_error",
      `${fileName} has unsupported store version ${JSON.stringify(version)}; refusing to read or overwrite it: ${filePath}`,
    );
  }
}

/** The collected file entry for a package-relative path, when present. */
function findPackagedFile(
  collected: readonly ScopeEntry[],
  path: string,
): ScopeEntry | undefined {
  return collected.find(
    (entry) => entry.path === path && entry.kind === "file",
  );
}

function readManagedJsonObject(entry: ScopeEntry): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(entry.absolutePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw snapshotError(
      "io_error",
      `Cannot read ${entry.path} (${code ?? "read failed"}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw snapshotError(
      "io_error",
      `${entry.path} is not valid JSON; the package would be incomplete.`,
    );
  }
  if (!isRecord(parsed)) {
    throw snapshotError(
      "io_error",
      `${entry.path} is not a JSON object; the package would be incomplete.`,
    );
  }
  return parsed;
}

/**
 * The `home/schedules.json` body that goes into the package: a copy with the
 * scheduler lease and every task lease cleared, the shape the import side
 * writes (docs/44-2 §5.3 A, §5.10.1). `signal_state`, tasks and every other
 * field stay verbatim. A newer store version is refused (M5 #16).
 */
export function preparePackagedSchedules(
  collected: readonly ScopeEntry[],
): Buffer | undefined {
  const entry = findPackagedFile(collected, PACKAGED_SCHEDULES_PATH);
  if (entry === undefined) return undefined;
  const source = readManagedJsonObject(entry);
  assertSnapshotStoreVersion(
    source,
    PACKAGED_SCHEDULES_PATH,
    entry.absolutePath,
  );
  const tasks = Array.isArray(source.tasks)
    ? source.tasks.map((task) =>
        typeof task === "object" && task !== null && !Array.isArray(task)
          ? { ...(task as Record<string, unknown>), lease: null }
          : task,
      )
    : source.tasks;
  const cleared: Record<string, unknown> = {
    ...source,
    scheduler_owner: null,
    scheduler_owners: {},
    tasks,
  };
  return Buffer.from(`${JSON.stringify(cleared, null, 2)}\n`, "utf-8");
}

/**
 * Warn when this machine only has the pre-migration store: the export would
 * otherwise pack zero scheduled tasks with no user-visible hint (M5 #3).
 */
export function warnLegacyCronOnlyExport(
  roots: ScopeRoots,
  collected: readonly ScopeEntry[],
  warnings: string[],
): void {
  if (findPackagedFile(collected, PACKAGED_SCHEDULES_PATH) !== undefined)
    return;
  const legacyPath = join(roots.appHome, LEGACY_CRON_FILE_NAME);
  if (!existsSync(legacyPath)) return;
  warnings.push(
    `this machine has not migrated its schedule store yet: ${PACKAGED_SCHEDULES_PATH} is absent, so the tasks in ${legacyPath} were NOT packed. Run any schedule command (for example \`haruyuki schedule status\`) once to migrate, then export again.`,
  );
}

/**
 * Retire a leftover live `crons.json` after a v2 restore (M5 #5).
 *
 * The restored `schedules.json` is authoritative; the old live store keeps its
 * own `scheduler_owner` and tasks, and a downgrade or a deleted v2 store would
 * resurrect them. Moving it to the read-only v1 name makes it inert, keeps its
 * bytes for recovery, and never overwrites an existing `crons.v1.json`.
 */
export function retireLegacyCronStore(
  home: string,
  packagePaths: ReadonlySet<string>,
  warnings: string[],
): void {
  if (!packagePaths.has(PACKAGED_SCHEDULES_PATH)) return;
  const legacyPath = join(home, LEGACY_CRON_FILE_NAME);
  if (!existsSync(legacyPath)) return;
  const backupPath = join(home, LEGACY_CRON_BACKUP_FILE_NAME);
  const targetPath = existsSync(backupPath)
    ? join(home, `${LEGACY_CRON_FILE_NAME}.restored`)
    : backupPath;
  try {
    rmSync(targetPath, { force: true });
    renameSync(legacyPath, targetPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(
      `the leftover ${legacyPath} could not be moved aside (${detail}); it is inert while ${PACKAGED_SCHEDULES_PATH} exists, but a downgrade could resurrect its tasks.`,
    );
  }
}
