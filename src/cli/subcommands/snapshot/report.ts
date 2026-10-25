/**
 * Renderers and exit-code mapping for `haruyuki export` / `haruyuki import`.
 *
 * Signatures are frozen at M0; the bodies land at M4 together with the CLI shell.
 * Keeping all three in one module is what makes the `--json` shape and the exit
 * codes a single reviewable contract instead of something each code path
 * re-invents.
 */

import type { SnapshotErrorCode, SnapshotReport } from "./types";

/**
 * Map a report code onto the process exit code.
 *
 * Preflight refusals are `2` because retrying cannot help — the user has to
 * change a condition (pass `--yes`, upgrade the program, free disk space).
 * Everything else is a runtime failure at `1`.
 */
export function exitCodeFor(code: SnapshotErrorCode): number {
  void code;
  throw new Error("snapshot/report.exitCodeFor: implemented at M4");
}

/**
 * Human-readable rendering: progress stage lines plus a summary.
 *
 * Never prints secret values — secret names only, even with `--verbose`.
 */
export function toHuman(report: SnapshotReport): string {
  void report;
  throw new Error("snapshot/report.toHuman: implemented at M4");
}

/**
 * Machine-readable rendering: exactly one JSON object.
 *
 * Keys follow the requirement doc's `--json` contract, which is why the
 * multi-word report fields are mapped here:
 *   notRemapped   -> not_remapped
 *   failedSecrets -> failed_secrets
 * `entries` is present only when the invocation was verbose.
 */
export function toJson(report: SnapshotReport): string {
  void report;
  throw new Error("snapshot/report.toJson: implemented at M4");
}
