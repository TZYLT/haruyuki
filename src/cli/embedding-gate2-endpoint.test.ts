/**
 * Gate 2 (feature 48) — group A: the **external endpoint** path end to end, and
 * group D: the F-07 / F-15 acceptance rules re-proved on that path.
 *
 * Group A drives the real chain with a real loopback HTTP server:
 * C6 (`verifyEmbeddingEndpoint` / `createEmbeddingEndpointClient`) → B2
 * (`writeEmbeddingIndex` on disk) → E2 (`createVectorRecallSource` +
 * `createEmbeddingIndexSearch`) → E3 (`runRecall` with two-arm fusion). Both
 * supported wire protocols (OpenAI-compatible and Ollama native) are covered,
 * a dimension and a norm violation are proven to be refused, and every
 * unavailable/empty case is proven to degrade instead of throwing.
 *
 * Group D re-states F-07 and F-15 where the user can observe them:
 * - F-07: two arms of depth 50, RRF `k = 60`, weights 0/0.5/1 change the
 *   order, and a unit found by both arms appears exactly once;
 * - F-15: a vector hit injects the hit-centred window (≤400 chars), a parent
 *   whose text drifted is dropped with a reason, and the injected total stays
 *   inside 1200 characters.
 *
 * Everything is synthetic and isolated (`docs/31` §1.2 A2): one temp root, no
 * real harness data, no public network, no model runtime.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmbeddingEndpointClient,
  type EmbeddingEndpointClient,
  type EmbeddingEndpointOptions,
  isEmbeddingEndpointError,
  verifyEmbeddingEndpoint,
} from "@/backend/local/embedding/endpoint-client";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunkPlan,
} from "@/backend/local/embedding-chunk";
import {
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import type { RecallMessageText } from "@/backend/local/recall-index";
import { resetEmbeddingMetrics } from "@/reminders/embedding-metrics";
import {
  fuseRecallCandidates,
  RECALL_FUSION_DEFAULTS,
} from "@/reminders/recall-fusion";
import type { RecallCandidate, RecallEntry } from "@/reminders/recall-port";
import { runRecall } from "@/reminders/recall-service";
import {
  createEmbeddingIndexSearch,
  createVectorRecallSource,
} from "@/reminders/recall-vector-source";
import {
  createGate2Environment,
  createGate2ParentPort,
  createGate2RecallBackend,
  GATE2_DIMENSIONS,
  type Gate2Environment,
  type Gate2MockEndpoint,
  gate2Coverage,
  gate2MessageTexts,
  startGate2MockEndpoint,
  writeGate2Conversation,
} from "@/test-utils/embedding-gate2-fixtures";

const AGENT_ID = "agent-gate2-endpoint";
const SPACE_ID = "space-gate2-endpoint";
const MODEL_ID = "gate2-mock-embedding";

let env: Gate2Environment;
let vectorRoot: string;
const servers: Gate2MockEndpoint[] = [];
let generationCounter = 0;

type FusedEntry = RecallEntry & {
  arms?: readonly string[];
  armScores?: Partial<Record<string, number>>;
};

function endpointOptions(
  server: Gate2MockEndpoint,
  overrides: Partial<EmbeddingEndpointOptions> = {},
): EmbeddingEndpointOptions {
  return {
    kind: server.kind,
    baseUrl: server.baseUrl,
    model: MODEL_ID,
    dimensions: GATE2_DIMENSIONS,
    ...overrides,
  };
}

function endpointClient(
  server: Gate2MockEndpoint,
  overrides: Partial<EmbeddingEndpointOptions> = {},
): EmbeddingEndpointClient {
  return createEmbeddingEndpointClient(endpointOptions(server, overrides));
}

/** Write a real B2 generation whose vectors came from the endpoint client. */
async function indexMessages(input: {
  client: EmbeddingEndpointClient;
  messages: readonly RecallMessageText[];
  conversationKey: string;
  spaceId?: string;
}): Promise<{
  plans: EmbeddingChunkPlan[];
  chunks: number;
  unitDir: string;
}> {
  const plans = input.messages.map((message) =>
    buildEmbeddingChunkPlan({ parentId: message.id, text: message.text }),
  );
  const chunkTexts = plans.flatMap((plan) =>
    plan.chunks.map((chunk) => chunk.text),
  );
  const vectors = await input.client.embed(chunkTexts);
  generationCounter += 1;
  const unit = {
    agentId: AGENT_ID,
    spaceId: input.spaceId ?? SPACE_ID,
    conversationKey: input.conversationKey,
  };
  const unitDir = embeddingVectorUnitDir(unit, { root: vectorRoot });
  writeEmbeddingIndex({
    unitDir,
    unit,
    modelId: MODEL_ID,
    dimensions: GATE2_DIMENSIONS,
    records: plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan)),
    vectors,
    coverage: gate2Coverage(plans),
    generation: `gate2-endpoint-gen-${generationCounter}`,
  });
  return { plans, chunks: chunkTexts.length, unitDir };
}

/** E2's real vector arm over the written generation and a parent port. */
function vectorSourceFor(input: {
  client: EmbeddingEndpointClient;
  messages: () => readonly RecallMessageText[];
  conversationKey: string;
  spaceId?: string;
  /** `-1` disables the cosine floor so a drift test reaches the mapping layer. */
  minScore?: number;
}) {
  return createVectorRecallSource({
    encoder: {
      id: "endpoint:gate2",
      async encodeQuery(text) {
        const vectors = await input.client.embed([text]);
        return vectors[0] ?? null;
      },
    },
    search: createEmbeddingIndexSearch({
      space: { agentId: AGENT_ID, spaceId: input.spaceId ?? SPACE_ID },
      root: vectorRoot,
      units: [{ kind: "transcript", conversationKey: input.conversationKey }],
      ...(input.minScore === undefined ? {} : { minScore: input.minScore }),
    }),
    parentReader: createGate2ParentPort({ messages: input.messages }),
    topK: 50,
    budgetMs: 0,
  });
}

async function recall(input: {
  messages: readonly RecallMessageText[];
  vectorSource: ReturnType<typeof vectorSourceFor>;
  userText: string;
  limit?: number;
}) {
  return runRecall({
    backend: createGate2RecallBackend(env.localBackendDir),
    agentId: AGENT_ID,
    conversationId: "conversation-gate2",
    userText: input.userText,
    currentTurn: 1,
    dryRun: true,
    options: { limit: input.limit ?? 3 },
    vectorSource: input.vectorSource,
  });
}

function vectorDiagnostic(
  decision: Awaited<ReturnType<typeof recall>>,
): { status: string; candidates: number; reason?: string } | undefined {
  return decision.diagnostics.sources.find(
    (diagnostic) => diagnostic.source === "vector",
  ) as { status: string; candidates: number; reason?: string } | undefined;
}

beforeAll(() => {
  env = createGate2Environment("haru-gate2-endpoint-");
  vectorRoot = mkdtempSync(join(tmpdir(), "haru-gate2-endpoint-vectors-"));
});

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  rmSync(vectorRoot, { recursive: true, force: true });
  env.cleanup();
  env.restore();
});

// ---------------------------------------------------------------------------
// Group A: endpoint path E2E
// ---------------------------------------------------------------------------

describe("group A - external endpoint path", () => {
  test("OpenAI: verify -> client embed -> B2 index -> E2 arm -> runRecall injects", async () => {
    const server = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
    });
    servers.push(server);

    const verified = await verifyEmbeddingEndpoint(endpointOptions(server));
    expect(verified.kind).toBe("openai");
    expect(verified.dimensions).toBe(GATE2_DIMENSIONS);
    expect(verified.norm).toBeGreaterThan(1 - 0.01);
    expect(verified.norm).toBeLessThan(1 + 0.01);
    expect(verified.egress).toBe(true);
    expect(verified.models.map((entry) => entry.id)).toEqual([MODEL_ID]);

    const client = endpointClient(server);
    const messages = gate2MessageTexts([
      {
        id: "m-a1",
        role: "assistant",
        text: "财务系统的记账方式是每日对账。对账结果写入当日的台账。",
      },
      { id: "m-a2", role: "user", text: "部署窗口定在周五晚上八点。" },
    ]);
    const { chunks } = await indexMessages({
      client,
      messages,
      conversationKey: "conv-a1",
    });
    expect(chunks).toBeGreaterThan(0);

    const source = vectorSourceFor({
      client,
      messages: () => messages,
      conversationKey: "conv-a1",
    });
    const arm = await source.search({
      terms: { rawText: messages[0]?.text ?? "", terms: ["记账"], phrases: [] },
      scope: { agentId: AGENT_ID, currentConversationId: "conv-a1" },
    });
    expect(arm.diagnostic.status).toBe("searched");
    expect(arm.diagnostic.candidates).toBeGreaterThan(0);
    expect(
      arm.candidates.every((candidate) => candidate.arm === "vector"),
    ).toBe(true);

    const decision = await recall({
      messages,
      vectorSource: source,
      userText: messages[0]?.text ?? "",
    });
    expect(decision.status).toBe("injected");
    expect(decision.entries.length).toBeGreaterThan(0);
    const injected = decision.entries[0] as FusedEntry;
    expect(injected.arms).toContain("vector");
    expect(injected.text.length).toBeLessThanOrEqual(400);
    expect(injected.fingerprint).toBe(`transcript:conv-a1:m-a1`);

    // Both protocol paths were actually spoken, not stubbed.
    expect(server.requests.map((request) => request.path)).toContain(
      "/v1/models",
    );
    expect(server.requests.map((request) => request.path)).toContain(
      "/v1/embeddings",
    );
  });

  test("Ollama: verify + embed through the native protocol", async () => {
    const server = await startGate2MockEndpoint({
      kind: "ollama",
      model: MODEL_ID,
    });
    servers.push(server);

    const verified = await verifyEmbeddingEndpoint(endpointOptions(server));
    expect(verified.kind).toBe("ollama");
    expect(verified.version).toBe("0.0.0-gate2-mock");
    expect(verified.models[0]?.id).toBe(MODEL_ID);

    const client = endpointClient(server);
    const vectors = await client.embed(["第一段文本", "第二段文本"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.length).toBe(GATE2_DIMENSIONS);
    expect(server.requests.map((request) => request.path)).toContain(
      "/api/tags",
    );
    expect(server.requests.map((request) => request.path)).toContain(
      "/api/embed",
    );
  });

  test("a declared dimension mismatch is refused by C6 (no index is usable)", async () => {
    const server = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
      embed: () => [1, 0, 0],
    });
    servers.push(server);

    let caught: unknown;
    try {
      await verifyEmbeddingEndpoint(endpointOptions(server));
    } catch (error) {
      caught = error;
    }
    expect(isEmbeddingEndpointError(caught)).toBe(true);
    if (isEmbeddingEndpointError(caught)) {
      expect(caught.kind).toBe("dimension");
    }
    let embedCaught: unknown;
    try {
      await endpointClient(server).embed(["维度不匹配"]);
    } catch (error) {
      embedCaught = error;
    }
    expect(isEmbeddingEndpointError(embedCaught)).toBe(true);
    if (isEmbeddingEndpointError(embedCaught)) {
      expect(embedCaught.kind).toBe("dimension");
    }
  });

  test("an unnormalised vector is refused by C6", async () => {
    const wrong = Array.from({ length: GATE2_DIMENSIONS }, () => 1);
    const server = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
      embed: () => wrong,
    });
    servers.push(server);

    let caught: unknown;
    try {
      await verifyEmbeddingEndpoint(endpointOptions(server));
    } catch (error) {
      caught = error;
    }
    expect(isEmbeddingEndpointError(caught)).toBe(true);
    if (isEmbeddingEndpointError(caught)) {
      expect(caught.kind).toBe("norm");
    }
  });

  test("unavailable endpoint / empty space / no encoder vector degrade without throwing", async () => {
    const messages = gate2MessageTexts([
      { id: "m-degrade", role: "user", text: "降级路径不得抛错。" },
    ]);
    // (1) The endpoint is gone: the arm degrades, the turn still returns.
    // A loopback server that accepted, then closed, refuses fast (no TCP hang).
    const dying = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
    });
    // A tight timeout keeps a theoretical TCP stall from stretching the test;
    // a refusal or a timeout both mean "the arm degrades".
    const deadClient = endpointClient(dying, {
      timeoutMs: 1_000,
      maxRetries: 0,
    });
    await dying.close();
    const degraded = await recall({
      messages,
      vectorSource: vectorSourceFor({
        client: deadClient,
        messages: () => messages,
        conversationKey: "conv-degrade",
      }),
      userText: messages[0]?.text ?? "",
    });
    const failed = vectorDiagnostic(degraded);
    expect(failed?.status).toBe("failed");
    expect(degraded.timedOut).toBeUndefined();

    // (2) No generation on disk: `unavailable`, still no throw.
    const server = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
    });
    servers.push(server);
    const empty = await recall({
      messages,
      vectorSource: vectorSourceFor({
        client: endpointClient(server),
        messages: () => messages,
        conversationKey: "conv-without-index",
        spaceId: "space-without-index",
      }),
      userText: messages[0]?.text ?? "",
    });
    expect(vectorDiagnostic(empty)?.status).toBe("unavailable");
    expect(empty.timedOut).toBeUndefined();

    // (3) The encoder cannot answer: `unavailable`, still no throw.
    const noVector = createVectorRecallSource({
      encoder: {
        async encodeQuery() {
          return null;
        },
      },
      search: createEmbeddingIndexSearch({
        space: { agentId: AGENT_ID, spaceId: "space-no-encoder" },
        root: vectorRoot,
        units: [{ kind: "transcript", conversationKey: "conv-degrade" }],
      }),
      parentReader: createGate2ParentPort({ messages: () => messages }),
    });
    const decision = await recall({
      messages,
      vectorSource: noVector,
      userText: messages[0]?.text ?? "",
    });
    expect(vectorDiagnostic(decision)?.status).toBe("unavailable");
    expect(decision.timedOut).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group D: F-07 / F-15 rules re-proved on the green path
// ---------------------------------------------------------------------------

function candidate(input: {
  fingerprint: string;
  score: number;
  arm?: "vector";
  source?: "transcript" | "memory";
}): RecallCandidate {
  const source = input.source ?? "transcript";
  return {
    source,
    fingerprint: input.fingerprint,
    file: "fixture",
    text: `text for ${input.fingerprint}`,
    score: input.score,
    ...(input.arm === undefined ? {} : { arm: input.arm }),
  };
}

describe("group D - F-07 fusion rules", () => {
  test("defaults are two arms of depth 50 at RRF k=60", () => {
    expect(RECALL_FUSION_DEFAULTS.k).toBe(60);
    expect(RECALL_FUSION_DEFAULTS.candidateDepth).toBe(50);
    expect(RECALL_FUSION_DEFAULTS.vectorWeight).toBe(0.5);
  });

  test("each arm contributes at most 50 candidates and k=60 sets the score", () => {
    const lexical = Array.from({ length: 60 }, (_unused, index) =>
      candidate({ fingerprint: `lexical-${index}`, score: 100 - index }),
    );
    const vector = Array.from({ length: 60 }, (_unused, index) =>
      candidate({
        fingerprint: `vector-${index}`,
        score: 1 / (index + 1),
        arm: "vector",
      }),
    );
    const fused = fuseRecallCandidates({ lexical, vector });
    // 50 unique lexical + 50 unique vector; ranks 51..60 never participate.
    expect(fused.candidates).toHaveLength(100);
    expect(
      fused.candidates.some((entry) => entry.fingerprint === "lexical-50"),
    ).toBe(false);
    expect(
      fused.candidates.some((entry) => entry.fingerprint === "vector-50"),
    ).toBe(false);
    // Rank 1 in one arm under the default 0.5 weight is 0.5 / (60 + 1).
    const top = fused.candidates[0];
    expect(top?.score).toBeCloseTo(0.5 / 61, 12);
    expect(top?.arms).toEqual(["lexical"]);
    expect(top?.armRanks.lexical).toBe(1);
    // The relative floor is top * 0.35, never an absolute value.
    expect(fused.threshold).toBeCloseTo((0.5 / 61) * 0.35, 12);
  });

  test("weights 0 / 0.5 / 1 change the order", () => {
    const a = candidate({ fingerprint: "a", score: 9 });
    const c = candidate({ fingerprint: "c", score: 7 });
    const b = candidate({ fingerprint: "b", score: 1, arm: "vector" });
    const aVector = candidate({ fingerprint: "a", score: 0.9, arm: "vector" });

    const order = (vectorWeight: number): string[] =>
      fuseRecallCandidates(
        { lexical: [a, c], vector: [b, aVector] },
        { vectorWeight },
      ).candidates.map((entry) => entry.fingerprint);

    expect(order(0)).toEqual(["a", "c"]); // lexical only
    expect(order(1)).toEqual(["b", "a"]); // vector only
    // Both arms agree on `a`, so it outranks either arm's lone favourite.
    expect(order(0.5)).toEqual(["a", "b", "c"]);
  });

  test("the same fingerprint appears exactly once and sums both contributions", () => {
    const shared = candidate({ fingerprint: "shared", score: 5 });
    const sharedVector = candidate({
      fingerprint: "shared",
      score: 0.8,
      arm: "vector",
    });
    const fused = fuseRecallCandidates({
      lexical: [shared],
      vector: [sharedVector],
    });
    expect(fused.candidates).toHaveLength(1);
    expect(fused.candidates[0]?.arms).toEqual(["lexical", "vector"]);
    expect(fused.candidates[0]?.score).toBeCloseTo(0.5 / 61 + 0.5 / 61, 12);
  });

  test("runRecall merges a two-arm hit once and keeps the 3 x 400 / 1200 budget", async () => {
    const server = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
    });
    servers.push(server);
    const client = endpointClient(server);

    const fixtureMessages = [
      {
        id: "m-d1",
        role: "assistant" as const,
        text: "财务系统的记账方式是每日对账。对账结果写入当日的台账。",
      },
    ];
    await writeGate2Conversation({
      storageDir: env.localBackendDir,
      directory: "conv-d1",
      conversationId: "conversation-d1",
      agentId: AGENT_ID,
      messages: fixtureMessages,
    });
    const messages = gate2MessageTexts(fixtureMessages);
    await indexMessages({
      client,
      messages,
      conversationKey: "conv-d1",
      spaceId: "space-d1",
    });

    const source = vectorSourceFor({
      client,
      messages: () => messages,
      conversationKey: "conv-d1",
      spaceId: "space-d1",
    });
    const decision = await recall({
      messages,
      vectorSource: source,
      userText: fixtureMessages[0]?.text ?? "",
    });
    expect(decision.status).toBe("injected");
    const fingerprints = decision.entries.map((entry) => entry.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    const merged = decision.entries.find(
      (entry) => entry.fingerprint === "transcript:conv-d1:m-d1",
    ) as FusedEntry | undefined;
    expect(merged).toBeDefined();
    expect(merged?.arms).toEqual(["lexical", "vector"]);
    const total = decision.entries.reduce(
      (sum, entry) => sum + entry.text.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(1200);
    for (const entry of decision.entries) {
      expect(entry.text.length).toBeLessThanOrEqual(400);
    }
  });
});

describe("group D - F-15 injection window rules", () => {
  test("a hit on a long message injects the hit-centred window, capped at 400", async () => {
    const server = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
    });
    servers.push(server);
    const client = endpointClient(server);
    const longText = Array.from(
      { length: 12 },
      (_unused, index) =>
        `第${index + 1}节：财务系统的记账方式与每日对账口径说明，用于验证长消息的命中窗口。`,
    ).join("");
    const longMessages = gate2MessageTexts([
      { id: "m-long", role: "assistant", text: longText },
    ]);
    const { plans } = await indexMessages({
      client,
      messages: longMessages,
      conversationKey: "conv-long",
      spaceId: "space-long",
    });
    expect(plans[0]?.chunks.length).toBeGreaterThan(1);
    expect(longText.length).toBeGreaterThan(400);
    const targetChunk = plans[0]?.chunks[1];
    if (targetChunk === undefined) throw new Error("no second chunk");

    const source = vectorSourceFor({
      client,
      messages: () => longMessages,
      conversationKey: "conv-long",
      spaceId: "space-long",
    });
    const arm = await source.search({
      terms: {
        rawText: targetChunk.text,
        terms: ["对账"],
        phrases: [],
      },
      scope: { agentId: AGENT_ID, currentConversationId: "conv-long" },
    });
    const hit = arm.candidates[0];
    expect(hit?.fingerprint).toBe("transcript:conv-long:m-long");
    expect(hit?.text.length).toBeLessThanOrEqual(400);
    // The window is a slice of the original text around the matched chunk, not
    // the whole message and not the from-the-head excerpt the lexical arm uses.
    expect(hit?.text.length).toBeLessThan(longText.length);
    expect(hit?.text).toContain(targetChunk.text.slice(0, 8));
  });

  test("a drifted parent is dropped with a reason and never injected", async () => {
    const server = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
    });
    servers.push(server);
    const client = endpointClient(server);
    const original = gate2MessageTexts([
      { id: "m-drift", role: "user", text: "这一段原文稍后会被修改掉。" },
    ]);
    await indexMessages({
      client,
      messages: original,
      conversationKey: "conv-drift",
      spaceId: "space-drift",
    });
    let current: readonly RecallMessageText[] = original;
    const source = vectorSourceFor({
      client,
      messages: () => current,
      conversationKey: "conv-drift",
      spaceId: "space-drift",
      // The default cosine floor can filter this edited parent before the drift
      // check runs; the point of this test is the mapping layer's own drop.
      minScore: -1,
    });
    // Simulate an edit between the build and the query: same message id, new text.
    current = gate2MessageTexts([
      {
        id: "m-drift",
        role: "user",
        text: "这一段原文被改成了完全不同的句子。",
      },
    ]);
    const arm = await source.search({
      terms: { rawText: "原文", terms: ["原文"], phrases: [] },
      scope: { agentId: AGENT_ID, currentConversationId: "conv-drift" },
    });
    expect(arm.diagnostic.status).toBe("empty");
    expect(arm.candidates).toHaveLength(0);
    expect(arm.diagnostic.reason).toContain("drifted");

    const decision = await recall({
      messages: current,
      vectorSource: source,
      userText: "原文",
    });
    expect(decision.entries).toHaveLength(0);
    expect(decision.timedOut).toBeUndefined();
    expect(vectorDiagnostic(decision)?.reason).toContain("drifted");
  });

  test("the total injected text budget stays at or under 1200 characters", async () => {
    const server = await startGate2MockEndpoint({
      kind: "openai",
      model: MODEL_ID,
    });
    servers.push(server);
    const client = endpointClient(server);
    const many = gate2MessageTexts([
      { id: "b-1", role: "assistant", text: "预算测试第一条：对账与台账。" },
      { id: "b-2", role: "assistant", text: "预算测试第二条：台账与审计。" },
      { id: "b-3", role: "assistant", text: "预算测试第三条：审计与回滚。" },
      { id: "b-4", role: "assistant", text: "预算测试第四条：回滚与复盘。" },
    ]);
    await indexMessages({
      client,
      messages: many,
      conversationKey: "conv-budget",
      spaceId: "space-budget",
    });
    const source = vectorSourceFor({
      client,
      messages: () => many,
      conversationKey: "conv-budget",
      spaceId: "space-budget",
    });
    const decision = await recall({
      messages: many,
      vectorSource: source,
      userText: "预算测试第一条：对账与台账。",
      limit: 3,
    });
    expect(decision.entries.length).toBeLessThanOrEqual(3);
    const total = decision.entries.reduce(
      (sum, entry) => sum + entry.text.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(1200);
    for (const entry of decision.entries) {
      expect(entry.text.length).toBeLessThanOrEqual(400);
    }
  });
});

// Keep the metrics recorder from leaking a recorded round into later files.
afterAll(() => {
  resetEmbeddingMetrics();
});
