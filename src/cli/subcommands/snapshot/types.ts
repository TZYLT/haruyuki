/**
 * Frozen contracts for F-02: `haruyuki export` / `haruyuki import`.
 *
 * This module is the single frozen surface of the feature. It is written once at
 * M0 and is READ-ONLY for every later milestone: the archive, manifest, scope,
 * secrets, machine-state, remap, export, import and CLI tracks all import from
 * here. A new or changed field fans out to every track at once, so it is a
 * Lead-only change that must be broadcast (see docs/45-2 §4.5 rule 1).
 *
 * Package layout of a `.hryk` (a gzipped tar, written by `src/utils/tar-stream.ts`):
 *
 *   manifest.json     root, written last, covers every entry but itself
 *   home/**           app-home data (resolved through appHomeRoot())
 *   local-backend/**  local backend storage (LETTA_LOCAL_BACKEND_DIR)
 *   project/**        optional, present only when exported with --with-project
 *   secrets.json      settings tokens, per-agent secrets, channel credentials
 *
 * Naming: TypeScript fields are camelCase; `report.ts` maps the multi-word ones
 * to the snake_case keys the `--json` contract promises (`not_remapped`,
 * `failed_secrets`).
 */

/** Fixed literal identifying a snapshot package. */
export const SNAPSHOT_FORMAT = "haruyuki-snapshot";

/**
 * Current manifest schema version. A single integer carries the major version:
 * a package whose value is greater than this one is refused, and the migration
 * chain for older values is empty until v2 exists.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

export type SnapshotCommand = "export" | "import";

/**
 * Where a package entry came from. `project` is the optional third tree;
 * `secrets` covers `secrets.json` only.
 */
export type SnapshotScope = "home" | "local-backend" | "project" | "secrets";

/**
 * Failure classification used by `--json` (`code`) and by the exit-code
 * mapping (0 ok / 1 runtime failure / 2 preflight refusal).
 */
export type SnapshotErrorCode =
  | "ok"
  | "confirm_required"
  | "verify_failed"
  | "version_unsupported"
  | "insufficient_space"
  | "backup_failed"
  | "io_error"
  | "rollback_failed"
  | "path_conflict";

/** Stage names printed as human-readable progress lines. */
export type SnapshotPhase =
  | "prepare"
  | "scan"
  | "pack"
  | "verify"
  | "backup"
  | "clear"
  | "place"
  | "remap"
  | "cleanup"
  | "secrets"
  | "done";

/**
 * Error that carries the report code it maps to. Every snapshot module throws
 * this (never a bare Error) so the CLI can turn a failure into a report, a
 * `--json` code and an exit code without parsing message text.
 */
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/** One-line throw helper: `throw snapshotError("path_conflict", "...")`. */
export function snapshotError(
  code: SnapshotErrorCode,
  message: string,
): SnapshotError {
  return new SnapshotError(code, message);
}

/** One entry in `manifest.json`, and one verified entry in a report. */
export interface SnapshotEntry {
  /** Package-relative path, `/`-separated, no drive letter and no `..`. */
  path: string;
  scope: SnapshotScope;
  bytes: number;
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256: string;
}

/** Absolute source roots captured in the manifest (reporting and remap only). */
export interface SnapshotRoots {
  home: string;
  localBackend: string;
  project?: string;
}

export interface SnapshotCounts {
  files: number;
  bytes: number;
  /** Number of secret values carried in `secrets.json` (never their values). */
  secrets: number;
}

/** An excluded path with the reason it was left out of the package. */
export interface SnapshotExclusion {
  path: string;
  reason: string;
}

/** Root-level `manifest.json`. */
export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  schemaVersion: number;
  /** Exporter version, display only: it never participates in compatibility. */
  appVersion: string;
  createdAt: string;
  /** `${process.platform}-${process.arch}`. */
  platform: string;
  /** Display only: helps a human tell two machines apart. */
  hostname: string;
  roots: SnapshotRoots;
  counts: SnapshotCounts;
  entries: SnapshotEntry[];
  excluded: SnapshotExclusion[];
  warnings: string[];
}

/** One `sessionsByServer` bucket key rewritten during import. */
export interface SnapshotRemap {
  field: string;
  from: string;
  to: string;
}

/** A path-shaped field deliberately left alone, with the reason. */
export interface SnapshotNotRemapped {
  field: string;
  reason: string;
}

/**
 * Which store a failed secret write belongs to. Mirrors the three partitions of
 * `secrets.json`, not `SnapshotScope`.
 */
export type SecretScope = "settings" | "agent" | "channel";

/** A secret write that failed. Carries the NAME only, never the value. */
export interface SnapshotFailedSecret {
  scope: SecretScope;
  name: string;
  reason: string;
}

export interface SnapshotRollback {
  attempted: boolean;
  ok: boolean;
  /** Absolute path of the pre-import backup used for the restore. */
  backupPath?: string;
  message?: string;
}

/**
 * Result of one CLI invocation. `toHuman` / `toJson` in `report.ts` are the only
 * renderers; nothing else formats it.
 */
export interface SnapshotReport {
  ok: boolean;
  code: SnapshotErrorCode;
  command: SnapshotCommand;
  /** One-line human summary; always safe to print (no secret values). */
  message: string;
  /** Export: absolute path of the package that was written (or previewed). */
  out?: string;
  /** Import: absolute path of the package that was read. */
  package?: string;
  dryRun: boolean;
  counts: SnapshotCounts;
  excluded: SnapshotExclusion[];
  remapped: SnapshotRemap[];
  notRemapped: SnapshotNotRemapped[];
  failedSecrets: SnapshotFailedSecret[];
  warnings: string[];
  /** Per-entry list; only filled when `--verbose` was requested. */
  entries?: SnapshotEntry[];
  /** Import: absolute path of `backups/pre-import.hryk` when one was written. */
  backupPath?: string;
  /** Import: present only when a rollback was attempted. */
  rollback?: SnapshotRollback;
  /** Import: migration steps applied, oldest first (empty for schemaVersion 1). */
  migrations?: string[];
  durationMs: number;
}

/**
 * Injectable ambient facts. Every pipeline takes these so tests can pin the
 * home root, the local backend root and the clock instead of touching the real
 * `~/.haruyuki` (docs/31 red line A).
 */
export interface SnapshotCliDeps {
  /** Overrides `appHomeRoot()` for this invocation. */
  homeRoot?: string;
  /** Overrides the local backend storage root for this invocation. */
  storageDir?: string;
  cwd?: string;
  now?: () => Date;
  hostname?: () => string;
  appVersion?: string;
}

/** A progress line handed to the CLI layer; no percentage, no timers. */
export interface SnapshotProgress {
  phase: SnapshotPhase;
  message: string;
  current?: number;
  total?: number;
}

export type SnapshotProgressHandler = (progress: SnapshotProgress) => void;
