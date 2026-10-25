/**
 * CLI shell for `haruyuki export` / `haruyuki import`.
 *
 * M0 holds the signatures only; M4 fills the bodies and wires the router. This
 * is the only snapshot module the router imports: argument parsing, the
 * confirmation words (`export` / `overwrite`), `--json` selection, human output
 * and the process exit code all live behind these two entry points.
 *
 * Both commands read local data roots, so the router must also list them in
 * `subcommandNeedsEarlyBackendMode`.
 */

import type { SnapshotCliDeps } from "./types";

/**
 * `haruyuki export --out <pkg> [--with-project=<dir>] [--dry-run] [--json]
 * [--verbose] [--yes]`. Returns the process exit code (0 ok / 1 runtime
 * failure / 2 preflight refusal).
 */
export async function runSnapshotExport(
  argv: string[],
  deps?: SnapshotCliDeps,
): Promise<number> {
  void argv;
  void deps;
  throw new Error("snapshot/cli.runSnapshotExport: implemented at M4");
}

/**
 * `haruyuki import --from <pkg> [--with-project=<dir>] [--verify] [--json]
 * [--verbose] [--yes]`. Returns the process exit code.
 */
export async function runSnapshotImport(
  argv: string[],
  deps?: SnapshotCliDeps,
): Promise<number> {
  void argv;
  void deps;
  throw new Error("snapshot/cli.runSnapshotImport: implemented at M4");
}
