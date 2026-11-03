/**
 * Gate-1 mock end-to-end test for feature 48 (embedding recall).
 *
 * It exercises the de-risking path that must hold before the endpoint/builtin
 * delivery: B1 chunking -> B2 index write/load/search -> B4 injection mapping ->
 * E1 weighted RRF fusion, plus A1's two-phase service with the lexical verdict
 * frozen at the phase boundary. Everything is synthetic: fake deterministic
 * embeddings (no model, no network), a temp index root, and no real harness data.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEmbeddingIndex } from "@/backend/local/embedding-cache";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import { searchEmbeddingIndex } from "@/backend/local/embedding-search";
import type { RecallMessageText } from "@/backend/local/recall-index";
import type { RecallDeadline } from "@/reminders/recall-deadline";
import { fuseRecallCandidates } from "@/reminders/recall-fusion";
import type {
  RecallCandidate,
  RecallSourcePort,
  RecallSourceRequest,
} from "@/reminders/recall-port";
import { searchRecallPhases } from "@/reminders/recall-service";
import {
  buildTranscriptVectorCandidate,
  createTranscriptVectorParentReader,
} from "@/reminders/recall-sources";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";

const DIMENSIONS = 8;
const AGENT_ID = "agent-mock";
const SPACE_ID = "space-mock";
const CONVERSATION_KEY = "conversation-mock";

const root = mkdtempSync(join(tmpdir(), "haru-embedding-gate1-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const messages: RecallMessageText[] = [
  {
    id: "msg-1",
    role: "user",
    ts: "2026-01-01T00:00:01.000Z",
    text: "财务系统的记账方式是每日对账。对账结果写入当日的台账。月底再汇总一次。",
  },
  {
    id: "msg-2",
    role: "assistant",
    ts: "2026-01-01T00:00:02.000Z",
    text: "The deploy ran at 09:30. 回滚脚本仍然可用。Next step is the canary check. 之后再看监控。",
  },
];

type BuiltIndex = {
  unitDir: string;
  hit: Parameters<typeof buildTranscriptVectorCandidate>[0]["hit"];
  candidate: NonNullable<ReturnType<typeof buildTranscriptVectorCandidate>>;
};

let cachedGateOneIndex: BuiltIndex | undefined;

/** Builds the mock index once: a second copy would collide on the generation rename. */
function gateOneIndex(): BuiltIndex {
  cachedGateOneIndex ??= buildGateOneIndex();
  return cachedGateOneIndex;
}

function buildGateOneIndex(): BuiltIndex {
  const unitDir = embeddingVectorUnitDir(
    { agentId: AGENT_ID, spaceId: SPACE_ID, conversationKey: CONVERSATION_KEY },
    { root },
  );
  const plans = messages.map((message) =>
    buildEmbeddingChunkPlan({ parentId: message.id, text: message.text }),
  );
  const records = plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan));
  const vectors = plans.flatMap((plan) =>
    plan.chunks.map((chunk) => fakeEmbeddingVector(chunk.text, DIMENSIONS)),
  );
  const coverage = plans.reduce(
    (accumulated, plan) => ({
      embeddedChars: accumulated.embeddedChars + plan.coverage.embeddedChars,
      recallableChars:
        accumulated.recallableChars + plan.coverage.recallableChars,
      ratio: 0,
    }),
    { embeddedChars: 0, recallableChars: 0, ratio: 0 },
  );
  coverage.ratio =
    coverage.recallableChars === 0
      ? 0
      : coverage.embeddedChars / coverage.recallableChars;

  writeEmbeddingIndex({
    unitDir,
    unit: {
      agentId: AGENT_ID,
      spaceId: SPACE_ID,
      conversationKey: CONVERSATION_KEY,
    },
    modelId: "fake-deterministic",
    dimensions: DIMENSIONS,
    records,
    vectors,
    coverage,
    generation: "gate1-generation-1",
  });

  const loaded = loadEmbeddingIndex(unitDir);
  if (!loaded.ok) {
    throw new Error(`gate-1 index did not load: ${loaded.problem}`);
  }
  const searched = searchEmbeddingIndex(
    loaded.index,
    fakeEmbeddingVector(messages[0]?.text ?? "", DIMENSIONS),
    { topK: 2 },
  );
  if (!searched.ok || searched.hits.length === 0) {
    throw new Error("gate-1 search returned no hits");
  }
  const hit = searched.hits[0];
  if (hit === undefined) {
    throw new Error("gate-1 search hit was undefined");
  }
  const candidate = buildTranscriptVectorCandidate({
    hit,
    conversationKey: CONVERSATION_KEY,
    messages,
    readParent: createTranscriptVectorParentReader(messages),
  });
  if (candidate === undefined) {
    throw new Error("gate-1 vector hit did not map to a candidate");
  }
  return { unitDir, hit, candidate };
}

describe("gate-1 mock pipeline: chunk -> index -> search -> inject -> fuse", () => {
  test("B1->B2 round trip yields a parent-level hit with a verified chunk", () => {
    const { unitDir, hit } = gateOneIndex();
    expect(unitDir.startsWith(root)).toBe(true);
    expect(messages.some((message) => message.id === hit.parentId)).toBe(true);
    expect(hit.textHash.length).toBeGreaterThan(0);
    expect(hit.focusChar).toBeGreaterThanOrEqual(hit.startChar);
    expect(hit.focusChar).toBeLessThanOrEqual(hit.endChar);
  });

  test("B4 maps the hit to a <=400-char vector candidate with the lexical identity", () => {
    const { candidate } = gateOneIndex();
    expect(candidate.arm).toBe("vector");
    expect(candidate.source).toBe("transcript");
    expect(candidate.fingerprint).toBe(`transcript:${CONVERSATION_KEY}:msg-1`);
    expect(candidate.text.length).toBeGreaterThan(0);
    expect(candidate.text.length).toBeLessThanOrEqual(400);
    expect(candidate.text).toContain("财务系统的记账方式");
  });

  test("E1 fuses lexical + vector arms and merges the same fingerprint once", () => {
    const { candidate } = gateOneIndex();
    const lexical: RecallCandidate[] = [
      {
        source: "transcript",
        fingerprint: `transcript:${CONVERSATION_KEY}:msg-1`,
        file: CONVERSATION_KEY,
        conversationKey: CONVERSATION_KEY,
        messageId: "msg-1",
        timestamp: messages[0]?.ts,
        text: "lexical snapshot for msg-1",
        score: 9,
      },
      {
        source: "transcript",
        fingerprint: `transcript:${CONVERSATION_KEY}:msg-2`,
        file: CONVERSATION_KEY,
        conversationKey: CONVERSATION_KEY,
        messageId: "msg-2",
        timestamp: messages[1]?.ts,
        text: "lexical snapshot for msg-2",
        score: 7,
      },
    ];
    const fused = fuseRecallCandidates({ lexical, vector: [candidate] });
    const merged = fused.candidates.find(
      (entry) => entry.fingerprint === `transcript:${CONVERSATION_KEY}:msg-1`,
    );
    expect(merged).toBeDefined();
    expect(merged?.arms).toEqual(["lexical", "vector"]);
    expect(merged?.armScores.lexical).toBe(9);
    expect(merged?.armScores.vector).toBe(candidate.score);
    expect(fused.candidates.length).toBe(2);
    expect(fused.threshold).toBeGreaterThan(0);
    // Fused scores replace the arm scores (relative threshold stays meaningful).
    for (const entry of fused.candidates) {
      expect(entry.score).toBeLessThan(0.1);
    }
  });
});

function outcomeFor(source: "transcript" | "memory", count: number) {
  return {
    candidates: [] as RecallCandidate[],
    diagnostic: { source, status: "searched" as const, candidates: count },
  };
}

function port(
  id: "transcript" | "memory",
  arm: "lexical" | "vector",
  onSearch: () => void,
): RecallSourcePort {
  return {
    id,
    arm,
    async search(_request: RecallSourceRequest) {
      onSearch();
      return outcomeFor(id, 1);
    },
  };
}

describe("gate-1 mock pipeline: A1 two-phase service boundary", () => {
  test("a lexical overrun freezes timedOut at the boundary; the vector arm still runs", async () => {
    let expired = false;
    const vectorRan: string[] = [];
    const sources: RecallSourcePort[] = [
      port("transcript", "lexical", () => {
        // The lexical arm spends the whole turn budget.
        expired = true;
      }),
      port("memory", "vector", () => {
        vectorRan.push("memory");
      }),
    ];
    const deadline: RecallDeadline = {
      timeoutMs: 1000,
      expired: () => expired,
    };
    const result = await searchRecallPhases(
      sources,
      { rawText: "对账结果", terms: ["对账"], phrases: [] },
      { agentId: AGENT_ID, currentConversationId: CONVERSATION_KEY },
      deadline,
    );
    expect(result.timedOut).toBe(true);
    expect(vectorRan).toEqual(["memory"]);
  });

  test("a vector overrun does not become a timeout (breaker semantics stay lexical)", async () => {
    let expired = false;
    const sources: RecallSourcePort[] = [
      port("transcript", "lexical", () => {
        // Lexical finishes inside budget.
      }),
      port("memory", "vector", () => {
        expired = true;
      }),
    ];
    const deadline: RecallDeadline = {
      timeoutMs: 1000,
      expired: () => expired,
    };
    const result = await searchRecallPhases(
      sources,
      { rawText: "对账结果", terms: ["对账"], phrases: [] },
      { agentId: AGENT_ID, currentConversationId: CONVERSATION_KEY },
      deadline,
    );
    expect(result.timedOut).toBe(false);
    expect(result.candidates.length).toBe(0);
    expect(result.diagnostics.length).toBe(2);
  });
});
