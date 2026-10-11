import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
  LOCAL_TRANSCRIPT_SCHEMA_VERSION,
} from "@/backend/local/local-transcript";
import {
  loadRecallCorpus,
  rebuildConversationIndex,
} from "@/backend/local/recall-index";
import {
  hasTerm,
  matchesPhrase,
  type RankableSearchRecord,
  rankMatches,
  termFrequency,
  termOccurrences,
  tokenize,
} from "@/backend/local/transcript-search";

/**
 * The scorer reads a record's `normalizedText` instead of walking its tokens, for
 * both the document-frequency pass and the per-candidate frequency. That is only
 * allowed while it is *exactly* the old answer, so these tests compare the new
 * definitions against `termFrequency`, which is the unchanged per-token definition
 * the scoring used before.
 *
 * The reference BM25 below is deliberately a second implementation: it is written
 * with `termFrequency` only, so `rankMatches` matching its scores bit-for-bit is
 * evidence about the arithmetic, not a restatement of the same call.
 */

function record(tokens: string[], isSearchEcho = false): RankableSearchRecord {
  return { normalizedText: tokens.join(" "), tokens, isSearchEcho };
}

const RECORDS: RankableSearchRecord[] = [
  record(["记忆库"]),
  record(["记忆库记忆库"]),
  record(["记忆库房", "记忆"]),
  record(["记忆记忆记忆"]),
  record(["记忆记忆"]),
  record(["记", "忆"]),
  record(["bun"]),
  record(["bunny"]),
  record(["bun", "记忆库"]),
  record(["the", "finance", "ledger"]),
  record(["finance"]),
  record(["记忆库"], true),
];

const TERMS = [
  "记忆库",
  "记忆",
  "库",
  "记",
  "忆",
  "记忆库房",
  "bun",
  "bunny",
  "the",
  "finance",
  "ledger",
  "记忆库 bun",
  "",
  "  ",
];

describe("the scorer's term predicates agree with the per-token definition", () => {
  test("hasTerm matches termFrequency > 0 for every record and term", () => {
    const mismatches: string[] = [];
    for (const [index, entry] of RECORDS.entries()) {
      for (const term of TERMS) {
        const expected = termFrequency(entry.tokens, term) > 0;
        const actual = hasTerm(entry, term);
        if (expected !== actual) {
          mismatches.push(`record ${index} term ${JSON.stringify(term)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("termOccurrences matches termFrequency for every record and term", () => {
    const mismatches: string[] = [];
    for (const [index, entry] of RECORDS.entries()) {
      for (const term of TERMS) {
        const expected = termFrequency(entry.tokens, term);
        const actual = termOccurrences(entry, term);
        if (expected !== actual) {
          mismatches.push(
            `record ${index} term ${JSON.stringify(term)}: ${expected} !== ${actual}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("a Latin term is not matched by substring", () => {
    // The whole reason the Latin branch keeps token equality: `termFrequency` for a
    // Latin term means "this token", never "text containing this".
    expect(hasTerm(record(["bunny"]), "bun")).toBe(false);
    expect(termOccurrences(record(["bunny"]), "bun")).toBe(0);
    expect(hasTerm(record(["记忆库房"]), "记忆库")).toBe(true);
  });
});

function referenceScores(
  records: readonly RankableSearchRecord[],
  query: { terms: string[]; phrases: string[] },
): number[] {
  const phraseMatches = records.filter((entry) =>
    query.phrases.every((phrase) =>
      matchesPhrase(entry.normalizedText, phrase),
    ),
  );
  const candidates = phraseMatches.filter(
    (entry) =>
      query.phrases.length > 0 ||
      query.terms.some((term) => termFrequency(entry.tokens, term) > 0),
  );
  const historical = records.filter((entry) => !entry.isSearchEcho);
  const corpus = historical.length > 0 ? historical : records;
  const averageLength =
    corpus.reduce((sum, entry) => sum + entry.tokens.length, 0) / corpus.length;
  const k1 = 1.2;
  const b = 0.75;
  return candidates.map((entry) => {
    let score = 0;
    for (const term of query.terms) {
      const frequency = termFrequency(entry.tokens, term);
      if (frequency === 0) continue;
      const inDocuments = corpus.filter(
        (other) => termFrequency(other.tokens, term) > 0,
      ).length;
      const inverseDocumentFrequency = Math.log(
        1 + (corpus.length - inDocuments + 0.5) / (inDocuments + 0.5),
      );
      const lengthNormalization =
        1 - b + b * (entry.tokens.length / Math.max(averageLength, 1));
      score +=
        inverseDocumentFrequency *
        ((frequency * (k1 + 1)) / (frequency + k1 * lengthNormalization));
    }
    score += query.phrases.length * 2;
    return score * (entry.isSearchEcho ? 0.1 : 1);
  });
}

describe("rankMatches is bit-identical to the per-token reference", () => {
  const queries = [
    { terms: ["记忆库"], phrases: [] },
    { terms: ["记忆"], phrases: [] },
    { terms: ["记忆库", "bun"], phrases: [] },
    { terms: ["bun"], phrases: [] },
    { terms: ["the", "finance", "ledger"], phrases: [] },
    { terms: ["记忆"], phrases: ["记忆库"] },
    { terms: [], phrases: ["记忆库"] },
  ];

  for (const query of queries) {
    test(`query ${JSON.stringify(query)}`, () => {
      const actual = rankMatches(RECORDS, query).map((entry) => entry.score);
      expect(actual).toEqual(referenceScores(RECORDS, query));
    });
  }
});

describe("tokenize keeps a Han run whole", () => {
  test("the n-gram layer depends on this, and it has not changed", () => {
    expect(tokenize("记忆库记忆库")).toEqual(["记忆库记忆库"]);
    expect(tokenize("我养了一只猫，它叫小白。")).toEqual([
      "我养了一只猫",
      "它叫小白",
    ]);
    expect(tokenize("harness 的 compaction")).toEqual([
      "harness",
      "的",
      "compaction",
    ]);
  });
});

describe("the corpus producers honour the normalizedText contract", () => {
  test("loadRecallCorpus rebuilds every record's normalizedText from its tokens", async () => {
    // The joined-text shortcuts are only equivalent while this holds, so it is
    // asserted against a real producer rather than only against hand-built
    // records. The other producer is `collectConversationMessages`, which uses the
    // same `tokenize(...).join(" ")` expression.
    const storageDir = await mkdtemp(join(tmpdir(), "haru-scorer-contract-"));
    const conversationDir = join(
      storageDir,
      "conversations",
      "conversation-c1",
    );
    try {
      await mkdir(conversationDir, { recursive: true });
      await writeFile(
        join(conversationDir, "conversation.json"),
        `${JSON.stringify({
          id: "conv-c1",
          agent_id: "agent-c1",
          in_context_message_ids: [],
        })}\n`,
      );
      await writeFile(
        join(conversationDir, "manifest.json"),
        `${JSON.stringify({
          schema_version: LOCAL_TRANSCRIPT_SCHEMA_VERSION,
          message_format: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
          provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
          created_at: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      await writeFile(
        join(conversationDir, "messages.jsonl"),
        `${JSON.stringify({
          type: "message",
          id: "row-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            id: "m1",
            role: "user",
            content: [{ type: "text", text: "记忆库 memory 混合" }],
          },
        })}\n`,
      );
      rebuildConversationIndex({
        conversationDir,
        identity: {
          conversationKey: "conversation-c1",
          conversationId: "conv-c1",
          agentId: "agent-c1",
        },
      });
      const corpus = loadRecallCorpus(storageDir, {});
      expect(corpus.records.length).toBeGreaterThan(0);
      for (const entry of corpus.records) {
        expect(entry.normalizedText).toBe(entry.tokens.join(" "));
      }
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
