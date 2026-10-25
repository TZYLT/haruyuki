/**
 * Renderers and exit-code mapping for `haruyuki export` / `haruyuki import`.
 *
 * Signatures are frozen at M0; the bodies land at M4 together with the CLI shell.
 * Keeping all three in one module is what makes the `--json` shape and the exit
 * codes a single reviewable contract instead of something each code path
 * re-invents.
 *
 * Two rules the renderers must never break:
 *   - secret VALUES are never printed, in any channel, not even with --verbose;
 *     only the name and the store the value belongs to appear;
 *   - there is no progress bar and no timer here. The stage lines come from the
 *     pipeline's progress callback; these functions render a finished report.
 */

import type {
  SnapshotCounts,
  SnapshotEntry,
  SnapshotErrorCode,
  SnapshotReport,
  SnapshotScope,
} from "./types";

/**
 * Exit codes from the requirement doc §5.11.4.
 *
 * A `Record` keyed by the code union is the point: adding a code to
 * `SnapshotErrorCode` without deciding its exit code is a type error, and no
 * `switch` can silently fall through to the wrong bucket.
 *
 *   0  success
 *   1  runtime failure (io_error, backup_failed, rollback_failed, path_conflict)
 *   2  preflight refusal that retrying cannot fix (confirm_required,
 *      verify_failed, version_unsupported, insufficient_space)
 */
const EXIT_CODES: Record<SnapshotErrorCode, number> = {
  ok: 0,
  confirm_required: 2,
  verify_failed: 2,
  version_unsupported: 2,
  insufficient_space: 2,
  backup_failed: 1,
  io_error: 1,
  rollback_failed: 1,
  path_conflict: 1,
};

/**
 * Map a report code onto the process exit code.
 *
 * Preflight refusals are `2` because retrying cannot help — the user has to
 * change a condition (pass `--yes`, upgrade the program, free disk space).
 * Everything else is a runtime failure at `1`.
 */
export function exitCodeFor(code: SnapshotErrorCode): number {
  return EXIT_CODES[code];
}

/** Scope order used by the verbose entry list: package order, not alphabetical. */
const SCOPE_ORDER: SnapshotScope[] = [
  "home",
  "local-backend",
  "project",
  "secrets",
];

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human byte size with one decimal from KB upward (`12.3 MB`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const label = BYTE_UNITS[unit] ?? "B";
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${label}`;
}

/** Duration with one decimal in seconds (the only timing the report shows). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCounts(counts: SnapshotCounts): string[] {
  return [
    `  files      ${counts.files}`,
    `  bytes      ${formatBytes(counts.bytes)}`,
    `  secrets    ${counts.secrets}`,
  ];
}

/**
 * Per-tree lines for the human summary, in package order.
 *
 * `secrets` is a value count rather than a byte count, so it prints the number
 * alone; the three path trees print `N files / X MB`. Scopes the pipeline did
 * not fill are skipped instead of printed as zero, so an absent tree does not
 * look like an empty one, and a report without `byScope` prints no block at all.
 */
function formatScopeCounts(byScope: SnapshotReport["byScope"]): string[] {
  if (byScope === undefined) return [];
  const lines: string[] = [];
  for (const scope of SCOPE_ORDER) {
    const counts = byScope[scope];
    if (counts === undefined) continue;
    lines.push(
      scope === "secrets"
        ? `    ${scope.padEnd(14)}${counts.files}`
        : `    ${scope.padEnd(14)}${counts.files} files / ${formatBytes(counts.bytes)}`,
    );
  }
  return lines.length === 0 ? [] : ["  by scope:", ...lines];
}

function formatEntry(entry: SnapshotEntry): string {
  return `  ${entry.scope}/${entry.path}  ${formatBytes(entry.bytes)}`;
}

function formatRollback(report: SnapshotReport): string[] {
  const rollback = report.rollback;
  if (!rollback?.attempted) return [];
  const lines = [
    rollback.ok
      ? "Rolled back to the state before this import."
      : "ROLLBACK FAILED: the data may be in a half state.",
  ];
  if (rollback.message) lines.push(`  ${rollback.message}`);
  if (rollback.backupPath) {
    lines.push(`  backup: ${rollback.backupPath}`);
    if (!rollback.ok) {
      lines.push(
        `  manual recovery: haruyuki import --from "${rollback.backupPath}" --yes`,
      );
    }
  }
  return lines;
}

/**
 * Human-readable rendering: progress stage lines plus a summary.
 *
 * The stage lines themselves are printed by the CLI as the pipeline reports
 * them (§5.13.4: no progress bar, no timer); this renders the summary that
 * follows them, including the entry list when the report carries one.
 *
 * Detail lists (per-entry lines, remap pairs) render only when the report
 * carries `entries`, which the pipeline fills for `--verbose` alone.
 *
 * Never prints secret values — secret names only, even with `--verbose`.
 */
export function toHuman(report: SnapshotReport): string {
  const command = report.command === "export" ? "Export" : "Import";
  const target = report.command === "export" ? report.out : report.package;
  const where = target ? `: ${target}` : "";
  const verbose = report.entries !== undefined;

  const lines: string[] = [];

  if (report.ok) {
    lines.push(
      report.dryRun
        ? `${command} preview (nothing was written)${where}`
        : `${command} complete${where}`,
    );
  } else {
    lines.push(`${command} failed (${report.code})${where}`);
  }
  lines.push(`  ${report.message}`);

  lines.push(...formatScopeCounts(report.byScope));
  lines.push(...formatCounts(report.counts));
  lines.push(`  duration   ${formatDuration(report.durationMs)}`);

  if (report.command === "import") {
    lines.push(`  remapped   ${report.remapped.length} path(s)`);
    lines.push(
      `  untouched  ${report.notRemapped.length} path-shaped field(s)`,
    );
    if (report.backupPath) lines.push(`  backup     ${report.backupPath}`);
  }

  if (report.excluded.length > 0) {
    lines.push(`  excluded   ${report.excluded.length} rule(s)`);
  }

  const entries = report.entries;
  if (entries) {
    lines.push("", "Entries:");
    const ordered = [...entries].sort(
      (left, right) =>
        SCOPE_ORDER.indexOf(left.scope) - SCOPE_ORDER.indexOf(right.scope) ||
        left.path.localeCompare(right.path),
    );
    for (const entry of ordered) lines.push(formatEntry(entry));
  }

  if (verbose && report.remapped.length > 0) {
    lines.push("", "Rewritten:");
    for (const remap of report.remapped) {
      lines.push(`  ${remap.field}: ${remap.from} -> ${remap.to}`);
    }
  }

  if (verbose && report.notRemapped.length > 0) {
    lines.push("", "Deliberately not rewritten:");
    for (const item of report.notRemapped) {
      lines.push(`  ${item.field}: ${item.reason}`);
    }
  }

  if (report.dryRun && report.excluded.length > 0) {
    lines.push("", "Excluded:");
    for (const exclusion of report.excluded) {
      lines.push(`  ${exclusion.path} — ${exclusion.reason}`);
    }
  }

  if (report.excluded.length > 0 && !report.dryRun && !verbose) {
    lines.push("", "Run again with --dry-run to see the excluded paths.");
  }

  const rollback = formatRollback(report);
  if (rollback.length > 0) lines.push("", ...rollback);

  if (report.failedSecrets.length > 0) {
    lines.push("", "Secrets that could not be written back (names only):");
    for (const failure of report.failedSecrets) {
      lines.push(`  [${failure.scope}] ${failure.name}: ${failure.reason}`);
    }
  }

  if (report.migrations && report.migrations.length > 0) {
    lines.push("", "Migrations applied:");
    for (const step of report.migrations) lines.push(`  ${step}`);
  }

  if (report.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }

  return lines.join("\n");
}

/**
 * Machine-readable rendering: exactly one JSON object.
 *
 * Keys follow the requirement doc's `--json` contract (§5.13.2), which is why
 * the multi-word report fields are mapped here:
 *   notRemapped   -> not_remapped
 *   failedSecrets -> failed_secrets
 *   byScope       -> by_scope
 *   dryRun        -> dry_run
 *   durationMs    -> duration_ms
 *   backupPath    -> backup_path
 * `entries` is present only when the invocation was verbose; `by_scope`,
 * `rollback` and `migrations` are additive and appear only when present.
 */
export function toJson(report: SnapshotReport): string {
  const payload: Record<string, unknown> = {
    ok: report.ok,
    code: report.code,
    message: report.message,
  };
  if (report.out !== undefined) payload.out = report.out;
  if (report.package !== undefined) payload.package = report.package;
  payload.dry_run = report.dryRun;
  payload.counts = report.counts;
  if (report.byScope !== undefined) payload.by_scope = report.byScope;
  payload.excluded = report.excluded;
  payload.remapped = report.remapped;
  payload.not_remapped = report.notRemapped;
  payload.failed_secrets = report.failedSecrets;
  payload.warnings = report.warnings;
  if (report.backupPath !== undefined) payload.backup_path = report.backupPath;
  payload.duration_ms = report.durationMs;
  if (report.entries !== undefined) payload.entries = report.entries;
  if (report.rollback !== undefined) payload.rollback = report.rollback;
  if (report.migrations !== undefined && report.migrations.length > 0) {
    payload.migrations = report.migrations;
  }
  return JSON.stringify(payload, null, 2);
}
