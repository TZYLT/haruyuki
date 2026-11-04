/**
 * int8 on-disk generation for the vector index (feature 48, package C9).
 *
 * This is the `int8` half of B2's layout: a generation directory with the same
 * `meta.json` / `records.jsonl` / `vectors.bin` files, plus an optional
 * `vectors.float32.bin` holding the originals used for exact rescore. The
 * commit point is still B2's single-rename `current.json`, so a reader never
 * sees a half-written generation.
 *
 * `embedding-format.ts` owns the f32 encoding and its writer rejects any other
 * quant; its reader reports `unsupported-quant` for a generation written here.
 * The cache therefore dispatches on `pointer.quant` and the two encodings are
 * never mixed. Records carry `vectorScale` — a per-vector scale is part of the
 * encoded row — and `vectorOffset` is a byte offset into the int8 `vectors.bin`
 * (`row * dimensions`).
 *
 * The read path never throws: missing/corrupt/version-mismatched files and a
 * failed checksum all come back as an {@link EmbeddingIndexProblem}, which the
 * cache maps to `unusable` so recall falls back to the lexical arm.
 *
 * Layer: `backend/local/`. Imports only `embedding-format.ts`,
 * `embedding-quant.ts` and `@/utils/type-guards`; no `cli/`, `websocket/`,
 * `reminders/` or `agent/`.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "@/utils/type-guards";
import type {
  EmbeddingChunkCoverage,
  EmbeddingTextSpan,
} from "./embedding-chunk";
import {
  EMBEDDING_INDEX_CHUNKER_VERSION,
  EMBEDDING_INDEX_FILE_NAMES,
  EMBEDDING_INDEX_FORMAT_VERSION,
  type EmbeddingChunkRecordInput,
  type EmbeddingIndexCoverage,
  type EmbeddingIndexMeta,
  type EmbeddingIndexPointer,
  type EmbeddingIndexProblem,
  type EmbeddingParentLineSpan,
  type EmbeddingVectorUnit,
  embeddingGenerationDir,
  readEmbeddingIndexPointer,
  writeEmbeddingIndexPointer,
} from "./embedding-format";
import {
  type EmbeddingQuantChunkRecord,
  EmbeddingQuantError,
  type EmbeddingQuantMode,
  quantizeEmbeddingVectors,
} from "./embedding-quant";

/** File holding the optional float32 originals used for rescore. */
export const EMBEDDING_QUANT_FLOAT32_FILE_NAME = "vectors.float32.bin";

/** Metadata of an int8 generation: B2's shape plus the rescore section. */
export type EmbeddingQuantIndexMeta = Omit<EmbeddingIndexMeta, "quant"> & {
  quant: "int8";
  /** Size of `vectors.float32.bin`; `0` when only int8 codes are stored. */
  float32VectorsBytes: number;
  /** SHA-256 of `vectors.float32.bin`; absent when the file is absent. */
  float32Checksum?: string;
};

/** A loaded, validated int8 generation, held resident by `embedding-cache.ts`. */
export type EmbeddingQuantIndexSnapshot = {
  unitDir: string;
  generation: string;
  pointer: EmbeddingIndexPointer;
  meta: EmbeddingQuantIndexMeta;
  records: EmbeddingQuantChunkRecord[];
  /** `chunkCount * dimensions` codes; `records[row]` describes row `row`. */
  codes: Int8Array;
  /** One scale per row, copied out of the records. */
  scales: Float32Array;
  /** Exact float32 originals, only when stored and requested. */
  exactVectors?: Float32Array;
  /** Resolved read mode: `int8-rescore` only when the originals are resident. */
  mode: EmbeddingQuantMode;
  /** True when exact rescore cannot run from this snapshot. */
  rescoreUnavailable: boolean;
};

export type EmbeddingQuantWriteInput = {
  /** Absolute unit directory; build it with `embeddingVectorUnitDir`. */
  unitDir: string;
  unit: EmbeddingVectorUnit;
  modelId: string;
  dimensions: number;
  records: readonly EmbeddingChunkRecordInput[];
  /** One L2-normalized float32 vector per record, aligned by index. */
  vectors: readonly ArrayLike<number>[];
  coverage: EmbeddingChunkCoverage | EmbeddingIndexCoverage;
  /** Keep the float32 originals for exact rescore (default `true`). */
  rescore?: boolean;
  chunkerVersion?: number;
  /** Override only in tests; production generations are timestamped. */
  generation?: string;
};

export type EmbeddingQuantWriteResult = {
  generation: string;
  unitDir: string;
  pointer: EmbeddingIndexPointer;
  meta: EmbeddingQuantIndexMeta;
};

const TEMP_DIR_PREFIX = ".tmp-i8-";
let generationCounter = 0;
let tempCounter = 0;

/**
 * Writes one immutable int8 generation and commits it with B2's single pointer
 * rename. Throws on programmer errors or IO failure; readers keep seeing the
 * previous generation because the pointer is written last.
 */
export function writeEmbeddingQuantIndex(
  input: EmbeddingQuantWriteInput,
): EmbeddingQuantWriteResult {
  const { dimensions } = input;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new EmbeddingQuantError(
      "invalid-dimensions",
      `quantized index dimensions must be a positive integer, got ${dimensions}`,
    );
  }
  if (input.records.length !== input.vectors.length) {
    throw new EmbeddingQuantError(
      "record-vector-mismatch",
      `${input.records.length} records but ${input.vectors.length} vectors`,
    );
  }
  const rescore = input.rescore !== false;
  const chunkerVersion =
    input.chunkerVersion ?? EMBEDDING_INDEX_CHUNKER_VERSION;
  if (!Number.isInteger(chunkerVersion) || chunkerVersion <= 0) {
    throw new EmbeddingQuantError(
      "invalid-record",
      `chunkerVersion must be a positive integer, got ${chunkerVersion}`,
    );
  }
  const quantized = quantizeEmbeddingVectors(input.vectors, dimensions);
  const records: EmbeddingQuantChunkRecord[] = input.records.map(
    (record, row) => {
      validateQuantRecordInput(record, row);
      return {
        ...record,
        norm: vectorNorm(input.vectors[row], dimensions, row),
        vectorOffset: row * dimensions,
        vectorScale: quantized.scales[row] ?? 0,
      };
    },
  );
  const recordsBytes = Buffer.from(
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  const codesBytes = Buffer.from(
    new Uint8Array(
      quantized.codes.buffer,
      quantized.codes.byteOffset,
      quantized.codes.byteLength,
    ),
  );
  // An empty generation has no originals to keep: writing a zero-byte
  // `vectors.float32.bin` alongside its checksum would make the reader reject
  // the generation as corrupt, because it treats size 0 as "no file".
  const exactBytes =
    rescore && input.vectors.length > 0
      ? encodeFloat32Vectors(input.vectors, dimensions)
      : undefined;
  const checksum = quantChecksum(recordsBytes, codesBytes);
  const identity = unitIdentity(input.unit);
  const createdAt = new Date().toISOString();
  const parentCount = new Set(records.map((record) => record.parentId)).size;
  const meta: EmbeddingQuantIndexMeta = {
    formatVersion: EMBEDDING_INDEX_FORMAT_VERSION,
    chunkerVersion,
    agentId: input.unit.agentId,
    spaceId: input.unit.spaceId,
    unitKind: identity.unitKind,
    unitKey: identity.unitKey,
    modelId: input.modelId,
    dimensions,
    quant: "int8",
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
    vectorsBytes: codesBytes.byteLength,
    float32VectorsBytes: exactBytes?.byteLength ?? 0,
    ...(exactBytes === undefined
      ? {}
      : { float32Checksum: sha256Hex(exactBytes) }),
  };
  const generation = input.generation ?? nextGenerationName();
  const temporaryDir = join(
    input.unitDir,
    `${TEMP_DIR_PREFIX}${process.pid.toString(36)}-${nextTempName()}`,
  );
  mkdirSync(input.unitDir, { recursive: true });
  const generationDir = embeddingGenerationDir(input.unitDir, generation);
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
      codesBytes,
    );
    if (exactBytes !== undefined) {
      writeFileSync(
        join(temporaryDir, EMBEDDING_QUANT_FLOAT32_FILE_NAME),
        exactBytes,
      );
    }
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
    quant: "int8",
    checksum,
    updatedAt: createdAt,
  };
  writeEmbeddingIndexPointer(input.unitDir, pointer);
  return { generation, unitDir: input.unitDir, pointer, meta };
}

function encodeFloat32Vectors(
  vectors: readonly ArrayLike<number>[],
  dimensions: number,
): Buffer {
  const bytes = Buffer.allocUnsafe(vectors.length * dimensions * 4);
  for (let row = 0; row < vectors.length; row += 1) {
    for (let axis = 0; axis < dimensions; axis += 1) {
      bytes.writeFloatLE(
        vectors[row]?.[axis] ?? 0,
        (row * dimensions + axis) * 4,
      );
    }
  }
  return bytes;
}

function vectorNorm(
  vector: ArrayLike<number> | undefined,
  dimensions: number,
  row: number,
): number {
  if (vector === undefined) {
    throw new EmbeddingQuantError("invalid-vector", `vector ${row} is missing`);
  }
  let sumOfSquares = 0;
  for (let axis = 0; axis < dimensions; axis += 1) {
    const value = vector[axis] ?? 0;
    sumOfSquares += value * value;
  }
  return Math.sqrt(sumOfSquares);
}

function validateQuantRecordInput(
  record: EmbeddingChunkRecordInput,
  row: number,
): void {
  const where = `quantized index record ${row}`;
  const rangeInvalid =
    !isNonNegativeInteger(record.chunkIndex) ||
    !isNonNegativeInteger(record.startChar) ||
    !isNonNegativeInteger(record.endChar) ||
    record.endChar < record.startChar ||
    !isNonNegativeInteger(record.focusChar) ||
    record.focusChar < record.startChar ||
    record.focusChar > record.endChar;
  if (
    typeof record.parentId !== "string" ||
    record.parentId.length === 0 ||
    rangeInvalid ||
    !Array.isArray(record.spans) ||
    record.spans.length === 0 ||
    typeof record.textHash !== "string" ||
    record.textHash.length === 0 ||
    !isValidLineSpan(record.parentLineSpan)
  ) {
    throw new EmbeddingQuantError("invalid-record", `${where} is invalid`);
  }
  for (const span of record.spans) {
    if (
      !isNonNegativeInteger(span.startChar) ||
      !isNonNegativeInteger(span.endChar) ||
      span.endChar < span.startChar
    ) {
      throw new EmbeddingQuantError(
        "invalid-record",
        `${where} has a bad span`,
      );
    }
  }
}

function nextGenerationName(): string {
  generationCounter += 1;
  return `gen-i8-${Date.now().toString(36)}-${generationCounter.toString(36)}`;
}

function nextTempName(): string {
  tempCounter += 1;
  return tempCounter.toString(36);
}

function unitIdentity(unit: EmbeddingVectorUnit): {
  unitKind: "conversation" | "memory";
  unitKey: string;
} {
  return "memoryFileKey" in unit
    ? { unitKind: "memory", unitKey: unit.memoryFileKey }
    : { unitKind: "conversation", unitKey: unit.conversationKey };
}

// ---------------------------------------------------------------------------
// Tolerant read
// ---------------------------------------------------------------------------

export type EmbeddingQuantReadOptions = {
  /** Reuse an already-read pointer (the cache does this). */
  pointer?: EmbeddingIndexPointer;
  /**
   * Decode `vectors.float32.bin` when present. Default `true`; the int8-only
   * cache mode passes `false` so the originals never become resident.
   */
  includeFloat32?: boolean;
};

export type EmbeddingQuantReadResult =
  | { ok: true; snapshot: EmbeddingQuantIndexSnapshot }
  | { ok: false; problem: EmbeddingIndexProblem; detail?: string };

/** Reads and validates an int8 generation. Never throws. */
export function readEmbeddingQuantIndex(
  unitDir: string,
  options: EmbeddingQuantReadOptions = {},
): EmbeddingQuantReadResult {
  let pointer = options.pointer;
  if (pointer === undefined) {
    const result = readEmbeddingIndexPointer(unitDir);
    if (!result.ok) return result;
    pointer = result.pointer;
  }
  if (pointer.formatVersion !== EMBEDDING_INDEX_FORMAT_VERSION) {
    return failure(
      "version-mismatch",
      `pointer formatVersion ${pointer.formatVersion}`,
    );
  }
  if (pointer.quant !== "int8") {
    return failure("unsupported-quant", `the int8 reader got ${pointer.quant}`);
  }
  let generationDir: string;
  try {
    generationDir = embeddingGenerationDir(unitDir, pointer.generation);
  } catch (error) {
    return failure("corrupt", errorMessage(error));
  }
  const metaResult = readQuantMeta(generationDir);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.meta;
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
  if (meta.vectorsBytes !== meta.chunkCount * meta.dimensions) {
    return failure("corrupt", "meta vectorsBytes disagree with int8 row size");
  }
  let recordsBytes: Buffer;
  let codesBytes: Buffer;
  let exactBytes: Buffer | undefined;
  try {
    recordsBytes = readFileSync(
      join(generationDir, EMBEDDING_INDEX_FILE_NAMES.records),
    );
    codesBytes = readFileSync(
      join(generationDir, EMBEDDING_INDEX_FILE_NAMES.vectors),
    );
    if (meta.float32VectorsBytes > 0 && options.includeFloat32 !== false) {
      exactBytes = readFileSync(
        join(generationDir, EMBEDDING_QUANT_FLOAT32_FILE_NAME),
      );
    }
  } catch (error) {
    return failure("unreadable", errorMessage(error));
  }
  if (
    recordsBytes.byteLength !== meta.recordsBytes ||
    codesBytes.byteLength !== meta.vectorsBytes
  ) {
    return failure("corrupt", "generation file size does not match meta");
  }
  if (quantChecksum(recordsBytes, codesBytes) !== meta.checksum) {
    return failure(
      "checksum-mismatch",
      "records/int8-vectors checksum does not match meta",
    );
  }
  if (
    exactBytes !== undefined &&
    (exactBytes.byteLength !== meta.float32VectorsBytes ||
      meta.float32Checksum === undefined ||
      sha256Hex(exactBytes) !== meta.float32Checksum)
  ) {
    return failure(
      "checksum-mismatch",
      "float32-originals file does not match meta",
    );
  }
  const records = parseQuantRecords(recordsBytes, meta);
  if (records === undefined) {
    return failure("corrupt", "records.jsonl failed validation");
  }
  const codes = new Int8Array(codesBytes.byteLength);
  codes.set(
    new Int8Array(
      codesBytes.buffer,
      codesBytes.byteOffset,
      codesBytes.byteLength,
    ),
  );
  const scales = new Float32Array(records.length);
  for (let row = 0; row < records.length; row += 1) {
    scales[row] = records[row]?.vectorScale ?? 0;
  }
  const exactVectors =
    exactBytes === undefined ? undefined : decodeFloat32Vectors(exactBytes);
  return {
    ok: true,
    snapshot: {
      unitDir,
      generation: pointer.generation,
      pointer,
      meta,
      records,
      codes,
      scales,
      ...(exactVectors === undefined ? {} : { exactVectors }),
      mode: exactVectors === undefined ? "int8-only" : "int8-rescore",
      rescoreUnavailable: exactVectors === undefined,
    },
  };
}

function readQuantMeta(
  generationDir: string,
): { ok: true; meta: EmbeddingQuantIndexMeta } | EmbeddingQuantReadFailure {
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
  const meta = parseQuantMeta(parsed);
  if (meta === undefined) return failure("corrupt", "invalid meta.json");
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
  if (meta.float32VectorsBytes === 0 && meta.float32Checksum !== undefined) {
    return failure("corrupt", "meta has a float32 checksum but no file");
  }
  return { ok: true, meta };
}

type EmbeddingQuantReadFailure = {
  ok: false;
  problem: EmbeddingIndexProblem;
  detail?: string;
};

function parseQuantMeta(value: unknown): EmbeddingQuantIndexMeta | undefined {
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
    value.quant !== "int8" ||
    !isNonNegativeInteger(value.parentCount) ||
    !isNonNegativeInteger(value.chunkCount) ||
    coverage === undefined ||
    typeof value.createdAt !== "string" ||
    typeof value.checksum !== "string" ||
    !isNonNegativeInteger(value.recordsBytes) ||
    !isNonNegativeInteger(value.vectorsBytes) ||
    !isNonNegativeInteger(value.float32VectorsBytes) ||
    (value.float32Checksum !== undefined &&
      typeof value.float32Checksum !== "string")
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
    quant: "int8",
    parentCount: value.parentCount,
    chunkCount: value.chunkCount,
    coverage,
    createdAt: value.createdAt,
    checksum: value.checksum,
    recordsBytes: value.recordsBytes,
    vectorsBytes: value.vectorsBytes,
    float32VectorsBytes: value.float32VectorsBytes,
    ...(value.float32Checksum === undefined
      ? {}
      : { float32Checksum: value.float32Checksum }),
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

function parseQuantRecords(
  bytes: Buffer,
  meta: EmbeddingQuantIndexMeta,
): EmbeddingQuantChunkRecord[] | undefined {
  const lines = bytes.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== meta.chunkCount) return undefined;
  const records: EmbeddingQuantChunkRecord[] = [];
  for (const [row, line] of lines.entries()) {
    if (line === undefined || line.trim() === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    const record = parseQuantRecord(parsed, row, meta);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return records;
}

function parseQuantRecord(
  value: unknown,
  row: number,
  meta: EmbeddingQuantIndexMeta,
): EmbeddingQuantChunkRecord | undefined {
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
    value.vectorOffset !== row * meta.dimensions ||
    !isFiniteNumber(value.vectorScale) ||
    value.vectorScale < 0 ||
    !isValidLineSpan(value.parentLineSpan)
  ) {
    return undefined;
  }
  const record: EmbeddingQuantChunkRecord = {
    parentId: value.parentId,
    chunkIndex: value.chunkIndex,
    startChar: value.startChar,
    endChar: value.endChar,
    spans,
    focusChar: value.focusChar,
    textHash: value.textHash,
    norm: value.norm,
    vectorOffset: value.vectorOffset,
    vectorScale: value.vectorScale,
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

function decodeFloat32Vectors(bytes: Buffer): Float32Array {
  const vectors = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < vectors.length; index += 1) {
    vectors[index] = bytes.readFloatLE(index * 4);
  }
  return vectors;
}

function failure(
  problem: EmbeddingIndexProblem,
  detail?: string,
): EmbeddingQuantReadFailure {
  return detail === undefined
    ? { ok: false, problem }
    : { ok: false, problem, detail };
}

function quantChecksum(recordsBytes: Buffer, codesBytes: Buffer): string {
  const hash = createHash("sha256");
  hash.update(recordsBytes);
  hash.update(codesBytes);
  return hash.digest("hex");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
