/**
 * ANN selection benchmark for the recall index (feature 48, package B6).
 *
 * Phase ③ starts above **200k chunks or p95 > 150 ms**; at 100× corpus (850k
 * chunks) a linear scan cannot hold the 300 ms hard budget (docs/48-2 §4.10).
 * B6 picks the index for W7's B7 under the fork's hard constraint: **no new
 * native dependency** (AGENTS.md). `hnswlib-wasm` / `sqlite-vec` would each add
 * one, so this compares the committed brute-force path (B2 semantics:
 * normalized vectors, inner product = cosine) with two pure-TS candidates:
 * k-means IVF-Flat and banded SimHash random-projection LSH.
 *
 * Deterministic: seeded clustered corpus and queries, so one seed gives the
 * same vectors/index/recall; recall is flat's exact top-k at CHUNK level (B7
 * keeps parent aggregation above the index, like B2). Decision: ship
 * **IVF-Flat** — smallest auxiliary index, best recall/query-time trade-off,
 * no dependency; SimHash is the cross-check. Measured on the dev machine
 * (512d, Bun 1.3.14): 10k flat 3.7 ms vs IVF 0.6 ms (recall@10 1.000); 100k
 * flat 36 ms vs IVF 6.3 ms (1.000, 1.0 MB); 850k flat 479 ms vs IVF 72/81 ms
 * p50/p95 (1.000, 3.7 MB), SimHash 30/33 ms at recall@10 0.925 / 87.5 MB.
 * 850k stays a manual run, never a unit test.
 *
 * B7 seam: the `AnnIndex` type below plus a `build(input, options)` factory.
 * B7 builds one index per `(agentId, spaceId)` shard, searches each shard and
 * fuses parent-level candidates at the TOP level (never inside a shard).
 * `serialize()` is auxiliary bytes only; the generation layout stays B2's.
 * Layer: `backend/local/embedding/`. Zero imports; no upward dependencies.
 */
export const ANN_BENCH_DEFAULT_SEED = 0x48_b6_2026;
export const ANN_BENCH_DEFAULT_DIMENSIONS = 512;
export const ANN_BENCH_DEFAULT_TOP_K = 50;
export const ANN_BENCH_DEFAULT_NOISE_RATIO = 0.45;
export const ANN_BENCH_SCALES = {
  "1k": 1_000,
  "10k": 10_000,
  "100k": 100_000,
  "850k": 850_000,
} as const;
export type AnnBenchScaleName = keyof typeof ANN_BENCH_SCALES;
export const ANN_BENCH_KINDS = ["flat", "ivf", "simhash"] as const;
export type AnnIndexKind = (typeof ANN_BENCH_KINDS)[number];
export type AnnSearchHit = { id: number; score: number };
export type AnnSearchProblem =
  | "empty-query"
  | "dimension-mismatch"
  | "invalid-k";
export type AnnSearchResult =
  | { ok: true; hits: AnnSearchHit[]; scannedVectors: number }
  | { ok: false; problem: AnnSearchProblem; detail?: string };
export type AnnIndexStats = {
  kind: AnnIndexKind;
  count: number;
  dimensions: number;
  indexBytes: number;
  params: Readonly<Record<string, number>>;
};
export type AnnIndexBuildInput = {
  vectors: Float32Array;
  count: number;
  dimensions: number;
};
/** The B7 seam: build once, then search/stats/serialize. */
export type AnnIndex = {
  readonly kind: AnnIndexKind;
  search(query: ArrayLike<number>, k: number): AnnSearchResult;
  stats(): AnnIndexStats;
  serialize(): Uint8Array;
};
export type AnnIndexBuildOptions = {
  ivf?: Partial<IvfFlatOptions>;
  simhash?: Partial<SimHashOptions>;
};
export type IvfFlatOptions = {
  nlist: number;
  nprobe: number;
  trainSample: number;
  iterations: number;
  seed: number;
};
export type SimHashOptions = { bits: number; bands: number; seed: number };
export type AnnBenchDatasetOptions = Partial<AnnBenchDataset> &
  Pick<AnnBenchDataset, "count">;
export type AnnBenchDataset = {
  seed: number;
  count: number;
  dimensions: number;
  queryCount: number;
  clusterCount: number;
  noiseRatio: number;
  vectors: Float32Array;
  queries: Float32Array;
};
export type AnnBenchCandidateResult = {
  kind: AnnIndexKind;
  buildMs: number;
  vectorsBytes: number;
  indexBytes: number;
  memoryBytes: number;
  p50Ms: number;
  p95Ms: number;
  recallAt10: number;
  recallAt50: number;
  meanScannedVectors: number;
  params: Record<string, number>;
};
export type AnnBenchResult = {
  scaleName: AnnBenchScaleName | "custom";
  count: number;
  dimensions: number;
  seed: number;
  clusterCount: number;
  queryCount: number;
  topK: number;
  candidates: AnnBenchCandidateResult[];
  summary: string;
};
export type AnnBenchOptions = {
  /** Named scale or a raw chunk count (default `"10k"`). */
  scale?: AnnBenchScaleName | number;
  dimensions?: number;
  seed?: number;
  queryCount?: number;
  topK?: number;
  /** Subset to compare; `flat` is always measured as the truth baseline. */
  candidates?: readonly AnnIndexKind[];
  ivf?: Partial<IvfFlatOptions>;
  simhash?: Partial<SimHashOptions>;
};

/** Deterministic LCG: same seed ⇒ same stream, across runs and runtimes. */
function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || Math.floor(value) !== value) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function defaultAnnBenchClusterCount(count: number): number {
  return clamp(Math.round(Math.sqrt(count)), 8, 1024);
}

/** Default query count keeps the manual 850k run inside a few minutes. */
export function defaultAnnBenchQueryCount(count: number): number {
  if (count >= 850_000) return 16;
  if (count >= 100_000) return 32;
  return 64;
}

/** Dot product of two rows; the one scoring primitive every index reuses. */
function dotAt(
  vectors: Float32Array,
  origin: number,
  other: ArrayLike<number>,
  otherOrigin: number,
  dimensions: number,
): number {
  let dot = 0;
  for (let axis = 0; axis < dimensions; axis += 1) {
    dot += (vectors[origin + axis] ?? 0) * (other[otherOrigin + axis] ?? 0);
  }
  return dot;
}

function normalizeRange(
  values: Float32Array,
  offset: number,
  dimensions: number,
): void {
  let sumOfSquares = 0;
  for (let axis = 0; axis < dimensions; axis += 1) {
    const value = values[offset + axis] ?? 0;
    sumOfSquares += value * value;
  }
  const norm = Math.sqrt(sumOfSquares) || 1;
  for (let axis = 0; axis < dimensions; axis += 1) {
    values[offset + axis] = (values[offset + axis] ?? 0) / norm;
  }
}

/** Normalized row = random latent center + independent noise, then L2. */
function fillClusterRows(
  rows: Float32Array,
  rowCount: number,
  dimensions: number,
  clusterCount: number,
  centers: Float32Array,
  noiseRatio: number,
  random: () => number,
): void {
  const centerWeight = Math.sqrt(Math.max(0, 1 - noiseRatio * noiseRatio));
  for (let row = 0; row < rowCount; row += 1) {
    const cluster = Math.min(
      clusterCount - 1,
      Math.floor(random() * clusterCount),
    );
    const centerOrigin = cluster * dimensions;
    const offset = row * dimensions;
    let noiseSquares = 0;
    for (let axis = 0; axis < dimensions; axis += 1) {
      const noise = random() * 2 - 1;
      rows[offset + axis] = noise;
      noiseSquares += noise * noise;
    }
    const noiseNorm = Math.sqrt(noiseSquares) || 1;
    for (let axis = 0; axis < dimensions; axis += 1) {
      rows[offset + axis] =
        (centers[centerOrigin + axis] ?? 0) * centerWeight +
        ((rows[offset + axis] ?? 0) / noiseNorm) * noiseRatio;
    }
    normalizeRange(rows, offset, dimensions);
  }
}

/** One LCG draws centers, corpus, queries: same options ⇒ same arrays. */
export function generateAnnBenchDataset(
  options: AnnBenchDatasetOptions,
): AnnBenchDataset {
  const count = requirePositiveInteger(options.count, "count");
  const dimensions = requirePositiveInteger(
    options.dimensions ?? ANN_BENCH_DEFAULT_DIMENSIONS,
    "dimensions",
  );
  const queryCount = requirePositiveInteger(
    options.queryCount ?? 16,
    "queryCount",
  );
  const seed = options.seed ?? ANN_BENCH_DEFAULT_SEED;
  const clusterCount = requirePositiveInteger(
    options.clusterCount ?? defaultAnnBenchClusterCount(count),
    "clusterCount",
  );
  const noiseRatio = options.noiseRatio ?? ANN_BENCH_DEFAULT_NOISE_RATIO;
  if (!Number.isFinite(noiseRatio) || noiseRatio < 0 || noiseRatio >= 1) {
    throw new RangeError(`noiseRatio must be in [0, 1), got ${noiseRatio}`);
  }
  const random = createDeterministicRandom(seed);
  const centers = new Float32Array(clusterCount * dimensions);
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const offset = cluster * dimensions;
    for (let axis = 0; axis < dimensions; axis += 1) {
      centers[offset + axis] = random() * 2 - 1;
    }
    normalizeRange(centers, offset, dimensions);
  }
  const vectors = new Float32Array(count * dimensions);
  fillClusterRows(
    vectors,
    count,
    dimensions,
    clusterCount,
    centers,
    noiseRatio,
    random,
  );
  const queries = new Float32Array(queryCount * dimensions);
  fillClusterRows(
    queries,
    queryCount,
    dimensions,
    clusterCount,
    centers,
    noiseRatio,
    random,
  );
  return {
    seed,
    count,
    dimensions,
    queryCount,
    clusterCount,
    noiseRatio,
    vectors,
    queries,
  };
}

/** Nearest-rank percentile; throws on an empty set so zeros stay visible. */
export function percentile(
  samples: readonly number[],
  percent: number,
): number {
  if (samples.length === 0) {
    throw new RangeError("percentile needs at least one sample");
  }
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new RangeError(`percent must be in (0, 100], got ${percent}`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = clamp(
    Math.ceil((percent / 100) * sorted.length) - 1,
    0,
    sorted.length - 1,
  );
  return sorted[rank] ?? 0;
}

/** Resolves a named scale or a raw count (raw counts stay out of the table). */
export function resolveAnnBenchScale(scale?: AnnBenchScaleName | number): {
  name: AnnBenchScaleName | "custom";
  count: number;
} {
  if (scale === undefined) {
    return { name: "10k", count: ANN_BENCH_SCALES["10k"] };
  }
  if (typeof scale === "string") {
    const count = ANN_BENCH_SCALES[scale];
    if (count === undefined) {
      throw new RangeError(`unknown ANN bench scale "${scale}"`);
    }
    return { name: scale, count };
  }
  return { name: "custom", count: requirePositiveInteger(scale, "scale") };
}

function validateAnnIndexInput(input: AnnIndexBuildInput): void {
  const count = requirePositiveInteger(input.count, "count");
  const dimensions = requirePositiveInteger(input.dimensions, "dimensions");
  if (input.vectors.length !== count * dimensions) {
    throw new RangeError(
      `vectors has ${input.vectors.length} entries, expected ${count} × ${dimensions}`,
    );
  }
}

function validateSearchInput(
  query: ArrayLike<number>,
  dimensions: number,
  k: number,
): AnnSearchResult | null {
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

/** Small fixed-size top-k: score desc, then id asc, so ties are stable. */
type TopKCollector = { ids: number[]; scores: number[]; limit: number };

function createTopKCollector(limit: number): TopKCollector {
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

function offerTopK(collector: TopKCollector, id: number, score: number): void {
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

function hitsFromCollector(collector: TopKCollector): AnnSearchHit[] {
  return collector.ids.map((id, index) => ({
    id,
    score: collector.scores[index] ?? 0,
  }));
}

/** Exact flat index: B2's scan semantics, one inner product per row. */
export function buildFlatAnnIndex(input: AnnIndexBuildInput): AnnIndex {
  validateAnnIndexInput(input);
  const { vectors, count, dimensions } = input;
  return {
    kind: "flat",
    search(query: ArrayLike<number>, k: number): AnnSearchResult {
      const invalid = validateSearchInput(query, dimensions, k);
      if (invalid !== null) return invalid;
      const collector = createTopKCollector(k);
      for (let id = 0; id < count; id += 1) {
        offerTopK(
          collector,
          id,
          dotAt(vectors, id * dimensions, query, 0, dimensions),
        );
      }
      return {
        ok: true,
        hits: hitsFromCollector(collector),
        scannedVectors: count,
      };
    },
    stats(): AnnIndexStats {
      return { kind: "flat", count, dimensions, indexBytes: 0, params: {} };
    },
    serialize(): Uint8Array {
      // Degenerate: the corpus itself is the index, so there is nothing extra.
      return new Uint8Array(0);
    },
  };
}

/** `nlist`≈√count capped for 850k; `nprobe` scans ~1/8 of the lists. */
export function resolveIvfFlatOptions(
  count: number,
  options: Partial<IvfFlatOptions> = {},
): IvfFlatOptions {
  requirePositiveInteger(count, "count");
  const listCap = count > 200_000 ? 256 : 512;
  const trainSample = Math.min(
    count,
    requirePositiveInteger(options.trainSample ?? 4096, "trainSample"),
  );
  const defaultNlist = clamp(Math.round(Math.sqrt(count)), 8, listCap);
  const nlist = Math.min(
    requirePositiveInteger(options.nlist ?? defaultNlist, "nlist"),
    count,
    trainSample,
  );
  const defaultNprobe = clamp(Math.round(nlist / 8), 4, nlist);
  const nprobe = Math.min(
    requirePositiveInteger(options.nprobe ?? defaultNprobe, "nprobe"),
    nlist,
  );
  return {
    nlist,
    nprobe,
    trainSample,
    iterations: requirePositiveInteger(options.iterations ?? 4, "iterations"),
    seed: options.seed ?? ANN_BENCH_DEFAULT_SEED + 1,
  };
}

/** Auxiliary bytes of an IVF-Flat index (centroids, offsets, ids). */
export function estimateIvfFlatIndexBytes(
  count: number,
  dimensions: number,
  options: Partial<IvfFlatOptions> = {},
): number {
  const resolved = resolveIvfFlatOptions(count, options);
  return resolved.nlist * dimensions * 4 + (resolved.nlist + 1) * 4 + count * 4;
}

/** Closest centroid for one row; unit vectors, so the max dot product wins. */
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
    const dot = dotAt(
      vectors,
      origin,
      centroids,
      center * dimensions,
      dimensions,
    );
    if (dot > bestDot) {
      bestDot = dot;
      best = center;
    }
  }
  return best;
}

/** Lloyd iterations over a corpus prefix; dot = cosine for unit rows. */
function trainKMeans(
  vectors: Float32Array,
  dimensions: number,
  options: IvfFlatOptions,
): Float32Array {
  const { nlist, trainSample, iterations } = options;
  const centroids = new Float32Array(nlist * dimensions);
  for (let center = 0; center < nlist; center += 1) {
    const sample = Math.floor((center * trainSample) / nlist);
    const origin = sample * dimensions;
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
      const origin = sample * dimensions;
      const best = nearestCentroid(
        vectors,
        origin,
        centroids,
        nlist,
        dimensions,
      );
      counts[best] = (counts[best] ?? 0) + 1;
      const sumOrigin = best * dimensions;
      for (let axis = 0; axis < dimensions; axis += 1) {
        sums[sumOrigin + axis] =
          (sums[sumOrigin + axis] ?? 0) + (vectors[origin + axis] ?? 0);
      }
    }
    for (let center = 0; center < nlist; center += 1) {
      const origin = center * dimensions;
      if ((counts[center] ?? 0) === 0) {
        const fallback = ((iteration + center) % trainSample) * dimensions;
        for (let axis = 0; axis < dimensions; axis += 1) {
          centroids[origin + axis] = vectors[fallback + axis] ?? 0;
        }
        continue;
      }
      for (let axis = 0; axis < dimensions; axis += 1) {
        centroids[origin + axis] = sums[origin + axis] ?? 0;
      }
      normalizeRange(centroids, origin, dimensions);
    }
  }
  return centroids;
}

/** IVF-Flat: one inverted list per centroid, probe `nprobe`, rescore. */
export function buildIvfFlatAnnIndex(
  input: AnnIndexBuildInput,
  options: Partial<IvfFlatOptions> = {},
): AnnIndex {
  validateAnnIndexInput(input);
  const { vectors, count, dimensions } = input;
  const resolved = resolveIvfFlatOptions(count, options);
  const { nlist, nprobe } = resolved;
  const centroids = trainKMeans(vectors, dimensions, resolved);
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
  return {
    kind: "ivf",
    search(query: ArrayLike<number>, k: number): AnnSearchResult {
      const invalid = validateSearchInput(query, dimensions, k);
      if (invalid !== null) return invalid;
      const centers = createTopKCollector(nprobe);
      for (let center = 0; center < nlist; center += 1) {
        offerTopK(
          centers,
          center,
          dotAt(centroids, center * dimensions, query, 0, dimensions),
        );
      }
      const collector = createTopKCollector(k);
      let scannedVectors = 0;
      for (const { id: center } of hitsFromCollector(centers)) {
        const start = listOffsets[center] ?? 0;
        const end = listOffsets[center + 1] ?? start;
        for (let position = start; position < end; position += 1) {
          const id = listIds[position] ?? 0;
          offerTopK(
            collector,
            id,
            dotAt(vectors, id * dimensions, query, 0, dimensions),
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
          centroids.byteLength + listOffsets.byteLength + listIds.byteLength,
        params: {
          nlist,
          nprobe,
          trainSample: resolved.trainSample,
          iterations: resolved.iterations,
        },
      };
    },
    serialize(): Uint8Array {
      return concatBytes([centroids, listOffsets, listIds]);
    },
  };
}

function concatBytes(parts: readonly ArrayBufferView[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(
      new Uint8Array(part.buffer, part.byteOffset, part.byteLength),
      offset,
    );
    offset += part.byteLength;
  }
  return output;
}

/** Sign bits of one row under the seeded projection matrix. */
function signatureOf(
  projections: Float32Array,
  bits: number,
  dimensions: number,
  words: Uint32Array,
  row: ArrayLike<number>,
  rowOffset: number,
): void {
  words.fill(0);
  for (let bit = 0; bit < bits; bit += 1) {
    if (dotAt(projections, bit * dimensions, row, rowOffset, dimensions) > 0) {
      const word = bit >>> 5;
      words[word] = (words[word] ?? 0) | (1 << (bit & 31));
    }
  }
}

/** Resolves SimHash parameters; `bands * bandBits === bits`, `bandBits ≤ 16`. */
export function resolveSimHashOptions(
  options: Partial<SimHashOptions> = {},
): SimHashOptions & { bandBits: number } {
  const bits = requirePositiveInteger(options.bits ?? 96, "bits");
  const bands = requirePositiveInteger(options.bands ?? 12, "bands");
  const bandBits = bits / bands;
  if (bits % bands !== 0 || bandBits > 16) {
    throw new RangeError(`invalid SimHash ${bits}/${bands} split`);
  }
  return {
    bits,
    bands,
    bandBits,
    seed: options.seed ?? ANN_BENCH_DEFAULT_SEED + 2,
  };
}

/** Packed index bytes (signatures + band keys + ids); prototype uses maps. */
export function estimateSimHashIndexBytes(
  count: number,
  options: Partial<SimHashOptions> = {},
): number {
  const { bits, bands } = resolveSimHashOptions(options);
  return count * 4 * (Math.ceil(bits / 32) + 2 * bands);
}

/** Extract one band key from the packed signature words. */
function bandKeyAt(
  words: Uint32Array,
  shift: number,
  bandBits: number,
  mask: number,
): number {
  const offset = shift & 31;
  const word = shift >>> 5;
  let key = (words[word] ?? 0) >>> offset;
  if (offset + bandBits > 32) key |= (words[word + 1] ?? 0) << (32 - offset);
  return key & mask;
}

/** Banded SimHash: seeded sign projections, band-bucket candidates, rescore. */
export function buildSimHashAnnIndex(
  input: AnnIndexBuildInput,
  options: Partial<SimHashOptions> = {},
): AnnIndex {
  validateAnnIndexInput(input);
  const { vectors, count, dimensions } = input;
  const { bits, bands, bandBits, seed } = resolveSimHashOptions(options);
  const signatureWords = Math.ceil(bits / 32);
  const random = createDeterministicRandom(seed);
  const projections = new Float32Array(bits * dimensions);
  for (let index = 0; index < projections.length; index += 1) {
    projections[index] = random() * 2 - 1;
  }
  const signatures = new Uint32Array(count * signatureWords);
  const buckets: Array<Map<number, number[]>> = [];
  for (let band = 0; band < bands; band += 1) buckets.push(new Map());
  const words = new Uint32Array(signatureWords);
  const bandMask = (1 << bandBits) - 1;
  for (let id = 0; id < count; id += 1) {
    signatureOf(projections, bits, dimensions, words, vectors, id * dimensions);
    signatures.set(words, id * signatureWords);
    const signature = signatures.subarray(
      id * signatureWords,
      (id + 1) * signatureWords,
    );
    for (let band = 0; band < bands; band += 1) {
      const key = bandKeyAt(signature, band * bandBits, bandBits, bandMask);
      const bucket = buckets[band] as Map<number, number[]>;
      const existing = bucket.get(key);
      if (existing === undefined) bucket.set(key, [id]);
      else existing.push(id);
    }
  }
  const seen = new Uint32Array(count);
  const candidates = new Uint32Array(count);
  let epoch = 0;
  return {
    kind: "simhash",
    search(query: ArrayLike<number>, k: number): AnnSearchResult {
      const invalid = validateSearchInput(query, dimensions, k);
      if (invalid !== null) return invalid;
      signatureOf(projections, bits, dimensions, words, query, 0);
      epoch += 1;
      let candidateCount = 0;
      for (let band = 0; band < bands; band += 1) {
        const key = bandKeyAt(words, band * bandBits, bandBits, bandMask);
        const bucket = buckets[band] as Map<number, number[]>;
        for (const id of bucket.get(key) ?? []) {
          if (seen[id] === epoch) continue;
          seen[id] = epoch;
          candidates[candidateCount] = id;
          candidateCount += 1;
        }
      }
      const collector = createTopKCollector(k);
      for (const id of candidates.subarray(0, candidateCount)) {
        offerTopK(
          collector,
          id,
          dotAt(vectors, id * dimensions, query, 0, dimensions),
        );
      }
      return {
        ok: true,
        hits: hitsFromCollector(collector),
        scannedVectors: candidateCount,
      };
    },
    stats(): AnnIndexStats {
      return {
        kind: "simhash",
        count,
        dimensions,
        indexBytes: estimateSimHashIndexBytes(count, { bits, bands }),
        params: { bits, bands, bandBits },
      };
    },
    serialize(): Uint8Array {
      // Prototype: signature section only; B7 packs keys/ids per the estimate.
      return concatBytes([signatures]);
    },
  };
}

/** Builds one candidate by kind; an unknown kind is a typed-programmer error. */
export function buildAnnIndex(
  kind: AnnIndexKind,
  input: AnnIndexBuildInput,
  options: AnnIndexBuildOptions = {},
): AnnIndex {
  switch (kind) {
    case "flat":
      return buildFlatAnnIndex(input);
    case "ivf":
      return buildIvfFlatAnnIndex(input, options.ivf);
    case "simhash":
      return buildSimHashAnnIndex(input, options.simhash);
    default:
      throw new RangeError(`unknown ANN index kind "${String(kind)}"`);
  }
}

type QueryRun = { samples: number[]; hits: number[][]; scanned: number[] };

/** Runs every query once, timing each search; failures are bench errors. */
function measureQueries(
  index: AnnIndex,
  queries: Float32Array,
  queryCount: number,
  dimensions: number,
  topK: number,
): QueryRun {
  const run: QueryRun = { samples: [], hits: [], scanned: [] };
  // Warm the JIT on one untimed query so p50/p95 measure steady state.
  index.search(queries.subarray(0, dimensions), topK);
  for (let query = 0; query < queryCount; query += 1) {
    const view = queries.subarray(query * dimensions, (query + 1) * dimensions);
    const started = performance.now();
    const result = index.search(view, topK);
    run.samples.push(performance.now() - started);
    if (!result.ok) {
      throw new Error(
        `ANN search failed: ${result.problem} (${result.detail ?? ""})`,
      );
    }
    run.hits.push(result.hits.map((hit) => hit.id));
    run.scanned.push(result.scannedVectors);
  }
  return run;
}

/** Mean fraction of the exact top-k found, one fraction per query. */
function meanRecall(
  found: readonly (readonly number[])[],
  truth: readonly (readonly number[])[],
  k: number,
): number {
  if (found.length === 0) return 0;
  let total = 0;
  for (let query = 0; query < found.length; query += 1) {
    const expected = new Set((truth[query] ?? []).slice(0, k));
    if (expected.size === 0) continue;
    const matched = (found[query] ?? []).filter((id) => expected.has(id));
    total += matched.length / expected.size;
  }
  return total / found.length;
}

const megabytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Measures one candidate; flat's own hits become the recall ground truth. */
function runCandidate(
  kind: AnnIndexKind,
  input: AnnIndexBuildInput,
  dataset: AnnBenchDataset,
  options: AnnBenchOptions,
  topK: number,
  truth: readonly (readonly number[])[] | null,
): { result: AnnBenchCandidateResult; hits: number[][] } {
  const started = performance.now();
  const index = buildAnnIndex(kind, input, options);
  const buildMs = performance.now() - started;
  const run = measureQueries(
    index,
    dataset.queries,
    dataset.queryCount,
    dataset.dimensions,
    topK,
  );
  const stats = index.stats();
  const vectorsBytes = input.vectors.byteLength;
  const recall = (k: number): number =>
    truth === null ? 1 : meanRecall(run.hits, truth, Math.min(k, topK));
  return {
    hits: run.hits,
    result: {
      kind,
      buildMs,
      vectorsBytes,
      indexBytes: stats.indexBytes,
      memoryBytes: vectorsBytes + stats.indexBytes,
      p50Ms: percentile(run.samples, 50),
      p95Ms: percentile(run.samples, 95),
      recallAt10: recall(10),
      recallAt50: recall(50),
      meanScannedVectors:
        run.scanned.reduce((total, value) => total + value, 0) /
        run.scanned.length,
      params: { ...stats.params },
    },
  };
}

/** Full B6 matrix: flat truth, then build+query every requested candidate. */
export function runAnnBench(options: AnnBenchOptions = {}): AnnBenchResult {
  const scale = resolveAnnBenchScale(options.scale);
  const dimensions = requirePositiveInteger(
    options.dimensions ?? ANN_BENCH_DEFAULT_DIMENSIONS,
    "dimensions",
  );
  const seed = options.seed ?? ANN_BENCH_DEFAULT_SEED;
  const topK = requirePositiveInteger(
    options.topK ?? ANN_BENCH_DEFAULT_TOP_K,
    "topK",
  );
  const queryCount = requirePositiveInteger(
    options.queryCount ?? defaultAnnBenchQueryCount(scale.count),
    "queryCount",
  );
  const requested = options.candidates ?? ANN_BENCH_KINDS;
  if (requested.length === 0) throw new RangeError("candidates is empty");
  for (const kind of requested) {
    if (!ANN_BENCH_KINDS.includes(kind)) {
      throw new RangeError(`unknown ANN index kind "${String(kind)}"`);
    }
  }
  const dataset = generateAnnBenchDataset({
    count: scale.count,
    dimensions,
    queryCount,
    seed,
  });
  const input: AnnIndexBuildInput = {
    vectors: dataset.vectors,
    count: dataset.count,
    dimensions: dataset.dimensions,
  };
  const flat = runCandidate("flat", input, dataset, options, topK, null);
  const candidates: AnnBenchCandidateResult[] = [flat.result];
  for (const kind of requested) {
    if (kind === "flat") continue;
    candidates.push(
      runCandidate(kind, input, dataset, options, topK, flat.hits).result,
    );
  }
  const result: AnnBenchResult = {
    scaleName: scale.name,
    count: dataset.count,
    dimensions: dataset.dimensions,
    seed: dataset.seed,
    clusterCount: dataset.clusterCount,
    queryCount,
    topK,
    candidates,
    summary: "",
  };
  result.summary = formatAnnBenchSummary(result);
  return result;
}

/** Renders the structured result as a table; callable on a stored result. */
export function formatAnnBenchSummary(result: AnnBenchResult): string {
  const header =
    `ANN benchmark — scale=${result.scaleName} count=${result.count} ` +
    `dimensions=${result.dimensions} seed=0x${result.seed.toString(16)} ` +
    `clusters=${result.clusterCount} queries=${result.queryCount} topK=${result.topK}`;
  const rows = result.candidates.map((candidate) =>
    [
      candidate.kind.padEnd(10),
      (candidate.buildMs / 1000).toFixed(2).padStart(8),
      megabytes(candidate.vectorsBytes).padStart(8),
      megabytes(candidate.indexBytes).padStart(8),
      megabytes(candidate.memoryBytes).padStart(9),
      candidate.p50Ms.toFixed(2).padStart(8),
      candidate.p95Ms.toFixed(2).padStart(8),
      candidate.recallAt10.toFixed(3).padStart(10),
      candidate.recallAt50.toFixed(3).padStart(10),
      Math.round(candidate.meanScannedVectors).toString().padStart(10),
    ].join("  "),
  );
  const lines = [
    header,
    "candidate   build(s)  vectors   index     memory    p50(ms)  p95(ms)  recall@10  recall@50  scan/query",
    ...rows,
  ];
  if (result.count >= 200_000) {
    lines.push(
      "phase-③ trigger (>200k chunks): compare p95 with the 300ms hard budget.",
    );
  }
  return lines.join("\n");
}
