/**
 * `manifest.json` construction, parsing, version gating and self-verification.
 *
 * M0 holds signatures only; M2 fills the bodies and the tests. A package is
 * only trusted after `verifyManifest` agrees with an independent pass over the
 * archive, so every check here must report its FIRST failure plus the total
 * failure count rather than streaming every mismatch.
 */

import type {
  SnapshotEntry,
  SnapshotExclusion,
  SnapshotManifest,
  SnapshotRoots,
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
}

/** Which single entry failed verification, and how. */
export interface ManifestFailure {
  path: string;
  kind: "missing" | "extra" | "bytes" | "sha256";
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

/** Assemble a manifest from the entries an export actually wrote. */
export function buildManifest(
  entries: ReadonlyArray<SnapshotEntry>,
  roots: SnapshotRoots,
  opts: BuildManifestOptions,
): SnapshotManifest {
  void entries;
  void roots;
  void opts;
  throw new Error("snapshot/manifest.buildManifest: implemented at M2");
}

/** Stable JSON serialization (fixed key order, trailing newline). */
export function serializeManifest(manifest: SnapshotManifest): string {
  void manifest;
  throw new Error("snapshot/manifest.serializeManifest: implemented at M2");
}

/** Parse and structurally validate `manifest.json`; failure is `verify_failed`. */
export function parseManifest(raw: string): SnapshotManifest {
  void raw;
  throw new Error("snapshot/manifest.parseManifest: implemented at M2");
}

/**
 * Compare a package's schema version with the program's:
 * greater -> unsupported (refuse), smaller -> migrations (empty for v1),
 * equal -> plain ok.
 */
export function checkVersion(
  manifest: SnapshotManifest,
  supportedSchemaVersion: number,
): ManifestVersionCheck {
  void manifest;
  void supportedSchemaVersion;
  throw new Error("snapshot/manifest.checkVersion: implemented at M2");
}

/**
 * Compare the manifest's claims against an independent pass over the archive:
 * entry set, per-entry bytes, per-entry sha256, and `counts`.
 */
export function verifyManifest(
  manifest: SnapshotManifest,
  actual: ReadonlyArray<SnapshotEntry>,
): ManifestVerification {
  void manifest;
  void actual;
  throw new Error("snapshot/manifest.verifyManifest: implemented at M2");
}
