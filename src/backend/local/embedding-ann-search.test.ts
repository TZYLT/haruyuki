/**
 * Unit tests for the ANN query path (feature 48, package A6).
 *
 * Everything is synthetic and lives under the OS temp directory (docs/31 §1.2
 * A2): B2 writes real generations below a fixture root, B7 builds real IVF
 * sidecars from deterministic clustered vectors, and the ANN path is exercised
 * with injected trigger thresholds so no 200k corpus is needed. No ONNX, no
 * network, no real harness data.
 *
 * The structural check at the bottom pins the E2 seam: the adapter must remain
 * assignable to `RecallVectorSearchPort` (type-only import; the runtime never
 * loads `reminders/`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAnnBenchDataset } from "@/backend/local/embedding/ann-bench";
import { resolveAnnIvfOptions } from "@/backend/local/embedding-ann-index";
import {
  ANN_SEARCH_DEGRADED,
  type AnnSearchTaggedHit,
  type AnnSearchUnit,
  annShardSidecarDir,
  createAnnAwareIndexSearch,
  createAnnShardedSearch,
  resolveAnnSearchTrigger,
  writeAnnShardSidecar,
} from "@/backend/local/embedding-ann-search";
import {
  type EmbeddingChunkRecordInput,
  type EmbeddingVectorUnit,
  embeddingVectorUnitDir,
  hashEmbeddingText,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import type { RecallVectorSearchPort } from "@/reminders/recall-vector-source";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";

const DIMENSIONS = 8;
const PARENT_SIZE = 2;
const SEED = 0x48_a6_2026;

const SPACE = { agentId: "agent-a6", spaceId: "space-a6-0001" };
const OTHER_SPACE = { agentId: "agent-a6", spaceId: "space-a6-0002" };

let dirs: EmbeddingFixtureDirs;
let previousHome: string | undefined;

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs("haru-ann-search-");
  previousHome = process.env.HARUYUKI_HOME;
  process.env.HARUYUKI_HOME = dirs.homeDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  dirs.cleanup();
});

// ---------------------------------------------------------------------------
// Synthetic corpus + B2 generation helpers
// ---------------------------------------------------------------------------

function dataset(
  count: number,
  options: { dimensions?: number; seed?: number; queryCount?: number } = {},
) {
  return generateAnnBenchDataset({
    count,
    dimensions: options.dimensions ?? DIMENSIONS,
    seed: options.seed ?? SEED,
    queryCount: options.queryCount ?? 8,
  });
}

type Corpus = ReturnType<typeof dataset>;

function rows(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_unused, index) => from + index);
}

function rowVector(data: Corpus, row: number): Float32Array {
  return data.vectors.subarray(
    row * data.dimensions,
    (row + 1) * data.dimensions,
  ) as Float32Array;
}

function queryOf(data: Corpus, index = 0): Float32Array {
  return data.queries.subarray(
    index * data.dimensions,
    (index + 1) * data.dimensions,
  ) as Float32Array;
}

function recordFor(row: number): EmbeddingChunkRecordInput {
  const parent = Math.floor(row / PARENT_SIZE);
  const chunkIndex = row % PARENT_SIZE;
  const startChar = row * 16;
  return {
    parentId: `msg-${parent.toString().padStart(4, "0")}`,
    chunkIndex,
    startChar,
    endChar: startChar + 12,
    spans: [{ startChar, endChar: startChar + 12 }],
    focusChar: startChar + 6,
    textHash: hashEmbeddingText(`chunk-${row}`),
  };
}

function transcriptUnit(conversationKey: string): AnnSearchUnit {
  return { kind: "transcript", conversationKey };
}

function memoryUnit(file: string, memoryFileKey: string): AnnSearchUnit {
  return { kind: "memory", file, memoryFileKey };
}

function embeddingUnitOf(
  space: { agentId: string; spaceId: string },
  unit: AnnSearchUnit,
): EmbeddingVectorUnit {
  return unit.kind === "transcript"
    ? {
        agentId: space.agentId,
        spaceId: space.spaceId,
        conversationKey: unit.conversationKey,
      }
    : {
        agentId: space.agentId,
        spaceId: space.spaceId,
        memoryFileKey: unit.memoryFileKey,
      };
}

/** Writes one real B2 generation for `unit` from the given dataset rows. */
function writeUnit(
  space: { agentId: string; spaceId: string },
  unit: AnnSearchUnit,
  data: Corpus,
  unitRows: readonly number[],
): void {
  const identity = embeddingUnitOf(space, unit);
  writeEmbeddingIndex({
    unitDir: embeddingVectorUnitDir(identity, { root: dirs.root }),
    unit: identity,
    modelId: "fake-bge-small-zh",
    dimensions: data.dimensions,
    records: unitRows.map((row) => recordFor(row)),
    vectors: unitRows.map((row) => rowVector(data, row)),
    coverage: {
      embeddedChars: unitRows.length * 12,
      recallableChars: unitRows.length * 12,
      ratio: 1,
    },
  });
}

/** IVF overrides that probe every list, so ANN == flat on these corpora. */
function exactIvf(count: number) {
  const resolved = resolveAnnIvfOptions(count);
  return {
    nlist: resolved.nlist,
    nprobe: resolved.nlist,
    trainSample: resolved.trainSample,
    iterations: resolved.iterations,
  };
}

function parentIds(hits: readonly AnnSearchTaggedHit[]): string[] {
  return hits.map((hit) => hit.hit.parentId);
}

function kinds(hits: readonly AnnSearchTaggedHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.kind))].sort();
}

function sidecarFiles(space: { agentId: string; spaceId: string }): string[] {
  return readdirSync(annShardSidecarDir(space, { root: dirs.root }));
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

describe("per-shard trigger (48-2 §4.10)", () => {
  test("defaults to B7 shouldUseAnn (>200k chunks or >150ms p95)", () => {
    const trigger = resolveAnnSearchTrigger();
    expect(trigger(199_999, 150)).toBe(false);
    expect(trigger(200_000, 150)).toBe(false);
    expect(trigger(200_001, 0)).toBe(true);
    expect(trigger(1_000, 150.001)).toBe(true);
  });

  test("injected thresholds replace either default", () => {
    expect(resolveAnnSearchTrigger({ chunkCount: 10 })(10, 0)).toBe(false);
    expect(resolveAnnSearchTrigger({ chunkCount: 10 })(11, 0)).toBe(true);
    expect(resolveAnnSearchTrigger({ p95Ms: 5 })(4, 6)).toBe(true);
    expect(resolveAnnSearchTrigger({ p95Ms: 5 })(4, 5)).toBe(false);
    expect(
      resolveAnnSearchTrigger({ shouldUseAnn: () => true })(0, undefined),
    ).toBe(true);
    expect(() => resolveAnnSearchTrigger({ chunkCount: -1 })).toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Small corpus: flat path
// ---------------------------------------------------------------------------

describe("flat path below the trigger", () => {
  test("scans every chunk and reports kind/scanned/chunkCount", () => {
    const data = dataset(12);
    writeUnit(SPACE, transcriptUnit("conv-1"), data, rows(0, 6));
    writeUnit(SPACE, transcriptUnit("conv-2"), data, rows(6, 12));
    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units: [transcriptUnit("conv-1"), transcriptUnit("conv-2")],
      root: dirs.root,
      now: () => 0,
    });

    const result = search({ query: queryOf(data), topK: 5 });
    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.hits.length).toBe(5);
    expect(result.chunks).toBe(12);
    // The flat path must report chunk hits: a status face showing 0 here while
    // the vector arm returned candidates is the 48-4 P0-1 bug.
    expect(result.chunkHits).toBeGreaterThan(0);
    expect(result.degraded).toBeUndefined();
    for (let index = 1; index < result.hits.length; index += 1) {
      expect(result.hits[index - 1]?.hit.score ?? 0).toBeGreaterThanOrEqual(
        result.hits[index]?.hit.score ?? 0,
      );
    }

    const stats = search.stats();
    expect(stats.kind).toBe("flat");
    expect(stats.scannedChunks).toBe(12);
    expect(stats.chunkCount).toBe(12);
    expect(stats.p95Ms).toBe(0);
    expect(stats.searches).toBe(1);
    expect(stats.flatSearches).toBe(1);
    expect(stats.annSearches).toBe(0);
    expect(stats.annShards).toBe(0);
    expect(stats.degraded).toBeUndefined();
  });

  test("memory units keep their file tag and both corpora are searched", () => {
    const data = dataset(12);
    const memory = memoryUnit("notes/a.md", "mem-a");
    writeUnit(SPACE, transcriptUnit("conv-1"), data, rows(0, 6));
    writeUnit(SPACE, memory, data, rows(6, 12));
    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units: [transcriptUnit("conv-1"), memory],
      root: dirs.root,
    });

    const result = search({ query: queryOf(data), topK: 6 });
    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(kinds(result.hits)).toEqual(["memory", "transcript"]);
    const memoryHit = result.hits.find((hit) => hit.kind === "memory");
    expect(memoryHit?.file).toBe("notes/a.md");
  });

  test("no units yet reports empty (a fresh install, not a failure)", () => {
    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units: [],
      root: dirs.root,
    });
    const result = search({ query: new Float32Array(DIMENSIONS), topK: 5 });
    expect(result.status).toBe("empty");
    expect(search.stats().searches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ANN path and chunk -> record -> B2 parent aggregation
// ---------------------------------------------------------------------------

describe("ANN path (injected trigger)", () => {
  test("ANN and flat agree on the parent top-k when the sidecar is exact", () => {
    const data = dataset(120);
    const units = [transcriptUnit("conv-1"), transcriptUnit("conv-2")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 60));
    writeUnit(SPACE, units[1] as AnnSearchUnit, data, rows(60, 120));
    const written = writeAnnShardSidecar({
      space: SPACE,
      units,
      root: dirs.root,
      ivf: exactIvf(120),
    });
    expect(written.ok).toBe(true);

    const query = queryOf(data);
    const flat = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
    });
    const ann = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      trigger: { chunkCount: 1 },
    });

    const flatResult = flat({ query, topK: 5 });
    const annResult = ann({ query, topK: 5 });
    expect(flatResult.status).toBe("searched");
    expect(annResult.status).toBe("searched");
    if (flatResult.status !== "searched" || annResult.status !== "searched") {
      return;
    }
    expect(annResult.degraded).toBeUndefined();
    expect(parentIds(annResult.hits)).toEqual(parentIds(flatResult.hits));
    // The ANN path reports the chunk refs it selected, never a hard 0.
    expect(annResult.chunkHits).toBeGreaterThan(0);
    for (const [index, hit] of annResult.hits.entries()) {
      expect(hit.hit.score).toBeCloseTo(
        flatResult.hits[index]?.hit.score ?? 0,
        6,
      );
    }

    const stats = ann.stats();
    expect(stats.kind).toBe("ann");
    expect(stats.annSearches).toBe(1);
    expect(stats.annShards).toBe(1);
    expect(stats.chunkCount).toBe(120);
    expect(stats.scannedChunks).toBeGreaterThan(0);
    expect(stats.scannedChunks).toBeLessThanOrEqual(120);
    expect(stats.degraded).toBeUndefined();
  });

  test("observed p95 above the threshold escalates the next query to ANN", () => {
    const data = dataset(40);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 40));
    expect(
      writeAnnShardSidecar({ space: SPACE, units, root: dirs.root }).ok,
    ).toBe(true);

    let clock = 0;
    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      now: () => {
        clock += 200;
        return clock;
      },
    });

    const first = search({ query: queryOf(data), topK: 3 });
    expect(first.status).toBe("searched");
    expect(search.stats().kind).toBe("flat");
    expect(search.stats().p95Ms).toBe(200);

    const second = search({ query: queryOf(data), topK: 3 });
    expect(second.status).toBe("searched");
    const stats = search.stats();
    expect(stats.kind).toBe("ann");
    expect(stats.annSearches).toBe(1);
    expect(stats.flatSearches).toBe(1);
    expect(stats.p95Ms).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Fallbacks: sidecar unavailable -> flat + degraded, never throws
// ---------------------------------------------------------------------------

describe("sidecar fallbacks", () => {
  test("missing sidecar above the trigger falls back to flat + degraded", () => {
    const data = dataset(20);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 20));
    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      trigger: { chunkCount: 1 },
    });
    const plain = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
    });

    const result = search({ query: queryOf(data), topK: 4 });
    const plainResult = plain({ query: queryOf(data), topK: 4 });
    expect(result.status).toBe("searched");
    expect(plainResult.status).toBe("searched");
    if (result.status !== "searched" || plainResult.status !== "searched") {
      return;
    }
    expect(result.degraded).toBe(ANN_SEARCH_DEGRADED);
    expect(result.reason).toContain("sidecar-missing");
    // Same answer as the exact path: degradation must not change the result.
    expect(parentIds(result.hits)).toEqual(parentIds(plainResult.hits));
    const stats = search.stats();
    expect(stats.kind).toBe("flat");
    expect(stats.degraded).toBe(ANN_SEARCH_DEGRADED);
    expect(stats.degradedReason).toBe("sidecar-missing");
    expect(stats.degradedSearches).toBe(1);
  });

  test("a corrupt index file degrades to flat + degraded", () => {
    const data = dataset(20);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 20));
    expect(
      writeAnnShardSidecar({ space: SPACE, units, root: dirs.root }).ok,
    ).toBe(true);
    const indexFile = sidecarFiles(SPACE).find((file) =>
      file.endsWith(".hann"),
    );
    expect(indexFile).toBeDefined();
    if (indexFile === undefined) return;
    writeFileSync(
      join(annShardSidecarDir(SPACE, { root: dirs.root }), indexFile),
      Buffer.from([0, 1, 2]),
    );

    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      trigger: { chunkCount: 1 },
    });
    const result = search({ query: queryOf(data), topK: 4 });
    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.degraded).toBe(ANN_SEARCH_DEGRADED);
    expect(result.reason).toContain("sidecar-corrupt");
    expect(search.stats().degradedReason).toBe("sidecar-corrupt");
  });

  test("a corrupt manifest degrades to flat + degraded", () => {
    const data = dataset(20);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 20));
    expect(
      writeAnnShardSidecar({ space: SPACE, units, root: dirs.root }).ok,
    ).toBe(true);
    writeFileSync(
      join(annShardSidecarDir(SPACE, { root: dirs.root }), "current.json"),
      "{not json",
      "utf8",
    );

    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      trigger: { chunkCount: 1 },
    });
    const result = search({ query: queryOf(data), topK: 4 });
    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.degraded).toBe(ANN_SEARCH_DEGRADED);
    expect(result.reason).toContain("sidecar-corrupt");
  });

  test("a sidecar with another width degrades to flat + degraded", () => {
    const data = dataset(20);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 20));
    expect(
      writeAnnShardSidecar({ space: SPACE, units, root: dirs.root }).ok,
    ).toBe(true);
    const manifestPath = join(
      annShardSidecarDir(SPACE, { root: dirs.root }),
      "current.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dimensions: number;
    };
    manifest.dimensions += 8;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      trigger: { chunkCount: 1 },
    });
    const result = search({ query: queryOf(data), topK: 4 });
    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.degraded).toBe(ANN_SEARCH_DEGRADED);
    expect(result.reason).toContain("sidecar-dimension-mismatch");
  });

  test("a stale sidecar (unit generation moved) degrades to flat + degraded", () => {
    const data = dataset(20);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 20));
    expect(
      writeAnnShardSidecar({ space: SPACE, units, root: dirs.root }).ok,
    ).toBe(true);

    // Rebuild the unit: same shape, new generation/checksum.
    const rebuilt = dataset(20, { seed: 0x1234 });
    writeUnit(SPACE, units[0] as AnnSearchUnit, rebuilt, rows(0, 20));

    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      trigger: { chunkCount: 1 },
    });
    const query = queryOf(rebuilt);
    const plain = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
    });
    const result = search({ query, topK: 4 });
    const plainResult = plain({ query, topK: 4 });
    expect(result.status).toBe("searched");
    expect(plainResult.status).toBe("searched");
    if (result.status !== "searched" || plainResult.status !== "searched") {
      return;
    }
    expect(result.degraded).toBe(ANN_SEARCH_DEGRADED);
    expect(result.reason).toContain("sidecar-stale");
    expect(parentIds(result.hits)).toEqual(parentIds(plainResult.hits));
  });

  test("a wrong-width query degrades to unavailable without throwing", () => {
    const data = dataset(20);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 20));
    expect(
      writeAnnShardSidecar({ space: SPACE, units, root: dirs.root }).ok,
    ).toBe(true);
    const search = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      trigger: { chunkCount: 1 },
    });
    expect(() => search({ query: new Float32Array(3), topK: 4 })).not.toThrow();
    const result = search({ query: new Float32Array(3), topK: 4 });
    expect(result.status).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// Sharding: per-shard trigger, global parent fusion
// ---------------------------------------------------------------------------

describe("per-shard decision and global fusion", () => {
  test("a big shard uses ANN while a small shard stays flat, fused globally", () => {
    const big = dataset(40, { seed: 0x11 });
    const small = dataset(8, { seed: 0x22 });
    const bigUnit = transcriptUnit("conv-big");
    const smallUnit = transcriptUnit("conv-small");
    writeUnit(SPACE, bigUnit, big, rows(0, 40));
    writeUnit(OTHER_SPACE, smallUnit, small, rows(0, 8));
    expect(
      writeAnnShardSidecar({
        space: SPACE,
        units: [bigUnit],
        root: dirs.root,
        ivf: exactIvf(40),
      }).ok,
    ).toBe(true);

    const search = createAnnShardedSearch({
      shards: [
        { ...SPACE, units: [bigUnit] },
        { ...OTHER_SPACE, units: [smallUnit] },
      ],
      root: dirs.root,
      trigger: { chunkCount: 10 },
      topK: 24,
    });
    const result = search({ query: queryOf(big), topK: 24 });
    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    const stats = search.stats();
    expect(stats.kind).toBe("ann");
    expect(stats.shards).toBe(2);
    expect(stats.annShards).toBe(1);
    expect(stats.degraded).toBeUndefined();
    expect(result.hits.length).toBe(24);
    // The query comes from the big shard, so it dominates the fused ordering.
    expect(result.hits[0]?.kind).toBe("transcript");
    expect(
      result.hits.some(
        (hit) =>
          hit.kind === "transcript" && hit.conversationKey === "conv-small",
      ),
    ).toBe(true);
    for (let index = 1; index < result.hits.length; index += 1) {
      expect(result.hits[index - 1]?.hit.score ?? 0).toBeGreaterThanOrEqual(
        result.hits[index]?.hit.score ?? 0,
      );
    }
  });

  test("two ANN shards merge into one deterministic global top-k", () => {
    const left = dataset(20, { seed: 0x33 });
    const right = dataset(20, { seed: 0x44 });
    const leftUnit = transcriptUnit("conv-left");
    const rightUnit = transcriptUnit("conv-right");
    writeUnit(SPACE, leftUnit, left, rows(0, 20));
    writeUnit(OTHER_SPACE, rightUnit, right, rows(0, 20));
    for (const [space, unit] of [
      [SPACE, leftUnit],
      [OTHER_SPACE, rightUnit],
    ] as const) {
      expect(
        writeAnnShardSidecar({
          space,
          units: [unit],
          root: dirs.root,
          ivf: exactIvf(20),
        }).ok,
      ).toBe(true);
    }
    const search = createAnnShardedSearch({
      shards: [
        { ...SPACE, units: [leftUnit] },
        { ...OTHER_SPACE, units: [rightUnit] },
      ],
      root: dirs.root,
      trigger: { chunkCount: 1 },
      topK: 12,
    });
    const query = queryOf(left);
    const first = search({ query, topK: 12 });
    const second = search({ query, topK: 12 });
    expect(first.status).toBe("searched");
    expect(second.status).toBe("searched");
    if (first.status !== "searched" || second.status !== "searched") return;
    expect(second).toEqual(first);
    expect(first.hits.length).toBe(12);
    expect(kinds(first.hits)).toEqual(["transcript"]);
    expect(
      first.hits.filter(
        (hit) =>
          hit.kind === "transcript" && hit.conversationKey === "conv-left",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      first.hits.filter(
        (hit) =>
          hit.kind === "transcript" && hit.conversationKey === "conv-right",
      ).length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism, stats and the E2 seam
// ---------------------------------------------------------------------------

describe("determinism, writer and stats", () => {
  test("the same query on the same corpus returns identical hits and stats shape", () => {
    const data = dataset(30);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 30));
    expect(
      writeAnnShardSidecar({ space: SPACE, units, root: dirs.root }).ok,
    ).toBe(true);
    const query = queryOf(data);
    const first = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
      trigger: { chunkCount: 1 },
    });
    const firstResult = first({ query, topK: 6 });
    const secondResult = first({ query, topK: 6 });
    expect(secondResult).toEqual(firstResult);
    expect(firstResult.status).toBe("searched");
    if (firstResult.status !== "searched") return;
    expect(firstResult.degraded).toBeUndefined();
    expect(new Set(parentIds(firstResult.hits)).size).toBe(
      firstResult.hits.length,
    );
    expect(first.stats().searches).toBe(2);
    expect(first.stats().annSearches).toBe(2);
  });

  test("the writer is content-addressed and idempotent", () => {
    const data = dataset(24);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 24));
    const first = writeAnnShardSidecar({
      space: SPACE,
      units,
      root: dirs.root,
    });
    const second = writeAnnShardSidecar({
      space: SPACE,
      units,
      root: dirs.root,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.wrote).toBe(true);
    expect(second.wrote).toBe(false);
    expect(second.manifest.signature).toBe(first.manifest.signature);
    expect(second.indexPath).toBe(first.indexPath);
    expect(readFileSync(first.indexPath)).toEqual(
      readFileSync(second.indexPath),
    );
    expect(first.manifest.chunkCount).toBe(24);
    expect(first.manifest.kind).toBe("ivf");
  });

  test("the writer reports typed failures instead of throwing", () => {
    const data = dataset(8);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 8));
    const missing = writeAnnShardSidecar({
      space: SPACE,
      units: [transcriptUnit("conv-missing")],
      root: dirs.root,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.problem).toBe("no-units");

    const empty = writeAnnShardSidecar({
      space: { agentId: "bad space", spaceId: "s" },
      units,
      root: dirs.root,
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.problem).toBe("invalid-space");
  });

  test("the adapter satisfies E2's RecallVectorSearchPort", async () => {
    const data = dataset(10);
    const units = [transcriptUnit("conv-1")];
    writeUnit(SPACE, units[0] as AnnSearchUnit, data, rows(0, 10));
    // Type-only dependency: production code never imports `reminders/`.
    const port: RecallVectorSearchPort = createAnnAwareIndexSearch({
      space: SPACE,
      units,
      root: dirs.root,
    });
    const result = await port({
      scope: { agentId: SPACE.agentId, currentConversationId: "conv-1" },
      query: queryOf(data),
      topK: 3,
      shouldStop: () => false,
    });
    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.hits.length).toBe(3);
  });
});
