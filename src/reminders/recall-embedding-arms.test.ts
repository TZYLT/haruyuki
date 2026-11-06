/**
 * Production wiring for feature 48's query arm (rework B).
 *
 * What this file pins down:
 * - the pure decision (embedding must be exactly `enabled`, and the backend must
 *   be able to describe a space);
 * - the unit listing: conversation units only for conversations that still
 *   exist, memory units mapped back from `fileKey` to the live workspace path;
 * - the factory: a real B2 index + a fake deterministic encoder produce a
 *   working `createVectorRecallSource`, and the fusion tunables are the
 *   settings' weight/depth with E1's `k` and relative floor;
 * - every "no arms" case (disabled, endpoint without a form, missing space,
 *   unusable pointer, non-local backend) returns `null` without throwing;
 * - on the live `runRecall`, the arms' vector candidates are fused with the real
 *   lexical arm, and `vectorWeight: 0` still behaves as lexical-only.
 *
 * Everything is synthetic: fake embeddings (no model, no network, no worker),
 * a temp vector root and temp storage/memory roots, with `HARUYUKI_HOME` and
 * `LETTA_LOCAL_BACKEND_DIR` redirected for the file (docs/31 §1.2 A2).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import type { EmbeddingQueryEncoder } from "@/backend/local/embedding-encoder";
import {
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import {
  buildMemoryVectorFilePlan,
  memoryFileKey,
} from "@/backend/local/embedding-memory";
import { writeEmbeddingQuantIndex } from "@/backend/local/embedding-quant-format";
import { resolveEmbeddingSpace } from "@/backend/local/embedding-space";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { readRecallMessageTexts } from "@/backend/local/recall-snippets";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";
import {
  createRecallEmbeddingArms,
  isRecallEmbeddingArmsRequested,
  listRecallEmbeddingUnits,
  maybeCreateRecallEmbeddingArms,
  type RecallEmbeddingArmsBackend,
  recallFusionOptionsFor,
  resetRecallEmbeddingArmsEncoderCacheForTests,
} from "@/reminders/recall-embedding-arms";
import { RECALL_FUSION_DEFAULTS } from "@/reminders/recall-fusion";
import type { RecallEntry } from "@/reminders/recall-port";
import { runRecall } from "@/reminders/recall-service";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";
import {
  RECALL_FIXTURE_QUERY,
  type RecallFixture,
  withRecallFixture,
} from "@/test-utils/recall-fixture";

const DIMENSIONS = 8;
const MODEL_ID = "fake-embedding-arms";
const VECTOR_ROOT = mkdtempSync(join(tmpdir(), "haru-embedding-arms-vectors-"));
const ENVIRONMENT_ROOT = mkdtempSync(
  join(tmpdir(), "haru-embedding-arms-env-"),
);

let previousHome: string | undefined;
let previousBackend: string | undefined;

beforeAll(() => {
  previousHome = process.env.HARUYUKI_HOME;
  previousBackend = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = join(ENVIRONMENT_ROOT, "home");
  process.env.LETTA_LOCAL_BACKEND_DIR = join(ENVIRONMENT_ROOT, "local-backend");
  mkdirSync(process.env.HARUYUKI_HOME, { recursive: true });
  mkdirSync(process.env.LETTA_LOCAL_BACKEND_DIR, { recursive: true });
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousBackend === undefined) delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = previousBackend;
  rmSync(VECTOR_ROOT, { recursive: true, force: true });
  rmSync(ENVIRONMENT_ROOT, { recursive: true, force: true });
});

// --- fixtures -------------------------------------------------------------

/** Endpoint-backed settings with a fake, loopback-only form (no request made). */
function endpointSettings(
  overrides: Partial<ResolvedEmbeddingSettings> = {},
): ResolvedEmbeddingSettings {
  return {
    ...EMBEDDING_SETTING_DEFAULTS,
    enabled: true,
    backend: "endpoint",
    endpoint: {
      kind: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      model: MODEL_ID,
      dimensions: DIMENSIONS,
      timeoutMs: 1_000,
    },
    ...overrides,
  };
}

/** A fake encoder whose query vector is the target chunk's vector. */
function targetingEncoder(targetText: string): EmbeddingQueryEncoder {
  return {
    id: "fake:embedding-arms",
    async encodeQuery() {
      return fakeEmbeddingVector(targetText, DIMENSIONS);
    },
    async encodeBatch(texts: readonly string[]) {
      return texts.map((text) => fakeEmbeddingVector(text, DIMENSIONS));
    },
    async dispose() {
      // Nothing to release: this encoder owns no worker.
    },
  };
}

function spaceFor(
  agentId: string,
  settings: ResolvedEmbeddingSettings,
): ReturnType<typeof resolveEmbeddingSpace> {
  return resolveEmbeddingSpace(agentId, settings, { root: VECTOR_ROOT });
}

function aggregateCoverage(
  plans: readonly {
    coverage: { embeddedChars: number; recallableChars: number };
  }[],
): { embeddedChars: number; recallableChars: number; ratio: number } {
  const embeddedChars = plans.reduce(
    (total, plan) => total + plan.coverage.embeddedChars,
    0,
  );
  const recallableChars = plans.reduce(
    (total, plan) => total + plan.coverage.recallableChars,
    0,
  );
  return {
    embeddedChars,
    recallableChars,
    ratio: recallableChars === 0 ? 0 : embeddedChars / recallableChars,
  };
}

/**
 * Writes a real B2 index for the fixture's history conversation and returns the
 * first chunk's text — the encoder targets it, so the top hit is deterministic.
 */
function writeTranscriptUnit(input: {
  storageDir: string;
  agentId: string;
  spaceId: string;
  conversationKey: string;
  generation: string;
}): { targetText: string; messageId: string } {
  const messages = readRecallMessageTexts(
    join(input.storageDir, "conversations", input.conversationKey),
  );
  if (messages.length === 0) {
    throw new Error("the fixture conversation has no recallable text");
  }
  const plans = messages.map((message) =>
    buildEmbeddingChunkPlan({ parentId: message.id, text: message.text }),
  );
  const chunks = plans.flatMap((plan) => plan.chunks);
  const targetText = chunks[0]?.text;
  if (targetText === undefined) {
    throw new Error("the fixture conversation produced no chunk");
  }
  writeEmbeddingIndex({
    unitDir: embeddingVectorUnitDir(
      {
        agentId: input.agentId,
        spaceId: input.spaceId,
        conversationKey: input.conversationKey,
      },
      { root: VECTOR_ROOT },
    ),
    unit: {
      agentId: input.agentId,
      spaceId: input.spaceId,
      conversationKey: input.conversationKey,
    },
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan)),
    vectors: chunks.map((chunk) => fakeEmbeddingVector(chunk.text, DIMENSIONS)),
    coverage: aggregateCoverage(plans),
    generation: input.generation,
  });
  const messageId = messages[0]?.id;
  if (messageId === undefined) {
    throw new Error("the fixture conversation has no message id");
  }
  return { targetText, messageId };
}

/** The int8 twin of {@link writeTranscriptUnit}: codes only, no f32 originals. */
function writeTranscriptUnitInt8(input: {
  storageDir: string;
  agentId: string;
  spaceId: string;
  conversationKey: string;
  generation: string;
}): { targetText: string; messageId: string } {
  const messages = readRecallMessageTexts(
    join(input.storageDir, "conversations", input.conversationKey),
  );
  if (messages.length === 0) {
    throw new Error("the fixture conversation has no recallable text");
  }
  const plans = messages.map((message) =>
    buildEmbeddingChunkPlan({ parentId: message.id, text: message.text }),
  );
  const chunks = plans.flatMap((plan) => plan.chunks);
  const targetText = chunks[0]?.text;
  if (targetText === undefined) {
    throw new Error("the fixture conversation produced no chunk");
  }
  writeEmbeddingQuantIndex({
    unitDir: embeddingVectorUnitDir(
      {
        agentId: input.agentId,
        spaceId: input.spaceId,
        conversationKey: input.conversationKey,
      },
      { root: VECTOR_ROOT },
    ),
    unit: {
      agentId: input.agentId,
      spaceId: input.spaceId,
      conversationKey: input.conversationKey,
    },
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan)),
    vectors: chunks.map((chunk) => fakeEmbeddingVector(chunk.text, DIMENSIONS)),
    coverage: aggregateCoverage(plans),
    rescore: false,
    generation: input.generation,
  });
  const messageId = messages[0]?.id;
  if (messageId === undefined) {
    throw new Error("the fixture conversation has no message id");
  }
  return { targetText, messageId };
}

/** Writes a real B2 index for one memory file, using the builder's own plan. */
function writeMemoryUnit(input: {
  storageDir: string;
  agentId: string;
  spaceId: string;
  filePath: string;
  generation: string;
}): { fileKey: string; targetText: string } {
  const memoryDir = getLocalBackendMemoryFilesystemRoot(
    input.agentId,
    input.storageDir,
  );
  const plan = buildMemoryVectorFilePlan(memoryDir, input.filePath, {
    gitRevision: "embedding-arms-test",
  });
  if (plan === undefined) {
    throw new Error(`the fixture memory file ${input.filePath} is unreadable`);
  }
  const chunks = plan.parents.flatMap((parent) => parent.plan.chunks);
  const targetText = chunks[0]?.text ?? plan.parents[0]?.text ?? "";
  writeEmbeddingIndex({
    unitDir: embeddingVectorUnitDir(
      {
        agentId: input.agentId,
        spaceId: input.spaceId,
        memoryFileKey: plan.signature.fileKey,
      },
      { root: VECTOR_ROOT },
    ),
    unit: {
      agentId: input.agentId,
      spaceId: input.spaceId,
      memoryFileKey: plan.signature.fileKey,
    },
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plan.parents.flatMap((parent) => parent.records),
    vectors: chunks.map((chunk) => fakeEmbeddingVector(chunk.text, DIMENSIONS)),
    coverage: aggregateCoverage(plan.parents.map((parent) => parent.plan)),
    generation: input.generation,
  });
  return { fileKey: plan.signature.fileKey, targetText };
}

function armsFor(
  fixture: RecallFixture,
  settings: ResolvedEmbeddingSettings,
  targetText: string,
): ReturnType<typeof createRecallEmbeddingArms> {
  return createRecallEmbeddingArms({
    agentId: fixture.agentId,
    settings,
    storageDir: fixture.storageDir,
    memoryDir: getLocalBackendMemoryFilesystemRoot(
      fixture.agentId,
      fixture.storageDir,
    ),
    root: VECTOR_ROOT,
    encoder: targetingEncoder(targetText),
    now: () => 0,
  });
}

// --- the pure decision ----------------------------------------------------

describe("the embedding-arm decision", () => {
  test("embedding off, an endpoint without a form, or a broken agent id means no arms", () => {
    expect(
      isRecallEmbeddingArmsRequested(endpointSettings({ enabled: false })),
    ).toBe(false);
    expect(
      isRecallEmbeddingArmsRequested(endpointSettings({ endpoint: null })),
    ).toBe(false);
    expect(isRecallEmbeddingArmsRequested(endpointSettings())).toBe(true);
    expect(
      isRecallEmbeddingArmsRequested(
        endpointSettings({ backend: "builtin", enabled: true }),
      ),
    ).toBe(true);

    // No filesystem access may be needed to answer "off".
    expect(
      createRecallEmbeddingArms({
        agentId: "agent-off",
        settings: endpointSettings({ enabled: false }),
        storageDir: join(VECTOR_ROOT, "missing-storage"),
        memoryDir: join(VECTOR_ROOT, "missing-memory"),
        root: VECTOR_ROOT,
      }),
    ).toBeNull();
    // An unsafe agent id cannot be pinned to a space; a construction failure is
    // a `null`, never a throw.
    expect(
      createRecallEmbeddingArms({
        agentId: "../escape",
        settings: endpointSettings(),
        storageDir: join(VECTOR_ROOT, "missing-storage"),
        memoryDir: join(VECTOR_ROOT, "missing-memory"),
        root: VECTOR_ROOT,
      }),
    ).toBeNull();
  });

  test("the fusion tunables are the settings' weight/depth with E1's k and ratio", () => {
    const settings = endpointSettings({ weight: 0.7, candidateDepth: 12 });
    expect(recallFusionOptionsFor(settings)).toEqual({
      vectorWeight: 0.7,
      k: RECALL_FUSION_DEFAULTS.k,
      minScoreRatio: RECALL_FUSION_DEFAULTS.minScoreRatio,
      candidateDepth: 12,
    });
  });
});

// --- unit listing ---------------------------------------------------------

describe("space unit listing", () => {
  test("a missing space lists nothing", () => {
    expect(
      listRecallEmbeddingUnits({
        agentId: "agent-missing",
        spaceDir: join(VECTOR_ROOT, "absent", "space"),
        storageDir: join(VECTOR_ROOT, "absent-storage"),
        memoryDir: join(VECTOR_ROOT, "absent-memory"),
      }),
    ).toEqual([]);
  });

  test("conversation and memory units come from live files, sorted deterministically", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "listing-transcript-1",
      });
      const memory = writeMemoryUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        filePath: "reference/notes.md",
        generation: "listing-memory-1",
      });
      expect(memory.fileKey).toBe(memoryFileKey("reference/notes.md"));

      const units = listRecallEmbeddingUnits({
        agentId: fixture.agentId,
        spaceDir: space.spaceDir,
        storageDir: fixture.storageDir,
        memoryDir: getLocalBackendMemoryFilesystemRoot(
          fixture.agentId,
          fixture.storageDir,
        ),
      });
      const historyRecord = JSON.parse(
        readFileSync(
          join(
            fixture.storageDir,
            "conversations",
            fixture.historyDirectory,
            "conversation.json",
          ),
          "utf8",
        ),
      ) as { id: string };
      expect(units).toEqual([
        {
          kind: "transcript",
          conversationKey: fixture.historyDirectory,
          conversationId: historyRecord.id,
        },
        {
          kind: "memory",
          file: "reference/notes.md",
          memoryFileKey: memory.fileKey,
        },
      ]);
      // The listing is a pure view: a repeat lists the same units in the same
      // order.
      expect(
        listRecallEmbeddingUnits({
          agentId: fixture.agentId,
          spaceDir: space.spaceDir,
          storageDir: fixture.storageDir,
          memoryDir: getLocalBackendMemoryFilesystemRoot(
            fixture.agentId,
            fixture.storageDir,
          ),
        }),
      ).toEqual(units);
    });
  });

  test("a conversation that no longer exists is not listed, even with a valid index", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "stale-transcript-1",
      });
      // Rename the conversation directory away: the space keeps a valid pointer,
      // but the store no longer has the transcript the arm would inject from.
      rmSync(
        join(fixture.storageDir, "conversations", fixture.historyDirectory),
        {
          recursive: true,
          force: true,
        },
      );
      expect(
        listRecallEmbeddingUnits({
          agentId: fixture.agentId,
          spaceDir: space.spaceDir,
          storageDir: fixture.storageDir,
          memoryDir: getLocalBackendMemoryFilesystemRoot(
            fixture.agentId,
            fixture.storageDir,
          ),
        }),
      ).toEqual([]);
      expect(armsFor(fixture, settings, "unused")).toBeNull();
    });
  });

  test("a conversation hidden after its build is not listed", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "hidden-transcript-1",
      });
      // The lexical corpus (`loadRecallCorpus`) and the builder both drop hidden
      // conversations; a unit left from before the flag was set must not make the
      // vector arm answer from a transcript the lexical arm refuses.
      const recordPath = join(
        fixture.storageDir,
        "conversations",
        fixture.historyDirectory,
        "conversation.json",
      );
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(recordPath, JSON.stringify({ ...record, hidden: true }));
      expect(
        listRecallEmbeddingUnits({
          agentId: fixture.agentId,
          spaceDir: space.spaceDir,
          storageDir: fixture.storageDir,
          memoryDir: getLocalBackendMemoryFilesystemRoot(
            fixture.agentId,
            fixture.storageDir,
          ),
        }),
      ).toEqual([]);
      expect(armsFor(fixture, settings, "unused")).toBeNull();
    });
  });

  test("a weak or unreadable pointer counts as no unit", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "corrupt-transcript-1",
      });
      const unitDir = embeddingVectorUnitDir(
        {
          agentId: fixture.agentId,
          spaceId: space.spaceId,
          conversationKey: fixture.historyDirectory,
        },
        { root: VECTOR_ROOT },
      );
      writeFileSync(join(unitDir, "current.json"), "{not json");
      expect(
        listRecallEmbeddingUnits({
          agentId: fixture.agentId,
          spaceDir: space.spaceDir,
          storageDir: fixture.storageDir,
          memoryDir: getLocalBackendMemoryFilesystemRoot(
            fixture.agentId,
            fixture.storageDir,
          ),
        }),
      ).toEqual([]);
      expect(armsFor(fixture, settings, "unused")).toBeNull();
    });
  });
});

// --- the factory ----------------------------------------------------------

describe("createRecallEmbeddingArms", () => {
  test("an empty space yields no arms even with embedding enabled", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      mkdirSync(space.spaceDir, { recursive: true });
      expect(armsFor(fixture, settings, "unused")).toBeNull();
    });
  });

  test("a real index and a fake encoder produce a working, mapped arm", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings({ weight: 0.7, candidateDepth: 12 });
      const space = spaceFor(fixture.agentId, settings);
      const { targetText, messageId } = writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "factory-transcript-1",
      });
      const arms = armsFor(fixture, settings, targetText);
      expect(arms).not.toBeNull();
      if (arms === null) return;
      expect(arms.fusion).toEqual({
        vectorWeight: 0.7,
        k: 60,
        minScoreRatio: 0.35,
        candidateDepth: 12,
      });

      const outcome = await arms.vectorSource.search({
        terms: {
          rawText: "财务系统是怎么记账的",
          terms: ["财务系统", "记账"],
          phrases: [],
        },
        scope: {
          agentId: fixture.agentId,
          currentConversationId: fixture.currentConversationId,
        },
      });
      expect(outcome.diagnostic.source).toBe("vector");
      expect(outcome.diagnostic.status).toBe("searched");
      expect(outcome.candidates.length).toBeGreaterThan(0);
      const hit = outcome.candidates.find(
        (candidate) =>
          candidate.fingerprint ===
          `transcript:${fixture.historyDirectory}:${messageId}`,
      );
      expect(hit).toBeDefined();
      expect(hit?.arm).toBe("vector");
      expect(hit?.source).toBe("transcript");
    });
  });

  test("an int8 space searches through the shared A6 port", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings({ quantization: "int8" });
      const space = spaceFor(fixture.agentId, settings);
      const { targetText, messageId } = writeTranscriptUnitInt8({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "int8-transcript-1",
      });
      const arms = armsFor(fixture, settings, targetText);
      expect(arms).not.toBeNull();
      if (arms === null) return;
      const outcome = await arms.vectorSource.search({
        terms: {
          rawText: "财务系统是怎么记账的",
          terms: ["财务系统", "记账"],
          phrases: [],
        },
        scope: {
          agentId: fixture.agentId,
          currentConversationId: fixture.currentConversationId,
        },
      });
      expect(outcome.diagnostic.status).toBe("searched");
      const hit = outcome.candidates.find(
        (candidate) =>
          candidate.fingerprint ===
          `transcript:${fixture.historyDirectory}:${messageId}`,
      );
      expect(hit).toBeDefined();
      expect(hit?.arm).toBe("vector");
    });
  });

  test("a weight of zero still returns the arms; the service is what goes lexical-only", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings({ weight: 0 });
      const space = spaceFor(fixture.agentId, settings);
      const { targetText } = writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "weight-zero-transcript-1",
      });
      const arms = armsFor(fixture, settings, targetText);
      expect(arms?.fusion.vectorWeight).toBe(0);
    });
  });

  test("the cosine safety floor still applies through the ANN-aware port", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      const { targetText } = writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "floor-transcript-1",
      });
      void targetText;
      const unrelated = "zzzz completely unrelated words";
      const encoder: EmbeddingQueryEncoder = {
        id: "fake:floor",
        async encodeQuery() {
          return fakeEmbeddingVector(unrelated, DIMENSIONS);
        },
        async encodeBatch(texts: readonly string[]) {
          return texts.map(() => fakeEmbeddingVector(unrelated, DIMENSIONS));
        },
        async dispose() {
          // Nothing to release.
        },
      };
      const arms = createRecallEmbeddingArms({
        agentId: fixture.agentId,
        settings,
        storageDir: fixture.storageDir,
        memoryDir: getLocalBackendMemoryFilesystemRoot(
          fixture.agentId,
          fixture.storageDir,
        ),
        root: VECTOR_ROOT,
        encoder,
        now: () => 0,
      });
      expect(arms).not.toBeNull();
      if (arms === null) return;
      const outcome = await arms.vectorSource.search({
        terms: { rawText: unrelated, terms: ["zzzz"], phrases: [] },
        scope: {
          agentId: fixture.agentId,
          currentConversationId: fixture.currentConversationId,
        },
      });
      // The arm ran; the 0.35 floor removed the unrelated parent before
      // fusion could see it.
      expect(outcome.diagnostic.status).not.toBe("failed");
      expect(outcome.candidates).toHaveLength(0);
    });
  });

  test("one encoder per agent configuration; a switch stops the previous one", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      const { targetText } = writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "shared-encoder-1",
      });
      void targetText;
      const built: string[] = [];
      const disposed: string[] = [];
      const factory = (
        next: ResolvedEmbeddingSettings,
      ): EmbeddingQueryEncoder => {
        const id = `fake:encoder-${built.length}`;
        built.push(id);
        void next;
        return {
          id,
          async encodeQuery() {
            return null;
          },
          async encodeBatch(texts: readonly string[]) {
            return texts.map(() => null);
          },
          async dispose() {
            disposed.push(id);
          },
        };
      };
      const input = {
        agentId: fixture.agentId,
        settings,
        storageDir: fixture.storageDir,
        memoryDir: getLocalBackendMemoryFilesystemRoot(
          fixture.agentId,
          fixture.storageDir,
        ),
        root: VECTOR_ROOT,
        encoderFactory: factory,
        now: () => 0,
      };
      try {
        // Two turns with the same settings share one handle: no per-turn ref
        // growth and no second worker.
        expect(createRecallEmbeddingArms(input)).not.toBeNull();
        expect(createRecallEmbeddingArms(input)).not.toBeNull();
        expect(built).toHaveLength(1);
        expect(disposed).toHaveLength(0);

        // A configuration change (another endpoint URL) replaces it and stops
        // the old one. Since 48-4 D-11 the endpoint is part of the space
        // identity, so the new configuration needs its own index.
        const nextSettings: ResolvedEmbeddingSettings = {
          ...settings,
          endpoint: {
            kind: "openai",
            baseUrl: "http://127.0.0.1:2/v1",
            model: MODEL_ID,
            dimensions: DIMENSIONS,
            timeoutMs: 1_000,
          },
        };
        writeTranscriptUnit({
          storageDir: fixture.storageDir,
          agentId: fixture.agentId,
          spaceId: spaceFor(fixture.agentId, nextSettings).spaceId,
          conversationKey: fixture.historyDirectory,
          generation: "shared-encoder-2",
        });
        expect(
          createRecallEmbeddingArms({
            ...input,
            settings: nextSettings,
          }),
        ).not.toBeNull();
        expect(built).toHaveLength(2);
        expect(disposed).toEqual(["fake:encoder-0"]);
      } finally {
        await resetRecallEmbeddingArmsEncoderCacheForTests();
      }
      expect(disposed).toHaveLength(2);
    });
  });
});

// --- the backend-facing helper -------------------------------------------

describe("maybeCreateRecallEmbeddingArms", () => {
  test("resolves the roots from the backend; a non-local backend and disabled settings are null", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "maybe-transcript-1",
      });
      const localBackend: RecallEmbeddingArmsBackend = {
        getLocalStorageDir: () => fixture.storageDir,
      };
      const arms = maybeCreateRecallEmbeddingArms({
        backend: localBackend,
        agentId: fixture.agentId,
        settings,
        encoder: targetingEncoder("unused"),
        root: VECTOR_ROOT,
        now: () => 0,
      });
      expect(arms).not.toBeNull();
      expect(arms?.fusion.candidateDepth).toBe(settings.candidateDepth);

      // The API backend has no local store, so there is nothing to search.
      expect(
        maybeCreateRecallEmbeddingArms({
          backend: {},
          agentId: fixture.agentId,
          settings,
          root: VECTOR_ROOT,
        }),
      ).toBeNull();
      // An empty storage dir is not a local backend answer this module trusts.
      expect(
        maybeCreateRecallEmbeddingArms({
          backend: { getLocalStorageDir: () => "" },
          agentId: fixture.agentId,
          settings,
          root: VECTOR_ROOT,
        }),
      ).toBeNull();
      // Off by settings is off before touching the store.
      expect(
        maybeCreateRecallEmbeddingArms({
          backend: localBackend,
          agentId: fixture.agentId,
          settings: { ...settings, enabled: false },
          root: VECTOR_ROOT,
        }),
      ).toBeNull();
    });
  });
});

// --- the live service path ------------------------------------------------

function probe(
  fixture: RecallFixture,
  arms: NonNullable<ReturnType<typeof createRecallEmbeddingArms>>,
): Promise<Awaited<ReturnType<typeof runRecall>>> {
  return runRecall({
    backend: fixture.backend,
    agentId: fixture.agentId,
    conversationId: fixture.currentConversationId,
    userText: RECALL_FIXTURE_QUERY,
    currentTurn: 1,
    dryRun: true,
    options: { limit: 3 },
    vectorSource: arms.vectorSource,
    fusion: arms.fusion,
  });
}

type FusedEntry = RecallEntry & {
  arms?: readonly string[];
  armScores?: Partial<Record<string, number>>;
};

describe("runRecall with production arms", () => {
  test("the vector arm is fused into the real lexical result", async () => {
    await withRecallFixture(async (fixture) => {
      const settings = endpointSettings();
      const space = spaceFor(fixture.agentId, settings);
      const { targetText, messageId } = writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "service-transcript-1",
      });
      const arms = armsFor(fixture, settings, targetText);
      expect(arms).not.toBeNull();
      if (arms === null) return;

      // Prove the arm itself found the unit, so a fusion failure below cannot be
      // mistaken for a listing/encoder problem.
      const outcome = await arms.vectorSource.search({
        terms: {
          rawText: RECALL_FIXTURE_QUERY,
          terms: ["财务系统", "记账"],
          phrases: [],
        },
        scope: {
          agentId: fixture.agentId,
          currentConversationId: fixture.currentConversationId,
        },
      });
      const targetFingerprint = `transcript:${fixture.historyDirectory}:${messageId}`;
      expect(
        outcome.candidates.some(
          (candidate) => candidate.fingerprint === targetFingerprint,
        ),
      ).toBe(true);

      const decision = await probe(fixture, arms);
      expect(decision.status).toBe("injected");
      const vectorDiagnostic = decision.diagnostics.sources.find(
        (diagnostic) => diagnostic.source === "vector",
      );
      expect(vectorDiagnostic?.status).toBe("searched");
      expect(vectorDiagnostic?.candidates ?? 0).toBeGreaterThan(0);

      const merged = decision.entries.find(
        (entry) => entry.fingerprint === targetFingerprint,
      ) as FusedEntry | undefined;
      expect(merged).toBeDefined();
      // The same unit was found by both arms and merged once, with both scores
      // kept for diagnostics — that is the fusion path, not the lexical one.
      expect(merged?.arms).toEqual(["lexical", "vector"]);
      expect(merged?.armScores?.lexical).toBeGreaterThan(0);
      expect(merged?.armScores?.vector).toBeGreaterThan(0);
    });
  });

  test("vectorWeight 0 on the live path is lexical-only (the service drops the arm)", async () => {
    await withRecallFixture(async (fixture) => {
      const baseline = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: RECALL_FIXTURE_QUERY,
        currentTurn: 1,
        dryRun: true,
        options: { limit: 3 },
      });
      expect(baseline.entries.length).toBeGreaterThan(0);

      const settings = endpointSettings({ weight: 0 });
      const space = spaceFor(fixture.agentId, settings);
      const { targetText } = writeTranscriptUnit({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
        spaceId: space.spaceId,
        conversationKey: fixture.historyDirectory,
        generation: "service-weight-zero-1",
      });
      const arms = armsFor(fixture, settings, targetText);
      expect(arms).not.toBeNull();
      if (arms === null) return;
      const decision = await probe(fixture, arms);
      // Same injected passages as the lexical-only reference: the arm searched
      // (it has a diagnostic) but contributed nothing to the selection.
      expect(decision.entries).toEqual(baseline.entries);
      expect(
        decision.diagnostics.sources.some(
          (diagnostic) => diagnostic.source === "vector",
        ),
      ).toBe(true);
    });
  });
});
