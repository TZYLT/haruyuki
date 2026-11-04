/**
 * Feature 48's scope rules for the vector arm: what the arm may not answer from.
 *
 * The arm reads a different corpus than the lexical sources (the B2 index rather
 * than the live conversation sidecars), so every exclusion the lexical arm gets
 * for free at corpus-build time has to be applied again here:
 *
 * - hidden conversations and other agents are filtered when the units are listed
 *   (`listRecallEmbeddingUnits`, covered in `recall-embedding-arms.test.ts`);
 * - the current conversation's in-context messages (`N`) are filtered here,
 *   keyed by the conversation *record id* because message ids are reused between
 *   conversations (48-1 §6.2 item 9).
 *
 * Everything is synthetic: a temp vector root, a temp store, temp
 * `HARUYUKI_HOME`/`LETTA_LOCAL_BACKEND_DIR` (docs/31 §1.2 A2) and a fake
 * deterministic encoder. No model, no worker, no real harness data.
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
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import type { RecallMessageText } from "@/backend/local/recall-index";
import { rebuildConversationIndex } from "@/backend/local/recall-index";
import type {
  RecallSourcePort,
  RecallSourceRequest,
} from "@/reminders/recall-port";
import { recallQueryTerms } from "@/reminders/recall-query";
import {
  createEmbeddingIndexSearch,
  createLocalVectorParentPort,
  createVectorRecallSource,
  type RecallEncoderPort,
  type RecallVectorUnit,
} from "@/reminders/recall-vector-source";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";

const DIMENSIONS = 8;
const AGENT_ID = "agent-scope";
const SPACE_ID = "space-scope";
const MODEL_ID = "fake-scope";
const HISTORY_DIRECTORY_KEY = "history";
/** Directory key of the conversation the test turn runs in. */
const CURRENT_DIRECTORY_KEY = "current";
const CURRENT_CONVERSATION_ID = "conversation-current";

/** Two messages, both short enough to be one chunk each. */
const MESSAGES: readonly RecallMessageText[] = [
  {
    id: "m1",
    role: "user",
    ts: "2026-01-01T00:00:01.000Z",
    text: "财务系统的记账方式是每日对账。对账结果写入当日的台账。",
  },
  {
    id: "m2",
    role: "assistant",
    ts: "2026-01-01T00:00:02.000Z",
    text: "对账脚本在每日九点半运行，回滚脚本仍然可用，之后再看监控。",
  },
];

// --- isolated environment -------------------------------------------------

let homeDir: string;
let backendDir: string;
let previousHome: string | undefined;
let previousBackend: string | undefined;
const createdRoots: string[] = [];
let generationCounter = 0;

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), "haru-vector-scope-home-"));
  backendDir = mkdtempSync(join(tmpdir(), "haru-vector-scope-backend-"));
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
});

// --- fixtures -------------------------------------------------------------

type Fixture = {
  vectorsRoot: string;
  storageDir: string;
  memoryDir: string;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "haru-vector-scope-"));
  createdRoots.push(root);
  const vectorsRoot = join(root, "recall-vectors");
  const storageDir = join(root, "storage");
  const memoryDir = join(root, "memory");
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  return { vectorsRoot, storageDir, memoryDir };
}

/** Writes a conversation the way ingestion does, recall sidecar included. */
function writeConversation(
  fixture: Fixture,
  conversationKey: string,
  messages: readonly RecallMessageText[] = MESSAGES,
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

/**
 * Writes a real B2 index for one conversation unit.
 *
 * `vectorFor` lets a test pin the cosine exactly (the safety-floor case) instead
 * of relying on whatever the synthetic vectors happen to be.
 */
function indexTranscript(
  fixture: Fixture,
  conversationKey: string,
  messages: readonly RecallMessageText[] = MESSAGES,
  vectorFor: (chunkText: string) => Float32Array = (chunkText) =>
    fakeEmbeddingVector(chunkText, DIMENSIONS),
): void {
  const unitDir = embeddingVectorUnitDir(
    { agentId: AGENT_ID, spaceId: SPACE_ID, conversationKey },
    { root: fixture.vectorsRoot },
  );
  const plans = messages.map((message) =>
    buildEmbeddingChunkPlan({ parentId: message.id, text: message.text }),
  );
  const chunks = plans.flatMap((plan) => plan.chunks);
  generationCounter += 1;
  writeEmbeddingIndex({
    unitDir,
    unit: { agentId: AGENT_ID, spaceId: SPACE_ID, conversationKey },
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan)),
    vectors: chunks.map((chunk) => vectorFor(chunk.text)),
    coverage: plans.reduce(
      (total, plan) => ({
        embeddedChars: total.embeddedChars + plan.coverage.embeddedChars,
        recallableChars: total.recallableChars + plan.coverage.recallableChars,
        ratio: 0,
      }),
      { embeddedChars: 0, recallableChars: 0, ratio: 0 },
    ),
    generation: `scope-generation-${generationCounter}`,
  });
}

/** A source whose encoder always answers the first message's chunk vector. */
function makeSource(
  fixture: Fixture,
  units: readonly RecallVectorUnit[],
): RecallSourcePort {
  const target = MESSAGES[0]?.text ?? "";
  const encoder: RecallEncoderPort = {
    id: "fake-scope",
    async encodeQuery() {
      return fakeEmbeddingVector(target, DIMENSIONS);
    },
  };
  return createVectorRecallSource({
    encoder,
    search: createEmbeddingIndexSearch({
      space: { agentId: AGENT_ID, spaceId: SPACE_ID },
      units,
      root: fixture.vectorsRoot,
    }),
    parentReader: createLocalVectorParentPort({
      storageDir: fixture.storageDir,
      memoryDir: fixture.memoryDir,
    }),
    topK: 50,
  });
}

function searchRequest(): RecallSourceRequest {
  return {
    terms: recallQueryTerms("财务系统是怎么记账的"),
    scope: {
      agentId: AGENT_ID,
      currentConversationId: CURRENT_CONVERSATION_ID,
    },
  };
}

// --- tests ----------------------------------------------------------------

describe("the vector arm's scope exclusions", () => {
  test("drops the current conversation's in-context hits and keeps the same id elsewhere", async () => {
    const fixture = createFixture();
    // Two conversations with the *same* message ids: the exclusion must be
    // decided by the conversation's record id, not by the message id alone.
    writeConversation(fixture, HISTORY_DIRECTORY_KEY);
    writeConversation(fixture, CURRENT_DIRECTORY_KEY);
    indexTranscript(fixture, HISTORY_DIRECTORY_KEY);
    indexTranscript(fixture, CURRENT_DIRECTORY_KEY);
    const source = makeSource(fixture, [
      { kind: "transcript", conversationKey: HISTORY_DIRECTORY_KEY },
      {
        kind: "transcript",
        conversationKey: CURRENT_DIRECTORY_KEY,
        conversationId: CURRENT_CONVERSATION_ID,
      },
    ]);

    // Without `N` both conversations answer: the arm excludes nothing by itself.
    const unfiltered = await source.search(searchRequest());
    expect(
      unfiltered.candidates.filter((entry) =>
        entry.fingerprint.endsWith(":m1"),
      ),
    ).toHaveLength(2);

    const request = searchRequest();
    const filtered = await source.search({
      ...request,
      scope: {
        ...request.scope,
        excludedMessageIds: new Set(["m1"]),
      },
    });

    const fingerprints = filtered.candidates.map((entry) => entry.fingerprint);
    // The current conversation's m1 is still in the model's context: not
    // recallable, exactly like the lexical arm's `N` filter.
    expect(fingerprints).not.toContain(
      `transcript:${CURRENT_DIRECTORY_KEY}:m1`,
    );
    // The history conversation's m1 is a different unit, and the current
    // conversation's other messages stay recallable.
    expect(fingerprints).toContain(`transcript:${HISTORY_DIRECTORY_KEY}:m1`);
    expect(fingerprints).toContain(`transcript:${CURRENT_DIRECTORY_KEY}:m2`);
    expect(filtered.diagnostic.status).toBe("searched");
    expect(filtered.diagnostic.reason).toContain(
      "still in the current conversation's context",
    );
  });

  test("a unit without a record id keeps its hits rather than guessing", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CURRENT_DIRECTORY_KEY);
    indexTranscript(fixture, CURRENT_DIRECTORY_KEY);
    // No `conversationId` on the unit: the arm cannot prove this is the current
    // conversation, so it must not drop the hit on a guess.
    const source = makeSource(fixture, [
      { kind: "transcript", conversationKey: CURRENT_DIRECTORY_KEY },
    ]);

    const request = searchRequest();
    const result = await source.search({
      ...request,
      scope: {
        ...request.scope,
        excludedMessageIds: new Set(["m1"]),
      },
    });

    expect(result.candidates.map((entry) => entry.fingerprint)).toContain(
      `transcript:${CURRENT_DIRECTORY_KEY}:m1`,
    );
    expect(result.diagnostic.reason).toBeUndefined();
  });

  test("an empty or absent exclusion set changes nothing", async () => {
    const fixture = createFixture();
    writeConversation(fixture, CURRENT_DIRECTORY_KEY);
    indexTranscript(fixture, CURRENT_DIRECTORY_KEY);
    const source = makeSource(fixture, [
      {
        kind: "transcript",
        conversationKey: CURRENT_DIRECTORY_KEY,
        conversationId: CURRENT_CONVERSATION_ID,
      },
    ]);

    const absent = await source.search(searchRequest());
    const request = searchRequest();
    const empty = await source.search({
      ...request,
      scope: { ...request.scope, excludedMessageIds: new Set<string>() },
    });

    expect(empty.candidates).toEqual(absent.candidates);
    expect(empty.diagnostic).toEqual(absent.diagnostic);
  });
});

describe("the vector arm's cosine safety floor", () => {
  test("keeps an unrelated passage out of the merge, and is a per-model knob", async () => {
    const fixture = createFixture();
    writeConversation(fixture, HISTORY_DIRECTORY_KEY);
    indexTranscript(fixture, HISTORY_DIRECTORY_KEY);
    const queryVector = fakeEmbeddingVector(
      MESSAGES[0]?.text ?? "",
      DIMENSIONS,
    );
    // A second unit whose vectors are exactly anti-parallel to the query, so its
    // cosine is -1: a certain miss for any floor above -1.
    const unrelatedKey = "unrelated";
    const unrelated: readonly RecallMessageText[] = [
      {
        id: "u1",
        role: "user",
        ts: "2026-01-01T00:00:05.000Z",
        text: "机房搬迁计划在下周执行，涉及三台服务器与一条专线。",
      },
    ];
    writeConversation(fixture, unrelatedKey, unrelated);
    indexTranscript(fixture, unrelatedKey, unrelated, () =>
      Float32Array.from(queryVector, (value) => -value),
    );

    const searchWith = (minScore?: number) =>
      createEmbeddingIndexSearch({
        space: { agentId: AGENT_ID, spaceId: SPACE_ID },
        units: [
          { kind: "transcript", conversationKey: HISTORY_DIRECTORY_KEY },
          { kind: "transcript", conversationKey: unrelatedKey },
        ],
        root: fixture.vectorsRoot,
        ...(minScore === undefined ? {} : { minScore }),
      });
    const keysOf = (
      result: Awaited<
        ReturnType<ReturnType<typeof createEmbeddingIndexSearch>>
      >,
    ): string[] =>
      result.hits.map((entry) =>
        entry.kind === "transcript"
          ? `${entry.conversationKey}:${entry.hit.parentId}`
          : `memory:${entry.hit.parentId}`,
      );
    const request = {
      scope: {
        agentId: AGENT_ID,
        currentConversationId: CURRENT_CONVERSATION_ID,
      },
      query: queryVector,
      topK: 10,
      shouldStop: () => false,
    };

    // The default floor is 48-1 §6.7's 0.35: an unrelated passage never enters
    // the merge, while the matching parent does.
    const floored = await searchWith()(request);
    expect(floored.status).toBe("searched");
    expect(keysOf(floored)).toContain(`${HISTORY_DIRECTORY_KEY}:m1`);
    expect(keysOf(floored)).not.toContain(`${unrelatedKey}:u1`);

    // The floor is a per-model knob, and -1 is how a caller turns it off.
    const unfloored = await searchWith(-1)(request);
    expect(keysOf(unfloored)).toContain(`${unrelatedKey}:u1`);
  });
});
