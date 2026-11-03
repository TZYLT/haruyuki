/**
 * E2 — the vector recall arm (feature 48).
 *
 * The arm is exercised through the real B2 index format, the real B4 injection
 * mapping and the real E1 fusion, with a fake deterministic encoder: no model,
 * no network and no harness data. Every directory is a fresh OS temp root, and
 * `HARUYUKI_HOME` / `LETTA_LOCAL_BACKEND_DIR` are redirected for the duration of
 * the file and restored afterwards (docs/31 §1.2 A2).
 *
 * What the tests pin down, in the order they appear below:
 * - fusion gets the arm split back (`partitionRecallCandidates`);
 * - one source answers for both corpora and keeps the lexical identity;
 * - B2 parent aggregation and the arm's 50-candidate depth;
 * - an unavailable encoder, a broken space and an empty space are diagnostics,
 *   not throws;
 * - the arm's own budget yields partial results with `degraded` and never a
 *   `timedOut` turn, which is what keeps the breaker out of it;
 * - a drawn parent text is dropped rather than injected at stale offsets;
 * - the injection window stays inside the 400-character cap;
 * - the vector candidates fuse with lexical ones, and `runRecall` wires the
 *   source in without learning about encoders.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunkPlan,
} from "@/backend/local/embedding-chunk";
import {
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  hashEmbeddingText,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import { buildMemoryVectorFilePlan } from "@/backend/local/embedding-memory";
import type { EmbeddingSearchHit } from "@/backend/local/embedding-search";
import {
  type RecallMessageText,
  rebuildConversationIndex,
} from "@/backend/local/recall-index";
import { fuseRecallCandidates } from "@/reminders/recall-fusion";
import type {
  RecallBackendPort,
  RecallCandidate,
  RecallSourcePort,
  RecallSourceRequest,
} from "@/reminders/recall-port";
import { recallQueryTerms } from "@/reminders/recall-query";
import {
  readRecallRuntimeStatus,
  recordRecallDecision,
  resetRecallRuntime,
} from "@/reminders/recall-runtime";
import { runRecall } from "@/reminders/recall-service";
import type { RecallVectorCandidate } from "@/reminders/recall-sources";
import {
  createEmbeddingIndexSearch,
  createLocalVectorParentPort,
  createVectorRecallSource,
  partitionRecallCandidates,
  type RecallEncoderPort,
  type RecallVectorUnit,
} from "@/reminders/recall-vector-source";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";

const DIMENSIONS = 8;
const AGENT_ID = "agent-e2";
const SPACE_ID = "space-e2";
const MODEL_ID = "fake-e2";
const CONVERSATION_KEY = "history";
const CURRENT_CONVERSATION_ID = "current-conversation";
const MEMORY_FILE = "reference/notes.md";

const MESSAGES: readonly RecallMessageText[] = [
  {
    id: "m1",
    role: "user",
    ts: "2026-01-01T00:00:01.000Z",
    text: "财务系统的记账方式是每日对账。对账结果写入当日的台账。月底再汇总一次。",
  },
  {
    id: "m2",
    role: "assistant",
    ts: "2026-01-01T00:00:02.000Z",
    text: "The deploy ran at 09:30. 回滚脚本仍然可用。Next step is the canary check. 之后再看监控。",
  },
  {
    id: "m3",
    role: "user",
    ts: "2026-01-01T00:00:03.000Z",
    text: Array.from(
      { length: 12 },
      (_unused, index) =>
        `第${index}段对账记录写入当日台账，月底汇总一次并复核差异。`,
    ).join(""),
  },
];

const MEMORY_CONTENT = [
  "# 记账规则",
  "",
  "财务系统每日对账，对账结果写入当日的台账；月底汇总一次，并复核差异。失败时保留现场并上报，不要自行删除任何东西。",
  "",
  "## 部署",
  "",
  "部署脚本在每日九点半运行，回滚脚本仍然可用；先看金丝雀检查，再观察监控。若变更失败，保留现场并上报。",
].join("\n");

// --- isolated environment -------------------------------------------------

let homeDir: string;
let backendDir: string;
let previousHome: string | undefined;
let previousBackend: string | undefined;

const createdRoots: string[] = [];
let generationCounter = 0;

function nextGeneration(): string {
  generationCounter += 1;
  return `generation-${generationCounter}`;
}

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), "haru-vector-home-"));
  backendDir = mkdtempSync(join(tmpdir(), "haru-vector-backend-"));
  previousHome = process.env.HARUYUKI_HOME;
  previousBackend = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = backendDir;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousBackend === undefined) delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = previousBackend;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(backendDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  resetRecallRuntime();
});

// --- fixture --------------------------------------------------------------

type Fixture = {
  root: string;
  vectorsRoot: string;
  storageDir: string;
  memoryDir: string;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "haru-vector-e2-"));
  createdRoots.push(root);
  const vectorsRoot = join(root, "recall-vectors");
  const storageDir = join(root, "storage");
  const memoryDir = join(root, "memory");
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  return { root, vectorsRoot, storageDir, memoryDir };
}

function writeConversation(
  fixture: Fixture,
  conversationKey: string,
  messages: readonly RecallMessageText[],
): void {
  const conversationDir = join(
    fixture.storageDir,
    "conversations",
    conversationKey,
  );
  mkdirSync(conversationDir, { recursive: true });
  writeFileSync(
    join(conversationDir, "conversation.json"),
    JSON.stringify({
      id: `conversation-${conversationKey}`,
      agent_id: AGENT_ID,
      created_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(conversationDir, "messages.jsonl"),
    `${messages
      .map((message) =>
        JSON.stringify({
          id: message.id,
          role: message.role,
          content: message.text,
          metadata: { created_at: message.ts },
        }),
      )
      .join("\n")}\n`,
  );
  // The lexical arm only searches a conversation that already has its recall
  // sidecar; writing it here is what real ingestion does.
  const rebuilt = rebuildConversationIndex({
    conversationDir,
    identity: {
      conversationKey,
      conversationId: `conversation-${conversationKey}`,
      agentId: AGENT_ID,
    },
  });
  if ("error" in rebuilt) {
    throw new Error(
      `could not build the recall fixture index: ${rebuilt.error}`,
    );
  }
}

function writeMemory(fixture: Fixture, path: string, content: string): void {
  const target = join(fixture.memoryDir, ...path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function coverageOf(plans: readonly EmbeddingChunkPlan[]): {
  embeddedChars: number;
  recallableChars: number;
  ratio: number;
} {
  let embeddedChars = 0;
  let recallableChars = 0;
  for (const plan of plans) {
    embeddedChars += plan.coverage.embeddedChars;
    recallableChars += plan.coverage.recallableChars;
  }
  return {
    embeddedChars,
    recallableChars,
    ratio: recallableChars === 0 ? 0 : embeddedChars / recallableChars,
  };
}

function indexTranscript(
  fixture: Fixture,
  conversationKey: string,
  messages: readonly RecallMessageText[],
): EmbeddingChunkPlan[] {
  const unitDir = embeddingVectorUnitDir(
    { agentId: AGENT_ID, spaceId: SPACE_ID, conversationKey },
    { root: fixture.vectorsRoot },
  );
  const plans = messages.map((message) =>
    buildEmbeddingChunkPlan({ parentId: message.id, text: message.text }),
  );
  writeEmbeddingIndex({
    unitDir,
    unit: { agentId: AGENT_ID, spaceId: SPACE_ID, conversationKey },
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan)),
    vectors: plans.flatMap((plan) =>
      plan.chunks.map((chunk) => fakeEmbeddingVector(chunk.text, DIMENSIONS)),
    ),
    coverage: coverageOf(plans),
    generation: nextGeneration(),
  });
  return plans;
}

function indexMemory(fixture: Fixture, path: string): string {
  const plan = buildMemoryVectorFilePlan(fixture.memoryDir, path);
  if (plan === undefined) {
    throw new Error(`memory fixture ${path} could not be planned`);
  }
  const unitDir = embeddingVectorUnitDir(
    {
      agentId: AGENT_ID,
      spaceId: SPACE_ID,
      memoryFileKey: plan.signature.fileKey,
    },
    { root: fixture.vectorsRoot },
  );
  writeEmbeddingIndex({
    unitDir,
    unit: {
      agentId: AGENT_ID,
      spaceId: SPACE_ID,
      memoryFileKey: plan.signature.fileKey,
    },
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plan.parents.flatMap((parent) => parent.records),
    vectors: plan.parents.flatMap((parent) =>
      parent.plan.chunks.map((chunk) =>
        fakeEmbeddingVector(chunk.text, DIMENSIONS),
      ),
    ),
    coverage: coverageOf(plan.parents.map((parent) => parent.plan)),
    generation: nextGeneration(),
  });
  return plan.signature.fileKey;
}

function transcriptUnit(conversationKey: string): RecallVectorUnit {
  return { kind: "transcript", conversationKey };
}

function memoryUnit(file: string, memoryFileKey: string): RecallVectorUnit {
  return { kind: "memory", file, memoryFileKey };
}

function spaceSearch(
  fixture: Fixture,
  units: readonly RecallVectorUnit[],
): ReturnType<typeof createEmbeddingIndexSearch> {
  return createEmbeddingIndexSearch({
    space: { agentId: AGENT_ID, spaceId: SPACE_ID },
    units,
    root: fixture.vectorsRoot,
  });
}

function targetingEncoder(
  targetText: string,
  calls?: string[],
): RecallEncoderPort {
  return {
    id: "fake-targeting",
    async encodeQuery(text) {
      calls?.push(text);
      // Cosine 1.0 with the target parent's chunk: the fixture needs a known
      // top hit, not a semantically meaningful one.
      return fakeEmbeddingVector(targetText, DIMENSIONS);
    },
  };
}

function localParents(fixture: Fixture) {
  return createLocalVectorParentPort({
    storageDir: fixture.storageDir,
    memoryDir: fixture.memoryDir,
  });
}

type SourceOverrides = {
  encoder?: RecallEncoderPort;
  topK?: number;
  budgetMs?: number;
  now?: () => number;
};

function makeSource(
  fixture: Fixture,
  units: readonly RecallVectorUnit[],
  overrides: SourceOverrides = {},
): RecallSourcePort {
  return createVectorRecallSource({
    encoder: overrides.encoder ?? targetingEncoder(MESSAGES[0]?.text ?? ""),
    search: spaceSearch(fixture, units),
    parentReader: localParents(fixture),
    topK: overrides.topK,
    budgetMs: overrides.budgetMs,
    now: overrides.now,
  });
}

function searchRequest(rawText = "财务系统是怎么记账的"): RecallSourceRequest {
  return {
    terms: recallQueryTerms(rawText),
    scope: {
      agentId: AGENT_ID,
      currentConversationId: CURRENT_CONVERSATION_ID,
    },
  };
}

function fakeBackend(storageDir: string): RecallBackendPort {
  return {
    getLocalStorageDir: () => storageDir,
    getInContextMessageIds: async () => [],
    settleRecallDedup: () => ({ suppressed: new Set<string>(), window: {} }),
  };
}

function candidate(
  fingerprint: string,
  source: "transcript" | "memory",
  score = 0.5,
): RecallCandidate {
  return {
    source,
    fingerprint,
    file: fingerprint,
    text: `text for ${fingerprint}`,
    score,
  };
}

/** A valid B2 hit for the first chunk of one parent, built without a real index. */
function storedHitFor(parentId: string, text: string): EmbeddingSearchHit {
  const plan = buildEmbeddingChunkPlan({ parentId, text });
  const chunk = plan.chunks[0];
  if (chunk === undefined) throw new Error("fixture parent produced no chunk");
  return {
    parentId,
    chunkIndex: chunk.chunkIndex,
    score: 0.9,
    startChar: chunk.startChar,
    endChar: chunk.endChar,
    focusChar: chunk.focusChar,
    textHash: hashEmbeddingText(chunk.text),
  };
}

// --- tests ----------------------------------------------------------------

describe("partitionRecallCandidates", () => {
  test("splits by arm and treats a missing arm as lexical", () => {
    const lexical = candidate("transcript:history:m1", "transcript");
    const vector = {
      ...candidate("transcript:history:m2", "transcript"),
      arm: "vector" as const,
    };
    const explicit = {
      ...candidate("memory:notes.md", "memory"),
      arm: "lexical" as const,
    };

    const partitioned = partitionRecallCandidates([lexical, vector, explicit]);

    expect(partitioned.lexical).toEqual([lexical, explicit]);
    expect(partitioned.vector).toEqual([vector]);
  });
});

describe("createVectorRecallSource", () => {
  test("answers for both corpora and keeps the lexical identity", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    writeMemory(fixture, MEMORY_FILE, MEMORY_CONTENT);
    const memoryFileKey = indexMemory(fixture, MEMORY_FILE);
    const calls: string[] = [];
    const source = makeSource(
      fixture,
      [
        transcriptUnit(CONVERSATION_KEY),
        memoryUnit(MEMORY_FILE, memoryFileKey),
      ],
      { encoder: targetingEncoder(MESSAGES[0]?.text ?? "", calls), topK: 20 },
    );

    const result = await source.search(searchRequest());

    expect(source.id).toBe("vector");
    expect(source.arm).toBe("vector");
    expect(calls).toEqual(["财务系统是怎么记账的"]);
    expect(result.diagnostic).toMatchObject({
      source: "vector",
      status: "searched",
    });
    expect(result.diagnostic.candidates).toBe(result.candidates.length);

    const transcripts = result.candidates.filter(
      (entry) => entry.source === "transcript",
    );
    const memories = result.candidates.filter(
      (entry) => entry.source === "memory",
    );
    expect(transcripts.length).toBeGreaterThan(0);
    expect(memories.length).toBeGreaterThan(0);

    for (const entry of result.candidates) {
      const vector = entry as RecallVectorCandidate;
      expect(entry.arm).toBe("vector");
      expect(vector.focusChar).toBeGreaterThanOrEqual(0);
      expect(vector.chunkIndex).toBeGreaterThanOrEqual(0);
      expect(entry.text.length).toBeLessThanOrEqual(400);
    }

    const hit = result.candidates.find(
      (entry) => entry.fingerprint === `transcript:${CONVERSATION_KEY}:m1`,
    );
    expect(hit?.messageId).toBe("m1");
    expect(hit?.conversationKey).toBe(CONVERSATION_KEY);

    const memory = result.candidates.find((entry) => entry.source === "memory");
    expect(memory?.fingerprint).toBe(`memory:${MEMORY_FILE}`);
    expect(memory?.file).toBe(MEMORY_FILE);
    expect(memory?.text).toContain(MEMORY_FILE);
  });

  test("aggregates a multi-chunk parent into one candidate and respects top-k", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    const plans = indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    const longPlan = plans.find((plan) => plan.parentId === "m3");
    expect(longPlan?.chunks.length ?? 0).toBeGreaterThan(1);

    const full = await makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)], {
      topK: 50,
    }).search(searchRequest());
    expect(full.candidates).toHaveLength(MESSAGES.length);
    expect(
      full.candidates.filter(
        (entry) => entry.fingerprint === `transcript:${CONVERSATION_KEY}:m3`,
      ),
    ).toHaveLength(1);

    const limited = await makeSource(
      fixture,
      [transcriptUnit(CONVERSATION_KEY)],
      { topK: 2 },
    ).search(searchRequest());
    expect(limited.candidates.length).toBeLessThanOrEqual(2);
    const scores = limited.candidates.map((entry) => entry.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  test("reports an encoder that returns null as unavailable", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    const source = makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)], {
      encoder: { encodeQuery: async () => null },
    });

    const result = await source.search(searchRequest());

    expect(result.candidates).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      source: "vector",
      status: "unavailable",
    });
    expect(result.diagnostic.reason).toContain("no query vector");
  });

  test("reports an encoder that throws as failed with its message", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    const source = makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)], {
      encoder: {
        encodeQuery: async () => {
          throw new Error("worker is not running");
        },
      },
    });

    const result = await source.search(searchRequest());

    expect(result.candidates).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      source: "vector",
      status: "failed",
      reason: "worker is not running",
    });
  });

  test("degrades when its own budget is spent during encoding", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    let clock = 1_000;
    const source = makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)], {
      budgetMs: 300,
      now: () => clock,
      encoder: {
        async encodeQuery() {
          // The encode overruns the arm's budget while it runs.
          clock += 5_000;
          return fakeEmbeddingVector(MESSAGES[0]?.text ?? "", DIMENSIONS);
        },
      },
    });

    const result = await source.search(searchRequest());

    expect(result.candidates).toEqual([]);
    expect(result.diagnostic.status).toBe("degraded");
    expect(result.diagnostic.reason).toContain("budget expired");
  });

  test("keeps the hits it already has when the scan is cut short", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    const hit = storedHitFor("m1", MESSAGES[0]?.text ?? "");
    const source = createVectorRecallSource({
      encoder: targetingEncoder(MESSAGES[0]?.text ?? ""),
      parentReader: localParents(fixture),
      search: () => ({
        status: "searched" as const,
        hits: [
          {
            kind: "transcript" as const,
            conversationKey: CONVERSATION_KEY,
            hit,
          },
        ],
        chunks: 1,
        truncated: true,
        reason: "the vector search budget expired",
      }),
      topK: 10,
    });

    const result = await source.search(searchRequest());

    expect(result.diagnostic.status).toBe("degraded");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.fingerprint).toBe(
      `transcript:${CONVERSATION_KEY}:m1`,
    );
    expect(result.diagnostic.reason).toContain(
      "ran out of its own query budget",
    );
  });

  test("reports a space with no readable index as unavailable", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    // Deliberately no index: the conversation exists, its vectors do not.
    const source = makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)]);

    const result = await source.search(searchRequest());

    expect(result.candidates).toEqual([]);
    expect(result.diagnostic.status).toBe("unavailable");
    expect(result.diagnostic.reason).toContain("no usable vector index");
  });

  test("rejects a query whose width does not match the stored space", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    const source = makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)], {
      encoder: { encodeQuery: async () => new Float32Array(4).fill(0.5) },
    });

    const result = await source.search(searchRequest());

    expect(result.candidates).toEqual([]);
    expect(result.diagnostic.status).toBe("unavailable");
    expect(result.diagnostic.reason).toContain("dimension-mismatch");
  });

  test("reports an empty space as empty, not unavailable", async () => {
    const fixture = createFixture();
    const result = await makeSource(fixture, []).search(searchRequest());

    expect(result.candidates).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      source: "vector",
      status: "empty",
    });
    expect(result.diagnostic.reason).toContain("no units");
  });

  test("drops a hit whose parent text drifted instead of injecting it", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    // A single-paragraph memory file, so the drift cannot be masked by another
    // paragraph of the same file still matching.
    const driftMemoryFile = "reference/drift.md";
    writeMemory(
      fixture,
      driftMemoryFile,
      "财务系统每日对账，对账结果写入当日的台账。",
    );
    const memoryFileKey = indexMemory(fixture, driftMemoryFile);
    const drifted = MESSAGES.map((message) =>
      message.id === "m1"
        ? {
            ...message,
            text: "这一条已经改成别的说法，和索引里的文本完全对不上。",
          }
        : message,
    );
    writeConversation(fixture, CONVERSATION_KEY, drifted);
    writeMemory(
      fixture,
      driftMemoryFile,
      "财务系统改成每周对账，对账结果改在周五写入台账。",
    );
    const source = makeSource(
      fixture,
      [
        transcriptUnit(CONVERSATION_KEY),
        memoryUnit(driftMemoryFile, memoryFileKey),
      ],
      { topK: 20 },
    );

    const result = await source.search(searchRequest());

    expect(
      result.candidates.some(
        (entry) => entry.fingerprint === `transcript:${CONVERSATION_KEY}:m1`,
      ),
    ).toBe(false);
    expect(result.candidates.some((entry) => entry.source === "memory")).toBe(
      false,
    );
    expect(
      result.candidates.some(
        (entry) => entry.fingerprint === `transcript:${CONVERSATION_KEY}:m3`,
      ),
    ).toBe(true);
    expect(result.diagnostic.reason).toContain("drifted");
  });

  test("keeps the injection window inside 400 characters and adds the neighbour", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    const result = await makeSource(
      fixture,
      [transcriptUnit(CONVERSATION_KEY)],
      { topK: 20 },
    ).search(searchRequest());

    const assistant = result.candidates.find(
      (entry) => entry.messageId === "m2",
    );
    expect(assistant).toBeDefined();
    expect(assistant?.text).toContain("助手：");
    // Previous user message wins over the following assistant message.
    expect(assistant?.text).toContain("用户：");
    for (const entry of result.candidates) {
      expect(entry.text.length).toBeLessThanOrEqual(400);
    }
  });
});

describe("createEmbeddingIndexSearch", () => {
  test("merges transcript and memory units into one ranked list", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    writeMemory(fixture, MEMORY_FILE, MEMORY_CONTENT);
    const memoryFileKey = indexMemory(fixture, MEMORY_FILE);
    const search = spaceSearch(fixture, [
      transcriptUnit(CONVERSATION_KEY),
      memoryUnit(MEMORY_FILE, memoryFileKey),
    ]);

    const result = await search({
      scope: {
        agentId: AGENT_ID,
        currentConversationId: CURRENT_CONVERSATION_ID,
      },
      query: fakeEmbeddingVector(MESSAGES[0]?.text ?? "", DIMENSIONS),
      topK: 10,
      shouldStop: () => false,
    });

    expect(result.status).toBe("searched");
    // Three transcript parents plus the memory file's four paragraph parents.
    expect(result.hits).toHaveLength(7);
    expect(new Set(result.hits.map((entry) => entry.kind))).toEqual(
      new Set(["transcript", "memory"]),
    );
    const scores = result.hits.map((entry) => entry.hit.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  test("stops between units and reports the scan as truncated", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    const search = spaceSearch(fixture, [transcriptUnit(CONVERSATION_KEY)]);

    const result = await search({
      scope: {
        agentId: AGENT_ID,
        currentConversationId: CURRENT_CONVERSATION_ID,
      },
      query: fakeEmbeddingVector(MESSAGES[0]?.text ?? "", DIMENSIONS),
      topK: 10,
      shouldStop: () => true,
    });

    if (result.status !== "searched") {
      throw new Error(`expected a searched result, got ${result.status}`);
    }
    expect(result.truncated).toBe(true);
    expect(result.hits).toEqual([]);
  });
});

describe("fusion and the service wiring", () => {
  test("fuses the real vector candidates with lexical ones on the lexical keys", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    writeMemory(fixture, MEMORY_FILE, MEMORY_CONTENT);
    const memoryFileKey = indexMemory(fixture, MEMORY_FILE);
    const result = await makeSource(
      fixture,
      [
        transcriptUnit(CONVERSATION_KEY),
        memoryUnit(MEMORY_FILE, memoryFileKey),
      ],
      { topK: 20 },
    ).search(searchRequest());

    const lexical = [
      candidate(`transcript:${CONVERSATION_KEY}:m1`, "transcript", 7),
      candidate(`memory:${MEMORY_FILE}`, "memory", 3),
    ];
    // The service flattens both arms; fusion needs the split back.
    const partitioned = partitionRecallCandidates([
      ...lexical,
      ...result.candidates,
    ]);
    expect(partitioned.lexical).toEqual(lexical);
    expect(partitioned.vector).toEqual(result.candidates);

    const fused = fuseRecallCandidates(partitioned);
    const merged = fused.candidates.find(
      (entry) => entry.fingerprint === `transcript:${CONVERSATION_KEY}:m1`,
    );
    expect(merged).toBeDefined();
    expect(merged?.arms).toEqual(["lexical", "vector"]);
    expect(merged?.armScores.lexical).toBe(7);
    expect(
      fused.candidates.filter(
        (entry) => entry.fingerprint === merged?.fingerprint,
      ),
    ).toHaveLength(1);
    // Three transcript parents + one memory file, with two of them shared.
    expect(fused.candidates).toHaveLength(4);
    expect(fused.threshold).toBeGreaterThan(0);
    // RRF scores are ~1/(k+rank) per arm, so a two-arm merge is ~0.016 at k=60.
    expect(fused.candidates[0]?.score).toBeGreaterThan(0.01);
  });

  test("runRecall injects the vector arm and reports it in diagnostics", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    const source = makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)], {
      encoder: targetingEncoder(MESSAGES[0]?.text ?? ""),
    });

    const decision = await runRecall({
      backend: fakeBackend(fixture.storageDir),
      agentId: AGENT_ID,
      conversationId: CURRENT_CONVERSATION_ID,
      // No lexical term matches the corpus, so anything injected came from the arm.
      userText: "zzz qqq",
      currentTurn: 1,
      options: { limit: 3 },
      vectorSource: source,
    });

    expect(decision.status).toBe("injected");
    expect(
      decision.entries.some(
        (entry) => entry.fingerprint === `transcript:${CONVERSATION_KEY}:m1`,
      ),
    ).toBe(true);
    expect(
      decision.diagnostics.sources.some(
        (diagnostic) =>
          diagnostic.source === "vector" && diagnostic.status === "searched",
      ),
    ).toBe(true);
    expect(decision.timedOut).toBeUndefined();
  });

  test("a spent vector budget degrades without timing the turn out or tripping the breaker", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    let clock = 1_000;
    const source = makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)], {
      budgetMs: 300,
      now: () => clock,
      encoder: {
        async encodeQuery() {
          clock += 5_000;
          return fakeEmbeddingVector(MESSAGES[0]?.text ?? "", DIMENSIONS);
        },
      },
    });

    const decision = await runRecall({
      backend: fakeBackend(fixture.storageDir),
      agentId: AGENT_ID,
      conversationId: CURRENT_CONVERSATION_ID,
      userText: "zzz qqq",
      currentTurn: 1,
      options: { limit: 3 },
      vectorSource: source,
    });

    expect(decision.entries).toEqual([]);
    expect(decision.timedOut).toBeUndefined();
    expect(
      decision.diagnostics.sources.some(
        (diagnostic) =>
          diagnostic.source === "vector" && diagnostic.status === "degraded",
      ),
    ).toBe(true);
    // The breaker's input is `timedOut` and `failed`; a degraded arm is neither.
    expect(recordRecallDecision(decision)).toBeNull();
    expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);
  });

  test("memoryEnabled false keeps the injected vector source", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CONVERSATION_KEY, MESSAGES);
    indexTranscript(fixture, CONVERSATION_KEY, MESSAGES);
    const source = makeSource(fixture, [transcriptUnit(CONVERSATION_KEY)], {
      encoder: targetingEncoder(MESSAGES[0]?.text ?? ""),
    });

    const decision = await runRecall({
      backend: fakeBackend(fixture.storageDir),
      agentId: AGENT_ID,
      conversationId: CURRENT_CONVERSATION_ID,
      userText: "zzz qqq",
      currentTurn: 1,
      options: { limit: 3 },
      memoryEnabled: false,
      vectorSource: source,
    });

    expect(decision.status).toBe("injected");
    expect(
      decision.diagnostics.sources.some(
        (diagnostic) => diagnostic.source === "vector",
      ),
    ).toBe(true);
  });
});
