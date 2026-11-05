/**
 * Boundary lifecycle for the vector-recall index (feature 48, package B5).
 *
 * The index is a rebuildable derivative of transcripts and memory (48-1 §6.3),
 * so its lifecycle is deletion-first: when a conversation or a memory file goes
 * away, its unit must go away too; when a build dies halfway or a generation is
 * superseded, the leftovers must be collectable without touching live units.
 * Four operations live here, all on top of B2's public API:
 *
 * - `removeEmbeddingUnitIndex` deletes exactly one unit. `current.json` is
 *   invalidated first, then the generations are removed, so a crash mid-way
 *   leaves a unit that readers already treat as missing; the call is idempotent
 *   and a retry finishes the job.
 * - `sweepEmbeddingOrphanGenerations` returns a *preview* of stale generation
 *   directories (and crashed temp directories) under one space. It never
 *   mutates anything. `deleteEmbeddingOrphanGenerations` only accepts that
 *   preview and re-checks every path against the space root, so preview and
 *   delete stay separate (docs/31 §2, B1/B2).
 * - `needsEmbeddingIndexBuild` / `markEmbeddingUnitDirty` answer the fork
 *   question: a fork is not eagerly indexed and never hard-links the source
 *   generation. `markEmbeddingUnitDirty` records intent; it does not schedule a
 *   build. A later generation whose `updatedAt` is not older than the marker
 *   clears the dirty state by itself, so this module never has to rewrite B3.
 * - `summarizeEmbeddingCoverage` rolls B2 metadata + A2 build state into the
 *   numbers the status surface (D6/A5) renders: coverage ratio, missing units
 *   and stale generation count.
 *
 * The space directory is `<recall root>/<agentId>/<spaceId>` as laid out by
 * `embedding-format.ts`; `unitKey` mirrors the part below it, so a conversation
 * is `"<conversationKey>"` and a memory file is `"memory/<fileKey>"`. Every
 * segment is validated before a path is built, and delete never accepts a path
 * that is not inside the space directory.
 *
 * Backup intent (48-1 R-12, 48-2 §4.2): the recall root is `appHomePath([
 * RECALL_VECTORS_DIR_NAME])` and is explicitly excluded from snapshots by
 * `scope.ts`'s `recall-vectors` row. The operator-side `local-ops/backup-state.ps1`
 * needs no code change here; it is recorded in docs/22 S-12 and is not in git.
 *
 * All functions are tolerant: read/preview never throw on a missing or corrupt
 * file, and delete/rebuild helpers return a typed failure instead of a raw
 * exception. The lifecycle never reads vectors to compute a status summary and
 * never decides *when* to build.
 *
 * Layer: `backend/local/`. Imports `node:fs`/`node:path` and same-directory B2
 * public API only; no `cli/`, `websocket/`, `reminders/` or `agent/` imports.
 */

import type { Dirent } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  EMBEDDING_INDEX_FILE_NAMES,
  EMBEDDING_INDEX_FORMAT_VERSION,
  EMBEDDING_MEMORY_DIR_NAME,
  type EmbeddingChunkRecordInput,
  type EmbeddingIndexCoverage,
  type EmbeddingIndexSnapshot,
  type EmbeddingVectorUnit,
  embeddingCurrentPointerPath,
  embeddingGenerationDir,
  readEmbeddingIndex,
  readEmbeddingIndexPointer,
  writeEmbeddingIndex,
} from "./embedding-format";
import { copyQuantUnitIndex } from "./embedding-unit-copy-quant";

/** Marker written by `markEmbeddingUnitDirty` inside the unit directory. */
export const EMBEDDING_UNIT_DIRTY_FILE_NAME = ".dirty.json";

/**
 * Generations kept per unit besides the one `current.json` points at. One
 * previous generation is the useful rollback window for a running build; 48-1
 * §6.3 keeps "the most recent 2" model spaces, not generations, so this is a
 * local choice of the cleaner and `keep` overrides it.
 */
export const EMBEDDING_STALE_GENERATIONS_KEEP = 1;

/** Same segment rule as B2's unit/generation names (`[A-Za-z0-9][A-Za-z0-9._-]*`). */
const SAFE_UNIT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** B2 builds a generation in a dot-prefixed temp directory before renaming. */
const TEMPORARY_DIR_PREFIX = ".";

/** Typed failures; none of these is thrown. */
export type EmbeddingLifecycleProblem =
  | "unsafe-unit-key"
  | "unsafe-preview"
  | "space-mismatch"
  | "source-index-unavailable"
  | "io-error";

export type EmbeddingLifecycleFailure = {
  ok: false;
  problem: EmbeddingLifecycleProblem;
  detail?: string;
};

/** A unit location: the space directory plus the unit key described above. */
export type EmbeddingUnitLocation = { spaceDir: string; unitKey: string };

type ParsedUnitKey =
  | { kind: "conversation"; key: string }
  | { kind: "memory"; key: string };

/** Options for `removeEmbeddingUnitIndex`; the hook exists to pin the order. */
export type RemoveEmbeddingUnitIndexOptions = {
  /**
   * Called after `current.json` was removed and before any generation is
   * deleted. Production code does not need it; a test uses it to prove the
   * invalidation order and a diagnostic caller can log the commit point.
   */
  onPointerInvalidated?: (unitDir: string) => void;
};

export type RemoveEmbeddingUnitIndexResult =
  | {
      ok: true;
      unitDir: string;
      /** True when a `current.json` existed and was removed first. */
      pointerInvalidated: boolean;
      /** Generation directory names removed after the pointer went away. */
      removedGenerations: string[];
      /** Non-fatal leftovers; a retry removes them. */
      warnings: string[];
    }
  | EmbeddingLifecycleFailure;

/** Why a stale path is in the sweep preview. */
export type EmbeddingStaleReason =
  /** A non-current generation beyond the `keep` window. */
  | "beyond-recent"
  /** A generation when the unit has no readable `current.json`. */
  | "orphan-generation"
  /** A crashed build's temp directory; never a committed generation. */
  | "temp-artifact";

export type EmbeddingStaleEntry = {
  /** Unit key relative to the space directory (`memory/<fileKey>` included). */
  unitKey: string;
  /** Directory name inside the unit directory. */
  generation: string;
  /** Absolute path the delete API may remove. */
  path: string;
  reason: EmbeddingStaleReason;
};

/**
 * Read-only list of files a sweep would delete. Passing it to
 * `deleteEmbeddingOrphanGenerations` is the only way to delete: the delete side
 * never enumerates the filesystem on its own.
 */
export type EmbeddingOrphanSweepPreview = {
  spaceDir: string;
  keepPerUnit: number;
  unitsScanned: number;
  generationsScanned: number;
  stale: EmbeddingStaleEntry[];
};

export type EmbeddingOrphanDeleteResult =
  | {
      ok: true;
      /** Absolute paths removed. */
      deleted: string[];
      /** Preview paths skipped because they are no longer stale. */
      skipped: string[];
      /** Per-path cleanup errors; the rest of the preview still ran. */
      warnings: string[];
    }
  | EmbeddingLifecycleFailure;

/** Result of `markEmbeddingUnitDirty`. */
export type MarkEmbeddingUnitDirtyResult =
  | { ok: true; markerPath: string }
  | EmbeddingLifecycleFailure;

/** Result of `copyEmbeddingUnitIndex`. */
export type CopyEmbeddingUnitIndexResult =
  | {
      ok: true;
      sourceGeneration: string;
      /** New generation name written into the target unit. */
      targetGeneration: string;
      targetUnitDir: string;
      records: number;
    }
  | EmbeddingLifecycleFailure;

/**
 * The slice of A2's state the summary reads. `EmbeddingBuildStateRecord` and
 * `EmbeddingBuildStateSnapshot` both satisfy it structurally, which keeps the
 * lifecycle below the build-state module in the dependency graph.
 */
export type EmbeddingCoverageStateInput = {
  coverage?: {
    embeddedChars: number;
    recallableChars: number;
    /** A2's snapshot projection computes it; the record stores raw counts. */
    ratio?: number | null;
  };
  failures?: ReadonlyArray<{ conversationId: string }>;
};

export type EmbeddingCoverageSummary = {
  spaceDir: string;
  /** Unit directories found under the space (conversations + memory files). */
  units: number;
  indexedUnits: number;
  /** `embeddedChars / recallableChars`, 0..1 or `null` when unknown. */
  coverage: number | null;
  /** Count of units with no usable index; `missingUnitKeys` names them. */
  missingUnits: number;
  missingUnitKeys: string[];
  /** Stale generation directories a sweep would list (temp dirs excluded). */
  staleGenerations: number;
};

// ---------------------------------------------------------------------------
// Keys and paths
// ---------------------------------------------------------------------------

function failure(
  problem: EmbeddingLifecycleProblem,
  detail?: string,
): EmbeddingLifecycleFailure {
  return detail === undefined
    ? { ok: false, problem }
    : { ok: false, problem, detail };
}

function isSafeSegment(segment: string): boolean {
  return SAFE_UNIT_SEGMENT.test(segment);
}

function isUsableZeroSegment(name: string): boolean {
  return name !== "." && name !== ".." && isSafeSegment(name);
}

function parseUnitKey(unitKey: string): ParsedUnitKey | undefined {
  const segments = unitKey.replace(/\\/g, "/").split("/");
  if (segments.length === 1) {
    const conversationKey = segments[0];
    if (conversationKey === undefined) return undefined;
    if (conversationKey === EMBEDDING_MEMORY_DIR_NAME) return undefined;
    return isUsableZeroSegment(conversationKey)
      ? { kind: "conversation", key: conversationKey }
      : undefined;
  }
  if (segments.length === 2) {
    const [container, fileKey] = segments;
    if (container !== EMBEDDING_MEMORY_DIR_NAME) return undefined;
    if (fileKey === undefined) return undefined;
    return isUsableZeroSegment(fileKey)
      ? { kind: "memory", key: fileKey }
      : undefined;
  }
  return undefined;
}

/** Absolute unit directory, or `undefined` when the key is not safe. */
function unitDirFor(
  spaceDir: string,
  unitKey: string,
): { unitDir: string; parsed: ParsedUnitKey } | undefined {
  const parsed = parseUnitKey(unitKey);
  if (parsed === undefined) return undefined;
  return {
    unitDir:
      parsed.kind === "memory"
        ? join(spaceDir, EMBEDDING_MEMORY_DIR_NAME, parsed.key)
        : join(spaceDir, parsed.key),
    parsed,
  };
}

function identityOf(
  spaceDir: string,
): { agentId: string; spaceId: string } | undefined {
  const spaceId = basename(spaceDir);
  const agentId = basename(dirname(spaceDir));
  return isSafeSegment(agentId) && isSafeSegment(spaceId)
    ? { agentId, spaceId }
    : undefined;
}

function vectorUnitFor(
  spaceDir: string,
  parsed: ParsedUnitKey,
): EmbeddingVectorUnit | undefined {
  const identity = identityOf(spaceDir);
  if (identity === undefined) return undefined;
  return parsed.kind === "memory"
    ? { ...identity, memoryFileKey: parsed.key }
    : { ...identity, conversationKey: parsed.key };
}

/** True for an existing directory only; symlinks are not followed. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDirectory(path: string): Dirent[] | undefined {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Deletion cascade
// ---------------------------------------------------------------------------

/**
 * Removes one unit's index: `current.json` first, then every generation and
 * leftover temp entry beneath the unit directory.
 *
 * Readers treat a unit without `current.json` as missing, so the window between
 * the two steps degrades to lexical recall instead of exposing a half-deleted
 * generation. The call never throws; a per-generation failure becomes a
 * warning and a retry removes the leftovers, because the pointer is already
 * gone. Other units in the same space are never touched.
 */
export function removeEmbeddingUnitIndex(
  spaceDir: string,
  unitKey: string,
  options: RemoveEmbeddingUnitIndexOptions = {},
): RemoveEmbeddingUnitIndexResult {
  const resolved = unitDirFor(spaceDir, unitKey);
  if (resolved === undefined) {
    return failure(
      "unsafe-unit-key",
      `refusing to remove unit ${JSON.stringify(unitKey)}`,
    );
  }
  const { unitDir } = resolved;
  const pointerPath = embeddingCurrentPointerPath(unitDir);
  let pointerInvalidated = false;
  try {
    if (existsSync(pointerPath)) {
      rmSync(pointerPath, { force: true });
      pointerInvalidated = true;
    }
  } catch (error) {
    // The pointer could not be invalidated, so the unit still looks live:
    // report it and leave the generations alone rather than deleting from
    // under a readable pointer.
    return failure(
      "io-error",
      `cannot invalidate current.json: ${errorText(error)}`,
    );
  }
  options.onPointerInvalidated?.(unitDir);

  const entries = readDirectory(unitDir);
  if (entries === undefined) {
    // A missing unit directory means there is nothing left to delete. Any
    // other reason leaves the pointer already invalidated (safe to retry).
    return {
      ok: true,
      unitDir,
      pointerInvalidated,
      removedGenerations: [],
      warnings: existsSync(unitDir)
        ? ["unit directory could not be listed; retry to finish cleanup"]
        : [],
    };
  }

  const removedGenerations: string[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    const target = join(unitDir, entry.name);
    try {
      rmSync(target, { recursive: true, force: true });
      if (entry.isDirectory()) removedGenerations.push(entry.name);
    } catch (error) {
      warnings.push(`cannot remove ${entry.name}: ${errorText(error)}`);
    }
  }
  try {
    rmdirSync(unitDir);
  } catch {
    // Not empty (a failed entry above) or already gone; both are fine.
  }
  return {
    ok: true,
    unitDir,
    pointerInvalidated,
    removedGenerations,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Orphan generations: preview, then delete
// ---------------------------------------------------------------------------

type ScannedUnit = { unitKey: string; unitDir: string };

function scanSpaceUnits(spaceDir: string): ScannedUnit[] {
  const rootEntries = readDirectory(spaceDir);
  if (rootEntries === undefined) return [];
  const units: ScannedUnit[] = [];
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === EMBEDDING_MEMORY_DIR_NAME) {
      const memoryEntries = readDirectory(join(spaceDir, entry.name));
      if (memoryEntries === undefined) continue;
      for (const memoryEntry of memoryEntries) {
        if (!memoryEntry.isDirectory()) continue;
        if (!isSafeSegment(memoryEntry.name)) continue;
        units.push({
          unitKey: `${EMBEDDING_MEMORY_DIR_NAME}/${memoryEntry.name}`,
          unitDir: join(spaceDir, entry.name, memoryEntry.name),
        });
      }
      continue;
    }
    if (!isSafeSegment(entry.name)) continue;
    units.push({
      unitKey: entry.name,
      unitDir: join(spaceDir, entry.name),
    });
  }
  units.sort((left, right) => (left.unitKey < right.unitKey ? -1 : 1));
  return units;
}

function normalizeKeep(keep: number | undefined): number {
  return keep !== undefined && Number.isInteger(keep) && keep >= 0
    ? keep
    : EMBEDDING_STALE_GENERATIONS_KEEP;
}

type GenerationCandidate = { name: string; path: string; mtimeMs: number };

function listUnitEntries(
  unitDir: string,
  unitKey: string,
  stale: EmbeddingStaleEntry[],
): { generations: GenerationCandidate[]; generationsScanned: number } {
  const entries = readDirectory(unitDir);
  if (entries === undefined) return { generations: [], generationsScanned: 0 };
  const generations: GenerationCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(unitDir, entry.name);
    if (entry.name.startsWith(TEMPORARY_DIR_PREFIX)) {
      stale.push({
        unitKey,
        generation: entry.name,
        path,
        reason: "temp-artifact",
      });
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // A generation that vanished between readdir and stat is simply gone;
      // keeping mtimeMs 0 sorts it last and the delete side skips it.
    }
    generations.push({ name: entry.name, path, mtimeMs });
  }
  // Newest first. B2's names embed a timestamp, but the mtime is the honest
  // order and the name is a deterministic tie-break for same-millisecond builds.
  generations.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
    if (left.name === right.name) return 0;
    return left.name < right.name ? 1 : -1;
  });
  return { generations, generationsScanned: generations.length };
}

/**
 * Lists the generations a cleanup would remove, without removing anything.
 *
 * Per unit it keeps the generation `current.json` points at, plus the `keep`
 * most recent other generations. A unit without a readable pointer keeps its
 * `keep` most recent generations (recovery material) and reports the rest as
 * orphans. Dot-prefixed temp directories left by a crashed build are always
 * reported; `.dirty.json` is a file and is never listed.
 */
export function sweepEmbeddingOrphanGenerations(
  spaceDir: string,
  options: { keep?: number } = {},
): EmbeddingOrphanSweepPreview {
  const keepPerUnit = normalizeKeep(options.keep);
  const units = scanSpaceUnits(spaceDir);
  const stale: EmbeddingStaleEntry[] = [];
  let generationsScanned = 0;
  for (const unit of units) {
    const pointer = readEmbeddingIndexPointer(unit.unitDir);
    const current = pointer.ok ? pointer.pointer.generation : undefined;
    const listed = listUnitEntries(unit.unitDir, unit.unitKey, stale);
    generationsScanned += listed.generationsScanned;
    let kept = 0;
    for (const generation of listed.generations) {
      if (current !== undefined && generation.name === current) continue;
      if (kept < keepPerUnit) {
        kept += 1;
        continue;
      }
      stale.push({
        unitKey: unit.unitKey,
        generation: generation.name,
        path: generation.path,
        reason: current === undefined ? "orphan-generation" : "beyond-recent",
      });
    }
  }
  stale.sort((left, right) => (left.path < right.path ? -1 : 1));
  return {
    spaceDir,
    keepPerUnit,
    unitsScanned: units.length,
    generationsScanned,
    stale,
  };
}

function isInside(directory: string, target: string): boolean {
  const rel = relative(directory, target);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/");
}

/**
 * Deletes exactly the paths a {@link EmbeddingOrphanSweepPreview} listed.
 *
 * Every entry is re-validated against `spaceDir` (lexical containment, one
 * path segment, still a directory) and re-checked against the unit's *current*
 * pointer, so a generation that became current after the preview is skipped.
 * That is what keeps the caller able to preview, pause, and only then delete.
 */
export function deleteEmbeddingOrphanGenerations(
  spaceDir: string,
  preview: EmbeddingOrphanSweepPreview,
): EmbeddingOrphanDeleteResult {
  if (preview.spaceDir !== spaceDir) {
    return failure(
      "space-mismatch",
      "preview belongs to a different space directory",
    );
  }
  const currentByUnit = new Map<string, string | undefined>();
  const deleted: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const entry of preview.stale) {
    const resolved = unitDirFor(spaceDir, entry.unitKey);
    if (resolved === undefined) {
      warnings.push(`unsafe unit key in preview: ${entry.unitKey}`);
      continue;
    }
    const { unitDir } = resolved;
    const expected = join(unitDir, entry.generation);
    if (expected !== entry.path || !isInside(spaceDir, entry.path)) {
      warnings.push(`preview path does not belong to the space: ${entry.path}`);
      continue;
    }
    if (basename(entry.path) !== entry.generation) {
      warnings.push(`preview entry is not one segment: ${entry.path}`);
      continue;
    }
    if (entry.reason !== "temp-artifact") {
      let current = currentByUnit.get(entry.unitKey);
      if (!currentByUnit.has(entry.unitKey)) {
        const pointer = readEmbeddingIndexPointer(unitDir);
        current = pointer.ok ? pointer.pointer.generation : undefined;
        currentByUnit.set(entry.unitKey, current);
      }
      if (current === entry.generation) {
        skipped.push(entry.path);
        continue;
      }
    }
    if (!isDirectory(entry.path)) {
      skipped.push(entry.path);
      continue;
    }
    try {
      rmSync(entry.path, { recursive: true, force: true });
      deleted.push(entry.path);
    } catch (error) {
      warnings.push(`cannot remove ${entry.path}: ${errorText(error)}`);
    }
  }
  return { ok: true, deleted, skipped, warnings };
}

// ---------------------------------------------------------------------------
// Fork: lazy rebuild decision, dirty marker, copy without hard links
// ---------------------------------------------------------------------------

type DirtyMarker = { markedAt: number };

function dirtyMarkerPath(unitDir: string): string {
  return join(unitDir, EMBEDDING_UNIT_DIRTY_FILE_NAME);
}

function readDirtyMarker(unitDir: string): DirtyMarker | undefined {
  let raw: string;
  try {
    raw = readFileSync(dirtyMarkerPath(unitDir), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const markedAt = (parsed as { markedAt?: unknown }).markedAt;
  return typeof markedAt === "number" &&
    Number.isFinite(markedAt) &&
    markedAt > 0
    ? { markedAt }
    : undefined;
}

/**
 * True when the unit has no usable index and a build is required before vector
 * recall can serve it. A fork therefore answers `true` until its first build.
 *
 * "Usable" means: a parseable pointer in the supported format, its generation
 * directory exists, and no dirty marker is newer than the pointer's
 * `updatedAt` (a completed rebuild clears the marker by being newer). The
 * function is read-only and never throws.
 */
export function needsEmbeddingIndexBuild(
  spaceDir: string,
  unitKey: string,
): boolean {
  const resolved = unitDirFor(spaceDir, unitKey);
  if (resolved === undefined) return true;
  const pointerResult = readEmbeddingIndexPointer(resolved.unitDir);
  if (!pointerResult.ok) return true;
  const pointer = pointerResult.pointer;
  if (pointer.formatVersion !== EMBEDDING_INDEX_FORMAT_VERSION) return true;
  let generationDir: string;
  try {
    generationDir = embeddingGenerationDir(
      resolved.unitDir,
      pointer.generation,
    );
  } catch {
    return true;
  }
  if (!isDirectory(generationDir)) return true;
  const dirty = readDirtyMarker(resolved.unitDir);
  if (dirty === undefined) return false;
  const updatedAt = Date.parse(pointer.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return dirty.markedAt > updatedAt;
}

/**
 * Records that a unit needs rebuilding (a fork, a model-space switch, a
 * detected drift). Only the marker is written: this module does not schedule,
 * spawn or wait for a build. The marker self-clears once a generation is
 * written whose pointer `updatedAt` is at least the marker time.
 */
export function markEmbeddingUnitDirty(
  spaceDir: string,
  unitKey: string,
  options: { reason?: string; clock?: () => number } = {},
): MarkEmbeddingUnitDirtyResult {
  const resolved = unitDirFor(spaceDir, unitKey);
  if (resolved === undefined) {
    return failure(
      "unsafe-unit-key",
      `refusing to mark unit ${JSON.stringify(unitKey)}`,
    );
  }
  const markerPath = dirtyMarkerPath(resolved.unitDir);
  const clock = options.clock ?? (() => Date.now());
  try {
    mkdirSync(resolved.unitDir, { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        markedAt: clock(),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      })}\n`,
      "utf8",
    );
  } catch (error) {
    return failure(
      "io-error",
      `cannot write dirty marker: ${errorText(error)}`,
    );
  }
  return { ok: true, markerPath };
}

function recordsForCopy(
  snapshot: EmbeddingIndexSnapshot,
): EmbeddingChunkRecordInput[] {
  return snapshot.records.map((record) => {
    const base: EmbeddingChunkRecordInput = {
      parentId: record.parentId,
      chunkIndex: record.chunkIndex,
      startChar: record.startChar,
      endChar: record.endChar,
      spans: record.spans.map((span) => ({
        startChar: span.startChar,
        endChar: span.endChar,
      })),
      focusChar: record.focusChar,
      textHash: record.textHash,
    };
    return record.parentLineSpan === undefined
      ? base
      : {
          ...base,
          parentLineSpan: {
            startLine: record.parentLineSpan.startLine,
            endLine: record.parentLineSpan.endLine,
          },
        };
  });
}

/**
 * Copies one unit's index to another unit by rewriting the source snapshot
 * through B2's writer, producing its own new generation.
 *
 * Forked conversations must not share a generation directory with their
 * source (48-2 §3.2 B5): B2 renames a whole directory into place per build, so
 * sharing would mean two units point at the same mutable path. Copying bytes
 * is the deliberate choice over links; the new generation name is B2's.
 */
export function copyEmbeddingUnitIndex(
  source: EmbeddingUnitLocation,
  target: EmbeddingUnitLocation,
): CopyEmbeddingUnitIndexResult {
  const sourceResolved = unitDirFor(source.spaceDir, source.unitKey);
  const targetResolved = unitDirFor(target.spaceDir, target.unitKey);
  if (sourceResolved === undefined || targetResolved === undefined) {
    return failure("unsafe-unit-key", "source or target unit key is not safe");
  }
  if (sourceResolved.unitDir === targetResolved.unitDir) {
    return failure("unsafe-unit-key", "source and target are the same unit");
  }
  const pointer = readEmbeddingIndexPointer(sourceResolved.unitDir);
  if (!pointer.ok) {
    return failure(
      "source-index-unavailable",
      pointer.detail ?? pointer.problem,
    );
  }
  const unit = vectorUnitFor(target.spaceDir, targetResolved.parsed);
  if (unit === undefined) {
    return failure("unsafe-unit-key", "target space is not under an agent id");
  }
  if (pointer.pointer.quant === "int8") {
    // An int8-only space has no float32 generation to copy; the quant helper
    // decodes the source rows and commits an int8 generation for the target.
    const copied = copyQuantUnitIndex({
      sourceUnitDir: sourceResolved.unitDir,
      targetUnitDir: targetResolved.unitDir,
      targetUnit: unit,
    });
    if (!copied.ok) {
      return failure(
        copied.problem === "write-failed"
          ? "io-error"
          : "source-index-unavailable",
        copied.detail,
      );
    }
    return {
      ok: true,
      sourceGeneration: copied.sourceGeneration,
      targetGeneration: copied.targetGeneration,
      targetUnitDir: targetResolved.unitDir,
      records: copied.records,
    };
  }
  const sourceIndex = readEmbeddingIndex(sourceResolved.unitDir);
  if (!sourceIndex.ok) {
    return failure(
      "source-index-unavailable",
      sourceIndex.detail ?? sourceIndex.problem,
    );
  }
  const { snapshot } = sourceIndex;
  const { meta, vectors } = snapshot;
  const dimensions = meta.dimensions;
  if (dimensions <= 0) {
    return failure("source-index-unavailable", "source index has no width");
  }
  const copiedVectors: Float32Array[] = [];
  for (let row = 0; row < meta.chunkCount; row += 1) {
    copiedVectors.push(vectors.slice(row * dimensions, (row + 1) * dimensions));
  }
  try {
    const written = writeEmbeddingIndex({
      unitDir: targetResolved.unitDir,
      unit,
      modelId: meta.modelId,
      dimensions,
      quant: "f32",
      chunkerVersion: meta.chunkerVersion,
      records: recordsForCopy(snapshot),
      vectors: copiedVectors,
      coverage: meta.coverage,
    });
    return {
      ok: true,
      sourceGeneration: snapshot.generation,
      targetGeneration: written.generation,
      targetUnitDir: targetResolved.unitDir,
      records: written.meta.chunkCount,
    };
  } catch (error) {
    return failure(
      "io-error",
      `cannot write target generation: ${errorText(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Coverage summary
// ---------------------------------------------------------------------------

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Reads only `meta.json`; a status summary must never load `vectors.bin`. */
function readGenerationCoverage(
  unitDir: string,
  generation: string,
): EmbeddingIndexCoverage | undefined {
  let raw: string;
  try {
    raw = readFileSync(
      join(unitDir, generation, EMBEDDING_INDEX_FILE_NAMES.meta),
      "utf8",
    );
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const coverage = (parsed as { coverage?: unknown }).coverage;
  if (typeof coverage !== "object" || coverage === null) return undefined;
  const { embeddedChars, recallableChars, ratio } = coverage as {
    embeddedChars?: unknown;
    recallableChars?: unknown;
    ratio?: unknown;
  };
  if (
    !isNonNegativeFinite(embeddedChars) ||
    !isNonNegativeFinite(recallableChars)
  ) {
    return undefined;
  }
  return {
    embeddedChars,
    recallableChars,
    ratio: typeof ratio === "number" && Number.isFinite(ratio) ? ratio : 0,
  };
}

function coverageRatio(
  embeddedChars: number,
  recallableChars: number,
): number | null {
  return recallableChars > 0 ? embeddedChars / recallableChars : null;
}

function stateCoverage(
  state: EmbeddingCoverageStateInput | undefined,
): number | null | undefined {
  const coverage = state?.coverage;
  if (coverage === undefined) return undefined;
  if (typeof coverage.ratio === "number" && Number.isFinite(coverage.ratio)) {
    return coverage.ratio;
  }
  if (!isNonNegativeFinite(coverage.embeddedChars)) return undefined;
  if (!isNonNegativeFinite(coverage.recallableChars)) return undefined;
  return coverageRatio(coverage.embeddedChars, coverage.recallableChars);
}

/**
 * Rolls the space's units and, when supplied, A2's build state into one status
 * projection (D6/A5).
 *
 * `coverage` prefers A2's state because it knows the whole planned corpus;
 * without it the sum of the indexed units' own `meta.coverage` is used, and
 * `null` means "no recallable text known" rather than 0. `missingUnitKeys`
 * combines unit directories whose index is unusable with the conversation ids
 * A2 recorded as failures that still have no index. `staleGenerations` counts
 * only reachable-generation leftovers; the preview may also list temp dirs.
 */
export function summarizeEmbeddingCoverage(
  spaceDir: string,
  state?: EmbeddingCoverageStateInput,
): EmbeddingCoverageSummary {
  const units = scanSpaceUnits(spaceDir);
  let indexedUnits = 0;
  const indexedUnitKeys = new Set<string>();
  const missingUnitKeys: string[] = [];
  let embeddedChars = 0;
  let recallableChars = 0;
  for (const unit of units) {
    const pointer = readEmbeddingIndexPointer(unit.unitDir);
    let usable =
      pointer.ok &&
      pointer.pointer.formatVersion === EMBEDDING_INDEX_FORMAT_VERSION;
    if (usable && pointer.ok) {
      let generationDir: string | undefined;
      try {
        generationDir = embeddingGenerationDir(
          unit.unitDir,
          pointer.pointer.generation,
        );
      } catch {
        generationDir = undefined;
      }
      usable = generationDir !== undefined && isDirectory(generationDir);
    }
    if (!usable) {
      missingUnitKeys.push(unit.unitKey);
      continue;
    }
    if (!pointer.ok) continue;
    indexedUnits += 1;
    indexedUnitKeys.add(unit.unitKey);
    const coverage = readGenerationCoverage(
      unit.unitDir,
      pointer.pointer.generation,
    );
    if (coverage !== undefined) {
      embeddedChars += coverage.embeddedChars;
      recallableChars += coverage.recallableChars;
    }
  }

  for (const recorded of state?.failures ?? []) {
    const key = recorded.conversationId;
    if (typeof key !== "string" || key.length === 0) continue;
    if (indexedUnitKeys.has(key)) continue;
    if (!missingUnitKeys.includes(key)) missingUnitKeys.push(key);
  }
  missingUnitKeys.sort((left, right) => (left < right ? -1 : 1));

  const preview = sweepEmbeddingOrphanGenerations(spaceDir);
  const fromState = stateCoverage(state);
  return {
    spaceDir,
    units: units.length,
    indexedUnits,
    coverage:
      fromState !== undefined
        ? fromState
        : coverageRatio(embeddedChars, recallableChars),
    missingUnits: missingUnitKeys.length,
    missingUnitKeys,
    staleGenerations: preview.stale.filter(
      (entry) => entry.reason !== "temp-artifact",
    ).length,
  };
}
