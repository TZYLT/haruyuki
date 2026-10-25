/**
 * Report assembly for the import pipeline.
 *
 * Every field of `SnapshotReport` is filled here, in one place, so the `--json`
 * contract, the human summary and the exit code cannot drift apart between the
 * verify-only path, the restored path and the failure paths (requirement doc
 * section 5.13). Messages never contain secret values — only counts, paths and
 * secret NAMES.
 */

import { formatBytes } from "./report";
import type {
  SnapshotErrorCode,
  SnapshotFailedSecret,
  SnapshotManifest,
  SnapshotNotRemapped,
  SnapshotRemap,
  SnapshotReport,
  SnapshotRollback,
  SnapshotScope,
  SnapshotScopeCount,
} from "./types";

/** One remap pass: what was rewritten and what was deliberately left alone. */
export interface RemapSummary {
  remapped: SnapshotRemap[];
  notRemapped: SnapshotNotRemapped[];
}

/**
 * `sessions.jsonl.project`, transcript/memory text and channel path fields are
 * never rewritten (requirement doc section 5.9.2); they are listed in every
 * import report so the "not remapped" list is a contract, not a leftover.
 */
const KNOWN_UNREWRITTEN: ReadonlyArray<SnapshotNotRemapped> = [
  {
    field: "sessions.jsonl.project",
    reason:
      "the project does not travel inside the package, so a recorded project path is history (requirement 5.9.2)",
  },
  {
    field: "transcript and memory text paths",
    reason:
      "user content is never rewritten by a snapshot restore (requirement 5.9.5)",
  },
  {
    field: "channels configuration paths",
    reason:
      "channel path fields are not among the known structured fields (requirement 5.9.2)",
  },
];

/**
 * The remap module reports `"field (reason)"` strings; split them back into the
 * structured shape the `--json` contract promises, then append the static
 * not-rewritten rows (deduplicated by field).
 */
function splitNotRemapped(value: string): SnapshotNotRemapped {
  const match = /^(.*?) \((.*)\)$/.exec(value);
  if (!match) {
    return {
      field: value,
      reason: "not rewritten: it is not one of the known structured fields",
    };
  }
  return { field: match[1] ?? value, reason: match[2] ?? "" };
}

export function collectNotRemapped(
  entries: ReadonlyArray<string>,
): SnapshotNotRemapped[] {
  const reported = entries.map(splitNotRemapped);
  for (const known of KNOWN_UNREWRITTEN) {
    if (reported.some((item) => item.field === known.field)) continue;
    reported.push(known);
  }
  return reported;
}

function byScopeOf(
  manifest: SnapshotManifest,
): Partial<Record<SnapshotScope, SnapshotScopeCount>> {
  const totals: Partial<Record<SnapshotScope, SnapshotScopeCount>> = {};
  for (const entry of manifest.entries) {
    const bucket = totals[entry.scope] ?? { files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += entry.bytes;
    totals[entry.scope] = bucket;
  }
  // One "file" per carried secret VALUE: the human summary prints the number
  // alone, because credentials have no meaningful byte size here.
  totals.secrets = { files: manifest.counts.secrets, bytes: 0 };
  return totals;
}

function packageWarnings(manifest: SnapshotManifest): string[] {
  return manifest.warnings.map((warning) => `the package reported: ${warning}`);
}

export interface RestoredReportRequest {
  packagePath: string;
  manifest: SnapshotManifest;
  migrations: string[];
  warnings: string[];
  remap: RemapSummary;
  failedSecrets: SnapshotFailedSecret[];
  backupPath?: string;
  verbose: boolean;
  durationMs: number;
}

export function restoredReport(request: RestoredReportRequest): SnapshotReport {
  const { manifest } = request;
  return {
    ok: true,
    code: "ok",
    command: "import",
    message: `Restored ${manifest.counts.files} entries (${formatBytes(manifest.counts.bytes)}) from the package. Restart haruyuki; compiled prompt snapshots and recall indexes rebuild on first use, so the first conversation may be slower.`,
    package: request.packagePath,
    dryRun: false,
    counts: manifest.counts,
    byScope: byScopeOf(manifest),
    excluded: manifest.excluded,
    remapped: request.remap.remapped,
    notRemapped: request.remap.notRemapped,
    failedSecrets: request.failedSecrets,
    warnings: [...packageWarnings(manifest), ...request.warnings],
    ...(request.verbose ? { entries: manifest.entries } : {}),
    ...(request.backupPath === undefined
      ? {}
      : { backupPath: request.backupPath }),
    migrations: request.migrations,
    durationMs: request.durationMs,
  };
}

export function verifiedReport(
  packagePath: string,
  manifest: SnapshotManifest,
  migrations: string[],
  warnings: string[],
  verbose: boolean,
  durationMs: number,
): SnapshotReport {
  return {
    ok: true,
    code: "ok",
    command: "import",
    message: `Package verified: ${manifest.counts.files} entries (${formatBytes(manifest.counts.bytes)}), schema v${manifest.schemaVersion} from ${manifest.platform}. Nothing was written; run the import again without --verify to restore it.`,
    package: packagePath,
    dryRun: false,
    counts: manifest.counts,
    byScope: byScopeOf(manifest),
    excluded: manifest.excluded,
    remapped: [],
    notRemapped: [],
    failedSecrets: [],
    warnings: [...packageWarnings(manifest), ...warnings],
    ...(verbose ? { entries: manifest.entries } : {}),
    migrations,
    durationMs,
  };
}

export interface FailureReportRequest {
  packagePath: string;
  code: SnapshotErrorCode;
  message: string;
  manifest?: SnapshotManifest;
  warnings: string[];
  migrations: string[];
  durationMs: number;
  rollback?: SnapshotRollback;
  remap?: RemapSummary;
  failedSecrets?: SnapshotFailedSecret[];
  backupPath?: string;
}

export function failureReport(request: FailureReportRequest): SnapshotReport {
  const manifest = request.manifest;
  const remap = request.remap;
  return {
    ok: false,
    code: request.code,
    command: "import",
    message: request.message,
    package: request.packagePath,
    dryRun: false,
    counts: manifest?.counts ?? { files: 0, bytes: 0, secrets: 0 },
    byScope: manifest === undefined ? undefined : byScopeOf(manifest),
    excluded: manifest?.excluded ?? [],
    remapped: remap?.remapped ?? [],
    notRemapped: remap?.notRemapped ?? [],
    failedSecrets: request.failedSecrets ?? [],
    warnings: [
      ...(manifest === undefined ? [] : packageWarnings(manifest)),
      ...request.warnings,
    ],
    migrations: request.migrations,
    durationMs: request.durationMs,
    ...(request.backupPath === undefined
      ? {}
      : { backupPath: request.backupPath }),
    ...(request.rollback === undefined ? {} : { rollback: request.rollback }),
  };
}
