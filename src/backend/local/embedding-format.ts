/**
 * On-disk format for the vector-recall index (feature 48, package B2).
 *
 * Layout (docs/48-1 §6.3, docs/48-2 §4.2):
 *
 * ```
 * <recall root>/<agentId>/<spaceId>/<conversationKey>/       # transcript unit
 * <recall root>/<agentId>/<spaceId>/memory/<fileKey>/        # memory unit
 *   current.json                                             # pointer, single rename
 *   <generation>/{meta.json, records.jsonl, vectors.bin}     # immutable generation
 * ```
 *
 * `current.json` is the commit point and the only file rewritten in place. A
 * generation is built in a temporary directory and renamed into place whole, so
 * a reader never sees `meta.json` from one build next to `vectors.bin` from
 * another. The pointer itself is written to a temporary file and renamed over
 * `current.json`, which is atomic on every supported platform.
 *
 * The read side never throws. Missing files, unparseable JSON, a format or
 * chunker version bump, a byte-count mismatch or a checksum mismatch all come
 * back as an {@link EmbeddingIndexProblem} so the caller can fall back to
 * lexical recall. This module stores and validates bytes; it knows nothing
 * about models, encoders or the worker runtime.
 *
 * `records.jsonl` has one line per embedded chunk (`vectorOffset` is a byte
 * offset into the little-endian f32 `vectors.bin`; every chunk owns exactly
 * `dimensions * 4` bytes, so a parent's chunks are NOT required to be dense in
 * the unit — `chunkIndex` is parent-local and is preserved verbatim).
 * `textHash` hashes the chunk's *embedded text*: `embedding-chunk.ts` builds
 * that text deterministically from `spans[]` + the original parent, and B4
 * re-derives it to detect parent drift before injection.
 *
 * Layer: `backend/local/`. Imports only `utils/` and same-directory chunker
 * types; no `cli/`, `websocket/`, `reminders/` or `agent/` imports.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appHomePath } from "@/utils/app-paths";
import { isRecord } from "@/utils/type-guards";
import type {
  EmbeddingChunk,
  EmbeddingChunkCoverage,
  EmbeddingChunkPlan,
  EmbeddingTextSpan,
} from "./embedding-chunk";

/** Bump when the layout or field meanings of the generation files change. */
export const EMBEDDING_INDEX_FORMAT_VERSION = 1;

/**
 * Bump when `embedding-chunk.ts` changes chunk boundaries or span semantics.
 * Stored per index so a chunker upgrade rebuilds instead of mixing chunkings.
 */
export const EMBEDDING_INDEX_CHUNKER_VERSION = 1;

/** Directory name under the harness root (`<appHome>/recall-vectors`). */
export const RECALL_VECTORS_DIR_NAME = "recall-vectors";

/** Directory name holding one memory file's unit. */
export const EMBEDDING_MEMORY_DIR_NAME = "memory";

/** File names inside a unit directory. */
export const EMBEDDING_INDEX_FILE_NAMES = {
  meta: "meta.json",
  records: "records.jsonl",
  vectors: "vectors.bin",
  current: "current.json",
} as const;

/** Vector encoding. Only `f32` exists in phase 1; C9 adds `int8`. */
export type EmbeddingIndexQuant = "f32" | "int8";

/** Inclusive-start / exclusive-end line span of a memory chunk in its parent. */
export type EmbeddingParentLineSpan = { startLine: number; endLine: number };

/** Coverage copied from B1's chunk plan into the index metadata. */
export type EmbeddingIndexCoverage = {
  embeddedChars: number;
  recallableChars: number;
  ratio: number;
};

/** One on-disk chunk record; writer assigns `norm` and `vectorOffset`. */
export type EmbeddingChunkRecord = {
  /** Parent unit: transcript `message.id`, or `memory:<path>`. */
  parentId: string;
  /** Parent-local chunk index, preserved from B1. */
  chunkIndex: number;
  /** Original UTF-16 range of the chunk, fenced code in between included. */
  startChar: number;
  endChar: number;
  /** Prose runs (original offsets) that make up the embedded text. */
  spans: EmbeddingTextSpan[];
  /** Original offset of the prose midpoint; anchors the injection window. */
  focusChar: number;
  /** Hash of the chunk's embedded text; see {@link hashEmbeddingText}. */
  textHash: string;
  /** Euclidean norm of the stored vector (normalized vectors are ≈1). */
  norm: number;
  /** Byte offset into `vectors.bin`; always `row * dimensions * 4`. */
  vectorOffset: number;
  /** Memory units only: line span of the chunk inside the parent file. */
  parentLineSpan?: EmbeddingParentLineSpan;
};

/** What a caller supplies for one chunk; writer adds `norm`/`vectorOffset`. */
export type EmbeddingChunkRecordInput = Omit<
  EmbeddingChunkRecord,
  "norm" | "vectorOffset"
>;

/** Metadata stored next to a generation's records and vectors. */
export type EmbeddingIndexMeta = {
  formatVersion: number;
  chunkerVersion: number;
  agentId: string;
  spaceId: string;
  unitKind: "conversation" | "memory";
  unitKey: string;
  modelId: string;
  dimensions: number;
  quant: EmbeddingIndexQuant;
  /** Distinct `parentId`s in the generation. */
  parentCount: number;
  /** Number of records, equal to the number of stored vectors. */
  chunkCount: number;
  coverage: EmbeddingIndexCoverage;
  createdAt: string;
  /** SHA-256 of `records.jsonl` bytes followed by `vectors.bin` bytes. */
  checksum: string;
  recordsBytes: number;
  vectorsBytes: number;
};

/** The `current.json` payload: the single commit point of a unit. */
export type EmbeddingIndexPointer = {
  formatVersion: number;
  generation: string;
  chunkCount: number;
  parentCount: number;
  dimensions: number;
  quant: EmbeddingIndexQuant;
  checksum: string;
  updatedAt: string;
};

/** Cheap identity of a unit; conversation or memory (exactly one key). */
export type EmbeddingVectorUnit =
  | { agentId: string; spaceId: string; conversationKey: string }
  | { agentId: string; spaceId: string; memoryFileKey: string };

/** A loaded, validated generation, held resident by `embedding-cache.ts`. */
export type EmbeddingIndexSnapshot = {
  unitDir: string;
  generation: string;
  pointer: EmbeddingIndexPointer;
  meta: EmbeddingIndexMeta;
  records: EmbeddingChunkRecord[];
  /** Interleaved `chunkCount * dimensions` little-endian floats. */
  vectors: Float32Array;
};

/**
 * Why a read failed. Every value means "treat this unit as unavailable and use
 * lexical recall"; none is recoverable in place.
 */
export type EmbeddingIndexProblem =
  | "missing"
  | "unreadable"
  | "version-mismatch"
  | "expectation-mismatch"
  | "unsupported-quant"
  | "corrupt"
  | "checksum-mismatch";

/** `statSync` identity of `current.json`, used by the cache to skip reloads. */
export type EmbeddingPointerSignature = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type EmbeddingIndexFailure = {
  ok: false;
  problem: EmbeddingIndexProblem;
  detail?: string;
};

export type EmbeddingIndexPointerResult =
  | {
      ok: true;
      pointer: EmbeddingIndexPointer;
      signature: EmbeddingPointerSignature;
    }
  | EmbeddingIndexFailure;

export type EmbeddingIndexReadResult =
  | { ok: true; snapshot: EmbeddingIndexSnapshot }
  | EmbeddingIndexFailure;

export type EmbeddingIndexWriteInput = {
  /** Absolute unit directory; build it with {@link embeddingVectorUnitDir}. */
  unitDir: string;
  unit: EmbeddingVectorUnit;
  modelId: string;
  dimensions: number;
  quant?: EmbeddingIndexQuant;
  chunkerVersion?: number;
  records: readonly EmbeddingChunkRecordInput[];
  /** One vector per record, aligned by index; already L2-normalized. */
  vectors: readonly ArrayLike<number>[];
  coverage: EmbeddingChunkCoverage | EmbeddingIndexCoverage;
  /** Override only in tests; production generations are timestamped. */
  generation?: string;
};

export type EmbeddingIndexWriteResult = {
  generation: string;
  unitDir: string;
  pointer: EmbeddingIndexPointer;
  meta: EmbeddingIndexMeta;
};

/** Thrown when a caller-supplied path segment would leave the recall root. */
export class EmbeddingIndexPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingIndexPathError";
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TEMP_DIR_PREFIX = ".tmp-";
const TEMP_POINTER_PREFIX = ".current-";

let tempCounter = 0;
let generationCounter = 0;

function failure(
  problem: EmbeddingIndexProblem,
  detail?: string,
): EmbeddingIndexFailure {
  return detail === undefined
    ? { ok: false, problem }
    : { ok: false, problem, detail };
}

// --- Paths -----------------------------------------------------------------

/**
 * Root of every vector index (`<harness home>/recall-vectors`). Resolved on
 * each call so `HARUYUKI_HOME` moves it; never captured in a module constant.
 */
export function getRecallVectorsRoot(): string {
  return appHomePath([RECALL_VECTORS_DIR_NAME]);
}

/**
 * Absolute unit directory for a conversation or a memory file. Every segment is
 * validated as one safe path component so a malicious id cannot escape the
 * recall root.
 */
export function embeddingVectorUnitDir(
  unit: EmbeddingVectorUnit,
  options: { root?: string } = {},
): string {
  const root = options.root ?? getRecallVectorsRoot();
  assertSafeSegment(unit.agentId, "agentId");
  assertSafeSegment(unit.spaceId, "spaceId");
  if ("memoryFileKey" in unit) {
    assertSafeSegment(unit.memoryFileKey, "memoryFileKey");
    return join(
      root,
      unit.agentId,
      unit.spaceId,
      EMBEDDING_MEMORY_DIR_NAME,
      unit.memoryFileKey,
    );
  }
  assertSafeSegment(unit.conversationKey, "conversationKey");
  return join(root, unit.agentId, unit.spaceId, unit.conversationKey);
}

/** The generation directory inside a unit directory. */
export function embeddingGenerationDir(
  unitDir: string,
  generation: string,
): string {
  assertSafeSegment(generation, "generation");
  return join(unitDir, generation);
}

/** The `current.json` path inside a unit directory. */
export function embeddingCurrentPointerPath(unitDir: string): string {
  return join(unitDir, EMBEDDING_INDEX_FILE_NAMES.current);
}

function unitIdentity(unit: EmbeddingVectorUnit): {
  unitKind: "conversation" | "memory";
  unitKey: string;
} {
  return "memoryFileKey" in unit
    ? { unitKind: "memory", unitKey: unit.memoryFileKey }
    : { unitKind: "conversation", unitKey: unit.conversationKey };
}

function assertSafeSegment(segment: string, label: string): void {
  if (
    typeof segment !== "string" ||
    !SAFE_SEGMENT.test(segment) ||
    segment === "." ||
    segment === ".."
  ) {
    throw new EmbeddingIndexPathError(
      `Embedding index ${label} is not a safe path segment: ${JSON.stringify(segment)}`,
    );
  }
}

// --- Hashing ---------------------------------------------------------------

/**
 * Hash of a chunk's embedded text, used by the store and by B4's pre-injection
 * drift check. Truncated to 128 bits: collision risk is irrelevant for a
 * same-parent comparison, and a shorter field keeps `records.jsonl` small.
 */
export function hashEmbeddingText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

function checksumOf(records: Buffer, vectors: Buffer): string {
  const hash = createHash("sha256");
  hash.update(records);
  hash.update(vectors);
  return hash.digest("hex");
}

// --- Chunk-plan mapping ----------------------------------------------------

/** One B1 chunk as a record input; `textHash` hashes the embedded text. */
export function embeddingChunkRecordFromChunk(
  chunk: EmbeddingChunk,
  parentLineSpan?: EmbeddingParentLineSpan,
): EmbeddingChunkRecordInput {
  return {
    parentId: chunk.parentId,
    chunkIndex: chunk.chunkIndex,
    startChar: chunk.startChar,
    endChar: chunk.endChar,
    spans: chunk.spans.map((span) => ({ ...span })),
    focusChar: chunk.focusChar,
    textHash: hashEmbeddingText(chunk.text),
    ...(parentLineSpan === undefined ? {} : { parentLineSpan }),
  };
}

/**
 * Maps a B1 chunk plan to record inputs. `parentLineSpan` is optional and
 * per-chunk because a memory parent's line span depends on `focusChar`; B4
 * passes a resolver, transcript units pass nothing.
 */
export function embeddingChunkRecordsFromPlan(
  plan: EmbeddingChunkPlan,
  options: {
    parentLineSpan?: (
      chunk: EmbeddingChunk,
    ) => EmbeddingParentLineSpan | undefined;
  } = {},
): EmbeddingChunkRecordInput[] {
  return plan.chunks.map((chunk) =>
    embeddingChunkRecordFromChunk(chunk, options.parentLineSpan?.(chunk)),
  );
}

// --- Atomic write ----------------------------------------------------------

/**
 * Writes one immutable generation and commits it with a single pointer rename.
 *
 * Throws on programmer errors or IO failure (the builder should abort that
 * unit); readers still see the previous generation because the pointer is only
 * touched after every generation file is in place.
 */
export function writeEmbeddingIndex(
  input: EmbeddingIndexWriteInput,
): EmbeddingIndexWriteResult {
  const { dimensions } = input;
  const quant = input.quant ?? "f32";
  const chunkerVersion =
    input.chunkerVersion ?? EMBEDDING_INDEX_CHUNKER_VERSION;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `Embedding index dimensions must be a positive integer, got ${dimensions}.`,
    );
  }
  if (input.records.length !== input.vectors.length) {
    throw new Error(
      `Embedding index record/vector count mismatch: ${input.records.length} records, ${input.vectors.length} vectors.`,
    );
  }
  if (quant !== "f32") {
    throw new Error(
      `Embedding index writer only supports quant "f32" in phase 1, got ${quant}.`,
    );
  }
  if (!Number.isInteger(chunkerVersion) || chunkerVersion <= 0) {
    throw new Error(
      `Embedding index chunkerVersion must be a positive integer, got ${chunkerVersion}.`,
    );
  }

  const { bytes: vectorsBytes, norms } = encodeVectors(
    input.vectors,
    dimensions,
  );
  const records: EmbeddingChunkRecord[] = input.records.map((record, row) => {
    const norm = norms[row];
    if (norm === undefined) {
      throw new Error(`Embedding index vector ${row} is missing.`);
    }
    validateRecordInput(record, row);
    return { ...record, norm, vectorOffset: row * dimensions * 4 };
  });
  const recordsBytes = Buffer.from(
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  const checksum = checksumOf(recordsBytes, vectorsBytes);
  const identity = unitIdentity(input.unit);
  const createdAt = new Date().toISOString();
  const parentCount = new Set(records.map((record) => record.parentId)).size;
  const meta: EmbeddingIndexMeta = {
    formatVersion: EMBEDDING_INDEX_FORMAT_VERSION,
    chunkerVersion,
    agentId: input.unit.agentId,
    spaceId: input.unit.spaceId,
    unitKind: identity.unitKind,
    unitKey: identity.unitKey,
    modelId: input.modelId,
    dimensions,
    quant,
    parentCount,
    chunkCount: records.length,
    coverage: {
      embeddedChars: input.coverage.embeddedChars,
      recallableChars: input.coverage.recallableChars,
      ratio: input.coverage.ratio,
    },
    createdAt,
    checksum,
    recordsBytes: recordsBytes.byteLength,
    vectorsBytes: vectorsBytes.byteLength,
  };
  const generation = input.generation ?? nextGenerationName();
  assertSafeSegment(generation, "generation");

  mkdirSync(input.unitDir, { recursive: true });
  const generationDir = embeddingGenerationDir(input.unitDir, generation);
  const temporaryDir = join(input.unitDir, nextTempName(TEMP_DIR_PREFIX));
  try {
    mkdirSync(temporaryDir, { recursive: true });
    writeFileSync(
      join(temporaryDir, EMBEDDING_INDEX_FILE_NAMES.meta),
      `${JSON.stringify(meta)}\n`,
      "utf8",
    );
    writeFileSync(
      join(temporaryDir, EMBEDDING_INDEX_FILE_NAMES.records),
      recordsBytes,
    );
    writeFileSync(
      join(temporaryDir, EMBEDDING_INDEX_FILE_NAMES.vectors),
      vectorsBytes,
    );
    // Renaming the directory is the atomic move; every file it contains is
    // complete before the rename becomes visible.
    renameSync(temporaryDir, generationDir);
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }

  const pointer: EmbeddingIndexPointer = {
    formatVersion: EMBEDDING_INDEX_FORMAT_VERSION,
    generation,
    chunkCount: meta.chunkCount,
    parentCount: meta.parentCount,
    dimensions,
    quant,
    checksum,
    updatedAt: createdAt,
  };
  writeEmbeddingIndexPointer(input.unitDir, pointer);
  return { generation, unitDir: input.unitDir, pointer, meta };
}

/** Rewrites `current.json` through a temporary file + rename. */
export function writeEmbeddingIndexPointer(
  unitDir: string,
  pointer: EmbeddingIndexPointer,
): void {
  mkdirSync(unitDir, { recursive: true });
  const target = embeddingCurrentPointerPath(unitDir);
  const temporary = join(unitDir, nextTempName(TEMP_POINTER_PREFIX));
  writeFileSync(temporary, `${JSON.stringify(pointer)}\n`, "utf8");
  try {
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone; the original error is reported.
    }
    throw error;
  }
}

function nextGenerationName(): string {
  generationCounter += 1;
  return `gen-${Date.now().toString(36)}-${generationCounter.toString(36)}`;
}

function nextTempName(prefix: string): string {
  tempCounter += 1;
  return `${prefix}${process.pid.toString(36)}-${tempCounter.toString(36)}`;
}

function encodeVectors(
  vectors: readonly ArrayLike<number>[],
  dimensions: number,
): { bytes: Buffer; norms: number[] } {
  const bytes = Buffer.allocUnsafe(vectors.length * dimensions * 4);
  const norms: number[] = [];
  for (let row = 0; row < vectors.length; row += 1) {
    const vector = vectors[row];
    if (vector === undefined || vector.length !== dimensions) {
      throw new Error(
        `Embedding index vector ${row} has length ${vector?.length ?? 0}, expected ${dimensions}.`,
      );
    }
    let sumOfSquares = 0;
    for (let axis = 0; axis < dimensions; axis += 1) {
      const value = vector[axis] ?? 0;
      if (!Number.isFinite(value)) {
        throw new Error(
          `Embedding index vector ${row} axis ${axis} is not finite.`,
        );
      }
      bytes.writeFloatLE(value, (row * dimensions + axis) * 4);
      sumOfSquares += value * value;
    }
    norms.push(Math.sqrt(sumOfSquares));
  }
  return { bytes, norms };
}

function decodeVectors(bytes: Buffer, count: number): Float32Array {
  const vectors = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    vectors[index] = bytes.readFloatLE(index * 4);
  }
  return vectors;
}

function validateRecordInput(
  record: EmbeddingChunkRecordInput,
  row: number,
): void {
  const where = `Embedding index record ${row}`;
  if (typeof record.parentId !== "string" || record.parentId.length === 0) {
    throw new Error(`${where} has no parentId.`);
  }
  if (!isNonNegativeInteger(record.chunkIndex)) {
    throw new Error(`${where} has an invalid chunkIndex.`);
  }
  if (
    !isNonNegativeInteger(record.startChar) ||
    !isNonNegativeInteger(record.endChar) ||
    record.endChar < record.startChar
  ) {
    throw new Error(`${where} has an invalid char range.`);
  }
  if (!Array.isArray(record.spans) || record.spans.length === 0) {
    throw new Error(`${where} has no spans.`);
  }
  if (
    !isNonNegativeInteger(record.focusChar) ||
    record.focusChar < record.startChar ||
    record.focusChar > record.endChar
  ) {
    throw new Error(`${where} has an invalid focusChar.`);
  }
  if (typeof record.textHash !== "string" || record.textHash.length === 0) {
    throw new Error(`${where} has no textHash.`);
  }
  if (!isValidLineSpan(record.parentLineSpan)) {
    throw new Error(`${where} has an invalid parentLineSpan.`);
  }
}

// --- Tolerant read ---------------------------------------------------------

/** Stats `current.json` only — the cheap cache-health check. */
export function statEmbeddingIndexPointer(
  unitDir: string,
): { ok: true; signature: EmbeddingPointerSignature } | { ok: false } {
  try {
    const stats = statSync(embeddingCurrentPointerPath(unitDir));
    return { ok: true, signature: pointerSignature(stats) };
  } catch {
    return { ok: false };
  }
}

/** Reads and validates `current.json`. Never throws. */
export function readEmbeddingIndexPointer(
  unitDir: string,
): EmbeddingIndexPointerResult {
  let signature: EmbeddingPointerSignature;
  let raw: string;
  try {
    const path = embeddingCurrentPointerPath(unitDir);
    signature = pointerSignature(statSync(path));
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return failure("missing", errorMessage(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return failure("unreadable", errorMessage(error));
  }
  const pointer = parsePointer(parsed);
  if (pointer === undefined) {
    return failure("corrupt", "invalid current.json");
  }
  return { ok: true, pointer, signature };
}

/**
 * Loads and fully validates the generation named by `current.json`.
 *
 * `options.pointer` lets the resident cache reuse an already-read pointer
 * instead of stat-ing and parsing `current.json` twice.
 */
export function readEmbeddingIndex(
  unitDir: string,
  options: { pointer?: EmbeddingIndexPointer } = {},
): EmbeddingIndexReadResult {
  let pointer = options.pointer;
  if (pointer === undefined) {
    const pointerResult = readEmbeddingIndexPointer(unitDir);
    if (!pointerResult.ok) return pointerResult;
    pointer = pointerResult.pointer;
  }
  if (pointer.formatVersion !== EMBEDDING_INDEX_FORMAT_VERSION) {
    return failure(
      "version-mismatch",
      `pointer formatVersion ${pointer.formatVersion}`,
    );
  }

  let generationDir: string;
  try {
    generationDir = embeddingGenerationDir(unitDir, pointer.generation);
  } catch (error) {
    return failure("corrupt", errorMessage(error));
  }
  const metaResult = readGenerationMeta(generationDir);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.meta;
  if (meta.formatVersion !== EMBEDDING_INDEX_FORMAT_VERSION) {
    return failure(
      "version-mismatch",
      `meta formatVersion ${meta.formatVersion}`,
    );
  }
  if (meta.chunkerVersion !== EMBEDDING_INDEX_CHUNKER_VERSION) {
    return failure(
      "version-mismatch",
      `meta chunkerVersion ${meta.chunkerVersion}`,
    );
  }
  if (
    meta.formatVersion !== pointer.formatVersion ||
    meta.chunkCount !== pointer.chunkCount ||
    meta.dimensions !== pointer.dimensions ||
    meta.quant !== pointer.quant ||
    meta.checksum !== pointer.checksum
  ) {
    return failure(
      "corrupt",
      "pointer and meta disagree on generation contents",
    );
  }
  if (meta.quant !== "f32") {
    return failure("unsupported-quant", `quant ${meta.quant}`);
  }

  let recordsBytes: Buffer;
  let vectorsBytes: Buffer;
  try {
    recordsBytes = readFileSync(
      join(generationDir, EMBEDDING_INDEX_FILE_NAMES.records),
    );
    vectorsBytes = readFileSync(
      join(generationDir, EMBEDDING_INDEX_FILE_NAMES.vectors),
    );
  } catch (error) {
    return failure("unreadable", errorMessage(error));
  }
  if (
    recordsBytes.byteLength !== meta.recordsBytes ||
    vectorsBytes.byteLength !== meta.vectorsBytes ||
    vectorsBytes.byteLength !== meta.chunkCount * meta.dimensions * 4
  ) {
    return failure("corrupt", "generation file size does not match meta");
  }
  if (checksumOf(recordsBytes, vectorsBytes) !== meta.checksum) {
    return failure(
      "checksum-mismatch",
      "records/vectors checksum does not match meta",
    );
  }
  const records = parseRecords(recordsBytes, meta);
  if (records === undefined) {
    return failure("corrupt", "records.jsonl failed validation");
  }
  return {
    ok: true,
    snapshot: {
      unitDir,
      generation: pointer.generation,
      pointer,
      meta,
      records,
      vectors: decodeVectors(vectorsBytes, meta.chunkCount * meta.dimensions),
    },
  };
}

function readGenerationMeta(
  generationDir: string,
): { ok: true; meta: EmbeddingIndexMeta } | EmbeddingIndexFailure {
  let raw: string;
  try {
    raw = readFileSync(
      join(generationDir, EMBEDDING_INDEX_FILE_NAMES.meta),
      "utf8",
    );
  } catch (error) {
    return failure("missing", errorMessage(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return failure("unreadable", errorMessage(error));
  }
  const meta = parseMeta(parsed);
  if (meta === undefined) {
    return failure("corrupt", "invalid meta.json");
  }
  return { ok: true, meta };
}

function parsePointer(value: unknown): EmbeddingIndexPointer | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isPositiveInteger(value.formatVersion) ||
    typeof value.generation !== "string" ||
    !isNonNegativeInteger(value.chunkCount) ||
    !isNonNegativeInteger(value.parentCount) ||
    !isPositiveInteger(value.dimensions) ||
    (value.quant !== "f32" && value.quant !== "int8") ||
    typeof value.checksum !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  return {
    formatVersion: value.formatVersion,
    generation: value.generation,
    chunkCount: value.chunkCount,
    parentCount: value.parentCount,
    dimensions: value.dimensions,
    quant: value.quant,
    checksum: value.checksum,
    updatedAt: value.updatedAt,
  };
}

function parseMeta(value: unknown): EmbeddingIndexMeta | undefined {
  if (!isRecord(value)) return undefined;
  const coverage = parseCoverage(value.coverage);
  if (
    !isPositiveInteger(value.formatVersion) ||
    !isPositiveInteger(value.chunkerVersion) ||
    typeof value.agentId !== "string" ||
    typeof value.spaceId !== "string" ||
    (value.unitKind !== "conversation" && value.unitKind !== "memory") ||
    typeof value.unitKey !== "string" ||
    typeof value.modelId !== "string" ||
    !isPositiveInteger(value.dimensions) ||
    (value.quant !== "f32" && value.quant !== "int8") ||
    !isNonNegativeInteger(value.parentCount) ||
    !isNonNegativeInteger(value.chunkCount) ||
    coverage === undefined ||
    typeof value.createdAt !== "string" ||
    typeof value.checksum !== "string" ||
    !isNonNegativeInteger(value.recordsBytes) ||
    !isNonNegativeInteger(value.vectorsBytes)
  ) {
    return undefined;
  }
  return {
    formatVersion: value.formatVersion,
    chunkerVersion: value.chunkerVersion,
    agentId: value.agentId,
    spaceId: value.spaceId,
    unitKind: value.unitKind,
    unitKey: value.unitKey,
    modelId: value.modelId,
    dimensions: value.dimensions,
    quant: value.quant,
    parentCount: value.parentCount,
    chunkCount: value.chunkCount,
    coverage,
    createdAt: value.createdAt,
    checksum: value.checksum,
    recordsBytes: value.recordsBytes,
    vectorsBytes: value.vectorsBytes,
  };
}

function parseCoverage(value: unknown): EmbeddingIndexCoverage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonNegativeInteger(value.embeddedChars) ||
    !isNonNegativeInteger(value.recallableChars) ||
    !isFiniteNumber(value.ratio)
  ) {
    return undefined;
  }
  return {
    embeddedChars: value.embeddedChars,
    recallableChars: value.recallableChars,
    ratio: value.ratio,
  };
}

function parseRecords(
  bytes: Buffer,
  meta: EmbeddingIndexMeta,
): EmbeddingChunkRecord[] | undefined {
  const lines = bytes.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== meta.chunkCount) return undefined;
  const records: EmbeddingChunkRecord[] = [];
  for (const [row, line] of lines.entries()) {
    if (line === undefined || line.trim() === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    const record = parseRecord(parsed, row, meta.dimensions);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return records;
}

function parseRecord(
  value: unknown,
  row: number,
  dimensions: number,
): EmbeddingChunkRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.spans) || value.spans.length === 0) return undefined;
  const spans: EmbeddingTextSpan[] = [];
  for (const spanValue of value.spans) {
    const span = parseSpan(spanValue);
    if (span === undefined) return undefined;
    spans.push(span);
  }
  if (
    typeof value.parentId !== "string" ||
    value.parentId.length === 0 ||
    !isNonNegativeInteger(value.chunkIndex) ||
    !isNonNegativeInteger(value.startChar) ||
    !isNonNegativeInteger(value.endChar) ||
    value.endChar < value.startChar ||
    !isNonNegativeInteger(value.focusChar) ||
    value.focusChar < value.startChar ||
    value.focusChar > value.endChar ||
    typeof value.textHash !== "string" ||
    value.textHash.length === 0 ||
    !isFiniteNumber(value.norm) ||
    value.norm < 0 ||
    value.vectorOffset !== row * dimensions * 4 ||
    !isValidLineSpan(value.parentLineSpan)
  ) {
    return undefined;
  }
  const record: EmbeddingChunkRecord = {
    parentId: value.parentId,
    chunkIndex: value.chunkIndex,
    startChar: value.startChar,
    endChar: value.endChar,
    spans,
    focusChar: value.focusChar,
    textHash: value.textHash,
    norm: value.norm,
    vectorOffset: value.vectorOffset,
  };
  if (value.parentLineSpan !== undefined) {
    record.parentLineSpan = value.parentLineSpan;
  }
  return record;
}

function parseSpan(value: unknown): EmbeddingTextSpan | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonNegativeInteger(value.startChar) ||
    !isNonNegativeInteger(value.endChar) ||
    value.endChar < value.startChar
  ) {
    return undefined;
  }
  return { startChar: value.startChar, endChar: value.endChar };
}

function isValidLineSpan(
  value: unknown,
): value is EmbeddingParentLineSpan | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.startLine) &&
    isNonNegativeInteger(value.endLine) &&
    value.endLine >= value.startLine
  );
}

// --- Number helpers --------------------------------------------------------

function pointerSignature(stats: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): EmbeddingPointerSignature {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
