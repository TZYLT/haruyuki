/**
 * Native int8 IVF-Flat index for the vector-recall corpus (feature 48, D-23).
 *
 * `embedding-ann-index.ts` (B7) is the float32 index. An int8-only space never
 * materializes a float32 view — that is the memory int8 was chosen to avoid —
 * so it cannot use B7's `buildAnnIndex`. This module is the native path:
 *
 * - **Training** dequantizes only the sampled rows (≤ `trainSample`, 4096 by
 *   default) into a scratch matrix and reuses B7's Lloyd trainer, so the
 *   centroids match the float32 index built on the same dequantized rows.
 * - **Assignment** scores `Σ code·centroid` instead of `Σ v·centroid`. A row's
 *   dequantized vector is `code × scale` with `scale ≥ 0`, so the scale cannot
 *   change the argmax: assignment is exactly the same as on the dequantized
 *   vector, without building one.
 * - **Search** probes B7's `nprobe` lists and scores each candidate chunk with
 *   `Σ (code·query) × scale` — the same inner product `embedding-quant.ts`
 *   computes for the brute-force reader, so ANN and flat agree on the score for
 *   every chunk they both visit.
 * - **Serialization** is B7's layout with header kind `2` (flat `0`, float32
 *   IVF `1`): centroids, list offsets and list ids only. Codes and scales stay
 *   in B2's int8 generation; the sidecar never duplicates them.
 *
 * No vector data is copied here except the bounded training sample and the
 * `count`-sized row→unit table (4 bytes per chunk).
 *
 * Layer: `backend/local/`. Imports `embedding-ann-index.ts` (same layer,
 * itself dependency-free) and `embedding-quant.ts`; no `cli/`, `websocket/`,
 * `reminders/` or `agent/`.
 */

import {
  ANN_INDEX_SERIAL_HEADER_BYTES,
  ANN_INDEX_SERIAL_MAGIC,
  ANN_INDEX_SERIAL_VERSION,
  type AnnIndex,
  AnnIndexError,
  type AnnIndexMeta,
  type AnnIndexStats,
  type AnnIvfOptionOverrides,
  type AnnIvfOptions,
  type AnnSearchResult,
  createTopKCollector,
  fnv1a,
  hitsFromCollector,
  type IvfParts,
  ivfPayloadBytes,
  offerTopK,
  resolveAnnIvfOptions,
  trainCentroids,
  validateSearchInput,
  writeSerialHeader,
} from "./embedding-ann-index";
import { approximateEmbeddingInnerProduct } from "./embedding-quant";

/** Serialized header kind byte for the native int8 IVF index. */
export const ANN_INT8_SERIAL_KIND = 2;

/** One B2 int8 unit: signed codes plus one scale per row. */
export type AnnInt8UnitRows = {
  /** Row-major signed codes, `count × dimensions`. */
  codes: Int8Array;
  /** One non-negative scale per row (`0` for an all-zero vector). */
  scales: Float32Array;
  /** Rows in this unit; `codes.length === count × dimensions`. */
  count: number;
};

export type AnnInt8BuildInput = {
  /** Units in the sidecar manifest's chunk-id order. */
  units: readonly AnnInt8UnitRows[];
  /** Total rows across `units`. */
  count: number;
  dimensions: number;
  meta?: AnnIndexMeta;
};

export type AnnInt8BuildOptions = { ivf?: AnnIvfOptionOverrides };

type Int8RowTable = {
  /** Global row id → unit index. */
  unitOfRow: Uint32Array;
  /** Unit index → first global row id (`units.length + 1` entries). */
  unitStart: Uint32Array;
};

function requireInteger(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new AnnIndexError(
      "invalid-input",
      `${name} must be an integer >= ${minimum}, got ${value}`,
    );
  }
  return value;
}

function assertInt8BuildInput(input: AnnInt8BuildInput): void {
  const count = requireInteger(input.count, "count", 0);
  const dimensions = requireInteger(input.dimensions, "dimensions", 1);
  if (!Array.isArray(input.units)) {
    throw new AnnIndexError("invalid-input", "units must be an array");
  }
  let rows = 0;
  for (const [index, unit] of input.units.entries()) {
    if (!(unit.codes instanceof Int8Array)) {
      throw new AnnIndexError(
        "invalid-input",
        `unit ${index} codes must be an Int8Array`,
      );
    }
    if (!(unit.scales instanceof Float32Array)) {
      throw new AnnIndexError(
        "invalid-input",
        `unit ${index} scales must be a Float32Array`,
      );
    }
    const unitRows = requireInteger(unit.count, `unit ${index} count`, 0);
    if (unit.codes.length !== unitRows * dimensions) {
      throw new AnnIndexError(
        "invalid-input",
        `unit ${index} holds ${unit.codes.length} codes, expected ${unitRows} × ${dimensions}`,
      );
    }
    if (unit.scales.length !== unitRows) {
      throw new AnnIndexError(
        "invalid-input",
        `unit ${index} has ${unit.scales.length} scales, expected ${unitRows}`,
      );
    }
    for (let row = 0; row < unitRows; row += 1) {
      const scale = unit.scales[row] ?? 0;
      if (!Number.isFinite(scale) || scale < 0) {
        throw new AnnIndexError(
          "invalid-input",
          `unit ${index} row ${row} has an invalid scale: ${scale}`,
        );
      }
    }
    rows += unitRows;
  }
  if (rows !== count) {
    throw new AnnIndexError(
      "invalid-input",
      `units hold ${rows} rows, input says ${count}`,
    );
  }
}

function buildRowTable(
  units: readonly AnnInt8UnitRows[],
  count: number,
): Int8RowTable {
  const unitOfRow = new Uint32Array(count);
  const unitStart = new Uint32Array(units.length + 1);
  let row = 0;
  for (const [index, unit] of units.entries()) {
    unitStart[index] = row;
    unitOfRow.fill(index, row, row + unit.count);
    row += unit.count;
  }
  unitStart[units.length] = row;
  return { unitOfRow, unitStart };
}

/**
 * Nearest centroid for one row, scored on the codes alone.
 *
 * The row's dequantized vector is `code × scale`; with `scale ≥ 0` the argmax
 * of `(code × scale)·centroid` is the argmax of `code·centroid`, so this needs
 * neither the float32 row nor the scale.
 */
function nearestCentroidByCodes(
  codes: Int8Array,
  origin: number,
  centroids: Float32Array,
  nlist: number,
  dimensions: number,
): number {
  let best = 0;
  let bestDot = -Infinity;
  for (let center = 0; center < nlist; center += 1) {
    const centroidOrigin = center * dimensions;
    let sum = 0;
    for (let axis = 0; axis < dimensions; axis += 1) {
      sum +=
        (codes[origin + axis] ?? 0) * (centroids[centroidOrigin + axis] ?? 0);
    }
    if (sum > bestDot) {
      bestDot = sum;
      best = center;
    }
  }
  return best;
}

/**
 * Dequantizes the training sample into one compact scratch matrix.
 *
 * `trainCentroids` samples it with `Math.floor(sample * count / trainSample)`,
 * so passing `trainSample` as its count visits every row exactly once.
 */
function sampleVectors(
  input: AnnInt8BuildInput,
  trainSample: number,
  table: Int8RowTable,
): Float32Array {
  const { units, count, dimensions } = input;
  const matrix = new Float32Array(trainSample * dimensions);
  for (let sample = 0; sample < trainSample; sample += 1) {
    const row = Math.floor((sample * count) / trainSample);
    const unitIndex = table.unitOfRow[row] ?? 0;
    const unit = units[unitIndex];
    if (unit === undefined) continue;
    const local = row - (table.unitStart[unitIndex] ?? 0);
    const origin = local * dimensions;
    const scale = unit.scales[local] ?? 0;
    const target = sample * dimensions;
    for (let axis = 0; axis < dimensions; axis += 1) {
      matrix[target + axis] = (unit.codes[origin + axis] ?? 0) * scale;
    }
  }
  return matrix;
}

function createInt8Index(
  input: AnnInt8BuildInput,
  options: AnnIvfOptions,
  parts: IvfParts,
): AnnIndex {
  const { units, count, dimensions } = input;
  const { centroids, listOffsets, listIds } = parts;
  const table = buildRowTable(units, count);
  return {
    kind: "ivf",
    meta: input.meta,
    search(query: ArrayLike<number>, k: number): AnnSearchResult {
      const invalid = validateSearchInput(query, dimensions, k);
      if (invalid !== null) return invalid;
      if (count === 0 || options.nlist === 0) {
        return { ok: true, hits: [], scannedVectors: 0 };
      }
      const probe = createTopKCollector(options.nprobe);
      for (let center = 0; center < options.nlist; center += 1) {
        let sum = 0;
        const centroidOrigin = center * dimensions;
        for (let axis = 0; axis < dimensions; axis += 1) {
          sum += (centroids[centroidOrigin + axis] ?? 0) * (query[axis] ?? 0);
        }
        offerTopK(probe, center, sum);
      }
      const collector = createTopKCollector(k);
      let scannedVectors = 0;
      for (const center of probe.ids) {
        const start = listOffsets[center] ?? 0;
        const end = listOffsets[center + 1] ?? start;
        for (let position = start; position < end; position += 1) {
          const id = listIds[position] ?? 0;
          const unitIndex = table.unitOfRow[id] ?? 0;
          const unit = units[unitIndex];
          if (unit !== undefined) {
            const local = id - (table.unitStart[unitIndex] ?? 0);
            offerTopK(
              collector,
              id,
              approximateEmbeddingInnerProduct(
                unit.codes,
                local * dimensions,
                unit.scales[local] ?? 0,
                query,
              ),
            );
          }
          scannedVectors += 1;
        }
      }
      return { ok: true, hits: hitsFromCollector(collector), scannedVectors };
    },
    stats(): AnnIndexStats {
      return {
        kind: "ivf",
        count,
        dimensions,
        indexBytes:
          ANN_INDEX_SERIAL_HEADER_BYTES +
          ivfPayloadBytes(count, dimensions, options),
        params: { ...options, int8: 1 },
      };
    },
    serialize(): Uint8Array {
      return serializeInt8Ivf(count, dimensions, options, parts);
    },
  };
}

function serializeInt8Ivf(
  count: number,
  dimensions: number,
  options: AnnIvfOptions,
  parts: IvfParts,
): Uint8Array {
  const output = new Uint8Array(
    ANN_INDEX_SERIAL_HEADER_BYTES + ivfPayloadBytes(count, dimensions, options),
  );
  const view = new DataView(output.buffer);
  writeSerialHeader(view, ANN_INT8_SERIAL_KIND, count, dimensions, options);
  let offset = ANN_INDEX_SERIAL_HEADER_BYTES;
  output.set(
    new Uint8Array(
      parts.centroids.buffer,
      parts.centroids.byteOffset,
      parts.centroids.byteLength,
    ),
    offset,
  );
  offset += parts.centroids.byteLength;
  for (const listOffset of parts.listOffsets) {
    view.setUint32(offset, listOffset, true);
    offset += 4;
  }
  for (const id of parts.listIds) {
    view.setUint32(offset, id, true);
    offset += 4;
  }
  view.setUint32(32, fnv1a(output, ANN_INDEX_SERIAL_HEADER_BYTES), true);
  return output;
}

function failCorrupt(detail: string): never {
  throw new AnnIndexError("corrupt-serialized", detail);
}

/**
 * Builds a native int8 IVF index from B2's codes and scales.
 *
 * The options resolve exactly as B7's (`nlist ≈ √count`, `nprobe = nlist/8`,
 * 4096 training rows, 4 Lloyd rounds), so a test can compare this index with
 * the float32 index built on the dequantized rows.
 */
export function buildAnnInt8Index(
  input: AnnInt8BuildInput,
  options: AnnInt8BuildOptions = {},
): AnnIndex {
  assertInt8BuildInput(input);
  const { count, dimensions } = input;
  const resolved = resolveAnnIvfOptions(count, options.ivf);
  if (count === 0) {
    return createInt8Index(input, resolved, {
      centroids: new Float32Array(0),
      listOffsets: new Uint32Array(0),
      listIds: new Uint32Array(0),
    });
  }
  const { nlist } = resolved;
  const table = buildRowTable(input.units, count);
  const sample = sampleVectors(input, resolved.trainSample, table);
  const centroids = trainCentroids(
    sample,
    resolved.trainSample,
    dimensions,
    resolved,
  );
  const listOf = new Uint32Array(count);
  const counts = new Uint32Array(nlist);
  for (let row = 0; row < count; row += 1) {
    const unitIndex = table.unitOfRow[row] ?? 0;
    const unit = input.units[unitIndex];
    if (unit === undefined) continue;
    const local = row - (table.unitStart[unitIndex] ?? 0);
    const best = nearestCentroidByCodes(
      unit.codes,
      local * dimensions,
      centroids,
      nlist,
      dimensions,
    );
    listOf[row] = best;
    counts[best] = (counts[best] ?? 0) + 1;
  }
  const listOffsets = new Uint32Array(nlist + 1);
  for (let center = 0; center < nlist; center += 1) {
    listOffsets[center + 1] =
      (listOffsets[center] ?? 0) + (counts[center] ?? 0);
  }
  const cursors = Uint32Array.from(listOffsets.subarray(0, nlist));
  const listIds = new Uint32Array(count);
  for (let row = 0; row < count; row += 1) {
    const list = listOf[row] ?? 0;
    const cursor = cursors[list] ?? 0;
    listIds[cursor] = row;
    cursors[list] = cursor + 1;
  }
  return createInt8Index(input, resolved, { centroids, listOffsets, listIds });
}

/**
 * Reads a serialized int8 IVF index and binds it to the live int8 units.
 *
 * Same validation shape as B7's `deserializeAnnIndex`; a header kind other
 * than `2` is `corrupt-serialized` (a float32 sidecar must never be read as
 * int8, and vice versa).
 */
export function deserializeAnnInt8Index(
  data: Uint8Array,
  input: AnnInt8BuildInput,
): AnnIndex {
  assertInt8BuildInput(input);
  if (data.byteLength < ANN_INDEX_SERIAL_HEADER_BYTES) {
    failCorrupt(
      `truncated header: ${data.byteLength} < ${ANN_INDEX_SERIAL_HEADER_BYTES} bytes`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index < ANN_INDEX_SERIAL_MAGIC.length; index += 1) {
    if (view.getUint8(index) !== ANN_INDEX_SERIAL_MAGIC.charCodeAt(index)) {
      failCorrupt("bad magic");
    }
  }
  const version = view.getUint16(4, true);
  if (version !== ANN_INDEX_SERIAL_VERSION) {
    failCorrupt(
      `unsupported serial version ${version}, expected ${ANN_INDEX_SERIAL_VERSION}`,
    );
  }
  const kind = view.getUint8(6);
  if (kind !== ANN_INT8_SERIAL_KIND) {
    failCorrupt(`header kind ${kind} is not an int8 IVF index`);
  }
  const count = view.getUint32(8, true);
  const dimensions = view.getUint32(12, true);
  if (count !== input.count || dimensions !== input.dimensions) {
    failCorrupt(
      `sidecar shape ${count}×${dimensions} does not match input ${input.count}×${input.dimensions}`,
    );
  }
  const options: AnnIvfOptions = {
    nlist: view.getUint32(16, true),
    nprobe: view.getUint32(20, true),
    trainSample: view.getUint32(24, true),
    iterations: view.getUint32(28, true),
  };
  if (count === 0) {
    if (
      options.nlist !== 0 ||
      options.nprobe !== 0 ||
      options.trainSample !== 0 ||
      options.iterations !== 0
    ) {
      failCorrupt("empty index carries non-zero parameters");
    }
  } else if (
    options.nlist < 1 ||
    options.nlist > count ||
    options.nprobe < 1 ||
    options.nprobe > options.nlist ||
    options.trainSample < options.nlist ||
    options.trainSample > count ||
    options.iterations < 1
  ) {
    failCorrupt("incoherent IVF parameters");
  }
  const payloadBytes = ivfPayloadBytes(count, dimensions, options);
  if (data.byteLength !== ANN_INDEX_SERIAL_HEADER_BYTES + payloadBytes) {
    failCorrupt(
      `payload is ${data.byteLength - ANN_INDEX_SERIAL_HEADER_BYTES} bytes, expected ${payloadBytes}`,
    );
  }
  if (view.getUint32(32, true) !== fnv1a(data, ANN_INDEX_SERIAL_HEADER_BYTES)) {
    failCorrupt("sidecar checksum mismatch");
  }
  if (count === 0) {
    return createInt8Index(input, options, {
      centroids: new Float32Array(0),
      listOffsets: new Uint32Array(0),
      listIds: new Uint32Array(0),
    });
  }
  const centroidCount = options.nlist * dimensions;
  const centroids = new Float32Array(centroidCount);
  let offset = ANN_INDEX_SERIAL_HEADER_BYTES;
  for (let index = 0; index < centroidCount; index += 1) {
    const value = view.getFloat32(offset, true);
    if (!Number.isFinite(value)) failCorrupt("non-finite centroid");
    centroids[index] = value;
    offset += 4;
  }
  const listOffsets = new Uint32Array(options.nlist + 1);
  for (let index = 0; index < listOffsets.length; index += 1) {
    listOffsets[index] = view.getUint32(offset, true);
    offset += 4;
  }
  for (let index = 0; index < options.nlist; index += 1) {
    const current = listOffsets[index] ?? 0;
    const next = listOffsets[index + 1] ?? 0;
    if (next < current || next > count) {
      failCorrupt("list offsets are not monotonic or exceed the count");
    }
  }
  if ((listOffsets[0] ?? 0) !== 0)
    failCorrupt("list offsets do not start at 0");
  if ((listOffsets[options.nlist] ?? 0) !== count) {
    failCorrupt("list offsets do not end at the chunk count");
  }
  const listIds = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const id = view.getUint32(offset, true);
    if (id >= count) failCorrupt(`list id ${id} is outside the corpus`);
    listIds[index] = id;
    offset += 4;
  }
  return createInt8Index(input, options, { centroids, listOffsets, listIds });
}
