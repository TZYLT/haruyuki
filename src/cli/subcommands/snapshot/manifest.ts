/**
 * `manifest.json` construction, parsing, version gating and self-verification.
 *
 * A package is only trusted after `verifyManifest` agrees with an independent
 * pass over the archive, so every check here reports its FIRST failure plus the
 * total failure count rather than streaming every mismatch (docs/44-2 §5.7.4).
 *
 * Counts convention (Lead ruling, M2): `counts.files` is the number of manifest
 * ENTRIES, directory entries included. `SnapshotEntry` carries no `kind`, and a
 * package with an empty directory has to record that directory, so "files" means
 * "entries" in this schema. A directory entry has `bytes: 0` and the SHA-256 of
 * zero bytes (`DIRECTORY_ENTRY_SHA256` in `./scope`).
 */

import { scopeExclusions } from "./scope";
import type {
  SnapshotCounts,
  SnapshotEntry,
  SnapshotExclusion,
  SnapshotManifest,
  SnapshotRoots,
  SnapshotScope,
} from "./types";
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotError,
} from "./types";

/** Ambient facts stamped into a fresh manifest. */
export interface BuildManifestOptions {
  appVersion: string;
  /** ISO timestamp; injected so exports are testable and reproducible. */
  createdAt: string;
  /** `${process.platform}-${process.arch}`. */
  platform: string;
  hostname: string;
  excluded?: SnapshotExclusion[];
  warnings?: string[];
  /** How many secret values `secrets.json` carries; never their names or values. */
  secrets?: number;
}

/** Which single entry failed verification, and how. */
export interface ManifestFailure {
  path: string;
  /**
   * `counts` is the fourth comparison the design calls for: a package whose
   * entry-by-entry data agrees can still claim the wrong totals.
   */
  kind: "missing" | "extra" | "bytes" | "sha256" | "counts";
  expected: string;
  actual: string;
}

export interface ManifestVerification {
  ok: boolean;
  failures: number;
  firstFailure?: ManifestFailure;
}

export interface ManifestVersionCheck {
  ok: boolean;
  /** Migration steps to apply, oldest first. Empty until schema v2 exists. */
  migrations: string[];
}

/** One step of the schema migration chain (empty while v1 is current). */
export interface ManifestMigration {
  from: number;
  to: number;
  description: string;
}

/**
 * Migration chain, oldest first. v1 is the current version, so the chain is
 * empty: an older package cannot exist yet, and a newer one is refused rather
 * than migrated downwards. Add a step here (never mutate one) when v2 lands.
 */
export const MANIFEST_MIGRATIONS: ReadonlyArray<ManifestMigration> = [];

const SNAPSHOT_SCOPES: ReadonlySet<string> = new Set([
  "home",
  "local-backend",
  "project",
  "secrets",
]);

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** Assemble a manifest from the entries an export actually wrote. */
export function buildManifest(
  entries: ReadonlyArray<SnapshotEntry>,
  roots: SnapshotRoots,
  opts: BuildManifestOptions,
): SnapshotManifest {
  const packaged = entries.map((entry) => ({
    path: entry.path,
    scope: entry.scope,
    bytes: entry.bytes,
    sha256: entry.sha256,
  }));
  const counts: SnapshotCounts = {
    files: packaged.length,
    bytes: packaged.reduce((total, entry) => total + entry.bytes, 0),
    secrets: opts.secrets ?? 0,
  };
  return {
    format: SNAPSHOT_FORMAT,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    appVersion: opts.appVersion,
    createdAt: opts.createdAt,
    platform: opts.platform,
    hostname: opts.hostname,
    roots: normalizeRoots(roots),
    counts,
    entries: packaged,
    excluded: opts.excluded ?? scopeExclusions(),
    warnings: opts.warnings ?? [],
  };
}

function normalizeRoots(roots: SnapshotRoots): SnapshotRoots {
  if (roots.project === undefined) {
    return { home: roots.home, localBackend: roots.localBackend };
  }
  return {
    home: roots.home,
    localBackend: roots.localBackend,
    project: roots.project,
  };
}

function orderedManifest(manifest: SnapshotManifest): Record<string, unknown> {
  return {
    format: manifest.format,
    schemaVersion: manifest.schemaVersion,
    appVersion: manifest.appVersion,
    createdAt: manifest.createdAt,
    platform: manifest.platform,
    hostname: manifest.hostname,
    roots: normalizeRoots(manifest.roots),
    counts: {
      files: manifest.counts.files,
      bytes: manifest.counts.bytes,
      secrets: manifest.counts.secrets,
    },
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      scope: entry.scope,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    excluded: manifest.excluded.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    })),
    warnings: [...manifest.warnings],
  };
}

/**
 * Stable JSON serialization (fixed key order, trailing newline).
 *
 * Two exports of the same data must produce byte-identical manifests, so the
 * key order is spelled out here instead of relying on object construction order
 * at the call site.
 */
export function serializeManifest(manifest: SnapshotManifest): string {
  return `${JSON.stringify(orderedManifest(manifest), null, 2)}\n`;
}

function invalid(detail: string): never {
  throw snapshotError("verify_failed", `manifest.json: ${detail}`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`${field} must be a string`);
  return value;
}

function asCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * A package-relative entry path: `/`-separated, no drive letter, no leading
 * slash, no `..`, no empty segment and no trailing slash (a directory entry is
 * named without one; only the tar header carries it).
 */
function asEntryPath(value: unknown, field: string): string {
  const path = asString(value, field);
  if (path.length === 0) invalid(`${field} must not be empty`);
  if (path.startsWith("/")) invalid(`${field} must be relative: ${path}`);
  if (path.includes("\\")) invalid(`${field} must use / separators: ${path}`);
  if (path.endsWith("/"))
    invalid(`${field} must not end with a slash: ${path}`);
  if (/^[A-Za-z]:/.test(path))
    invalid(`${field} must not carry a drive letter: ${path}`);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      invalid(`${field} has an illegal segment: ${path}`);
    }
  }
  return path;
}

function asScope(value: unknown, field: string): SnapshotScope {
  const scope = asString(value, field);
  if (!SNAPSHOT_SCOPES.has(scope))
    invalid(`${field} is not a known scope: ${scope}`);
  return scope as SnapshotScope;
}

function parseEntry(value: unknown, index: number): SnapshotEntry {
  const record = asRecord(value, `entries[${index}]`);
  const sha256 = asString(record.sha256, `entries[${index}].sha256`);
  if (!HEX_SHA256.test(sha256)) {
    invalid(`entries[${index}].sha256 must be lowercase hex: ${sha256}`);
  }
  return {
    path: asEntryPath(record.path, `entries[${index}].path`),
    scope: asScope(record.scope, `entries[${index}].scope`),
    bytes: asCount(record.bytes, `entries[${index}].bytes`),
    sha256,
  };
}

function parseCounts(value: unknown): SnapshotCounts {
  const record = asRecord(value, "counts");
  return {
    files: asCount(record.files, "counts.files"),
    bytes: asCount(record.bytes, "counts.bytes"),
    secrets: asCount(record.secrets, "counts.secrets"),
  };
}

function parseRoots(value: unknown): SnapshotRoots {
  const record = asRecord(value, "roots");
  const roots: SnapshotRoots = {
    home: asString(record.home, "roots.home"),
    localBackend: asString(record.localBackend, "roots.localBackend"),
  };
  if (record.project !== undefined) {
    roots.project = asString(record.project, "roots.project");
  }
  return roots;
}

function parseExclusion(value: unknown, index: number): SnapshotExclusion {
  const record = asRecord(value, `excluded[${index}]`);
  const path = asString(record.path, `excluded[${index}].path`);
  if (path.length === 0) invalid(`excluded[${index}].path must not be empty`);
  return {
    path,
    reason: asString(record.reason, `excluded[${index}].reason`),
  };
}

/** Parse and structurally validate `manifest.json`; failure is `verify_failed`. */
export function parseManifest(raw: string): SnapshotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    invalid(`not valid JSON (${(error as Error).message})`);
  }
  const record = asRecord(parsed, "root");
  const format = asString(record.format, "format");
  if (format !== SNAPSHOT_FORMAT) {
    invalid(`format must be "${SNAPSHOT_FORMAT}", found "${format}"`);
  }
  const schemaVersion = asCount(record.schemaVersion, "schemaVersion");
  if (schemaVersion === 0) invalid("schemaVersion must be >= 1");
  const entries = asArray(record.entries, "entries").map((entry, index) =>
    parseEntry(entry, index),
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) invalid(`duplicate entry path: ${entry.path}`);
    seen.add(entry.path);
  }
  return {
    format: SNAPSHOT_FORMAT,
    schemaVersion,
    appVersion: asString(record.appVersion, "appVersion"),
    createdAt: asString(record.createdAt, "createdAt"),
    platform: asString(record.platform, "platform"),
    hostname: asString(record.hostname, "hostname"),
    roots: parseRoots(record.roots),
    counts: parseCounts(record.counts),
    entries,
    excluded: asArray(record.excluded, "excluded").map((item, index) =>
      parseExclusion(item, index),
    ),
    warnings: asArray(record.warnings, "warnings").map((item, index) =>
      asString(item, `warnings[${index}]`),
    ),
  };
}

/**
 * Compare a package's schema version with the program's:
 * greater -> unsupported (refuse), smaller -> migrations (empty for v1),
 * equal -> plain ok.
 *
 * `appVersion` takes no part: a patch release must not reject another patch
 * release's package (docs/44-2 §5.6.3).
 */
export function checkVersion(
  manifest: SnapshotManifest,
  supportedSchemaVersion: number,
): ManifestVersionCheck {
  const from = manifest.schemaVersion;
  if (!Number.isInteger(from) || from < 1) {
    return { ok: false, migrations: [] };
  }
  if (from > supportedSchemaVersion) {
    return { ok: false, migrations: [] };
  }
  if (from === supportedSchemaVersion) {
    return { ok: true, migrations: [] };
  }
  const migrations: string[] = [];
  let version = from;
  while (version < supportedSchemaVersion) {
    const step = MANIFEST_MIGRATIONS.find(
      (candidate) => candidate.from === version,
    );
    // A gap in the chain means the package cannot be brought forward: refuse it
    // rather than pretend the difference is cosmetic.
    if (!step) return { ok: false, migrations: [] };
    migrations.push(step.description);
    version = step.to;
  }
  return { ok: true, migrations };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Compare the manifest's claims against an independent pass over the archive:
 * entry set, per-entry bytes, per-entry sha256, and `counts`.
 *
 * The first failure is the first claim that disagrees, walking the manifest in
 * package order and then the unexpected entries in byte order; `failures` is
 * the total number of disagreements, including the counts check.
 */
export function verifyManifest(
  manifest: SnapshotManifest,
  actual: ReadonlyArray<SnapshotEntry>,
): ManifestVerification {
  const failures: ManifestFailure[] = [];
  const actualByPath = new Map<string, SnapshotEntry>();
  for (const entry of actual) {
    actualByPath.set(entry.path, entry);
  }
  const claimedPaths = new Set<string>();
  for (const claimed of manifest.entries) {
    claimedPaths.add(claimed.path);
    const found = actualByPath.get(claimed.path);
    if (!found) {
      failures.push({
        path: claimed.path,
        kind: "missing",
        expected: `bytes=${claimed.bytes} sha256=${claimed.sha256}`,
        actual: "missing from the package",
      });
      continue;
    }
    if (found.bytes !== claimed.bytes) {
      failures.push({
        path: claimed.path,
        kind: "bytes",
        expected: String(claimed.bytes),
        actual: String(found.bytes),
      });
    }
    if (found.sha256 !== claimed.sha256) {
      failures.push({
        path: claimed.path,
        kind: "sha256",
        expected: claimed.sha256,
        actual: found.sha256,
      });
    }
  }
  const unexpected = actual
    .filter((entry) => !claimedPaths.has(entry.path))
    .map((entry) => entry.path)
    .sort(compareUtf8);
  for (const path of unexpected) {
    failures.push({
      path,
      kind: "extra",
      expected: "not listed in the manifest",
      actual: "present in the package",
    });
  }
  const actualBytes = actual.reduce((total, entry) => total + entry.bytes, 0);
  if (manifest.counts.files !== actual.length) {
    failures.push({
      path: "counts.files",
      kind: "counts",
      expected: String(manifest.counts.files),
      actual: String(actual.length),
    });
  }
  if (manifest.counts.bytes !== actualBytes) {
    failures.push({
      path: "counts.bytes",
      kind: "counts",
      expected: String(manifest.counts.bytes),
      actual: String(actualBytes),
    });
  }
  if (failures.length === 0) return { ok: true, failures: 0 };
  return { ok: false, failures: failures.length, firstFailure: failures[0] };
}
