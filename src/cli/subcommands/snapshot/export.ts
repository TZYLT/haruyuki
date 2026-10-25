/**
 * Export pipeline: resolve roots -> collect -> write `.partial` -> append the
 * manifest -> fsync + rename.
 *
 * M0 holds the shape only; M5 fills the body. The archive is written through
 * `writeTarGz` from `@/utils/tar-stream`, which yields bytes and hashes in the
 * same pass, so the manifest is produced by the write that is being verified
 * rather than by a second read of the source tree.
 */

import type {
  SnapshotCliDeps,
  SnapshotProgressHandler,
  SnapshotReport,
} from "./types";

export interface ExportOptions {
  /** Absolute target package path; an existing file is overwritten. */
  out: string;
  /** Absolute project directory to include as the optional `project/` tree. */
  withProject?: string;
  /** Estimate only: no hashing, nothing written, same entry count as a real run. */
  dryRun?: boolean;
  verbose?: boolean;
  deps?: SnapshotCliDeps;
}

/**
 * Run an export and return its report. Failures delete the `.partial` package
 * and report the FIRST unreadable entry plus the total failure count; a partial
 * package is never left behind looking complete.
 */
export async function runExport(
  opts: ExportOptions,
  onProgress?: SnapshotProgressHandler,
): Promise<SnapshotReport> {
  void opts;
  void onProgress;
  throw new Error("snapshot/export.runExport: implemented at M5");
}
