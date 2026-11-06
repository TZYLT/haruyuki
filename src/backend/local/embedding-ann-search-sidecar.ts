/**
 * Persisted ANN sidecars for the vector-recall index (feature 48, package A6).
 *
 * One sidecar per `(agentId, spaceId)` shard, below
 * `<recall root>/<agentId>/<spaceId>/_ann/` (the `_ann` segment cannot collide
 * with a B2 unit key: B2's safe-segment rule requires an alphanumeric first
 * character). It holds two files:
 *
 * - `<signature>.hann` — B7's `serialize()` bytes, the auxiliary index only;
 *   vectors stay in B2.
 * - `current.json` — an atomically renamed manifest binding those bytes to the
 *   exact B2 unit generations they were built from (`generation` + `checksum`
 *   + counts). A manifest that no longer matches the live generations is
 *   `stale`, never remapped.
 *
 * `writeAnnShardSidecar` is the only writer (the build-side seam A3 will call);
 * the query path only reads. Reads are cached by `current.json`'s stat
 * signature, so a warm query is one `stat` per shard. Nothing here throws for
 * expected conditions: missing/corrupt/stale/dimension-mismatch come back as a
 * typed {@link AnnSearchDegradedReason}.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "@/utils/type-guards";
import {
  type AnnIndex,
  type AnnIndexKind,
  type AnnIvfOptionOverrides,
  buildAnnIndex,
  deserializeAnnIndex,
} from "./embedding-ann-index";
import {
  type AnnInt8UnitRows,
  buildAnnInt8Index,
  deserializeAnnInt8Index,
} from "./embedding-ann-int8";
import {
  type AnnSearchDegradedReason,
  type AnnSearchSpace,
  type AnnSearchUnit,
  type AnnSearchUnitSource,
  compareText,
  errorMessage,
  isNonNegativeInteger,
  isPositiveInteger,
  unitIdentityKey,
  unitKeyOf,
} from "./embedding-ann-search-shared";
import {
  type FlatLoadedUnit,
  isFlatUnit,
  isQuantUnit,
  type LoadedShard,
  type LoadedUnit,
  type LoadedUnitSnapshot,
  loadShard,
  resolveUnitSource,
  unitSnapshotQuant,
} from "./embedding-ann-search-units";
import type { EmbeddingIndexExpectation } from "./embedding-cache";
import {
  type EmbeddingChunkRecord,
  type EmbeddingIndexQuant,
  getRecallVectorsRoot,
} from "./embedding-format";

/** Sidecar location and file names, below `<root>/<agentId>/<spaceId>/`. */
export const ANN_SEARCH_SIDECAR_DIR_NAME = "_ann";
export const ANN_SEARCH_MANIFEST_FILE_NAME = "current.json";
export const ANN_SEARCH_INDEX_FILE_SUFFIX = ".hann";
export const ANN_SEARCH_MANIFEST_VERSION = 1;

/** Bound on resident deserialized shard indexes (each holds its vectors). */
export const ANN_SEARCH_SIDECAR_CACHE_MAX_ENTRIES = 16;

export type AnnSidecarUnit = {
  kind: "transcript" | "memory";
  /** Transcript `conversationKey` or memory `memoryFileKey`. */
  key: string;
  generation: string;
  checksum: string;
  chunkCount: number;
  dimensions: number;
};

/** The `current.json` payload binding one serialized index to generations. */
export type AnnShardSidecarManifest = {
  version: number;
  agentId: string;
  spaceId: string;
  /** Hash over the sorted unit identities; the index file is named after it. */
  signature: string;
  dimensions: number;
  chunkCount: number;
  /** Concatenation order of the index's chunk ids. */
  units: readonly AnnSidecarUnit[];
  indexBytes: number;
  kind: AnnIndexKind;
  /** Encoding of the vector data the index was built from. */
  quant: EmbeddingIndexQuant;
  params: Readonly<Record<string, number>>;
  createdAt: string;
};

export type AnnSidecarWriteProblem =
  | "invalid-space"
  | "no-units"
  | "unit-unavailable"
  | "dimension-mismatch"
  | "empty"
  | "write-failed";

export type WriteAnnShardSidecarOptions = {
  space: AnnSearchSpace;
  units: AnnSearchUnitSource;
  root?: string;
  expectation?: EmbeddingIndexExpectation;
  /** Scope forwarded to a unit callback (hosts that list units per scope). */
  scope?: unknown;
  /** B6 IVF parameter overrides (tests pin `nprobe` for exact recall). */
  ivf?: AnnIvfOptionOverrides;
};

export type WriteAnnShardSidecarResult =
  | {
      ok: true;
      /** False when an identical content-addressed sidecar already existed. */
      wrote: boolean;
      manifest: AnnShardSidecarManifest;
      /** Sidecar directory, e.g. `<root>/<agent>/<space>/_ann`. */
      dir: string;
      /** Absolute path of the serialized B7 index. */
      indexPath: string;
    }
  | { ok: false; problem: AnnSidecarWriteProblem; detail?: string };
function flatEntries(entries: readonly LoadedUnit[]): FlatLoadedUnit[] {
  const flat: FlatLoadedUnit[] = [];
  for (const entry of entries) if (isFlatUnit(entry)) flat.push(entry);
  return flat;
}

/** The int8 row arrays `buildAnnInt8Index` / `deserializeAnnInt8Index` take. */
function int8UnitRows(entries: readonly LoadedUnit[]): AnnInt8UnitRows[] {
  const rows: AnnInt8UnitRows[] = [];
  for (const entry of entries) {
    if (!isQuantUnit(entry)) continue;
    rows.push({
      codes: entry.snapshot.codes,
      scales: entry.snapshot.scales,
      count: entry.snapshot.meta.chunkCount,
    });
  }
  return rows;
}

export type Signature = { size: number; mtimeMs: number; ctimeMs: number };

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

let tempCounter = 0;

export function nextTempName(): string {
  tempCounter += 1;
  return `.tmp-${process.pid.toString(36)}-${tempCounter.toString(36)}`;
}

export function isSafeSegment(segment: string): boolean {
  return (
    typeof segment === "string" &&
    SAFE_SEGMENT.test(segment) &&
    segment !== "." &&
    segment !== ".."
  );
}
export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function pointerSignature(stats: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): Signature {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

export function sameSignature(left: Signature, right: Signature): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
export function assertSpace(space: AnnSearchSpace): void {
  if (!isSafeSegment(space.agentId) || !isSafeSegment(space.spaceId)) {
    throw new RangeError(
      `ANN search space is not a safe path pair: ${JSON.stringify(space)}`,
    );
  }
}

/** `<root>/<agentId>/<spaceId>/_ann` (root defaults to the harness home). */
export function annShardSidecarDir(
  space: AnnSearchSpace,
  options: { root?: string } = {},
): string {
  assertSpace(space);
  const root = options.root ?? getRecallVectorsRoot();
  return join(root, space.agentId, space.spaceId, ANN_SEARCH_SIDECAR_DIR_NAME);
}

export function annShardManifestPath(dir: string): string {
  return join(dir, ANN_SEARCH_MANIFEST_FILE_NAME);
}

export function annShardIndexPath(dir: string, signature: string): string {
  return join(dir, `${signature}${ANN_SEARCH_INDEX_FILE_SUFFIX}`);
}

export function sidecarUnitOf(
  unit: AnnSearchUnit,
  snapshot: LoadedUnitSnapshot,
): AnnSidecarUnit {
  return {
    kind: unit.kind,
    key: unitKeyOf(unit),
    generation: snapshot.generation,
    checksum: snapshot.meta.checksum,
    chunkCount: snapshot.meta.chunkCount,
    dimensions: snapshot.meta.dimensions,
  };
}

export function canonicalUnits(units: readonly AnnSidecarUnit[]): string {
  return JSON.stringify(
    [...units]
      .sort(
        (left, right) =>
          compareText(left.kind, right.kind) ||
          compareText(left.key, right.key),
      )
      .map((unit) => [
        unit.kind,
        unit.key,
        unit.generation,
        unit.checksum,
        unit.chunkCount,
        unit.dimensions,
      ]),
  );
}

/** Content-addressed identity of one shard's unit generations. */
export function sidecarSignature(units: readonly AnnSidecarUnit[]): string {
  return createHash("sha256")
    .update(canonicalUnits(units))
    .digest("hex")
    .slice(0, 16);
}
export function parseManifestUnits(
  value: unknown,
): AnnSidecarUnit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const units: AnnSidecarUnit[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (entry.kind !== "transcript" && entry.kind !== "memory")
      return undefined;
    if (
      typeof entry.key !== "string" ||
      entry.key.length === 0 ||
      typeof entry.generation !== "string" ||
      entry.generation.length === 0 ||
      typeof entry.checksum !== "string" ||
      entry.checksum.length === 0 ||
      !isNonNegativeInteger(entry.chunkCount) ||
      !isPositiveInteger(entry.dimensions)
    ) {
      return undefined;
    }
    units.push({
      kind: entry.kind,
      key: entry.key,
      generation: entry.generation,
      checksum: entry.checksum,
      chunkCount: entry.chunkCount,
      dimensions: entry.dimensions,
    });
  }
  return units;
}

export function parseManifest(
  value: unknown,
): AnnShardSidecarManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== ANN_SEARCH_MANIFEST_VERSION ||
    typeof value.agentId !== "string" ||
    typeof value.spaceId !== "string" ||
    typeof value.signature !== "string" ||
    value.signature.length === 0 ||
    !isPositiveInteger(value.dimensions) ||
    !isNonNegativeInteger(value.chunkCount) ||
    !isNonNegativeInteger(value.indexBytes) ||
    (value.kind !== "ivf" && value.kind !== "flat") ||
    (value.quant !== undefined &&
      value.quant !== "f32" &&
      value.quant !== "int8") ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.params)
  ) {
    return undefined;
  }
  const units = parseManifestUnits(value.units);
  if (units === undefined) return undefined;
  const params: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value.params)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return undefined;
    params[key] = entry;
  }
  if (
    units.reduce((total, unit) => total + unit.chunkCount, 0) !==
    value.chunkCount
  ) {
    return undefined;
  }
  return {
    version: value.version,
    agentId: value.agentId,
    spaceId: value.spaceId,
    signature: value.signature,
    dimensions: value.dimensions,
    chunkCount: value.chunkCount,
    units,
    indexBytes: value.indexBytes,
    kind: value.kind,
    // Manifests written before int8 ANN existed are float32.
    quant: value.quant === "int8" ? "int8" : "f32",
    params,
    createdAt: value.createdAt,
  };
}

export type ManifestReadResult =
  | { ok: true; manifest: AnnShardSidecarManifest }
  | { ok: false; problem: "missing" | "corrupt"; detail?: string };

export function readManifestFile(path: string): ManifestReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return isMissingFileError(error)
      ? { ok: false, problem: "missing" }
      : { ok: false, problem: "corrupt", detail: errorMessage(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, problem: "corrupt", detail: errorMessage(error) };
  }
  const manifest = parseManifest(parsed);
  if (manifest === undefined) {
    return {
      ok: false,
      problem: "corrupt",
      detail: "invalid sidecar manifest",
    };
  }
  return { ok: true, manifest };
}

export function writeFileAtomically(
  path: string,
  data: Uint8Array | string,
): void {
  const temporary = join(dirname(path), nextTempName());
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone; report the original error.
    }
    throw error;
  }
}
export type SidecarReadResult =
  | { ok: true; manifest: AnnShardSidecarManifest; index: AnnIndex }
  | { ok: false; problem: AnnSearchDegradedReason; detail?: string };

export type SidecarCacheEntry = {
  signature: Signature;
  result: SidecarReadResult;
};

export type SidecarCache = Map<string, SidecarCacheEntry>;

export function cacheSidecar(
  cache: SidecarCache,
  dir: string,
  signature: Signature,
  result: SidecarReadResult,
): SidecarReadResult {
  cache.delete(dir);
  cache.set(dir, { signature, result });
  while (cache.size > ANN_SEARCH_SIDECAR_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return result;
}

/** Entries re-ordered to the manifest's chunk-id order. */
export function orderedEntries(
  loaded: LoadedShard,
  manifest: AnnShardSidecarManifest,
): LoadedUnit[] | undefined {
  const byKey = new Map<string, LoadedUnit>();
  for (const entry of loaded.entries) {
    byKey.set(
      unitIdentityKey({ kind: entry.unit.kind, key: entry.key }),
      entry,
    );
  }
  const ordered: LoadedUnit[] = [];
  for (const unit of manifest.units) {
    const entry = byKey.get(
      unitIdentityKey({ kind: unit.kind, key: unit.key }),
    );
    if (entry === undefined) return undefined;
    ordered.push(entry);
  }
  return ordered;
}

/** Concatenates B2 float32 vectors/records in manifest order (cold path only). */
export function concatShard(
  entries: readonly FlatLoadedUnit[],
  dimensions: number,
): { vectors: Float32Array; records: EmbeddingChunkRecord[] } {
  const count = entries.reduce(
    (total, entry) => total + entry.snapshot.meta.chunkCount,
    0,
  );
  const vectors = new Float32Array(count * dimensions);
  const records: EmbeddingChunkRecord[] = [];
  let row = 0;
  for (const entry of entries) {
    vectors.set(entry.snapshot.vectors, row * dimensions);
    records.push(...entry.snapshot.records);
    row += entry.snapshot.meta.chunkCount;
  }
  return { vectors, records };
}

/**
 * Reads one shard's sidecar, reusing the deserialized index while
 * `current.json`'s stat signature is unchanged. The manifest's unit list is
 * checked against the live B2 generations; a mismatch is `stale`, never
 * remapped.
 */
export function readShardSidecar(
  loaded: LoadedShard,
  dir: string,
  cache: SidecarCache,
): SidecarReadResult {
  const manifestPath = annShardManifestPath(dir);
  let signature: Signature;
  try {
    signature = pointerSignature(statSync(manifestPath));
  } catch (error) {
    cache.delete(dir);
    return isMissingFileError(error)
      ? {
          ok: false,
          problem: "sidecar-missing",
          detail: `no readable ${ANN_SEARCH_MANIFEST_FILE_NAME} for ${loaded.agentId}/${loaded.spaceId}`,
        }
      : {
          ok: false,
          problem: "sidecar-corrupt",
          detail: errorMessage(error),
        };
  }
  const cached = cache.get(dir);
  if (cached !== undefined && sameSignature(cached.signature, signature)) {
    return cached.result;
  }
  const read = loadSidecar(loaded, dir);
  return cacheSidecar(cache, dir, signature, read);
}

export function loadSidecar(
  loaded: LoadedShard,
  dir: string,
): SidecarReadResult {
  const manifestRead = readManifestFile(annShardManifestPath(dir));
  if (!manifestRead.ok) {
    return manifestRead.problem === "missing"
      ? {
          ok: false,
          problem: "sidecar-missing",
          detail: `${loaded.agentId}/${loaded.spaceId}: manifest disappeared`,
        }
      : {
          ok: false,
          problem: "sidecar-corrupt",
          detail: manifestRead.detail ?? "unreadable manifest",
        };
  }
  const manifest = manifestRead.manifest;
  if (
    manifest.agentId !== loaded.agentId ||
    manifest.spaceId !== loaded.spaceId
  ) {
    return {
      ok: false,
      problem: "sidecar-stale",
      detail: `manifest belongs to ${manifest.agentId}/${manifest.spaceId}`,
    };
  }
  if (
    loaded.dimensions !== undefined &&
    manifest.dimensions !== loaded.dimensions
  ) {
    return {
      ok: false,
      problem: "sidecar-dimension-mismatch",
      detail: `sidecar is ${manifest.dimensions}-d, live space is ${loaded.dimensions}-d`,
    };
  }
  const liveUnits = loaded.entries.map((entry) =>
    sidecarUnitOf(entry.unit, entry.snapshot),
  );
  if (sidecarSignature(liveUnits) !== manifest.signature) {
    return {
      ok: false,
      problem: "sidecar-stale",
      detail: "sidecar was built for different unit generations",
    };
  }
  const ordered = orderedEntries(loaded, manifest);
  if (ordered === undefined) {
    return {
      ok: false,
      problem: "sidecar-stale",
      detail: "sidecar units do not match the live units",
    };
  }
  if (manifest.chunkCount <= 0) {
    return {
      ok: false,
      problem: "sidecar-corrupt",
      detail: "empty sidecar",
    };
  }
  const indexPath = annShardIndexPath(dir, manifest.signature);
  let bytes: Uint8Array;
  try {
    const file = readFileSync(indexPath);
    bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  } catch (error) {
    return isMissingFileError(error)
      ? {
          ok: false,
          problem: "sidecar-missing",
          detail: `index file ${manifest.signature}${ANN_SEARCH_INDEX_FILE_SUFFIX} is gone`,
        }
      : {
          ok: false,
          problem: "sidecar-corrupt",
          detail: errorMessage(error),
        };
  }
  if (bytes.byteLength !== manifest.indexBytes) {
    return {
      ok: false,
      problem: "sidecar-corrupt",
      detail: `index file is ${bytes.byteLength} bytes, manifest says ${manifest.indexBytes}`,
    };
  }
  const first = ordered[0];
  if (first === undefined) {
    return {
      ok: false,
      problem: "sidecar-corrupt",
      detail: "empty sidecar units",
    };
  }
  const liveQuant = unitSnapshotQuant(first);
  if (
    ordered.some((entry) => unitSnapshotQuant(entry) !== liveQuant) ||
    manifest.quant !== liveQuant
  ) {
    return {
      ok: false,
      problem: "sidecar-quant-mismatch",
      detail: `sidecar was built for ${manifest.quant}, live space is ${liveQuant}`,
    };
  }
  const meta = {
    agentId: manifest.agentId,
    spaceId: manifest.spaceId,
    generation: manifest.signature,
  };
  let index: AnnIndex;
  try {
    if (manifest.quant === "int8") {
      index = deserializeAnnInt8Index(bytes, {
        units: int8UnitRows(ordered),
        count: manifest.chunkCount,
        dimensions: manifest.dimensions,
        meta,
      });
    } else {
      const { vectors } = concatShard(
        flatEntries(ordered),
        manifest.dimensions,
      );
      index = deserializeAnnIndex(bytes, {
        vectors,
        count: manifest.chunkCount,
        dimensions: manifest.dimensions,
        meta,
      });
    }
  } catch (error) {
    return {
      ok: false,
      problem: "sidecar-corrupt",
      detail: errorMessage(error),
    };
  }
  return { ok: true, manifest, index };
}
export type SidecarWriteFailure = Extract<
  WriteAnnShardSidecarResult,
  { ok: false }
>;

export function failWrite(
  problem: AnnSidecarWriteProblem,
  detail?: string,
): SidecarWriteFailure {
  return detail === undefined
    ? { ok: false, problem }
    : { ok: false, problem, detail };
}

/**
 * Builds and persists one shard's ANN sidecar.
 *
 * This is the build-side half of A6 and the only writer of the `_ann` layout;
 * the query path above never writes. It is content-addressed: the signature
 * covers the exact B2 generations (`generation` + `checksum` + counts), so a
 * rebuilt unit yields a new file and the old one is ignored. The manifest is
 * replaced with a single rename, like B2's `current.json`, so a reader never
 * sees a manifest pointing at half-written bytes.
 *
 * Never throws for expected conditions (missing units, mixed dimensions, IO);
 * the caller (A3's runner integration) decides whether that unit gets rebuilt.
 */
export function writeAnnShardSidecar(
  options: WriteAnnShardSidecarOptions,
): WriteAnnShardSidecarResult {
  let space: AnnSearchSpace;
  try {
    assertSpace(options.space);
    space = options.space;
  } catch (error) {
    return failWrite("invalid-space", errorMessage(error));
  }
  const root = options.root ?? getRecallVectorsRoot();
  const units = resolveUnitSource(options.units, options.scope);
  const loaded = loadShard(
    { ...space, units },
    root,
    options.expectation,
    options.scope,
  );
  if (loaded.entries.length === 0) {
    return failWrite(
      "no-units",
      loaded.problems[0] ?? "no units were supplied",
    );
  }
  if (loaded.problems.length > 0) {
    return failWrite("unit-unavailable", loaded.problems[0]);
  }
  if (loaded.chunkCount === 0)
    return failWrite("empty", "the shard has no chunks");
  if (loaded.dimensions === undefined) {
    return failWrite(
      "dimension-mismatch",
      "the shard's units do not share one vector width",
    );
  }
  const ordered = [...loaded.entries].sort(
    (left, right) =>
      compareText(left.unit.kind, right.unit.kind) ||
      compareText(left.key, right.key),
  );
  const dimensions = loaded.dimensions;
  const first = ordered[0];
  if (first === undefined) return failWrite("no-units", "no ordered units");
  const quant = unitSnapshotQuant(first);
  if (ordered.some((entry) => unitSnapshotQuant(entry) !== quant)) {
    return failWrite(
      "dimension-mismatch",
      "the shard mixes float32 and int8 units",
    );
  }
  const sidecarUnits = ordered.map((entry) =>
    sidecarUnitOf(entry.unit, entry.snapshot),
  );
  const signature = sidecarSignature(sidecarUnits);
  const meta = {
    agentId: space.agentId,
    spaceId: space.spaceId,
    generation: signature,
  };
  let built: AnnIndex;
  try {
    built =
      quant === "int8"
        ? buildAnnInt8Index(
            {
              units: int8UnitRows(ordered),
              count: loaded.chunkCount,
              dimensions,
              meta,
            },
            { ivf: options.ivf },
          )
        : buildAnnIndex(
            {
              vectors: concatShard(flatEntries(ordered), dimensions).vectors,
              count: loaded.chunkCount,
              dimensions,
              meta,
            },
            { ivf: options.ivf },
          );
  } catch (error) {
    return failWrite("write-failed", errorMessage(error));
  }
  const stats = built.stats();
  const dir = annShardSidecarDir(space, { root });
  const indexPath = annShardIndexPath(dir, signature);
  const manifest: AnnShardSidecarManifest = {
    version: ANN_SEARCH_MANIFEST_VERSION,
    agentId: space.agentId,
    spaceId: space.spaceId,
    signature,
    dimensions,
    chunkCount: loaded.chunkCount,
    units: sidecarUnits,
    indexBytes: stats.indexBytes,
    kind: stats.kind,
    quant,
    params: { ...stats.params },
    createdAt: new Date().toISOString(),
  };
  let wrote = true;
  try {
    mkdirSync(dir, { recursive: true });
    let existingBytes = -1;
    try {
      existingBytes = statSync(indexPath).size;
    } catch {
      existingBytes = -1;
    }
    if (existingBytes === stats.indexBytes) {
      wrote = false;
    } else {
      writeFileAtomically(indexPath, built.serialize());
    }
    const existing = readManifestFile(annShardManifestPath(dir));
    if (
      existing.ok &&
      existing.manifest.signature === signature &&
      existing.manifest.indexBytes === stats.indexBytes &&
      existing.manifest.quant === quant
    ) {
      return {
        ok: true,
        wrote: false,
        manifest: existing.manifest,
        dir,
        indexPath,
      };
    }
    writeFileAtomically(
      annShardManifestPath(dir),
      `${JSON.stringify(manifest)}\n`,
    );
  } catch (error) {
    return failWrite("write-failed", errorMessage(error));
  }
  return { ok: true, wrote, manifest, dir, indexPath };
}
