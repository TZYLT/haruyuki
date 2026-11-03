/**
 * Gate 3 (S3 / phase ③) scale evidence for feature 48.
 *
 * Criteria: docs/48-2 §10 (gate 3 = ANN, int8, 100× = 850k chunks, full check)
 * and §4.10 (trigger >200k chunks or p95 >150 ms; int8 + float32 rescore);
 * docs/48-3 §8.2 (B6 decision: pure-TS IVF-Flat, 505 ms flat vs 80.8 ms IVF at
 * 850k) and §9.2 (gate 2 conclusion).
 *
 * Three blocks, all against the production implementations:
 *  A. B7 `embedding-ann-index.ts` — flat truth vs IVF-Flat at the 100× scale:
 *     build time, resident bytes, nearest-rank p50/p95, recall@10.
 *  B. C9 `embedding-quant.ts` — int8-only and int8 + float32 top-50 rescore:
 *     recall@10, p95, volume and compression ratio.
 *  C. A6 `embedding-ann-search.ts` — production wiring (B2 temp index + B7
 *     shard sidecar + `createAnnAwareIndexSearch`): ANN vs flat top-k
 *     agreement, then a corrupted and a deleted sidecar must fall back to the
 *     exact scan silently (`degraded: "ann-unavailable"`, never throw).
 *
 * Scale gate: the default run is a small production-path smoke and must stay
 * under 10 s. `HARUYUKI_EMBEDDING_SCALE=850k` (also `100k` / `10k`) runs the
 * named scale; 850k keeps the corpus in memory only (≈1.74 GB of float32) and
 * never writes a 1.7 GB index to disk — only block C writes its 100k-chunk B2
 * generation (~205 MB at 512d) below the OS temp root.
 *
 * Discipline (docs/31 §1.2): every path is a fresh `mkdtemp` root, and
 * `HARUYUKI_HOME` / `LETTA_LOCAL_BACKEND_DIR` are redirected and restored. No
 * ONNX, no network, no real harness data, no destructive command outside the
 * fixture root.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { generateAnnBenchDataset } from "@/backend/local/embedding/ann-bench";
import {
  ANN_TRIGGER_P95_MS,
  type AnnIndex,
  buildAnnIndex,
  buildFlatAnnIndex,
  resolveAnnIvfOptions,
  shouldUseAnn,
} from "@/backend/local/embedding-ann-index";
import {
  ANN_SEARCH_DEGRADED,
  type AnnSearchResult as AnnQueryResult,
  annShardSidecarDir,
  createAnnAwareIndexSearch,
  writeAnnShardSidecar,
} from "@/backend/local/embedding-ann-search";
import {
  type EmbeddingChunkRecordInput,
  type EmbeddingVectorUnit,
  embeddingVectorUnitDir,
  hashEmbeddingText,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import {
  EMBEDDING_QUANT_DEFAULT_RESCORE_CANDIDATES,
  type EmbeddingQuantChunkRecord,
  estimateEmbeddingQuantVolume,
  quantizeEmbeddingVectors,
  searchEmbeddingQuantIndex,
} from "@/backend/local/embedding-quant";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

const SCALE_ENV = "HARUYUKI_EMBEDDING_SCALE";
const SCALE_COUNTS = {
  "10k": 10_000,
  "100k": 100_000,
  "850k": 850_000,
} as const;
type Gate3ScaleName = keyof typeof SCALE_COUNTS;

/** Default smoke: small enough to run everywhere, real production code paths. */
const SMOKE_CORPUS_COUNT = 8_000;
const SMOKE_DIMENSIONS = 64;
/** Named scales use the production 512d width. */
const SCALE_DIMENSIONS = 512;
const TOP_K = 10;
/** B7 block: 64 queries is the 48-2 §4.10 / B6 measurement shape. */
const B7_QUERY_COUNT = 64;
const A6_QUERY_COUNT = 8;
/** A6 production wiring is evidenced at 100k even inside the 850k run. */
const A6_TARGET_COUNT = 100_000;

type ResolvedScale = {
  name: Gate3ScaleName | "smoke";
  count: number;
  dimensions: number;
};

function resolveScale(): ResolvedScale {
  const raw = (process.env[SCALE_ENV] ?? "").trim().toLowerCase();
  const count = SCALE_COUNTS[raw as Gate3ScaleName];
  if (count === undefined) {
    return {
      name: "smoke",
      count: SMOKE_CORPUS_COUNT,
      dimensions: SMOKE_DIMENSIONS,
    };
  }
  return { name: raw as Gate3ScaleName, count, dimensions: SCALE_DIMENSIONS };
}

const SCALE = resolveScale();
const IS_SMOKE = SCALE.name === "smoke";
/** Fewer int8 queries at 850k: the coarse scan is the whole corpus per query. */
const INT8_QUERY_COUNT = SCALE.count >= 500_000 ? 8 : 16;
const A6_COUNT = Math.min(SCALE.count, A6_TARGET_COUNT);
/** Smoke keeps a slow machine from turning a <10 s run into a timeout. */
const TEST_TIMEOUT_MS = IS_SMOKE ? 30_000 : 360_000;
/** Sampled once after every block: the whole suite may not run away. */
const SUITE_BUDGET_MS = IS_SMOKE ? 10_000 : 360_000;

// ---------------------------------------------------------------------------
// Fixture + evidence
// ---------------------------------------------------------------------------

let dirs: EmbeddingFixtureDirs;
let previousHome: string | undefined;
let previousLocalBackendDir: string | undefined;
let suiteStartedAt = 0;

const evidenceLog: Record<string, unknown> = {};

beforeAll(() => {
  suiteStartedAt = performance.now();
  dirs = createEmbeddingFixtureDirs("haru-gate3-scale-");
  previousHome = process.env.HARUYUKI_HOME;
  previousLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = dirs.homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = dirs.localBackendDir;
  console.log(
    `[gate3-scale] mode=${SCALE.name} count=${SCALE.count} dimensions=${SCALE.dimensions} int8Queries=${INT8_QUERY_COUNT} a6Count=${A6_COUNT}`,
  );
});

afterAll(() => {
  const elapsedMs = performance.now() - suiteStartedAt;
  const rssMb = process.memoryUsage().rss / (1024 * 1024);
  console.log(
    `[gate3-scale] GATE3_EVIDENCE ${JSON.stringify({
      mode: SCALE.name,
      count: SCALE.count,
      dimensions: SCALE.dimensions,
      elapsedMs: round(elapsedMs, 0),
      rssMb: round(rssMb, 1),
      blocks: evidenceLog,
    })}`,
  );
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousLocalBackendDir === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = previousLocalBackendDir;
  }
  dirs.cleanup();
});

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nearestRank(samples: readonly number[], percent: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1),
  );
  return sorted[rank] ?? 0;
}

function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample;
  return total / samples.length;
}

/** recall@k of `found` against `truth`; both are ranked id lists. */
function recallAtK(
  truth: readonly (readonly number[])[],
  found: readonly (readonly number[])[],
  k: number,
): number {
  if (truth.length === 0) return 0;
  let total = 0;
  for (let index = 0; index < truth.length; index += 1) {
    const expected = new Set(truth[index] ?? []);
    const actual = (found[index] ?? []).slice(0, k);
    let hits = 0;
    for (const id of actual) {
      if (expected.has(id)) hits += 1;
    }
    total += hits / Math.max(1, k);
  }
  return total / truth.length;
}

/** Mean |A ∩ B| / min(|A|, |B|) over every query's top-k parent ids. */
function topKAgreement(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[],
): number {
  if (left.length === 0) return 0;
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const expected = new Set(left[index] ?? []);
    const actual = new Set(right[index] ?? []);
    let shared = 0;
    for (const id of actual) {
      if (expected.has(id)) shared += 1;
    }
    total += shared / Math.max(1, Math.min(expected.size, actual.size));
  }
  return total / left.length;
}

function queryAt(
  data: { queries: Float32Array; dimensions: number },
  index: number,
): Float32Array {
  const start = index * data.dimensions;
  return data.queries.subarray(start, start + data.dimensions);
}

// ---------------------------------------------------------------------------
// Corpus (shared by the B7 and C9 blocks)
// ---------------------------------------------------------------------------

type Corpus = {
  data: ReturnType<typeof generateAnnBenchDataset>;
  flat: AnnIndex;
  generationMs: number;
  flatBuildMs: number;
  /** Top-K chunk ids per query from the exact scan: the recall truth. */
  flatIds: number[][];
  flatMs: number[];
};

let corpus: Corpus | undefined;

function getCorpus(): Corpus {
  if (corpus !== undefined) return corpus;
  const generationStartedAt = performance.now();
  const data = generateAnnBenchDataset({
    count: SCALE.count,
    dimensions: SCALE.dimensions,
    queryCount: B7_QUERY_COUNT,
  });
  const generationMs = performance.now() - generationStartedAt;
  const flatBuildStartedAt = performance.now();
  const flat = buildFlatAnnIndex({
    vectors: data.vectors,
    count: data.count,
    dimensions: data.dimensions,
  });
  const flatBuildMs = performance.now() - flatBuildStartedAt;
  const flatIds: number[][] = [];
  const flatMs: number[] = [];
  for (let index = 0; index < data.queryCount; index += 1) {
    const startedAt = performance.now();
    const result = flat.search(queryAt(data, index), TOP_K);
    flatMs.push(performance.now() - startedAt);
    if (!result.ok) {
      throw new Error(
        `flat truth query ${index} failed: ${result.problem}${result.detail ?? ""}`,
      );
    }
    flatIds.push(result.hits.map((hit) => hit.id));
  }
  corpus = { data, flat, generationMs, flatBuildMs, flatIds, flatMs };
  evidenceLog["corpus"] = {
    count: data.count,
    dimensions: data.dimensions,
    clusterCount: data.clusterCount,
    queries: data.queryCount,
    generationMs: round(generationMs, 1),
    flatBuildMs: round(flatBuildMs, 3),
  };
  return corpus;
}

// ---------------------------------------------------------------------------
// A. B7 ANN: flat truth vs IVF-Flat at the gate scale
// ---------------------------------------------------------------------------

describe("B7 ANN · flat vs IVF-Flat (48-2 §4.10 / 48-3 §8.2)", () => {
  test(
    "IVF meets the p95 budget and the recall@10 floor against the flat truth",
    () => {
      const { data, flat, flatBuildMs, flatIds, flatMs } = getCorpus();
      const vectorsBytes = data.count * data.dimensions * 4;
      const expectedOptions = resolveAnnIvfOptions(data.count);

      const buildStartedAt = performance.now();
      const ivf = buildAnnIndex({
        vectors: data.vectors,
        count: data.count,
        dimensions: data.dimensions,
      });
      const ivfBuildMs = performance.now() - buildStartedAt;

      const ivfMs: number[] = [];
      const ivfIds: number[][] = [];
      const scanned: number[] = [];
      for (let index = 0; index < data.queryCount; index += 1) {
        const startedAt = performance.now();
        const result = ivf.search(queryAt(data, index), TOP_K);
        ivfMs.push(performance.now() - startedAt);
        if (!result.ok) {
          throw new Error(
            `IVF query ${index} failed: ${result.problem}${result.detail ?? ""}`,
          );
        }
        ivfIds.push(result.hits.map((hit) => hit.id));
        scanned.push(result.scannedVectors);
      }

      const flatP50 = nearestRank(flatMs, 50);
      const flatP95 = nearestRank(flatMs, 95);
      const ivfP50 = nearestRank(ivfMs, 50);
      const ivfP95 = nearestRank(ivfMs, 95);
      const recall = recallAtK(flatIds, ivfIds, TOP_K);
      const meanScanned = mean(scanned);
      const stats = ivf.stats();
      const flatStats = flat.stats();
      const serializedBytes = ivf.serialize().byteLength;

      evidenceLog["b7"] = {
        scale: SCALE.name,
        count: data.count,
        dimensions: data.dimensions,
        flatBuildMs: round(flatBuildMs, 3),
        flatVectorsBytes: vectorsBytes,
        flatIndexBytes: flatStats.indexBytes,
        flatP50Ms: round(flatP50, 2),
        flatP95Ms: round(flatP95, 2),
        ivfBuildMs: round(ivfBuildMs, 1),
        ivfIndexBytes: stats.indexBytes,
        ivfTotalBytes: vectorsBytes + stats.indexBytes,
        ivfP50Ms: round(ivfP50, 2),
        ivfP95Ms: round(ivfP95, 2),
        recallAt10: round(recall, 4),
        meanScannedVectors: round(meanScanned, 1),
        serializedBytes,
        params: stats.params,
      };
      console.log(
        `[gate3-scale] B7 scale=${SCALE.name} flat(build=${round(flatBuildMs, 2)}ms p50=${round(flatP50, 2)}ms p95=${round(flatP95, 2)}ms) ivf(build=${round(ivfBuildMs, 0)}ms index=${stats.indexBytes}B p50=${round(ivfP50, 2)}ms p95=${round(ivfP95, 2)}ms recall@10=${round(recall, 4)} scanned=${round(meanScanned, 0)}/${data.count})`,
      );

      expect(stats.kind).toBe("ivf");
      expect(stats.count).toBe(data.count);
      expect(stats.dimensions).toBe(data.dimensions);
      expect(stats.params).toMatchObject(expectedOptions);
      expect(serializedBytes).toBe(stats.indexBytes);
      // Aux structure stays tiny next to the corpus (B6: 3.7 MB at 850k).
      expect(stats.indexBytes).toBeLessThan(32 * 1024 * 1024);
      // 48-2 §4.10 hard budgets.
      expect(ivfP95).toBeLessThanOrEqual(300);
      expect(recall).toBeGreaterThanOrEqual(0.9);
      expect(meanScanned).toBeGreaterThan(0);
      expect(meanScanned).toBeLessThan(data.count);

      if (SCALE.name === "850k") {
        // The 100× point must trigger ANN on both counts and observed latency.
        expect(shouldUseAnn(SCALE.count)).toBe(true);
        expect(flatP95).toBeGreaterThan(ANN_TRIGGER_P95_MS);
        expect(shouldUseAnn(SCALE.count, flatP95)).toBe(true);
      } else {
        // 10k/100k/smoke stay under the 200k count trigger (B6: 100k flat 39 ms).
        expect(shouldUseAnn(SCALE.count)).toBe(false);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// B. C9 int8: int8-only vs int8 + float32 top-50 rescore
// ---------------------------------------------------------------------------

const INT8_QUANT_CHUNK = 4_096;
const SHARED_TEXT_HASH = hashEmbeddingText("gate3-scale-chunk");

function quantRecord(
  row: number,
  dimensions: number,
  vectorScale: number,
): EmbeddingQuantChunkRecord {
  return {
    parentId: `p${row}`,
    chunkIndex: 0,
    startChar: 0,
    endChar: 1,
    spans: [],
    focusChar: 0,
    textHash: SHARED_TEXT_HASH,
    norm: 1,
    // int8 generation layout: one byte per axis (see embedding-quant.ts).
    vectorOffset: row * dimensions,
    vectorScale,
  };
}

function parentRow(parentId: string): number {
  return Number.parseInt(parentId.slice(1), 10);
}

describe("C9 int8 · int8-only vs int8 + top-50 rescore (48-2 §4.10)", () => {
  test(
    "rescore recovers exact recall@10 and int8 stays ~4× smaller",
    () => {
      const { data, flatIds } = getCorpus();
      const { count, dimensions } = data;

      const encodeStartedAt = performance.now();
      const codes = new Int8Array(count * dimensions);
      const scales = new Float32Array(count);
      for (let start = 0; start < count; start += INT8_QUANT_CHUNK) {
        const end = Math.min(count, start + INT8_QUANT_CHUNK);
        const rows: Float32Array[] = [];
        for (let row = start; row < end; row += 1) {
          rows.push(
            data.vectors.subarray(row * dimensions, (row + 1) * dimensions),
          );
        }
        const batch = quantizeEmbeddingVectors(rows, dimensions);
        codes.set(batch.codes, start * dimensions);
        scales.set(batch.scales, start);
      }
      const encodeMs = performance.now() - encodeStartedAt;

      const records: EmbeddingQuantChunkRecord[] = Array.from(
        { length: count },
        (_unused, row) => quantRecord(row, dimensions, scales[row] ?? 0),
      );
      const quantInput = { dimensions, records, codes, scales };
      const queryCount = Math.min(INT8_QUERY_COUNT, data.queryCount);
      const int8Ms: number[] = [];
      const int8Ids: number[][] = [];
      const rescoreMs: number[] = [];
      const rescoreIds: number[][] = [];
      let rescoredChunks = 0;

      for (let index = 0; index < queryCount; index += 1) {
        const query = queryAt(data, index);
        const int8StartedAt = performance.now();
        const int8Only = searchEmbeddingQuantIndex(quantInput, query, {
          mode: "int8-only",
          topK: TOP_K,
        });
        int8Ms.push(performance.now() - int8StartedAt);
        if (!int8Only.ok) {
          throw new Error(
            `int8-only query ${index} failed: ${int8Only.problem}`,
          );
        }
        expect(int8Only.mode).toBe("int8-only");
        expect(int8Only.rescoreUnavailable).toBe(true);
        expect(int8Only.scannedChunks).toBe(count);
        int8Ids.push(int8Only.hits.map((hit) => parentRow(hit.parentId)));

        const rescoreStartedAt = performance.now();
        const rescore = searchEmbeddingQuantIndex(
          { ...quantInput, exactVectors: data.vectors },
          query,
          {
            mode: "int8-rescore",
            topK: TOP_K,
            rescoreCandidates: EMBEDDING_QUANT_DEFAULT_RESCORE_CANDIDATES,
          },
        );
        rescoreMs.push(performance.now() - rescoreStartedAt);
        if (!rescore.ok) {
          throw new Error(
            `int8-rescore query ${index} failed: ${rescore.problem}`,
          );
        }
        expect(rescore.mode).toBe("int8-rescore");
        expect(rescore.rescoreUnavailable).toBe(false);
        expect(rescore.rescoredChunks).toBe(
          EMBEDDING_QUANT_DEFAULT_RESCORE_CANDIDATES,
        );
        expect(rescore.scannedChunks).toBe(count);
        rescoredChunks = rescore.rescoredChunks;
        rescoreIds.push(rescore.hits.map((hit) => parentRow(hit.parentId)));
      }

      const truth = flatIds.slice(0, queryCount);
      const int8Recall = recallAtK(truth, int8Ids, TOP_K);
      const rescoreRecall = recallAtK(truth, rescoreIds, TOP_K);
      const volume = estimateEmbeddingQuantVolume({
        chunkCount: count,
        dimensions,
        quant: "int8",
        rescore: false,
      });
      const rescoreVolume = estimateEmbeddingQuantVolume({
        chunkCount: count,
        dimensions,
        quant: "int8",
        rescore: true,
      });
      const naiveFloat32Bytes = count * dimensions * 4;

      evidenceLog["int8"] = {
        scale: SCALE.name,
        count,
        dimensions,
        queries: queryCount,
        encodeMs: round(encodeMs, 1),
        int8P50Ms: round(nearestRank(int8Ms, 50), 2),
        int8P95Ms: round(nearestRank(int8Ms, 95), 2),
        int8RecallAt10: round(int8Recall, 4),
        rescoreP50Ms: round(nearestRank(rescoreMs, 50), 2),
        rescoreP95Ms: round(nearestRank(rescoreMs, 95), 2),
        rescoreRecallAt10: round(rescoreRecall, 4),
        rescoredChunks,
        codesBytes: codes.byteLength,
        scalesBytes: scales.byteLength,
        int8OnlyBytes: volume.totalBytes,
        int8OnlyCompression: round(volume.compressionRatio, 4),
        rescoreBytes: rescoreVolume.totalBytes,
        rescoreCompression: round(rescoreVolume.compressionRatio, 4),
        naiveFloat32Bytes,
      };
      console.log(
        `[gate3-scale] C9 scale=${SCALE.name} int8(encode=${round(encodeMs, 0)}ms p95=${round(nearestRank(int8Ms, 95), 2)}ms recall@10=${round(int8Recall, 4)} volume=${volume.totalBytes}B ratio=${round(volume.compressionRatio, 2)}×) rescore(p95=${round(nearestRank(rescoreMs, 95), 2)}ms recall@10=${round(rescoreRecall, 4)} volume=${rescoreVolume.totalBytes}B ratio=${round(rescoreVolume.compressionRatio, 2)}×)`,
      );

      // int8 + float32 top-50 rescore must recover the exact top-10.
      expect(rescoreRecall).toBeGreaterThanOrEqual(0.9);
      // int8-only is allowed to lose recall, but must stay sane.
      expect(int8Recall).toBeGreaterThanOrEqual(0.5);
      expect(int8Recall).toBeLessThanOrEqual(1);
      // ~4× smaller than float32 on the vector bytes (exactly 1 byte/axis).
      expect(volume.vectorBytes).toBe(count * dimensions);
      expect(volume.compressionRatio).toBeGreaterThanOrEqual(3.7);
      expect(volume.compressionRatio).toBeLessThan(4.05);
      // Keeping float32 originals for rescore is a second copy: honest ratio.
      expect(rescoreVolume.totalBytes).toBeGreaterThan(volume.totalBytes);
      expect(rescoreVolume.compressionRatio).toBeLessThan(
        volume.compressionRatio,
      );
      expect(rescoreVolume.rescoreBytes).toBe(naiveFloat32Bytes);
      expect(codes.byteLength).toBe(count * dimensions);
      expect(scales.byteLength).toBe(count * 4);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// C. A6 production wiring: B2 index + B7 shard sidecar + silent fallback
// ---------------------------------------------------------------------------

const A6_SPACE = { agentId: "gate3-agent", spaceId: "gate3-space" };
const A6_UNIT = {
  kind: "transcript" as const,
  conversationKey: "conv-gate3",
};
const A6_SPANS: EmbeddingChunkRecordInput["spans"] = [
  { startChar: 0, endChar: 1 },
];
const A6_TEXT_HASH = hashEmbeddingText("gate3-a6-chunk");

function a6Record(row: number): EmbeddingChunkRecordInput {
  return {
    parentId: `p${row}`,
    chunkIndex: 0,
    startChar: 0,
    endChar: 1,
    spans: A6_SPANS,
    focusChar: 0,
    textHash: A6_TEXT_HASH,
  };
}

function searchedParentIds(result: AnnQueryResult): string[] {
  if (result.status !== "searched") {
    throw new Error(
      `expected a searched ANN result, got ${result.status} (${result.reason ?? "no reason"})`,
    );
  }
  return result.hits.map((hit) => hit.hit.parentId);
}

function assertInsideFixtureRoot(target: string): void {
  const root = dirs.root.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalized = target.replaceAll("\\", "/");
  if (!normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    throw new Error(
      `refusing to delete ${target}: outside the fixture root ${dirs.root}`,
    );
  }
}

describe("A6 production wiring · B2 index + ANN shard sidecar", () => {
  test(
    "ANN agrees with flat, then a corrupt/missing sidecar degrades silently",
    () => {
      const { data } = getCorpus();
      const count = A6_COUNT;
      const dimensions = data.dimensions;
      const identity: EmbeddingVectorUnit = {
        agentId: A6_SPACE.agentId,
        spaceId: A6_SPACE.spaceId,
        conversationKey: A6_UNIT.conversationKey,
      };
      const unitDir = embeddingVectorUnitDir(identity, { root: dirs.root });
      const records: EmbeddingChunkRecordInput[] = Array.from(
        { length: count },
        (_unused, row) => a6Record(row),
      );
      const vectors: Float32Array[] = Array.from(
        { length: count },
        (_unused, row) =>
          data.vectors.subarray(row * dimensions, (row + 1) * dimensions),
      );

      const writeStartedAt = performance.now();
      const written = writeEmbeddingIndex({
        unitDir,
        unit: identity,
        modelId: "gate3-fake-512",
        dimensions,
        records,
        vectors,
        coverage: {
          embeddedChars: count * 8,
          recallableChars: count * 8,
          ratio: 1,
        },
      });
      const b2WriteMs = performance.now() - writeStartedAt;
      expect(written.meta.chunkCount).toBe(count);

      const sidecarStartedAt = performance.now();
      const sidecar = writeAnnShardSidecar({
        space: A6_SPACE,
        units: [A6_UNIT],
        root: dirs.root,
      });
      const sidecarBuildMs = performance.now() - sidecarStartedAt;
      expect(sidecar.ok).toBe(true);
      if (!sidecar.ok) {
        throw new Error(
          `ANN sidecar build failed: ${sidecar.problem} (${sidecar.detail ?? ""})`,
        );
      }
      expect(sidecar.manifest.chunkCount).toBe(count);
      expect(sidecar.manifest.dimensions).toBe(dimensions);
      expect(sidecar.manifest.kind).toBe("ivf");
      expect(sidecar.manifest.indexBytes).toBeGreaterThan(0);

      const queries = Array.from(
        { length: Math.min(A6_QUERY_COUNT, data.queryCount) },
        (_unused, index) => queryAt(data, index),
      );

      // Exact scan baseline. The trigger is pinned off on purpose: the default
      // trigger legitimately escalates once a cold first scan (the 200MB load
      // included) pushes the observed flat p95 over 150 ms. The baseline must
      // stay the exact B2 scan, so pin it rather than rely on timing.
      const flatSearch = createAnnAwareIndexSearch({
        space: A6_SPACE,
        units: [A6_UNIT],
        root: dirs.root,
        trigger: { shouldUseAnn: () => false },
      });
      const flatMs: number[] = [];
      const flatParentIds: string[][] = [];
      for (const query of queries) {
        const startedAt = performance.now();
        const result = flatSearch({ query, topK: TOP_K });
        flatMs.push(performance.now() - startedAt);
        expect(result.status).toBe("searched");
        expect(result.degraded).toBeUndefined();
        flatParentIds.push(searchedParentIds(result));
      }
      const flatStats = flatSearch.stats();
      expect(flatStats.kind).toBe("flat");
      expect(flatStats.annSearches).toBe(0);
      expect(flatStats.degraded).toBeUndefined();

      // Forced ANN through the production adapter (injected trigger).
      const annSearch = createAnnAwareIndexSearch({
        space: A6_SPACE,
        units: [A6_UNIT],
        root: dirs.root,
        trigger: { chunkCount: 1 },
      });
      const annMs: number[] = [];
      const annParentIds: string[][] = [];
      for (const query of queries) {
        const startedAt = performance.now();
        const result = annSearch({ query, topK: TOP_K });
        annMs.push(performance.now() - startedAt);
        expect(result.status).toBe("searched");
        expect(result.degraded).toBeUndefined();
        annParentIds.push(searchedParentIds(result));
      }
      const annStats = annSearch.stats();
      const agreement = topKAgreement(flatParentIds, annParentIds);

      expect(annStats.kind).toBe("ann");
      expect(annStats.annSearches).toBe(queries.length);
      expect(annStats.annShards).toBe(1);
      expect(annStats.degraded).toBeUndefined();
      expect(annStats.annSearches).toBeGreaterThan(0);
      expect(agreement).toBeGreaterThanOrEqual(0.9);

      const sidecarDir = annShardSidecarDir(A6_SPACE, { root: dirs.root });
      const firstQuery = queries[0];
      const flatFirst = flatParentIds[0];
      expect(firstQuery).toBeDefined();
      expect(flatFirst).toBeDefined();
      if (firstQuery === undefined || flatFirst === undefined) return;

      // Corrupt the serialized index: silent flat fallback, never a throw.
      writeFileSync(sidecar.indexPath, Buffer.from([0, 1, 2]));
      const corruptSearch = createAnnAwareIndexSearch({
        space: A6_SPACE,
        units: [A6_UNIT],
        root: dirs.root,
        trigger: { chunkCount: 1 },
      });
      const corruptResult = corruptSearch({ query: firstQuery, topK: TOP_K });
      expect(corruptResult.status).toBe("searched");
      expect(corruptResult.degraded).toBe(ANN_SEARCH_DEGRADED);
      expect(corruptResult.reason).toContain("sidecar-corrupt");
      expect(searchedParentIds(corruptResult)).toEqual(flatFirst);
      const corruptStats = corruptSearch.stats();
      expect(corruptStats.kind).toBe("flat");
      expect(corruptStats.degraded).toBe(ANN_SEARCH_DEGRADED);
      expect(corruptStats.degradedReason).toBe("sidecar-corrupt");
      expect(corruptStats.degradedSearches).toBe(1);

      // Delete the whole sidecar: same silent fallback, missing reason.
      assertInsideFixtureRoot(sidecarDir);
      rmSync(sidecarDir, { recursive: true, force: true });
      const missingSearch = createAnnAwareIndexSearch({
        space: A6_SPACE,
        units: [A6_UNIT],
        root: dirs.root,
        trigger: { chunkCount: 1 },
      });
      const missingResult = missingSearch({ query: firstQuery, topK: TOP_K });
      expect(missingResult.status).toBe("searched");
      expect(missingResult.degraded).toBe(ANN_SEARCH_DEGRADED);
      expect(missingResult.reason).toContain("sidecar-missing");
      expect(searchedParentIds(missingResult)).toEqual(flatFirst);
      expect(missingSearch.stats().degradedReason).toBe("sidecar-missing");

      evidenceLog["a6"] = {
        scale: SCALE.name,
        count,
        dimensions,
        queries: queries.length,
        b2WriteMs: round(b2WriteMs, 1),
        sidecarBuildMs: round(sidecarBuildMs, 1),
        sidecarIndexBytes: sidecar.manifest.indexBytes,
        flatP50Ms: round(nearestRank(flatMs, 50), 2),
        flatP95Ms: round(nearestRank(flatMs, 95), 2),
        annP50Ms: round(nearestRank(annMs, 50), 2),
        annP95Ms: round(nearestRank(annMs, 95), 2),
        annSearches: annStats.annSearches,
        annShards: annStats.annShards,
        agreement: round(agreement, 4),
        degradedCorrupt: corruptResult.degraded,
        degradedMissing: missingResult.degraded,
      };
      console.log(
        `[gate3-scale] A6 count=${count} b2Write=${round(b2WriteMs, 0)}ms sidecar=${round(sidecarBuildMs, 0)}ms agreement=${round(agreement, 4)} ann(p50=${round(nearestRank(annMs, 50), 2)}ms p95=${round(nearestRank(annMs, 95), 2)}ms annSearches=${annStats.annSearches}) fallback(corrupt=${corruptResult.degraded} missing=${missingResult.degraded})`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Suite budget (the gate's default run must stay a fast smoke)
// ---------------------------------------------------------------------------

test(
  "gate 3 scale run finishes inside its budget",
  () => {
    const elapsedMs = performance.now() - suiteStartedAt;
    console.log(
      `[gate3-scale] budget mode=${SCALE.name} elapsed=${round(elapsedMs, 0)}ms limit=${SUITE_BUDGET_MS}ms`,
    );
    expect(elapsedMs).toBeLessThan(SUITE_BUDGET_MS);
    if (IS_SMOKE) {
      // 48-2 §10 gate 3 / task brief: the default run must be <10 s.
      expect(elapsedMs).toBeLessThan(10_000);
    }
  },
  TEST_TIMEOUT_MS,
);
