/**
 * Import pipeline: the 13 fixed steps from the requirement doc (§5.8), plus the
 * rollback that restores the pre-import backup if anything fails after the
 * landing step.
 *
 * M0 holds the shape only; M6 fills the body. Each step stays its own function
 * so a failure names the step that failed and the rollback can be reasoned
 * about without reading the whole pipeline.
 *
 * Validation runs BEFORE the confirmation word on purpose: the user should see
 * whether the package is intact and what will be overwritten before typing
 * `overwrite`, not after a failed verification.
 */

import type {
  SnapshotCliDeps,
  SnapshotCounts,
  SnapshotExclusion,
  SnapshotProgressHandler,
  SnapshotReport,
  SnapshotRoots,
} from "./types";

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
 * Run an import and return its report.
 *
 * After the landing step, any failure restores `backups/pre-import.hryk` through
 * this same pipeline (no confirmation). A failed restore reports
 * `rollback_failed`, keeps the backup, and prints its absolute path plus the
 * manual recovery command.
 */
export async function runImport(
  opts: ImportOptions,
  onProgress?: SnapshotProgressHandler,
): Promise<SnapshotReport> {
  void opts;
  void onProgress;
  throw new Error("snapshot/import.runImport: implemented at M6");
}
