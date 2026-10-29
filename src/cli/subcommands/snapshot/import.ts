/**
 * Import pipeline: the 13 fixed steps from the requirement doc (section 5.8),
 * plus the rollback that restores the pre-import backup if anything fails after
 * the backup is in place.
 *
 * Each step is its own function, and each throw is annotated with the step name,
 * so a failure says which step failed and the rollback can be reasoned about
 * without reading the whole pipeline.
 *
 * Validation runs BEFORE the confirmation word on purpose: the user should see
 * whether the package is intact and what will be overwritten before typing
 * `overwrite`, not after a failed verification. The package is read twice — once
 * to verify every entry, once to place it — because the archive reader is a
 * stream; the placement pass re-checks each digest, so a package swapped between
 * the two passes cannot land.
 *
 * Machine-state cleanup and hook reinstallation run on the data that is already
 * in place and never trigger a rollback (requirement doc section 5.10.6); a
 * failure there is reported as a warning.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_SUBDIRS } from "@/utils/app-paths";
import type { TarReadEntry } from "@/utils/tar-stream";
import { isTarStreamError, readTarGz } from "@/utils/tar-stream";
import { warnScheduleHostMissing } from "./autostart-warning";
import { PRE_IMPORT_BACKUP_NAME, writePreImportBackup } from "./import-backup";
import {
  assertPackagePathsSafe,
  assertTargetShapes,
  checkFreeDiskSpace,
  clearManagedTrees,
  type ImportTargetRoots,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_SECRETS_PATH,
  type PackageEntry,
  packagePathInRoots,
  packageScopeOf,
  placePackage,
  toSnapshotEntry,
} from "./import-place";
import {
  collectNotRemapped,
  failureReport,
  type RemapSummary,
  restoredReport,
  verifiedReport,
} from "./import-report";
import { retireLegacyCronStore } from "./legacy-store";
import {
  clearCronLease,
  clearGitLocks,
  listMemoryRepoDirs,
  reinstallHooks,
  removePlatformHelpers,
} from "./machine-state";
import { checkVersion, parseManifest, verifyManifest } from "./manifest";
import { remapSettingsBucket } from "./remap";
import {
  DIRECTORY_ENTRY_SHA256,
  literalHomeBase,
  resolveHomeRoots,
  type ScopeRoots,
} from "./scope";
import { applySecrets, type SecretBundle } from "./secrets";
import type {
  SnapshotCliDeps,
  SnapshotCounts,
  SnapshotExclusion,
  SnapshotFailedSecret,
  SnapshotManifest,
  SnapshotProgressHandler,
  SnapshotReport,
  SnapshotRollback,
  SnapshotRoots,
} from "./types";
import { SNAPSHOT_SCHEMA_VERSION, SnapshotError, snapshotError } from "./types";

/** What the CLI layer shows before asking for the `overwrite` confirmation. */
export interface ImportConfirmationDetails {
  packagePath: string;
  /** Target roots this import would write to. */
  roots: SnapshotRoots;
  counts: SnapshotCounts;
  excluded: SnapshotExclusion[];
}

/**
 * Ask for the `overwrite` confirmation. Injected by the CLI shell so the
 * pipeline stays testable; resolves false on a wrong word, EOF or a non-TTY
 * without `--yes`.
 */
export type RequireConfirm = (
  details: ImportConfirmationDetails,
) => Promise<boolean>;

export interface ImportOptions {
  /** Absolute package path to import from. */
  from: string;
  /** Override the target project directory when the package carries one. */
  withProject?: string;
  /** `--verify`: unpack and validate only, write nothing. */
  verify?: boolean;
  /** `--yes`: skip the confirmation word. */
  yes?: boolean;
  verbose?: boolean;
  deps?: SnapshotCliDeps;
  requireConfirm?: RequireConfirm;
}

/**
 * Pipeline-wide flags. `restore` marks the internal re-entry used by the
 * rollback: no confirmation, no second backup, no nested rollback.
 */
interface PipelineFlags {
  restore: boolean;
}

/** Injectable failures for the rollback tests (the CLI never sets a hook). */
export type ImportFaultPoint = "after-place" | "during-restore";

let faultHookForTests: ((point: ImportFaultPoint) => void) | null = null;

/** Test-only: make a chosen step throw, to exercise the rollback paths. */
export function __setImportFaultForTests(
  hook: ((point: ImportFaultPoint) => void) | null,
): void {
  faultHookForTests = hook;
}

function injectFault(point: ImportFaultPoint): void {
  faultHookForTests?.(point);
}

const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const PROGRESS_EVERY = 500;

/** One pass over the archive: verified entries plus the captured metadata. */
interface PackageScan {
  file: string;
  manifestRaw?: string;
  manifestCount: number;
  manifestIndex: number;
  entryCount: number;
  secretsRaw?: string;
  entries: PackageEntry[];
}

interface ResolvedImportRoots {
  roots: ImportTargetRoots;
  scopeRoots: ScopeRoots;
  warnings: string[];
}

// ── errors ──────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Windows compares paths case-insensitively, like its default filesystem. */
function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Normalise anything thrown into the code the report must carry. */
function toSnapshotError(error: unknown): SnapshotError {
  if (error instanceof SnapshotError) return error;
  if (isTarStreamError(error)) return snapshotError(error.code, error.message);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC") {
    return snapshotError("insufficient_space", errorMessage(error));
  }
  return snapshotError("io_error", errorMessage(error));
}

/** Run one pipeline step, naming it in the error it throws. */
async function runStep<T>(step: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const failure = toSnapshotError(error);
    throw snapshotError(failure.code, `${step} failed: ${failure.message}`);
  }
}

// ── step 1: read the package ────────────────────────────────────────

async function hashEntry(
  entry: TarReadEntry,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of entry.open() as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function readTextEntry(
  entry: TarReadEntry,
  limit: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of entry.open() as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > limit) {
      throw snapshotError(
        "verify_failed",
        `${entry.path} is larger than ${limit} bytes`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readPackage(
  file: string,
  onProgress?: SnapshotProgressHandler,
): Promise<PackageScan> {
  const entries: PackageEntry[] = [];
  let manifestRaw: string | undefined;
  let manifestCount = 0;
  let manifestIndex = -1;
  let secretsRaw: string | undefined;
  let position = 0;

  await readTarGz({
    file,
    onEntry: async (readEntry) => {
      position += 1;

      if (readEntry.path === PACKAGE_MANIFEST_PATH) {
        manifestCount += 1;
        manifestIndex = position - 1;
        manifestRaw = await readTextEntry(readEntry, MAX_METADATA_BYTES);
        return;
      }

      const scope = packageScopeOf(readEntry.path);
      if (!scope) {
        throw snapshotError(
          "path_conflict",
          `${file}: entry ${readEntry.path} is outside the fixed package layout`,
        );
      }

      if (readEntry.path === PACKAGE_SECRETS_PATH) {
        const raw = await readTextEntry(readEntry, MAX_METADATA_BYTES);
        const body = Buffer.from(raw, "utf-8");
        secretsRaw = raw;
        entries.push({
          path: readEntry.path,
          scope,
          kind: "file",
          bytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
        return;
      }

      if (readEntry.type === "dir") {
        entries.push({
          path: readEntry.path,
          scope,
          kind: "dir",
          bytes: 0,
          sha256: DIRECTORY_ENTRY_SHA256,
        });
        return;
      }

      const digest = await hashEntry(readEntry);
      entries.push({
        path: readEntry.path,
        scope,
        kind: "file",
        bytes: digest.bytes,
        sha256: digest.sha256,
      });

      if (position % PROGRESS_EVERY === 0) {
        onProgress?.({
          phase: "verify",
          message: "reading the package",
          current: position,
        });
      }
    },
  });

  return {
    file,
    manifestRaw,
    manifestCount,
    manifestIndex,
    entryCount: position,
    secretsRaw,
    entries,
  };
}

// ── step 2: take and parse manifest.json ────────────────────────────

function parsePackageManifest(scan: PackageScan): SnapshotManifest {
  if (scan.manifestCount === 0 || scan.manifestRaw === undefined) {
    throw snapshotError(
      "verify_failed",
      `${scan.file}: manifest.json is missing`,
    );
  }
  if (scan.manifestCount > 1) {
    throw snapshotError(
      "verify_failed",
      `${scan.file}: manifest.json appears ${scan.manifestCount} times; it must appear exactly once, as the last entry`,
    );
  }
  if (scan.manifestIndex !== scan.entryCount - 1) {
    throw snapshotError(
      "verify_failed",
      `${scan.file}: manifest.json is not the last entry (position ${scan.manifestIndex + 1} of ${scan.entryCount})`,
    );
  }
  return parseManifest(scan.manifestRaw);
}

// ── step 3: schema version ──────────────────────────────────────────

function checkPackageVersion(
  manifest: SnapshotManifest,
  file: string,
): string[] {
  const check = checkVersion(manifest, SNAPSHOT_SCHEMA_VERSION);
  if (check.ok) return check.migrations;
  if (manifest.schemaVersion > SNAPSHOT_SCHEMA_VERSION) {
    throw snapshotError(
      "version_unsupported",
      `${file}: the package was written with schemaVersion ${manifest.schemaVersion}, but this program supports ${SNAPSHOT_SCHEMA_VERSION}. Upgrade haruyuki and try again.`,
    );
  }
  throw snapshotError(
    "version_unsupported",
    `${file}: no migration path from schemaVersion ${manifest.schemaVersion} to ${SNAPSHOT_SCHEMA_VERSION}.`,
  );
}

// ── step 4: per-entry integrity ─────────────────────────────────────

function verifyPackageIntegrity(
  manifest: SnapshotManifest,
  scan: PackageScan,
): void {
  const actual = scan.entries.map(toSnapshotEntry);
  const verification = verifyManifest(manifest, actual);
  if (verification.ok) return;
  const first = verification.firstFailure;
  const detail =
    first === undefined
      ? "no detail available"
      : `${first.path} (${first.kind}): expected ${first.expected}, found ${first.actual}`;
  throw snapshotError(
    "verify_failed",
    `${scan.file}: the package does not match its manifest: ${detail}; ${verification.failures} mismatch(es) in total.`,
  );
}

// ── steps 5 and 6: path preflight and target roots ─────────────────

function preflightPackagePaths(scan: PackageScan): void {
  assertPackagePathsSafe(scan.entries);
}

function resolveProjectTarget(
  opts: ImportOptions,
  deps: SnapshotCliDeps,
  scan: PackageScan,
  warnings: string[],
): string | undefined {
  const carriesProject = scan.entries.some(
    (entry) => entry.scope === "project",
  );
  if (!carriesProject) {
    if (opts.withProject !== undefined) {
      warnings.push(
        `${opts.withProject} was given, but the package carries no project data; no project files were restored.`,
      );
    }
    return undefined;
  }
  if (opts.withProject === undefined) {
    warnings.push(
      "the package carries project data, but --with-project was not given; project files were not restored.",
    );
    return undefined;
  }
  return resolve(deps.cwd ?? process.cwd(), opts.withProject);
}

function resolveImportRoots(
  opts: ImportOptions,
  deps: SnapshotCliDeps,
  scan: PackageScan,
): ResolvedImportRoots {
  const scopeRoots = resolveHomeRoots(deps);
  if (scopeRoots.storageDir.trim().length === 0) {
    throw snapshotError(
      "io_error",
      "Cannot resolve the local-backend storage root; set LETTA_LOCAL_BACKEND_DIR or initialize the local backend first.",
    );
  }
  const warnings: string[] = [];
  const project = resolveProjectTarget(opts, deps, scan, warnings);
  const homeLiteral = resolve(literalHomeBase(scopeRoots));
  const home = resolve(scopeRoots.appHome);
  if (homeLiteral !== home) {
    // channels/ and transcripts/ are read from the literal home directory, so a
    // package that carries them must land there even when HARUYUKI_HOME points
    // somewhere else (docs/45-2 section 1 "path mismatch").
    warnings.push(
      `channels/ and transcripts/ are restored to the literal home root ${homeLiteral}, not ${home}, because those directories ignore HARUYUKI_HOME.`,
    );
  }
  const roots: ImportTargetRoots = {
    home,
    homeLiteral,
    localBackend: resolve(scopeRoots.storageDir),
    ...(project === undefined ? {} : { project }),
  };
  return { roots, scopeRoots, warnings };
}

// ── step 7: confirmation ────────────────────────────────────────────

function confirmationDetails(
  packagePath: string,
  roots: ImportTargetRoots,
  manifest: SnapshotManifest,
): ImportConfirmationDetails {
  return {
    packagePath,
    roots: {
      home: roots.home,
      localBackend: roots.localBackend,
      ...(roots.project === undefined ? {} : { project: roots.project }),
    },
    counts: manifest.counts,
    excluded: manifest.excluded,
  };
}

async function requestConfirmation(
  opts: ImportOptions,
  details: ImportConfirmationDetails,
): Promise<boolean> {
  if (opts.yes) return true;
  const confirm = opts.requireConfirm;
  if (!confirm) {
    throw snapshotError(
      "confirm_required",
      "this import needs a confirmation handler; the CLI injects one, and --yes skips it. Nothing was changed.",
    );
  }
  return confirm(details);
}

// ── step 9: machine state (non-fatal) ───────────────────────────────

async function clearMachineState(
  roots: ImportTargetRoots,
  warnings: string[],
): Promise<string[]> {
  try {
    const lease = await clearCronLease(roots.home);
    if (lease.warning) warnings.push(lease.warning);
  } catch (error) {
    warnings.push(
      `the scheduler and task leases in the restored schedule store were not cleared: ${errorMessage(error)}`,
    );
  }

  const repositories = listMemoryRepoDirs(roots.localBackend);
  try {
    await clearGitLocks(repositories);
  } catch (error) {
    warnings.push(`git lock files were not cleared: ${errorMessage(error)}`);
  }
  try {
    await removePlatformHelpers(repositories);
  } catch (error) {
    warnings.push(
      `platform-specific credential helpers were not removed: ${errorMessage(error)}`,
    );
  }
  return repositories;
}

async function reinstallMemoryHooks(
  repositories: ReadonlyArray<string>,
  warnings: string[],
): Promise<void> {
  try {
    const result = await reinstallHooks(repositories);
    for (const repository of result.failed) {
      warnings.push(
        `the memory git hooks could not be reinstalled in ${repository}; memory writes may be rejected by an old hook.`,
      );
    }
  } catch (error) {
    warnings.push(
      `the memory git hooks could not be reinstalled: ${errorMessage(error)}`,
    );
  }
}

// ── step 10: path remapping ─────────────────────────────────────────

async function remapPackagePaths(
  roots: ImportTargetRoots,
  manifest: SnapshotManifest,
): Promise<RemapSummary> {
  const settingsPath = join(roots.home, APP_SUBDIRS.settingsFile);
  if (!existsSync(settingsPath)) {
    return { remapped: [], notRemapped: collectNotRemapped([]) };
  }
  const result = await remapSettingsBucket(
    settingsPath,
    manifest.roots.localBackend,
    roots.localBackend,
  );
  return {
    remapped: result.remapped,
    notRemapped: collectNotRemapped(result.notRemapped),
  };
}

// ── step 12: credentials ────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function nestedStringRecord(
  value: unknown,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!isRecord(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    const record = stringRecord(item);
    if (Object.keys(record).length > 0) out[key] = record;
  }
  return out;
}

function channelRecord(
  value: unknown,
): Record<string, Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, Record<string, string>>> = {};
  if (!isRecord(value)) return out;
  for (const [channelId, accounts] of Object.entries(value)) {
    if (!isRecord(accounts)) continue;
    const accountsOut: Record<string, Record<string, string>> = {};
    for (const [accountId, fields] of Object.entries(accounts)) {
      const record = stringRecord(fields);
      if (Object.keys(record).length > 0) accountsOut[accountId] = record;
    }
    if (Object.keys(accountsOut).length > 0) out[channelId] = accountsOut;
  }
  return out;
}

function parseSecretBundle(
  raw: string | undefined,
  file: string,
): SecretBundle | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw snapshotError(
      "verify_failed",
      `${file}: secrets.json is not valid JSON`,
    );
  }
  if (!isRecord(parsed)) {
    throw snapshotError(
      "verify_failed",
      `${file}: secrets.json is not a JSON object`,
    );
  }
  const meta = isRecord(parsed.meta) ? parsed.meta : {};
  const mode = meta.channelStoreMode === "keyring" ? "keyring" : "file";
  return {
    version: 1,
    settings: stringRecord(parsed.settings),
    agents: nestedStringRecord(parsed.agents),
    channels: channelRecord(parsed.channels),
    meta: {
      channelStoreMode: mode,
      capturedAt:
        typeof meta.capturedAt === "string"
          ? meta.capturedAt
          : new Date().toISOString(),
    },
  };
}

async function writePackageSecrets(
  scan: PackageScan,
  deps: SnapshotCliDeps,
  warnings: string[],
): Promise<{ failed: SnapshotFailedSecret[]; written: number }> {
  const bundle = parseSecretBundle(scan.secretsRaw, scan.file);
  if (bundle === undefined) {
    warnings.push(
      "the package carries no secrets.json; no credentials were written back.",
    );
    return { failed: [], written: 0 };
  }
  const result = await applySecrets(bundle, deps);
  return { failed: result.failed, written: result.written };
}

// ── rollback ────────────────────────────────────────────────────────

async function restoreFromBackup(
  backupPath: string,
  opts: ImportOptions,
): Promise<SnapshotRollback> {
  const rollback: SnapshotRollback = {
    attempted: true,
    ok: false,
    backupPath,
  };
  try {
    injectFault("during-restore");
    const restore = await runPipeline(
      {
        ...opts,
        from: backupPath,
        verify: false,
        yes: true,
        verbose: false,
      },
      undefined,
      { restore: true },
    );
    rollback.ok = restore.ok;
    rollback.message = restore.ok
      ? "the pre-import backup was restored."
      : `${restore.code}: ${restore.message}`;
  } catch (error) {
    rollback.message = `the restore failed: ${errorMessage(error)}`;
  }
  return rollback;
}

async function rollbackAfterFailure(args: {
  backupPath: string | undefined;
  opts: ImportOptions;
  manifest?: SnapshotManifest;
  failure: SnapshotError;
  remap: RemapSummary;
  failedSecrets: SnapshotFailedSecret[];
  warnings: string[];
  migrations: string[];
  durationMs: number;
  packagePath: string;
}): Promise<SnapshotReport> {
  const { backupPath, failure } = args;
  if (backupPath === undefined) {
    return failureReport({
      packagePath: args.packagePath,
      code: failure.code,
      message: `${failure.message} The target held no managed data, so no pre-import backup existed and nothing could be rolled back.`,
      manifest: args.manifest,
      warnings: args.warnings,
      migrations: args.migrations,
      durationMs: args.durationMs,
      remap: args.remap,
      failedSecrets: args.failedSecrets,
      rollback: {
        attempted: false,
        ok: false,
        message:
          "no pre-import backup was written (the target held no managed data)",
      },
    });
  }

  const rollback = await restoreFromBackup(backupPath, args.opts);
  if (rollback.ok) {
    return failureReport({
      packagePath: args.packagePath,
      code: failure.code,
      message: `${failure.message} The data was rolled back to the state before this import.`,
      manifest: args.manifest,
      warnings: args.warnings,
      migrations: args.migrations,
      durationMs: args.durationMs,
      remap: args.remap,
      failedSecrets: args.failedSecrets,
      rollback,
      backupPath,
    });
  }

  const manual = `haruyuki import --from "${backupPath}" --yes`;
  return failureReport({
    packagePath: args.packagePath,
    code: "rollback_failed",
    message: `${failure.message} The rollback also failed, so the data may be in a half state. The backup is kept at ${backupPath}. Recover it manually with: ${manual}`,
    manifest: args.manifest,
    warnings: args.warnings,
    migrations: args.migrations,
    durationMs: args.durationMs,
    remap: args.remap,
    failedSecrets: args.failedSecrets,
    rollback,
    backupPath,
  });
}

// ── pipeline ────────────────────────────────────────────────────────

/**
 * Run an import and return its report.
 *
 * After the backup exists, any failure restores `backups/pre-import.hryk`
 * through this same pipeline (no confirmation, no second backup). A failed
 * restore reports `rollback_failed`, keeps the backup, and puts its absolute
 * path plus the manual recovery command in the message.
 */
export async function runImport(
  opts: ImportOptions,
  onProgress?: SnapshotProgressHandler,
): Promise<SnapshotReport> {
  return runPipeline(opts, onProgress, { restore: false });
}

async function runPipeline(
  opts: ImportOptions,
  onProgress: SnapshotProgressHandler | undefined,
  flags: PipelineFlags,
): Promise<SnapshotReport> {
  const startedAt = Date.now();
  const durationMs = (): number => Date.now() - startedAt;
  const deps = opts.deps ?? {};
  const packagePath = resolve(deps.cwd ?? process.cwd(), opts.from);

  const warnings: string[] = [];
  let manifest: SnapshotManifest | undefined;
  let migrations: string[] = [];
  let backupPath: string | undefined;
  let landed = false;
  let remap: RemapSummary = { remapped: [], notRemapped: [] };
  let failedSecrets: SnapshotFailedSecret[] = [];

  try {
    onProgress?.({
      phase: "prepare",
      message: `reading ${packagePath}`,
    });

    const scanned = await runStep("reading the package", () =>
      readPackage(packagePath, onProgress),
    );

    const parsedManifest = await runStep("reading manifest.json", () =>
      parsePackageManifest(scanned),
    );
    manifest = parsedManifest;

    migrations = await runStep("checking the package version", () =>
      checkPackageVersion(parsedManifest, packagePath),
    );

    await runStep("verifying the package", async () =>
      verifyPackageIntegrity(parsedManifest, scanned),
    );

    await runStep("preflighting the package paths", async () =>
      preflightPackagePaths(scanned),
    );

    const resolved = await runStep("resolving the target roots", async () =>
      resolveImportRoots(opts, deps, scanned),
    );
    warnings.push(...resolved.warnings);

    await runStep("preflighting the target roots", async () =>
      assertTargetShapes(scanned.entries, resolved.roots),
    );

    onProgress?.({
      phase: "verify",
      message: "the package verified",
      current: scanned.entries.length,
      total: scanned.entries.length,
    });

    const details = confirmationDetails(
      packagePath,
      resolved.roots,
      parsedManifest,
    );

    if (opts.verify) {
      return verifiedReport(
        packagePath,
        parsedManifest,
        migrations,
        warnings,
        opts.verbose === true,
        durationMs(),
      );
    }

    if (!flags.restore) {
      const backupTarget = join(
        resolve(resolved.scopeRoots.appHome),
        "backups",
        PRE_IMPORT_BACKUP_NAME,
      );
      const packageIsBackup = samePath(packagePath, backupTarget);

      await runStep("checking the free disk space", () =>
        checkFreeDiskSpace({
          manifest: parsedManifest,
          roots: resolved.roots,
          ...(packageIsBackup ? {} : { backupPath: backupTarget }),
          warnings,
        }),
      );

      const confirmed = await runStep("asking for confirmation", () =>
        requestConfirmation(opts, details),
      );
      if (!confirmed) {
        return failureReport({
          packagePath,
          code: "confirm_required",
          message:
            "Refused: the confirmation word was not given; nothing was changed.",
          manifest: parsedManifest,
          warnings,
          migrations,
          durationMs: durationMs(),
        });
      }

      if (packageIsBackup) {
        // Importing the backup itself is the documented manual recovery command
        // (requirement 5.11.2). Writing a fresh backup over it would destroy the
        // package that is being restored, so the step is skipped on purpose.
        warnings.push(
          "the package is the automatic pre-import backup; no second backup was written, because that would overwrite the package being restored.",
        );
      } else {
        onProgress?.({
          phase: "backup",
          message: "writing backups/pre-import.hryk",
        });
        const backup = await runStep("backing up the current data", () =>
          writePreImportBackup({
            roots: resolved.scopeRoots,
            project: resolved.roots.project,
            deps,
          }),
        );
        warnings.push(...backup.warnings);
        if (backup.written) backupPath = backup.path;
      }
    }

    // From here the data is being replaced: any failure rolls the backup back.
    landed = true;

    onProgress?.({
      phase: "clear",
      message: "clearing the managed trees",
    });
    const packagePaths = new Set(scanned.entries.map((entry) => entry.path));
    // A package stored inside the data it restores must not be cleared away
    // between the verify pass and the placement pass.
    const ownPackagePath = packagePathInRoots(packagePath, resolved.roots);
    if (ownPackagePath !== undefined) packagePaths.add(ownPackagePath);
    await runStep("clearing the managed trees", async () =>
      clearManagedTrees(resolved.roots, packagePaths, onProgress),
    );

    onProgress?.({
      phase: "place",
      message: "restoring the package",
      current: 0,
      total: scanned.entries.length,
    });
    const expected = new Map<string, PackageEntry>(
      scanned.entries.map((entry) => [entry.path, entry]),
    );
    await runStep("placing the package", () =>
      placePackage({
        file: packagePath,
        roots: resolved.roots,
        expected,
        onProgress,
      }),
    );
    // A restored v2 store makes a leftover live crons.json dangerous (M5 #5).
    retireLegacyCronStore(resolved.roots.home, packagePaths, warnings);
    // The fault hook models a failure of the user-facing run only: the internal
    // restore must stay able to finish, or no rollback could ever succeed.
    if (!flags.restore) injectFault("after-place");

    onProgress?.({
      phase: "clear",
      message: "clearing machine-specific state",
    });
    const repositories = await clearMachineState(resolved.roots, warnings);

    onProgress?.({
      phase: "remap",
      message: "rewriting the known path fields",
    });
    remap = await runStep("rewriting the known path fields", () =>
      remapPackagePaths(resolved.roots, parsedManifest),
    );

    onProgress?.({
      phase: "secrets",
      message: "writing the credentials back",
    });
    const secrets = await runStep("writing the credentials back", () =>
      writePackageSecrets(scanned, deps, warnings),
    );
    failedSecrets = secrets.failed;

    await reinstallMemoryHooks(repositories, warnings);

    // R-5.13.5 (M5 #1): say so when the restored tasks have no timer host.
    await warnScheduleHostMissing(
      resolved.roots.home,
      warnings,
      deps.autostartStatus,
    );
    onProgress?.({ phase: "done", message: "import complete" });
    return restoredReport({
      packagePath,
      manifest: parsedManifest,
      migrations,
      warnings,
      remap,
      failedSecrets,
      backupPath,
      verbose: opts.verbose === true,
      durationMs: durationMs(),
    });
  } catch (error) {
    const failure = toSnapshotError(error);
    if (!landed) {
      return failureReport({
        packagePath,
        code: failure.code,
        message: failure.message,
        manifest,
        warnings,
        migrations,
        durationMs: durationMs(),
      });
    }
    return rollbackAfterFailure({
      backupPath,
      opts,
      manifest,
      failure,
      remap,
      failedSecrets,
      warnings,
      migrations,
      durationMs: durationMs(),
      packagePath,
    });
  }
}
