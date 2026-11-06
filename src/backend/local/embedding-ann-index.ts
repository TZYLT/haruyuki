/**
 * Production ANN index for the vector-recall corpus (feature 48, package B7).
 *
 * B6 selected pure-TS IVF-Flat (docs/48-3 §8.2): at 850k chunks recall@10
 * stays 1.000 with a 3.7 MB auxiliary index, while brute force blows the
 * 300 ms budget. This module is that production index; `embedding/ann-bench.ts`
 * stays an independent zero-import reference.
 *
 * - Build: B2 `vectors.bin` order, so `hit.id` is a `records.jsonl` row.
 *   Defaults: `nlist ≈ √count` (cap 512, or 256 above 200k), `nprobe =
 *   nlist/8`, 4096 training rows, 4 Lloyd rounds, equidistant init.
 * - Search: chunk-level hits only; B2 keeps parent aggregation at the top.
 * - Shards: one index per `(agentId, spaceId)`; every shard is searched and
 *   fused into one global top-k. Tiny shards fall back to exact flat.
 * - Rebuild: `rebuildAnnShard` replaces one shard and reuses the other shard
 *   objects (immutable B2 generations ⇒ only the changed space moves).
 * - Persistence: `serialize()` holds auxiliary bytes only (centroids,
 *   offsets, ids); vectors stay in B2 `vectors.bin`. One sidecar per shard.
 *
 * Trigger `shouldUseAnn`: `chunkCount > 200_000 || p95 > 150 ms`. Below it the
 * caller keeps B2's scan; `buildFlatAnnIndex` shares the interface.
 *
 * Search never throws (typed failures degrade to lexical recall); build,
 * deserialize and option misuse throw `AnnIndexError` with a `code`.
 *
 * Layer: `backend/local/`; zero imports, no new dependency.
 */

export const ANN_TRIGGER_CHUNK_COUNT = 200_000;
export const ANN_TRIGGER_P95_MS = 150;
export const ANN_LIST_CAP_BELOW_TRIGGER = 512;
export const ANN_LIST_CAP_ABOVE_TRIGGER = 256;
export const ANN_SHARD_FLAT_THRESHOLD = 512;
export const ANN_INDEX_SERIAL_VERSION = 1;
export const ANN_INDEX_SERIAL_MAGIC = "HANN";
export const ANN_INDEX_SERIAL_HEADER_BYTES = 36;

export type AnnIndexKind = "ivf" | "flat";
export type AnnSearchProblem =
  | "empty-query"
  | "dimension-mismatch"
  | "invalid-k"
  | "invalid-index";
export type AnnSearchFailure = {
  ok: false;
  problem: AnnSearchProblem;
  detail?: string;
};
export type AnnSearchHit = { id: number; score: number };
export type AnnSearchResult =
  | { ok: true; hits: AnnSearchHit[]; scannedVectors: number }
  | AnnSearchFailure;
export type AnnIndexMeta = {
  agentId?: string;
  spaceId?: string;
  generation?: string;
  unitKey?: string;
};
export type AnnIndexBuildInput = {
  vectors: Float32Array;
  count: number;
  dimensions: number;
  meta?: AnnIndexMeta;
};
export type AnnIvfOptions = {
  nlist: number;
  nprobe: number;
  trainSample: number;
  iterations: number;
};
export type AnnIvfOptionOverrides = Partial<AnnIvfOptions>;
export type AnnIndexBuildOptions = { ivf?: AnnIvfOptionOverrides };
export type AnnIndex = {
  readonly kind: AnnIndexKind;
  readonly meta: AnnIndexMeta | undefined;
  search(query: ArrayLike<number>, k: number): AnnSearchResult;
  stats(): AnnIndexStats;
  serialize(): Uint8Array;
};
export type AnnIndexStats = {
  kind: AnnIndexKind;
  count: number;
  dimensions: number;
  indexBytes: number;
  params: Readonly<Record<string, number>>;
};
export type AnnShardInput = AnnIndexBuildInput & {
  agentId: string;
  spaceId: string;
};
export type AnnShardBuildOptions = {
  ivf?: AnnIvfOptionOverrides;
  flatThreshold?: number;
};
export type AnnShardKey = { agentId: string; spaceId: string };
export type AnnShardedSearchHit = AnnShardKey & { id: number; score: number };
export type AnnShardedSearchResult =
  | { ok: true; hits: AnnShardedSearchHit[]; scannedVectors: number }
  | AnnSearchFailure;
export type AnnShardedIndexStats = {
  kind: "sharded";
  shardCount: number;
  count: number;
  dimensions: number;
  indexBytes: number;
  params: Readonly<Record<string, number>>;
};
export type ShardedAnnIndex = {
  readonly kind: "sharded";
  readonly dimensions: number;
  search(query: ArrayLike<number>, k: number): AnnShardedSearchResult;
  stats(): AnnShardedIndexStats;
  shard(agentId: string, spaceId: string): AnnIndex | undefined;
  shardKeys(): readonly AnnShardKey[];
};
export type AnnIndexErrorCode =
  | "invalid-input"
  | "invalid-options"
  | "corrupt-serialized";
export class AnnIndexError extends Error {
  readonly code: AnnIndexErrorCode;

  constructor(code: AnnIndexErrorCode, message: string) {
    super(message);
    this.name = "AnnIndexError";
    this.code = code;
  }
}

function requireInteger(
  value: number,
  name: string,
  minimum: number,
  code: AnnIndexErrorCode = "invalid-input",
): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new AnnIndexError(
      code,
      `${name} must be an integer >= ${minimum}, got ${value}`,
    );
  }
  return value;
}
function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(Math.min(minimum, maximum), value));
}

function assertBuildInput(input: AnnIndexBuildInput): void {
  const count = requireInteger(input.count, "count", 0);
  const dimensions = requireInteger(input.dimensions, "dimensions", 1);
  if (!(input.vectors instanceof Float32Array)) {
    throw new AnnIndexError(
      "invalid-input",
      "vectors must be a Float32Array in B2 vectors.bin order",
    );
  }
  if (input.vectors.length !== count * dimensions) {
    throw new AnnIndexError(
      "invalid-input",
      `vectors has ${input.vectors.length} entries, expected ${count} × ${dimensions}`,
    );
  }
}

export function resolveAnnIvfOptions(
  count: number,
  options: AnnIvfOptionOverrides = {},
): AnnIvfOptions {
  requireInteger(count, "count", 0);
  if (count === 0) {
    return { nlist: 0, nprobe: 0, trainSample: 0, iterations: 0 };
  }
  const listCap =
    count > ANN_TRIGGER_CHUNK_COUNT
      ? ANN_LIST_CAP_ABOVE_TRIGGER
      : ANN_LIST_CAP_BELOW_TRIGGER;
  const trainSample = Math.min(
    count,
    options.trainSample === undefined
      ? 4096
      : requireInteger(
          options.trainSample,
          "trainSample",
          1,
          "invalid-options",
        ),
  );
  const nlist = Math.min(
    options.nlist === undefined
      ? clampInt(Math.round(Math.sqrt(count)), 8, listCap)
      : requireInteger(options.nlist, "nlist", 1, "invalid-options"),
    count,
    trainSample,
  );
  const defaultNprobe = clampInt(
    Math.round(nlist / 8),
    Math.min(4, nlist),
    nlist,
  );
  const nprobe = Math.min(
    options.nprobe === undefined
      ? defaultNprobe
      : requireInteger(options.nprobe, "nprobe", 1, "invalid-options"),
    nlist,
  );
  const iterations =
    options.iterations === undefined
      ? 4
      : requireInteger(options.iterations, "iterations", 1, "invalid-options");
  return { nlist, nprobe, trainSample, iterations };
}

/** Dot product of one row from `rows` with a row of `other` (or a query). */
function dot(
  rows: Float32Array,
  origin: number,
  other: ArrayLike<number>,
  otherOrigin: number,
  dimensions: number,
): number {
  let total = 0;
  for (let axis = 0; axis < dimensions; axis += 1) {
    total += (rows[origin + axis] ?? 0) * (other[otherOrigin + axis] ?? 0);
  }
  return total;
}

function normalizeRow(
  values: Float32Array,
  origin: number,
  dimensions: number,
): void {
  let sumOfSquares = 0;
  for (let axis = 0; axis < dimensions; axis += 1) {
    const value = values[origin + axis] ?? 0;
    sumOfSquares += value * value;
  }
  const norm = Math.sqrt(sumOfSquares) || 1;
  for (let axis = 0; axis < dimensions; axis += 1) {
    values[origin + axis] = (values[origin + axis] ?? 0) / norm;
  }
}

export type TopKCollector = { ids: number[]; scores: number[]; limit: number };

export function createTopKCollector(limit: number): TopKCollector {
  return { ids: [], scores: [], limit };
}

function isBetter(
  score: number,
  id: number,
  otherScore: number,
  otherId: number,
): boolean {
  return score > otherScore || (score === otherScore && id < otherId);
}

export function offerTopK(
  collector: TopKCollector,
  id: number,
  score: number,
): void {
  const { ids, scores, limit } = collector;
  if (limit <= 0) return;
  if (ids.length === limit) {
    if (!isBetter(score, id, scores[limit - 1] ?? 0, ids[limit - 1] ?? 0)) {
      return;
    }
    ids.pop();
    scores.pop();
  }
  let position = ids.length;
  while (
    position > 0 &&
    !isBetter(scores[position - 1] ?? 0, ids[position - 1] ?? 0, score, id)
  ) {
    position -= 1;
  }
  ids.splice(position, 0, id);
  scores.splice(position, 0, score);
}

export function hitsFromCollector(collector: TopKCollector): AnnSearchHit[] {
  return collector.ids.map((id, index) => ({
    id,
    score: collector.scores[index] ?? 0,
  }));
}

export function validateSearchInput(
  query: ArrayLike<number>,
  dimensions: number,
  k: number,
): AnnSearchFailure | null {
  if (!Number.isInteger(k) || k <= 0) {
    return { ok: false, problem: "invalid-k", detail: `bad k: ${k}` };
  }
  if (query.length === 0) {
    return { ok: false, problem: "empty-query", detail: "query is empty" };
  }
  if (query.length !== dimensions) {
    return {
      ok: false,
      problem: "dimension-mismatch",
      detail: `query has ${query.length} dimensions, index has ${dimensions}`,
    };
  }
  return null;
}

function nearestCentroid(
  vectors: Float32Array,
  origin: number,
  centroids: Float32Array,
  nlist: number,
  dimensions: number,
): number {
  let best = 0;
  let bestDot = -Infinity;
  for (let center = 0; center < nlist; center += 1) {
    const value = dot(
      vectors,
      origin,
      centroids,
      center * dimensions,
      dimensions,
    );
    if (value > bestDot) {
      bestDot = value;
      best = center;
    }
  }
  return best;
}

export function trainCentroids(
  vectors: Float32Array,
  count: number,
  dimensions: number,
  options: AnnIvfOptions,
): Float32Array {
  const { nlist, trainSample, iterations } = options;
  if (nlist === 0 || trainSample === 0) return new Float32Array(0);
  const sampleRow = (sample: number): number =>
    Math.floor((sample * count) / trainSample);
  const centroids = new Float32Array(nlist * dimensions);
  for (let center = 0; center < nlist; center += 1) {
    const origin =
      sampleRow(Math.floor((center * trainSample) / nlist)) * dimensions;
    for (let axis = 0; axis < dimensions; axis += 1) {
      centroids[center * dimensions + axis] = vectors[origin + axis] ?? 0;
    }
  }
  const sums = new Float64Array(nlist * dimensions);
  const counts = new Uint32Array(nlist);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    sums.fill(0);
    counts.fill(0);
    for (let sample = 0; sample < trainSample; sample += 1) {
      const origin = sampleRow(sample) * dimensions;
      const best = nearestCentroid(
        vectors,
        origin,
        centroids,
        nlist,
        dimensions,
      );
      counts[best] = (counts[best] ?? 0) + 1;
      for (let axis = 0; axis < dimensions; axis += 1) {
        const sumOrigin = best * dimensions + axis;
        sums[sumOrigin] =
          (sums[sumOrigin] ?? 0) + (vectors[origin + axis] ?? 0);
      }
    }
    for (let center = 0; center < nlist; center += 1) {
      const origin = center * dimensions;
      if ((counts[center] ?? 0) === 0) {
        const fallback =
          sampleRow((iteration + center) % trainSample) * dimensions;
        for (let axis = 0; axis < dimensions; axis += 1) {
          centroids[origin + axis] = vectors[fallback + axis] ?? 0;
        }
        continue;
      }
      for (let axis = 0; axis < dimensions; axis += 1) {
        centroids[origin + axis] = sums[origin + axis] ?? 0;
      }
      normalizeRow(centroids, origin, dimensions);
    }
  }
  return centroids;
}

export function ivfPayloadBytes(
  count: number,
  dimensions: number,
  options: AnnIvfOptions,
): number {
  if (count === 0) return 0;
  return options.nlist * dimensions * 4 + (options.nlist + 1) * 4 + count * 4;
}

export type IvfParts = {
  centroids: Float32Array;
  listOffsets: Uint32Array;
  listIds: Uint32Array;
};

function createIvfIndex(
  input: AnnIndexBuildInput,
  options: AnnIvfOptions,
  parts: IvfParts,
): AnnIndex {
  const { vectors, count, dimensions } = input;
  const { centroids, listOffsets, listIds } = parts;
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
        offerTopK(
          probe,
          center,
          dot(centroids, center * dimensions, query, 0, dimensions),
        );
      }
      const collector = createTopKCollector(k);
      let scannedVectors = 0;
      for (const center of probe.ids) {
        const start = listOffsets[center] ?? 0;
        const end = listOffsets[center + 1] ?? start;
        for (let position = start; position < end; position += 1) {
          const id = listIds[position] ?? 0;
          offerTopK(
            collector,
            id,
            dot(vectors, id * dimensions, query, 0, dimensions),
          );
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
        params: { ...options },
      };
    },
    serialize(): Uint8Array {
      return serializeIvf(count, dimensions, options, parts);
    },
  };
}

export function buildAnnIndex(
  input: AnnIndexBuildInput,
  options: AnnIndexBuildOptions = {},
): AnnIndex {
  assertBuildInput(input);
  const { vectors, count, dimensions } = input;
  const resolved = resolveAnnIvfOptions(count, options.ivf);
  if (count === 0) {
    return createIvfIndex(input, resolved, {
      centroids: new Float32Array(0),
      listOffsets: new Uint32Array(0),
      listIds: new Uint32Array(0),
    });
  }
  const { nlist } = resolved;
  const centroids = trainCentroids(vectors, count, dimensions, resolved);
  const listOf = new Uint32Array(count);
  const counts = new Uint32Array(nlist);
  for (let id = 0; id < count; id += 1) {
    const best = nearestCentroid(
      vectors,
      id * dimensions,
      centroids,
      nlist,
      dimensions,
    );
    listOf[id] = best;
    counts[best] = (counts[best] ?? 0) + 1;
  }
  const listOffsets = new Uint32Array(nlist + 1);
  for (let center = 0; center < nlist; center += 1) {
    listOffsets[center + 1] =
      (listOffsets[center] ?? 0) + (counts[center] ?? 0);
  }
  const cursors = Uint32Array.from(listOffsets.subarray(0, nlist));
  const listIds = new Uint32Array(count);
  for (let id = 0; id < count; id += 1) {
    const list = listOf[id] ?? 0;
    const cursor = cursors[list] ?? 0;
    listIds[cursor] = id;
    cursors[list] = cursor + 1;
  }
  return createIvfIndex(input, resolved, { centroids, listOffsets, listIds });
}

export function buildFlatAnnIndex(input: AnnIndexBuildInput): AnnIndex {
  assertBuildInput(input);
  const { vectors, count, dimensions } = input;
  return {
    kind: "flat",
    meta: input.meta,
    search(query: ArrayLike<number>, k: number): AnnSearchResult {
      const invalid = validateSearchInput(query, dimensions, k);
      if (invalid !== null) return invalid;
      const collector = createTopKCollector(k);
      for (let id = 0; id < count; id += 1) {
        offerTopK(
          collector,
          id,
          dot(vectors, id * dimensions, query, 0, dimensions),
        );
      }
      return {
        ok: true,
        hits: hitsFromCollector(collector),
        scannedVectors: count,
      };
    },
    stats(): AnnIndexStats {
      return {
        kind: "flat",
        count,
        dimensions,
        indexBytes: ANN_INDEX_SERIAL_HEADER_BYTES,
        params: {},
      };
    },
    serialize(): Uint8Array {
      return serializeFlat(count, dimensions);
    },
  };
}

export function fnv1a(bytes: Uint8Array, start: number): number {
  let hash = 0x811c9dc5;
  for (let index = start; index < bytes.length; index += 1) {
    hash ^= bytes[index] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function writeSerialHeader(
  view: DataView,
  kind: number,
  count: number,
  dimensions: number,
  options: AnnIvfOptions | null,
): void {
  for (let index = 0; index < ANN_INDEX_SERIAL_MAGIC.length; index += 1) {
    view.setUint8(index, ANN_INDEX_SERIAL_MAGIC.charCodeAt(index));
  }
  view.setUint16(4, ANN_INDEX_SERIAL_VERSION, true);
  view.setUint8(6, kind);
  view.setUint8(7, 0);
  view.setUint32(8, count, true);
  view.setUint32(12, dimensions, true);
  view.setUint32(16, options?.nlist ?? 0, true);
  view.setUint32(20, options?.nprobe ?? 0, true);
  view.setUint32(24, options?.trainSample ?? 0, true);
  view.setUint32(28, options?.iterations ?? 0, true);
  view.setUint32(32, 0, true); // checksum placeholder
}

function serializeFlat(count: number, dimensions: number): Uint8Array {
  const output = new Uint8Array(ANN_INDEX_SERIAL_HEADER_BYTES);
  const view = new DataView(output.buffer);
  writeSerialHeader(view, 0, count, dimensions, null);
  view.setUint32(32, fnv1a(output, ANN_INDEX_SERIAL_HEADER_BYTES), true);
  return output;
}

function serializeIvf(
  count: number,
  dimensions: number,
  options: AnnIvfOptions,
  parts: IvfParts,
): Uint8Array {
  const output = new Uint8Array(
    ANN_INDEX_SERIAL_HEADER_BYTES + ivfPayloadBytes(count, dimensions, options),
  );
  const view = new DataView(output.buffer);
  writeSerialHeader(view, 1, count, dimensions, options);
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

export function deserializeAnnIndex(
  data: Uint8Array,
  input: AnnIndexBuildInput,
): AnnIndex {
  assertBuildInput(input);
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
  const count = view.getUint32(8, true);
  const dimensions = view.getUint32(12, true);
  if (count !== input.count || dimensions !== input.dimensions) {
    failCorrupt(
      `sidecar shape ${count}×${dimensions} does not match input ${input.count}×${input.dimensions}`,
    );
  }
  if (kind === 0) {
    if (
      data.byteLength !== ANN_INDEX_SERIAL_HEADER_BYTES ||
      view.getUint32(32, true) !== fnv1a(data, ANN_INDEX_SERIAL_HEADER_BYTES)
    ) {
      failCorrupt("flat sidecar is malformed");
    }
    return buildFlatAnnIndex(input);
  }
  if (kind !== 1) failCorrupt(`unknown index kind byte ${kind}`);
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
    return createIvfIndex(input, options, {
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
  return createIvfIndex(input, options, { centroids, listOffsets, listIds });
}

export function shouldUseAnn(chunkCount: number, p95Ms?: number): boolean {
  requireInteger(chunkCount, "chunkCount", 0);
  if (chunkCount > ANN_TRIGGER_CHUNK_COUNT) return true;
  if (p95Ms === undefined) return false;
  if (!Number.isFinite(p95Ms) || p95Ms < 0) {
    throw new AnnIndexError(
      "invalid-input",
      `p95Ms must be a non-negative finite number, got ${p95Ms}`,
    );
  }
  return p95Ms > ANN_TRIGGER_P95_MS;
}

type InternalShardEntry = {
  agentId: string;
  spaceId: string;
  index: AnnIndex;
};

function shardKeyOf(agentId: string, spaceId: string): string {
  return `${agentId}\u0000${spaceId}`;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareShardKeys(left: AnnShardKey, right: AnnShardKey): number {
  return (
    compareText(left.agentId, right.agentId) ||
    compareText(left.spaceId, right.spaceId)
  );
}

function compareShardedHits(
  left: AnnShardedSearchHit,
  right: AnnShardedSearchHit,
): number {
  return (
    right.score - left.score ||
    compareText(left.agentId, right.agentId) ||
    compareText(left.spaceId, right.spaceId) ||
    left.id - right.id
  );
}

function validateShardInputs(shards: readonly AnnShardInput[]): number {
  if (!Array.isArray(shards) || shards.length === 0) {
    throw new AnnIndexError("invalid-input", "at least one shard is required");
  }
  const seen = new Set<string>();
  let dimensions: number | undefined;
  for (const shard of shards) {
    if (typeof shard.agentId !== "string" || shard.agentId.length === 0) {
      throw new AnnIndexError("invalid-input", "agentId must be non-empty");
    }
    if (typeof shard.spaceId !== "string" || shard.spaceId.length === 0) {
      throw new AnnIndexError("invalid-input", "spaceId must be non-empty");
    }
    assertBuildInput(shard);
    const key = shardKeyOf(shard.agentId, shard.spaceId);
    if (seen.has(key)) {
      throw new AnnIndexError(
        "invalid-input",
        `duplicate shard ${shard.agentId}/${shard.spaceId}`,
      );
    }
    seen.add(key);
    if (dimensions === undefined) {
      dimensions = shard.dimensions;
    } else if (dimensions !== shard.dimensions) {
      throw new AnnIndexError(
        "invalid-input",
        `shard ${shard.agentId}/${shard.spaceId} has ${shard.dimensions} dimensions, expected ${dimensions}`,
      );
    }
  }
  return dimensions ?? 1;
}

function resolveFlatThreshold(options: AnnShardBuildOptions): number {
  return options.flatThreshold === undefined
    ? ANN_SHARD_FLAT_THRESHOLD
    : requireInteger(
        options.flatThreshold,
        "flatThreshold",
        0,
        "invalid-options",
      );
}

function buildShardIndex(
  shard: AnnShardInput,
  options: AnnShardBuildOptions,
  flatThreshold: number,
): AnnIndex {
  const { agentId: _agentId, spaceId: _spaceId, ...input } = shard;
  if (shard.count < flatThreshold) return buildFlatAnnIndex(input);
  return buildAnnIndex(input, { ivf: options.ivf });
}

function searchShardedIndex(
  entries: readonly InternalShardEntry[],
  dimensions: number,
  query: ArrayLike<number>,
  k: number,
): AnnShardedSearchResult {
  const invalid = validateSearchInput(query, dimensions, k);
  if (invalid !== null) return invalid;
  const hits: AnnShardedSearchHit[] = [];
  let scannedVectors = 0;
  for (const entry of entries) {
    const result = entry.index.search(query, k);
    if (!result.ok) {
      return {
        ok: false,
        problem: result.problem,
        detail: `${entry.agentId}/${entry.spaceId}: ${result.detail ?? result.problem}`,
      };
    }
    scannedVectors += result.scannedVectors;
    for (const hit of result.hits) {
      hits.push({
        agentId: entry.agentId,
        spaceId: entry.spaceId,
        id: hit.id,
        score: hit.score,
      });
    }
  }
  hits.sort(compareShardedHits);
  return { ok: true, hits: hits.slice(0, k), scannedVectors };
}

function createShardedIndex(
  entries: readonly InternalShardEntry[],
  dimensions: number,
): ShardedAnnIndex {
  const ordered = [...entries].sort(compareShardKeys);
  const byKey = new Map<string, AnnIndex>();
  for (const entry of ordered) {
    byKey.set(shardKeyOf(entry.agentId, entry.spaceId), entry.index);
  }
  return {
    kind: "sharded",
    dimensions,
    search(query: ArrayLike<number>, k: number): AnnShardedSearchResult {
      return searchShardedIndex(ordered, dimensions, query, k);
    },
    stats(): AnnShardedIndexStats {
      let count = 0;
      let indexBytes = 0;
      let ivfShards = 0;
      for (const entry of ordered) {
        const shardStats = entry.index.stats();
        count += shardStats.count;
        indexBytes += shardStats.indexBytes;
        if (shardStats.kind === "ivf") ivfShards += 1;
      }
      return {
        kind: "sharded",
        shardCount: ordered.length,
        count,
        dimensions,
        indexBytes,
        params: {
          shards: ordered.length,
          ivfShards,
          flatShards: ordered.length - ivfShards,
        },
      };
    },
    shard(agentId: string, spaceId: string): AnnIndex | undefined {
      return byKey.get(shardKeyOf(agentId, spaceId));
    },
    shardKeys(): readonly AnnShardKey[] {
      return ordered.map((entry) => ({
        agentId: entry.agentId,
        spaceId: entry.spaceId,
      }));
    },
  };
}

export function buildShardedAnnIndex(
  shards: readonly AnnShardInput[],
  options: AnnShardBuildOptions = {},
): ShardedAnnIndex {
  const dimensions = validateShardInputs(shards);
  const flatThreshold = resolveFlatThreshold(options);
  return createShardedIndex(
    shards.map((shard) => ({
      agentId: shard.agentId,
      spaceId: shard.spaceId,
      index: buildShardIndex(shard, options, flatThreshold),
    })),
    dimensions,
  );
}

export function searchShardedAnnIndex(
  index: ShardedAnnIndex,
  query: ArrayLike<number>,
  options: { topK?: number } = {},
): AnnShardedSearchResult {
  return index.search(query, options.topK ?? 50);
}

export function rebuildAnnShard(
  current: ShardedAnnIndex | undefined,
  shard: AnnShardInput,
  options: AnnShardBuildOptions = {},
): ShardedAnnIndex {
  if (current === undefined) return buildShardedAnnIndex([shard], options);
  validateShardInputs([shard]);
  if (shard.dimensions !== current.dimensions) {
    throw new AnnIndexError(
      "invalid-input",
      `shard has ${shard.dimensions} dimensions, existing index has ${current.dimensions}`,
    );
  }
  const replacement = buildShardIndex(
    shard,
    options,
    resolveFlatThreshold(options),
  );
  const entries: InternalShardEntry[] = [];
  let replaced = false;
  for (const key of current.shardKeys()) {
    const existing = current.shard(key.agentId, key.spaceId);
    if (existing === undefined) continue;
    const isTarget =
      key.agentId === shard.agentId && key.spaceId === shard.spaceId;
    if (isTarget) replaced = true;
    entries.push({
      agentId: key.agentId,
      spaceId: key.spaceId,
      index: isTarget ? replacement : existing,
    });
  }
  if (!replaced) {
    entries.push({
      agentId: shard.agentId,
      spaceId: shard.spaceId,
      index: replacement,
    });
  }
  return createShardedIndex(entries, current.dimensions);
}
