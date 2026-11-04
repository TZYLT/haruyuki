/**
 * E3 — the two recall arms, fused on the live service path (feature 48).
 *
 * E1 owns the merge and E2 owns the vector arm; this file is the seam between
 * them: the real `runRecall`, the real selection/dedup path, the real B2 index
 * format and B4 mapping, with a fake deterministic encoder. No model, no
 * network, no harness data — every storage root is a fresh OS temp directory and
 * `HARUYUKI_HOME` / `LETTA_LOCAL_BACKEND_DIR` are redirected for the duration of
 * the file and restored afterwards (docs/31 §1.2 A2).
 *
 * What is pinned down here:
 * - two arms hitting the same unit merge by `fingerprint` (weight sums, the
 *   vector window is kept, nothing is injected twice);
 * - the lexical-only path is bit for bit the pre-fusion one (no vector source,
 *   an empty vector arm, or `vectorWeight: 0`);
 * - `vectorWeight` 0 / 0.5 / 1 really changes what the selector sees;
 * - the floor stays *relative* (`top × ratio`), never absolute;
 * - a degraded/unavailable vector arm neither touches the lexical result nor
 *   counts as a breaker failure;
 * - the fused output stays inside the entry/text budgets;
 * - `embeddingMetrics.record` gets one round with correct counts.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { readRecallMessageTexts } from "@/backend/local/recall-snippets";
import {
  embeddingMetrics,
  resetEmbeddingMetrics,
} from "@/reminders/embedding-metrics";
import type {
  RecallCandidate,
  RecallDecision,
  RecallEntry,
  RecallSourcePort,
  RecallSourceStatus,
} from "@/reminders/recall-port";
import { recallQueryTerms } from "@/reminders/recall-query";
import {
  readRecallRuntimeStatus,
  recordRecallDecision,
  resetRecallRuntime,
} from "@/reminders/recall-runtime";
import { type RecallRequest, runRecall } from "@/reminders/recall-service";
import {
  createEmbeddingIndexSearch,
  createLocalVectorParentPort,
  createVectorRecallSource,
  type RecallEncoderPort,
} from "@/reminders/recall-vector-source";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";
import {
  conversationDirFor,
  RECALL_FIXTURE_QUERY,
  type RecallFixture,
  withRecallFixture,
} from "@/test-utils/recall-fixture";

const DIMENSIONS = 8;
const SPACE_ID = "space-e3";
const MODEL_ID = "fake-e3";
const VECTOR_ROOT = mkdtempSync(join(tmpdir(), "haru-e3-vectors-"));

/** Fused entries carry E1's diagnostics fields on top of the injectable entry. */
type FusedEntry = RecallEntry & {
  arms?: readonly string[];
  armScores?: Partial<Record<string, number>>;
};

// --- isolated environment -------------------------------------------------

let homeDir: string;
let backendDir: string;
let previousHome: string | undefined;
let previousBackend: string | undefined;
const createdRoots: string[] = [];
let generationCounter = 0;

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), "haru-e3-home-"));
  backendDir = mkdtempSync(join(tmpdir(), "haru-e3-backend-"));
  previousHome = process.env.HARUYUKI_HOME;
  previousBackend = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = backendDir;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousBackend === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = previousBackend;
  }
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  rmSync(VECTOR_ROOT, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(backendDir, { recursive: true, force: true });
});

afterEach(() => {
  resetRecallRuntime();
});

// --- fixtures -------------------------------------------------------------

/** A fake encoder that always answers the vector of one indexed chunk. */
function targetingEncoder(chunkText: string): RecallEncoderPort {
  return {
    id: "fake:e3-targeting",
    async encodeQuery() {
      return fakeEmbeddingVector(chunkText, DIMENSIONS);
    },
  };
}

/**
 * Builds a real B2 index for one of the fixture's conversations.
 *
 * Defaults to the history conversation. Returns the messages and the first
 * chunk's text — the encoder targets that text, so the arm's top hit is
 * deterministic without a model.
 */
function buildTranscriptIndex(
  fixture: RecallFixture,
  conversationKey = fixture.historyDirectory,
): {
  conversationKey: string;
  messages: ReturnType<typeof readRecallMessageTexts>;
  targetText: string;
} {
  const messages = readRecallMessageTexts(
    join(fixture.storageDir, "conversations", conversationKey),
  );
  if (messages.length === 0) {
    throw new Error("the fixture history conversation has no recallable text");
  }
  const plans = messages.map((message) =>
    buildEmbeddingChunkPlan({ parentId: message.id, text: message.text }),
  );
  const chunks = plans.flatMap((plan) => plan.chunks);
  const targetText = chunks[0]?.text;
  if (targetText === undefined) {
    throw new Error("the fixture history message produced no chunk");
  }
  generationCounter += 1;
  writeEmbeddingIndex({
    unitDir: embeddingVectorUnitDir(
      { agentId: fixture.agentId, spaceId: SPACE_ID, conversationKey },
      { root: VECTOR_ROOT },
    ),
    unit: { agentId: fixture.agentId, spaceId: SPACE_ID, conversationKey },
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan)),
    vectors: chunks.map((chunk) => fakeEmbeddingVector(chunk.text, DIMENSIONS)),
    coverage: plans.reduce(
      (total, plan) => ({
        embeddedChars: total.embeddedChars + plan.coverage.embeddedChars,
        recallableChars: total.recallableChars + plan.coverage.recallableChars,
        ratio: 0,
      }),
      { embeddedChars: 0, recallableChars: 0, ratio: 0 },
    ),
    generation: `e3-generation-${generationCounter}`,
  });
  return { conversationKey, messages, targetText };
}

/** The real vector arm: E2 source over B2's index and B4's parent reader. */
function b2VectorSource(
  fixture: RecallFixture,
  conversationKey: string,
  chunkText: string,
  conversationId?: string,
): RecallSourcePort {
  return createVectorRecallSource({
    encoder: targetingEncoder(chunkText),
    search: createEmbeddingIndexSearch({
      space: { agentId: fixture.agentId, spaceId: SPACE_ID },
      root: VECTOR_ROOT,
      units: [
        {
          kind: "transcript",
          conversationKey,
          ...(conversationId === undefined ? {} : { conversationId }),
        },
      ],
    }),
    parentReader: createLocalVectorParentPort({
      storageDir: fixture.storageDir,
      memoryDir: getLocalBackendMemoryFilesystemRoot(
        fixture.agentId,
        fixture.storageDir,
      ),
    }),
    topK: 50,
  });
}

let candidateCounter = 0;

/** A hand-built vector-arm candidate, for the weight/threshold cases. */
function vectorCandidate(
  input: {
    fingerprint?: string;
    source?: "transcript" | "memory";
    file?: string;
    text?: string;
  } = {},
): RecallCandidate {
  candidateCounter += 1;
  const source = input.source ?? "memory";
  const file = input.file ?? `vector/only-${candidateCounter}.md`;
  return {
    source,
    fingerprint: input.fingerprint ?? `memory:${file}`,
    file,
    text: input.text ?? `向量专属的候选 ${candidateCounter}`,
    score: 1,
    arm: "vector",
  };
}

/** A vector port that answers exactly what the test needs, without an encoder. */
function vectorPort(
  candidates: readonly RecallCandidate[],
  status: RecallSourceStatus = "searched",
  reason?: string,
): RecallSourcePort {
  return {
    id: "vector",
    arm: "vector",
    async search() {
      return {
        candidates: [...candidates],
        diagnostic: {
          source: "vector",
          status,
          candidates: candidates.length,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    },
  };
}

/** One probe turn: deterministic, reads no dedup window and writes none. */
async function probe(
  fixture: RecallFixture,
  overrides: Partial<RecallRequest> = {},
): Promise<RecallDecision> {
  return runRecall({
    backend: fixture.backend,
    agentId: fixture.agentId,
    conversationId: fixture.currentConversationId,
    userText: RECALL_FIXTURE_QUERY,
    currentTurn: 1,
    dryRun: true,
    options: { limit: 5 },
    ...overrides,
  });
}

// --- the two-arm path -----------------------------------------------------

describe("two-arm fusion on the real service path", () => {
  test("the same unit is merged once, keeps the vector window, and is stable", async () => {
    await withRecallFixture(async (fixture) => {
      const { conversationKey, messages, targetText } =
        buildTranscriptIndex(fixture);
      const targetFingerprint = `transcript:${conversationKey}:${
        messages[0]?.id ?? ""
      }`;
      const source = b2VectorSource(fixture, conversationKey, targetText);

      // First prove the arm itself found the unit, so a failure below cannot be
      // mistaken for a fusion bug.
      const armOutcome = await source.search({
        terms: recallQueryTerms(RECALL_FIXTURE_QUERY),
        scope: {
          agentId: fixture.agentId,
          currentConversationId: fixture.currentConversationId,
        },
      });
      const armCandidate = armOutcome.candidates.find(
        (candidate) => candidate.fingerprint === targetFingerprint,
      );
      expect(armCandidate).toBeDefined();
      expect(armCandidate?.arm).toBe("vector");

      const first = await probe(fixture, {
        vectorSource: source,
        options: { limit: 3 },
      });
      const second = await probe(fixture, {
        vectorSource: source,
        options: { limit: 3 },
      });
      expect(first.status).toBe("injected");

      const fingerprints = first.entries.map((entry) => entry.fingerprint);
      // One entry per fingerprint: fusion merged the two-arm hit instead of
      // letting both arms inject the same passage.
      expect(new Set(fingerprints).size).toBe(fingerprints.length);
      const mergedEntries = first.entries.filter(
        (entry) => entry.fingerprint === targetFingerprint,
      );
      expect(mergedEntries).toHaveLength(1);
      const merged = mergedEntries[0] as FusedEntry | undefined;
      expect(merged?.arms).toEqual(["lexical", "vector"]);
      expect(merged?.armScores?.lexical).toBeGreaterThan(0);
      expect(merged?.armScores?.vector).toBeGreaterThan(0);
      // RRF sums both contributions, so the two-arm hit outranks a lone arm.
      expect(merged?.score).toBeGreaterThan(0.016);
      // B4's hit-centred window is what the merged entry shows.
      expect(merged?.text).toBe(armCandidate?.text);
      // Ordering is stable across identical runs (no wall-clock or Set-order
      // dependence in the merge).
      expect(second.entries.map((entry) => entry.fingerprint)).toEqual(
        fingerprints,
      );
      // Budgets and uniqueness hold on the fused output.
      expect(first.entries.length).toBeLessThanOrEqual(3);
      for (const entry of first.entries) {
        expect(entry.text.length).toBeLessThanOrEqual(400);
      }
      const totalCharacters = first.entries.reduce(
        (sum, entry) => sum + entry.text.length,
        0,
      );
      expect(totalCharacters).toBeLessThanOrEqual(1200);
    });
  });

  test("the vector arm applies the same in-context exclusion as the lexical arm", async () => {
    await withRecallFixture(async (fixture) => {
      // The fixture's current conversation has one message, and it is still in
      // the model's context (`N`). Index it so the vector arm *could* answer
      // from it, then prove both arms refuse it.
      const currentDirectory = basename(
        await conversationDirFor(
          fixture.storageDir,
          fixture.currentConversationId,
        ),
      );
      const indexed = buildTranscriptIndex(fixture, currentDirectory);
      const currentMessage = indexed.messages[0];
      expect(currentMessage).toBeDefined();
      if (currentMessage === undefined) return;
      const currentFingerprint = `transcript:${currentDirectory}:${currentMessage.id}`;

      // The lexical arm's `N` filter already refuses it.
      const baseline = await probe(fixture);
      expect(
        baseline.entries.some(
          (entry) => entry.fingerprint === currentFingerprint,
        ),
      ).toBe(false);

      // Without the record id the arm cannot tell which conversation is current,
      // so this is the control: the same index *does* yield the in-context unit.
      const anonymous = b2VectorSource(
        fixture,
        currentDirectory,
        indexed.targetText,
      );
      const anonymousOutcome = await anonymous.search({
        terms: recallQueryTerms(RECALL_FIXTURE_QUERY),
        scope: {
          agentId: fixture.agentId,
          currentConversationId: fixture.currentConversationId,
        },
      });
      expect(
        anonymousOutcome.candidates.some(
          (candidate) => candidate.fingerprint === currentFingerprint,
        ),
      ).toBe(true);

      // On the live turn the service passes `N` in the scope and the arm knows
      // the conversation id, so the in-context unit is dropped before it can be
      // injected twice.
      const source = b2VectorSource(
        fixture,
        currentDirectory,
        indexed.targetText,
        fixture.currentConversationId,
      );
      const decision = await probe(fixture, {
        vectorSource: source,
        options: { limit: 5 },
        fusion: { vectorWeight: 1, minScoreRatio: 0 },
      });
      const vectorDiagnostic = decision.diagnostics.sources.find(
        (diagnostic) => diagnostic.source === "vector",
      );
      expect(vectorDiagnostic?.candidates).toBe(0);
      expect(vectorDiagnostic?.reason).toContain(
        "still in the current conversation's context",
      );
      expect(
        decision.entries.some(
          (entry) => entry.fingerprint === currentFingerprint,
        ),
      ).toBe(false);
    });
  });

  test("a memory hit found by both arms keeps B4's title-prefixed window", async () => {
    await withRecallFixture(async (fixture) => {
      const baseline = await probe(fixture);
      const lexicalMemory = baseline.entries.find(
        (entry) => entry.source === "memory",
      );
      expect(lexicalMemory).toBeDefined();
      if (lexicalMemory === undefined) return;
      // B4 renders a vector memory hit as `path › heading` plus the best-line
      // window, counted inside the 400-character budget (48-2 §4.3).
      const vectorText = `${lexicalMemory.file} › 记账\n\n财务系统每日对账，对账结果写入当日台账。`;
      const twin: RecallCandidate = {
        source: "memory",
        fingerprint: lexicalMemory.fingerprint,
        file: lexicalMemory.file,
        startLine: 3,
        endLine: 5,
        text: vectorText,
        score: 1,
        arm: "vector",
      };

      const decision = await probe(fixture, {
        vectorSource: vectorPort([twin]),
        fusion: { vectorWeight: 0.5, minScoreRatio: 0 },
      });
      const mergedEntries = decision.entries.filter(
        (entry) => entry.fingerprint === lexicalMemory.fingerprint,
      );
      expect(mergedEntries).toHaveLength(1);
      const merged = mergedEntries[0] as FusedEntry | undefined;
      expect(merged?.arms).toEqual(["lexical", "vector"]);
      // The merged entry keeps the vector arm's display window (title prefix and
      // the line span it was cut from), not the lexical from-the-head excerpt.
      expect(merged?.text).toBe(vectorText);
      expect(merged?.startLine).toBe(3);
      expect(merged?.endLine).toBe(5);
      expect(merged?.text.length).toBeLessThanOrEqual(400);
    });
  });

  test("the lexical-only path is bit for bit the pre-fusion one", async () => {
    await withRecallFixture(async (fixture) => {
      const baseline = await probe(fixture);
      expect(baseline.entries.length).toBeGreaterThan(0);
      // A probe is deterministic: this is the reference the fallbacks must match.
      expect(await probe(fixture)).toEqual(baseline);

      // (a) No vector source at all — the embedding-off path.
      // (b) A vector source that found nothing (missing index / spent budget).
      const emptyArm = await probe(fixture, {
        vectorSource: vectorPort([], "empty", "the vector space has no units"),
      });
      // (c) The user asked for lexical only.
      const weightZero = await probe(fixture, {
        vectorSource: vectorPort([vectorCandidate()]),
        fusion: { vectorWeight: 0 },
      });

      for (const decision of [emptyArm, weightZero]) {
        expect(decision.entries).toEqual(baseline.entries);
        expect(decision.status).toBe(baseline.status);
        expect(decision.diagnostics.threshold).toBe(
          baseline.diagnostics.threshold,
        );
        expect(decision.diagnostics.candidates).toBe(
          baseline.diagnostics.candidates,
        );
        expect(decision.timedOut).toBeUndefined();
      }
    });
  });

  test("vectorWeight 0 / 0.5 / 1 changes what the selector sees", async () => {
    await withRecallFixture(async (fixture) => {
      const baseline = await probe(fixture);
      const lexicalFingerprints = baseline.entries.map(
        (entry) => entry.fingerprint,
      );
      expect(lexicalFingerprints.length).toBeGreaterThan(0);

      const vectorOnly = vectorCandidate({
        fingerprint: "memory:vector/only.md",
        file: "vector/only.md",
        text: "向量专属：机房搬迁计划在下周执行",
      });

      const weightZero = await probe(fixture, {
        vectorSource: vectorPort([vectorOnly]),
        fusion: { vectorWeight: 0 },
      });
      expect(weightZero.entries.map((entry) => entry.fingerprint)).toEqual(
        lexicalFingerprints,
      );
      expect(
        weightZero.entries.some(
          (entry) => entry.fingerprint === vectorOnly.fingerprint,
        ),
      ).toBe(false);

      const weightOne = await probe(fixture, {
        vectorSource: vectorPort([vectorOnly]),
        fusion: { vectorWeight: 1 },
      });
      expect(weightOne.entries.map((entry) => entry.fingerprint)).toEqual([
        vectorOnly.fingerprint,
      ]);

      const weightHalf = await probe(fixture, {
        vectorSource: vectorPort([vectorOnly]),
        fusion: { vectorWeight: 0.5, minScoreRatio: 0 },
      });
      const halfFingerprints = weightHalf.entries.map(
        (entry) => entry.fingerprint,
      );
      expect(halfFingerprints).toContain(vectorOnly.fingerprint);
      expect(halfFingerprints.length).toBeGreaterThan(1);
      // The vector-only entry keeps the text B4 produced for it.
      expect(
        weightHalf.entries.find(
          (entry) => entry.fingerprint === vectorOnly.fingerprint,
        )?.text,
      ).toBe(vectorOnly.text);
    });
  });

  test("the floor is relative (top × ratio), never an absolute score", async () => {
    await withRecallFixture(async (fixture) => {
      const arm = [
        vectorCandidate({ fingerprint: "memory:rank-1.md", file: "rank-1.md" }),
        vectorCandidate({ fingerprint: "memory:rank-2.md", file: "rank-2.md" }),
        vectorCandidate({ fingerprint: "memory:rank-3.md", file: "rank-3.md" }),
      ];
      // RRF makes the three scores ~1/61, 1/62, 1/63 — any constant threshold
      // would behave nothing like this.
      const permissive = await probe(fixture, {
        vectorSource: vectorPort(arm),
        fusion: { vectorWeight: 1, minScoreRatio: 0.35 },
      });
      expect(permissive.entries).toHaveLength(3);

      const strict = await probe(fixture, {
        vectorSource: vectorPort(arm),
        fusion: { vectorWeight: 1, minScoreRatio: 0.999 },
      });
      expect(strict.entries).toHaveLength(1);
      expect(strict.entries[0]?.fingerprint).toBe("memory:rank-1.md");
      expect(strict.diagnostics.threshold).toBeGreaterThan(0.015);
      expect(strict.diagnostics.threshold).toBeLessThan(0.017);
    });
  });

  test("a degraded or unavailable vector arm leaves the lexical result and the breaker alone", async () => {
    await withRecallFixture(async (fixture) => {
      resetRecallRuntime();
      const baseline = await probe(fixture);
      expect(baseline.entries.length).toBeGreaterThan(0);

      const degraded = await probe(fixture, {
        vectorSource: vectorPort(
          [],
          "degraded",
          "the vector arm ran out of its own query budget",
        ),
      });
      expect(degraded.timedOut).toBeUndefined();
      expect(degraded.entries).toEqual(baseline.entries);
      expect(
        degraded.diagnostics.sources.some(
          (diagnostic) =>
            diagnostic.source === "vector" && diagnostic.status === "degraded",
        ),
      ).toBe(true);
      expect(recordRecallDecision(degraded, fixture.agentId)).toBeNull();
      expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);
      expect(readRecallRuntimeStatus().tripped).toBe(false);

      // The real E2 source with an encoder that cannot answer: `unavailable`,
      // not a throw and not a timeout.
      const unavailable = createVectorRecallSource({
        encoder: {
          async encodeQuery() {
            return null;
          },
        },
        search: () => ({
          status: "unavailable",
          hits: [],
          reason: "no usable vector index in the space",
        }),
        parentReader: {
          transcriptMessages: () => undefined,
          memoryParent: () => undefined,
        },
      });
      const unavailableDecision = await probe(fixture, {
        vectorSource: unavailable,
      });
      expect(unavailableDecision.timedOut).toBeUndefined();
      expect(unavailableDecision.entries).toEqual(baseline.entries);
      expect(
        recordRecallDecision(unavailableDecision, fixture.agentId),
      ).toBeNull();
      expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);
    });
  });
});

// --- D6 telemetry ---------------------------------------------------------

describe("embeddingMetrics integration", () => {
  test("one round is recorded with the two arms' candidates and injections", async () => {
    await withRecallFixture(async (fixture) => {
      const { conversationKey, targetText } = buildTranscriptIndex(fixture);

      // Reference: the lexical-only round tells us how many candidates the
      // lexical arm produced on this fixture.
      resetEmbeddingMetrics();
      const baseline = await probe(fixture);
      const baselineRound = embeddingMetrics.snapshot().last;
      expect(baselineRound).not.toBeNull();
      const lexicalCandidates = baselineRound?.lexical.candidates ?? 0;
      expect(lexicalCandidates).toBeGreaterThan(0);
      expect(baselineRound?.vector.candidates).toBe(0);
      expect(baselineRound?.fusedIn).toBe(0);
      expect(baselineRound?.fusedOut).toBe(0);
      expect(baselineRound?.injected).toBe(baseline.entries.length);

      // The fused round: the arm's parent hits merge with their lexical twins.
      // Probe the arm directly first so the expected counts come from the arm,
      // not from a hand-written guess about the fixture corpus.
      const source = b2VectorSource(fixture, conversationKey, targetText);
      const armOutcome = await source.search({
        terms: recallQueryTerms(RECALL_FIXTURE_QUERY),
        scope: {
          agentId: fixture.agentId,
          currentConversationId: fixture.currentConversationId,
        },
      });
      const vectorCandidates = armOutcome.candidates.length;
      expect(vectorCandidates).toBeGreaterThan(0);

      resetEmbeddingMetrics();
      const fusedDecision = await probe(fixture, {
        vectorSource: source,
        options: { limit: 3 },
      });
      const round = embeddingMetrics.snapshot().last;
      expect(round).not.toBeNull();
      expect(round?.lexical.candidates).toBe(lexicalCandidates);
      expect(round?.vector.candidates).toBe(vectorCandidates);
      expect(round?.chunks.parents).toBe(vectorCandidates);
      expect(round?.fusedIn).toBe(lexicalCandidates + vectorCandidates);
      expect(round?.fusedOut).toBeGreaterThanOrEqual(vectorCandidates);
      expect(round?.fusedOut).toBeLessThanOrEqual(
        lexicalCandidates + vectorCandidates,
      );
      // At least the history message is found by both arms on this fixture.
      expect(round?.bothArms).toBeGreaterThanOrEqual(1);
      expect(round?.injected).toBe(fusedDecision.entries.length);
      expect(round?.lexical.injected).toBeGreaterThanOrEqual(1);
      expect(round?.vector.injected).toBeGreaterThanOrEqual(1);
      expect(round?.degrade).toEqual([]);
      expect(round?.timings.totalMs).toBeGreaterThanOrEqual(0);
      expect(round?.timings.lexicalMs).toBeGreaterThanOrEqual(0);
      expect(round?.timings.vectorMs).toBeGreaterThanOrEqual(0);
      expect(round?.timings.fusionMs).toBeGreaterThanOrEqual(0);
      expect(typeof round?.at).toBe("number");
    });
  });

  test("a degraded arm is a degrade reason in the round, not a failure", async () => {
    await withRecallFixture(async (fixture) => {
      resetEmbeddingMetrics();
      const decision = await probe(fixture, {
        vectorSource: vectorPort([], "degraded", "the scan budget expired"),
      });
      const round = embeddingMetrics.snapshot().last;
      expect(round?.degrade).toEqual(["degraded"]);
      expect(round?.vector.candidates).toBe(0);
      expect(round?.fusedIn).toBe(0);
      expect(round?.injected).toBe(decision.entries.length);
      expect(decision.timedOut).toBeUndefined();
    });
  });
});
