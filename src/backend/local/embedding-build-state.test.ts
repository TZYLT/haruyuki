import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createEmptyEmbeddingBuildState,
  EMBEDDING_BUILD_MAX_FAILURES,
  EMBEDDING_BUILD_MAX_RATE_SAMPLES,
  EMBEDDING_BUILD_STATE_SCHEMA_VERSION,
  embeddingBuildStatePath,
  mergeEmbeddingBuildProgress,
  readEmbeddingBuildState,
  snapshotEmbeddingBuildState,
  updateEmbeddingBuildState,
  writeEmbeddingBuildState,
} from "./embedding-build-state";

/**
 * All state files live under a fresh OS temp directory (docs/31 §1.2 A2): no
 * test ever points at the real harness data, and nothing here reads env.
 */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hryk-w2-a2-state-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const IDENTITY = { agentId: "agent-a", spaceId: "space-a" } as const;

let now = 1_000_000;
const clock = () => now;

beforeEach(() => {
  now = 1_000_000;
});

function makeStatePath(dir = makeTempDir()): string {
  return embeddingBuildStatePath(join(dir, IDENTITY.agentId, IDENTITY.spaceId));
}

function emptyState() {
  return createEmptyEmbeddingBuildState(IDENTITY, { clock });
}

describe("embeddingBuildStatePath", () => {
  test("puts state.json inside the space directory", () => {
    expect(embeddingBuildStatePath(join("root", "agent", "space"))).toBe(
      join("root", "agent", "space", "state.json"),
    );
  });
});

describe("createEmptyEmbeddingBuildState", () => {
  test("is idle, zeroed and schema-stamped", () => {
    const state = emptyState();
    expect(state.schemaVersion).toBe(EMBEDDING_BUILD_STATE_SCHEMA_VERSION);
    expect(state).toMatchObject(IDENTITY);
    expect(state.phase).toBe("idle");
    expect(state.mode).toBe("incremental");
    expect(state.buildId).toBeNull();
    expect(state.startedAt).toBeNull();
    expect(state.finishedAt).toBeNull();
    expect(state.updatedAt).toBe(now);
    expect(state.progress).toEqual({
      embeddedChunks: 0,
      totalChunks: 0,
      processedConversations: 0,
      totalConversations: 0,
    });
    expect(state.coverage).toEqual({ embeddedChars: 0, recallableChars: 0 });
    expect(state.failures).toEqual([]);
    expect(state.rateSamples).toEqual([]);
  });
});

describe("write / read round-trip", () => {
  test("persists and reads the same record without leaving temp files", async () => {
    const statePath = makeStatePath();
    const state = mergeEmbeddingBuildProgress(
      emptyState(),
      {
        embeddedChunks: 7,
        totalChunks: 20,
        embeddedChars: 700,
        recallableChars: 1_000,
      },
      { clock },
    );
    await writeEmbeddingBuildState(statePath, state);

    const read = await readEmbeddingBuildState(statePath, {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("ok");
    expect(read.discarded).toBe(false);
    expect(read.state).toEqual(state);
    const leftovers = readdirSync(dirname(statePath)).filter((entry) =>
      entry.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  test("creates missing parent directories", async () => {
    const statePath = makeStatePath();
    expect(existsSync(statePath)).toBe(false);
    await writeEmbeddingBuildState(statePath, emptyState());
    expect(existsSync(statePath)).toBe(true);
  });

  test("normalizes non-finite counters instead of persisting null", async () => {
    const statePath = makeStatePath();
    const state = emptyState();
    const corrupted = {
      ...state,
      progress: { ...state.progress, embeddedChunks: Number.NaN },
    };
    await writeEmbeddingBuildState(statePath, corrupted);
    const read = await readEmbeddingBuildState(statePath, {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("ok");
    expect(read.state.progress.embeddedChunks).toBe(0);
  });

  test("a missing file reads as an empty state marked missing", async () => {
    const read = await readEmbeddingBuildState(makeStatePath(), {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("missing");
    expect(read.discarded).toBe(false);
    expect(read.state.phase).toBe("idle");
    expect(read.state).toMatchObject(IDENTITY);
  });
});

describe("corruption tolerance", () => {
  test("a half-written file is discarded as corrupt", async () => {
    const statePath = makeStatePath();
    await writeEmbeddingBuildState(statePath, emptyState());
    writeFileSync(statePath, '{"schemaVersion":1,"agentId":"agent-a",', "utf8");

    const read = await readEmbeddingBuildState(statePath, {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("corrupt");
    expect(read.discarded).toBe(true);
    expect(read.detail).toContain("JSON");
    expect(read.state.phase).toBe("idle");
    expect(read.state.progress.embeddedChunks).toBe(0);
  });

  test("a structurally invalid record is discarded as corrupt", async () => {
    const statePath = makeStatePath();
    await writeEmbeddingBuildState(statePath, emptyState());
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        agentId: "agent-a",
        spaceId: "space-a",
        phase: "idle",
      }),
      "utf8",
    );
    const read = await readEmbeddingBuildState(statePath, {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("corrupt");
    expect(read.discarded).toBe(true);
    expect(read.detail).toContain("progress");
  });

  test("an unknown phase is discarded as corrupt", async () => {
    const statePath = makeStatePath();
    const state = emptyState();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ ...state, phase: "exploded" }),
      "utf8",
    );
    const read = await readEmbeddingBuildState(statePath, {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("corrupt");
    expect(read.discarded).toBe(true);
  });

  test("an unsupported schema version is discarded, not migrated", async () => {
    const statePath = makeStatePath();
    const state = emptyState();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ ...state, schemaVersion: 2 }),
      "utf8",
    );
    const read = await readEmbeddingBuildState(statePath, {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("unsupported_schema");
    expect(read.discarded).toBe(true);
    expect(read.state.schemaVersion).toBe(EMBEDDING_BUILD_STATE_SCHEMA_VERSION);
  });

  test("a state file for another (agentId, spaceId) is not adopted", async () => {
    const statePath = makeStatePath();
    const foreign = createEmptyEmbeddingBuildState(
      { agentId: "agent-b", spaceId: "space-b" },
      { clock },
    );
    await writeEmbeddingBuildState(statePath, foreign);

    const read = await readEmbeddingBuildState(statePath, {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("corrupt");
    expect(read.discarded).toBe(true);
    expect(read.state.agentId).toBe(IDENTITY.agentId);
  });

  test("update rebuilds a corrupt file and reports the recovery", async () => {
    const statePath = makeStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "not json at all", "utf8");

    const result = await updateEmbeddingBuildState(
      statePath,
      { ...IDENTITY, clock },
      { embeddedChunks: 3, totalChunks: 9, phase: "running" },
    );
    expect(result.readStatus).toBe("corrupt");
    expect(result.recovered).toBe(true);
    expect(result.state.progress.embeddedChunks).toBe(3);
    expect(result.state.phase).toBe("running");

    const read = await readEmbeddingBuildState(statePath, {
      ...IDENTITY,
      clock,
    });
    expect(read.status).toBe("ok");
    expect(read.state.progress.embeddedChunks).toBe(3);
  });
});

describe("mergeEmbeddingBuildProgress", () => {
  test("applies absolute counters and stamps the wall clock", () => {
    const state = emptyState();
    const next = mergeEmbeddingBuildProgress(
      state,
      {
        embeddedChunks: 10,
        totalChunks: 40,
        processedConversations: 2,
        totalConversations: 8,
        embeddedChars: 1_000,
        recallableChars: 5_000,
      },
      { clock },
    );
    expect(next.progress).toEqual({
      embeddedChunks: 10,
      totalChunks: 40,
      processedConversations: 2,
      totalConversations: 8,
    });
    expect(next.coverage).toEqual({
      embeddedChars: 1_000,
      recallableChars: 5_000,
    });
    expect(next.updatedAt).toBe(now);
    // The input record is never mutated.
    expect(state.progress.embeddedChunks).toBe(0);
    expect(state.updatedAt).toBe(1_000_000);
  });

  test("running sets startedAt and a terminal phase sets finishedAt", () => {
    let state = emptyState();
    state = mergeEmbeddingBuildProgress(state, { phase: "running" }, { clock });
    expect(state.startedAt).toBe(now);
    expect(state.finishedAt).toBeNull();

    now += 4_000;
    state = mergeEmbeddingBuildProgress(
      state,
      { phase: "completed" },
      { clock },
    );
    expect(state.finishedAt).toBe(now);
    expect(state.startedAt).toBe(now - 4_000);
  });

  test("appends failures and keeps the list bounded", () => {
    let state = emptyState();
    for (let index = 0; index < EMBEDDING_BUILD_MAX_FAILURES + 5; index += 1) {
      state = mergeEmbeddingBuildProgress(
        state,
        {
          failure: {
            conversationId: `conv-${index}`,
            code: "embed_failed",
            message: `batch ${index} failed`,
          },
        },
        { clock },
      );
    }
    expect(state.failures).toHaveLength(EMBEDDING_BUILD_MAX_FAILURES);
    expect(state.failures[0]?.conversationId).toBe("conv-5");
    expect(state.failures.at(-1)?.conversationId).toBe(
      `conv-${EMBEDDING_BUILD_MAX_FAILURES + 4}`,
    );
    expect(state.failures.at(-1)?.at).toBe(now);
  });

  test("sanitizes negative and non-finite counters", () => {
    const next = mergeEmbeddingBuildProgress(
      emptyState(),
      { embeddedChunks: -5, totalChunks: Number.POSITIVE_INFINITY },
      { clock },
    );
    expect(next.progress.embeddedChunks).toBe(0);
    expect(next.progress.totalChunks).toBe(0);
  });

  test("caps the persisted rate samples", () => {
    let state = emptyState();
    for (
      let index = 0;
      index < EMBEDDING_BUILD_MAX_RATE_SAMPLES * 2;
      index += 1
    ) {
      now += 10;
      state = mergeEmbeddingBuildProgress(
        state,
        { embeddedChunks: index },
        { clock },
      );
    }
    expect(state.rateSamples).toHaveLength(EMBEDDING_BUILD_MAX_RATE_SAMPLES);
    expect(state.rateSamples.at(-1)?.embeddedChunks).toBe(
      EMBEDDING_BUILD_MAX_RATE_SAMPLES * 2 - 1,
    );
  });

  test("prunes samples outside the window but keeps a baseline", () => {
    let state = emptyState();
    now = 10_000;
    state = mergeEmbeddingBuildProgress(
      state,
      { embeddedChunks: 0 },
      { clock, rateWindowMs: 1_000 },
    );
    now += 500;
    state = mergeEmbeddingBuildProgress(
      state,
      { embeddedChunks: 5 },
      { clock, rateWindowMs: 1_000 },
    );
    now += 2_000;
    state = mergeEmbeddingBuildProgress(
      state,
      { embeddedChunks: 25 },
      { clock, rateWindowMs: 1_000 },
    );
    expect(state.rateSamples).toEqual([
      { at: 10_500, embeddedChunks: 5 },
      { at: 12_500, embeddedChunks: 25 },
    ]);
  });
});

describe("snapshotEmbeddingBuildState", () => {
  test("derives progress, coverage, rate and ETA in one pass", () => {
    let state = emptyState();
    now = 10_000;
    state = mergeEmbeddingBuildProgress(
      state,
      {
        phase: "running",
        embeddedChunks: 0,
        totalChunks: 40,
        processedConversations: 0,
        totalConversations: 10,
        embeddedChars: 0,
        recallableChars: 4_000,
      },
      { clock },
    );
    now = 12_000;
    state = mergeEmbeddingBuildProgress(
      state,
      {
        embeddedChunks: 10,
        processedConversations: 3,
        embeddedChars: 1_000,
      },
      { clock },
    );

    const snapshot = snapshotEmbeddingBuildState(state);
    expect(snapshot.phase).toBe("running");
    expect(snapshot.progress).toEqual({
      embeddedChunks: 10,
      totalChunks: 40,
      processedConversations: 3,
      totalConversations: 10,
      remainingChunks: 30,
      fraction: 0.25,
    });
    expect(snapshot.coverage).toEqual({
      embeddedChars: 1_000,
      recallableChars: 4_000,
      ratio: 0.25,
    });
    expect(snapshot.rate.chunksPerSecond).toBeCloseTo(5);
    expect(snapshot.rate.windowMs).toBe(2_000);
    expect(snapshot.rate.sampleCount).toBe(2);
    expect(snapshot.eta).toEqual({ remainingChunks: 30, remainingMs: 6_000 });
  });

  test("reports unknown rate/ETA until two samples exist", () => {
    let state = emptyState();
    state = mergeEmbeddingBuildProgress(
      state,
      { embeddedChunks: 5, totalChunks: 20 },
      { clock },
    );
    const snapshot = snapshotEmbeddingBuildState(state);
    expect(snapshot.rate.chunksPerSecond).toBeNull();
    expect(snapshot.eta.remainingMs).toBeNull();
    expect(snapshot.progress.fraction).toBe(0.25);
  });

  test("reports null fraction/coverage when the denominators are unknown", () => {
    const snapshot = snapshotEmbeddingBuildState(emptyState());
    expect(snapshot.progress.fraction).toBeNull();
    expect(snapshot.coverage.ratio).toBeNull();
  });

  test("a finished build has a zero ETA", () => {
    let state = emptyState();
    state = mergeEmbeddingBuildProgress(
      state,
      { embeddedChunks: 10, totalChunks: 10, phase: "completed" },
      { clock },
    );
    state = mergeEmbeddingBuildProgress(
      state,
      { embeddedChunks: 10, totalChunks: 10 },
      { clock },
    );
    const snapshot = snapshotEmbeddingBuildState(state);
    expect(snapshot.eta).toEqual({ remainingChunks: 0, remainingMs: 0 });
  });

  test("is deep-frozen so consumers cannot mutate builder state", () => {
    const state = mergeEmbeddingBuildProgress(
      emptyState(),
      {
        embeddedChunks: 1,
        totalChunks: 2,
        failure: { conversationId: "conv-1", code: "embed_failed" },
      },
      { clock },
    );
    const snapshot = snapshotEmbeddingBuildState(state);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.progress)).toBe(true);
    expect(Object.isFrozen(snapshot.coverage)).toBe(true);
    expect(Object.isFrozen(snapshot.rate)).toBe(true);
    expect(Object.isFrozen(snapshot.eta)).toBe(true);
    expect(Object.isFrozen(snapshot.failures)).toBe(true);
    expect(Object.isFrozen(snapshot.failures[0])).toBe(true);
    expect(() => {
      (snapshot.progress as { embeddedChunks: number }).embeddedChunks = 99;
    }).toThrow();
    expect(() => {
      (snapshot.failures[0] as { code: string }).code = "changed";
    }).toThrow();
  });

  test("failure list in the snapshot is detached from the state", () => {
    const state = mergeEmbeddingBuildProgress(
      emptyState(),
      { failure: { conversationId: "conv-1", code: "embed_failed" } },
      { clock },
    );
    const snapshot = snapshotEmbeddingBuildState(state);
    const failure = state.failures[0];
    if (!failure) throw new Error("expected a recorded failure");
    failure.code = "mutated-after-snapshot";
    expect(snapshot.failures[0]?.code).toBe("embed_failed");
  });
});

describe("on-disk shape", () => {
  test("writes newline-terminated compact JSON", async () => {
    const statePath = makeStatePath();
    await writeEmbeddingBuildState(statePath, emptyState());
    const raw = readFileSync(statePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("\n  ");
    expect(JSON.parse(raw).schemaVersion).toBe(
      EMBEDDING_BUILD_STATE_SCHEMA_VERSION,
    );
  });
});
