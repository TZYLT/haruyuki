import { describe, expect, test } from "bun:test";
import {
  filterAboveRelativeThreshold,
  fuseRecallCandidates,
  RECALL_FUSION_DEFAULTS,
  type RecallFusedCandidate,
  type RecallFusionResult,
  type RecallFusionStrategy,
  relativeScoreThreshold,
  rrfFusionStrategy,
} from "./recall-fusion";
import type { RecallCandidate } from "./recall-port";

/**
 * The fusion rules, asserted on fixtures only.
 *
 * These are pure-function tests: no store, no settings, no encoder. The numbers
 * are exact rather than empirical — with the default weights a rank-1 hit from
 * either arm is `0.5 / 61`, and a hit both arms found is `1 / 61` — so a test
 * that passes here says the formula, the merge key and the ordering are what the
 * requirement states, not that one corpus happened to rank a passage well.
 */

function candidate(
  fingerprint: string,
  score: number,
  source: RecallCandidate["source"] = "transcript",
): RecallCandidate {
  return {
    source,
    fingerprint,
    file: source === "memory" ? "memory/notes.md" : "conversation-1",
    text: `text ${fingerprint}`,
    score,
  };
}

function scoreOf(
  result: RecallFusionResult,
  fingerprint: string,
): number | undefined {
  return result.candidates.find((entry) => entry.fingerprint === fingerprint)
    ?.score;
}

function fingerprints(result: RecallFusionResult): string[] {
  return result.candidates.map((entry) => entry.fingerprint);
}

describe("the weighted RRF formula", () => {
  test("equal-depth arms interleave by rank with the default weights", () => {
    const result = fuseRecallCandidates({
      lexical: [candidate("a:1", 9), candidate("a:2", 8)],
      vector: [candidate("b:1", 0.9), candidate("b:2", 0.8)],
    });

    // Rank 1 from each arm ties on score, so the fingerprint breaks it; rank 2
    // then follows the same pattern.
    expect(fingerprints(result)).toEqual(["a:1", "b:1", "a:2", "b:2"]);
    expect(scoreOf(result, "a:1")).toBeCloseTo(0.5 / 61, 12);
    expect(scoreOf(result, "b:1")).toBeCloseTo(0.5 / 61, 12);
    expect(scoreOf(result, "a:2")).toBeCloseTo(0.5 / 62, 12);
    expect(scoreOf(result, "b:2")).toBeCloseTo(0.5 / 62, 12);
    // The arm's own score is not the fused score and must not leak into `score`.
    expect(result.candidates[0]?.armScores).toEqual({
      lexical: 9,
    });
  });

  test("a fingerprint found by both arms merges and sums its RRF terms", () => {
    const result = fuseRecallCandidates({
      lexical: [candidate("shared", 11), candidate("lex-only", 10)],
      vector: [candidate("shared", 0.91), candidate("vec-only", 0.9)],
    });

    const shared = result.candidates[0];
    expect(shared?.fingerprint).toBe("shared");
    expect(shared?.score).toBeCloseTo(1 / 61, 12);
    expect(shared?.arms).toEqual(["lexical", "vector"]);
    expect(shared?.armRanks).toEqual({ lexical: 1, vector: 1 });
    expect(shared?.armScores).toEqual({ lexical: 11, vector: 0.91 });
    // One parent unit, one injectable entry — not one per arm.
    expect(result.candidates).toHaveLength(3);
    // The first-seen arm's passage fields survive; the merge is a score join,
    // not a re-render (window selection is E3's display rule).
    expect(shared?.text).toBe("text shared");
    expect(shared?.file).toBe("conversation-1");
  });

  test("unequal-depth arms still rank by each arm's own position", () => {
    const result = fuseRecallCandidates({
      lexical: [
        candidate("lex:1", 5),
        candidate("lex:2", 4),
        candidate("lex:3", 3),
      ],
      vector: [candidate("vec:1", 0.9)],
    });

    expect(fingerprints(result)).toEqual(["lex:1", "vec:1", "lex:2", "lex:3"]);
    expect(scoreOf(result, "lex:3")).toBeCloseTo(0.5 / 63, 12);
  });

  test("k is a parameter: it changes the gap, not the rank order", () => {
    const input = {
      lexical: [candidate("l1", 5), candidate("l2", 4)],
      vector: [],
    };

    const k0 = fuseRecallCandidates(input, { k: 0 });
    expect(scoreOf(k0, "l1")).toBeCloseTo(0.5, 12);
    expect(scoreOf(k0, "l2")).toBeCloseTo(0.25, 12);

    const k10 = fuseRecallCandidates(input, { k: 10 });
    expect(scoreOf(k10, "l1")).toBeCloseTo(0.5 / 11, 12);
    expect(scoreOf(k10, "l2")).toBeCloseTo(0.5 / 12, 12);

    const k60 = fuseRecallCandidates(input, { k: 60 });
    expect(scoreOf(k60, "l1")).toBeCloseTo(0.5 / 61, 12);
    expect(scoreOf(k60, "l2")).toBeCloseTo(0.5 / 62, 12);
    expect(fingerprints(k60)).toEqual(["l1", "l2"]);
  });

  test("equal fused scores break by fingerprint, independent of insertion order", () => {
    const first = fuseRecallCandidates({
      lexical: [candidate("z:1", 5)],
      vector: [candidate("a:1", 0.9)],
    });
    const reversed = fuseRecallCandidates({
      lexical: [candidate("a:1", 5)],
      vector: [candidate("z:1", 0.9)],
    });

    expect(fingerprints(first)).toEqual(["a:1", "z:1"]);
    expect(fingerprints(reversed)).toEqual(["a:1", "z:1"]);
  });
});

describe("arm weights", () => {
  const input = {
    lexical: [candidate("lex:1", 5), candidate("lex:2", 4)],
    vector: [candidate("vec:1", 0.9)],
  };

  test("weight 0 means lexical only and drops vector-only hits", () => {
    const result = fuseRecallCandidates(input, { vectorWeight: 0 });

    expect(fingerprints(result)).toEqual(["lex:1", "lex:2"]);
    expect(scoreOf(result, "lex:1")).toBeCloseTo(1 / 61, 12);
    expect(scoreOf(result, "lex:2")).toBeCloseTo(1 / 62, 12);
    expect(
      result.candidates.every((entry) => entry.arms[0] === "lexical"),
    ).toBe(true);
  });

  test("weight 1 means vector only and drops lexical-only hits", () => {
    const result = fuseRecallCandidates(input, { vectorWeight: 1 });

    expect(fingerprints(result)).toEqual(["vec:1"]);
    expect(scoreOf(result, "vec:1")).toBeCloseTo(1 / 61, 12);
  });

  test("weight 0.5 is the default and splits a shared hit evenly", () => {
    const explicit = fuseRecallCandidates(
      {
        lexical: [candidate("shared", 5)],
        vector: [candidate("shared", 0.9)],
      },
      { vectorWeight: 0.5 },
    );
    const implicit = fuseRecallCandidates({
      lexical: [candidate("shared", 5)],
      vector: [candidate("shared", 0.9)],
    });

    expect(scoreOf(explicit, "shared")).toBeCloseTo(1 / 61, 12);
    expect(fingerprints(implicit)).toEqual(fingerprints(explicit));
    expect(scoreOf(implicit, "shared")).toBeCloseTo(
      scoreOf(explicit, "shared") ?? -1,
      12,
    );
  });

  test("out-of-range and unusable weights clamp instead of throwing", () => {
    // >1 clamps to 1: vector only.
    expect(
      fingerprints(fuseRecallCandidates(input, { vectorWeight: 2 })),
    ).toEqual(["vec:1"]);
    // <0 clamps to 0: lexical only.
    expect(
      fingerprints(fuseRecallCandidates(input, { vectorWeight: -1 })),
    ).toEqual(["lex:1", "lex:2"]);
    // NaN falls back to the 0.5 default: both arms contribute.
    const nan = fuseRecallCandidates(input, { vectorWeight: Number.NaN });
    expect(fingerprints(nan)).toEqual(["lex:1", "vec:1", "lex:2"]);
  });
});

describe("the relative threshold", () => {
  test("the floor is top times ratio and filters the long tail", () => {
    // Rank 1 is shared, so the top is 1/61; the lexical tail is 0.5/(60+rank).
    const lexical = [
      candidate("top", 100),
      ...Array.from({ length: 49 }, (_, index) =>
        candidate(`lex:${index}`, 50 - index),
      ),
    ];
    const result = fuseRecallCandidates({
      lexical,
      vector: [candidate("top", 0.9)],
    });

    expect(result.candidates).toHaveLength(50);
    expect(result.threshold).toBeCloseTo((1 / 61) * 0.35, 12);

    const filtered = filterAboveRelativeThreshold(result.candidates);
    expect(filtered.threshold).toBeCloseTo((1 / 61) * 0.35, 12);
    // Ranks 2..27 of the lexical arm clear the floor; 28..50 fall below it.
    expect(filtered.candidates).toHaveLength(27);
    expect(filtered.candidates).toContainEqual(
      expect.objectContaining({ fingerprint: "top" }),
    );
    expect(fingerprints(filtered)).not.toContain("lex:26");
  });

  test("ratio 0 disables the floor and keeps every candidate", () => {
    const result = fuseRecallCandidates({
      lexical: [candidate("a", 5), candidate("b", 4)],
      vector: [],
    });
    const unfiltered = filterAboveRelativeThreshold(result.candidates, 0);

    expect(unfiltered.threshold).toBe(0);
    expect(fingerprints(unfiltered)).toEqual(["a", "b"]);
    expect(relativeScoreThreshold(1, 0)).toBe(0);
    expect(relativeScoreThreshold(0, 0.35)).toBe(0);
    expect(relativeScoreThreshold(Number.NaN, 0.35)).toBe(0);
  });

  test("the default ratio is the requirement's 0.35", () => {
    expect(RECALL_FUSION_DEFAULTS.minScoreRatio).toBe(0.35);
  });
});

describe("empty arms and duplicate fingerprints", () => {
  test("both arms empty yields nothing", () => {
    const result = fuseRecallCandidates({ lexical: [], vector: [] });

    expect(result.candidates).toEqual([]);
    expect(result.threshold).toBe(0);
    expect(filterAboveRelativeThreshold(result.candidates).candidates).toEqual(
      [],
    );
  });

  test("one empty arm keeps the other arm's entries", () => {
    const lexicalOnly = fuseRecallCandidates({
      lexical: [candidate("lex", 5)],
      vector: [],
    });
    const vectorOnly = fuseRecallCandidates({
      lexical: [],
      vector: [candidate("vec", 0.9)],
    });

    expect(fingerprints(lexicalOnly)).toEqual(["lex"]);
    expect(fingerprints(vectorOnly)).toEqual(["vec"]);
    expect(scoreOf(lexicalOnly, "lex")).toBeCloseTo(0.5 / 61, 12);
    expect(scoreOf(vectorOnly, "vec")).toBeCloseTo(0.5 / 61, 12);
  });

  test("a zero-weight arm's only candidate does not survive as a zero score", () => {
    const result = fuseRecallCandidates(
      { lexical: [], vector: [candidate("vec", 0.9)] },
      { vectorWeight: 0 },
    );

    expect(result.candidates).toEqual([]);
    expect(result.threshold).toBe(0);
  });

  test("a repeated fingerprint inside one arm counts once, at its best rank", () => {
    const result = fuseRecallCandidates({
      lexical: [candidate("dup", 9), candidate("dup", 8)],
      vector: [],
    });

    expect(result.candidates).toHaveLength(1);
    expect(scoreOf(result, "dup")).toBeCloseTo(0.5 / 61, 12);
    expect(result.candidates[0]?.armRanks).toEqual({ lexical: 1 });
    expect(result.candidates[0]?.arms).toEqual(["lexical"]);
  });

  test("the output is the unique fingerprint set the dedup window records", () => {
    // The 10-turn window contract at the pure layer: every injectable entry has
    // exactly one fingerprint, so recording the output once per turn can never
    // make the next turn see the same parent unit as two different entries.
    const result = fuseRecallCandidates({
      lexical: [
        candidate("t:1", 5),
        candidate("m:1", 4, "memory"),
        candidate("t:2", 3),
      ],
      vector: [candidate("t:1", 0.9), candidate("t:2", 0.8)],
    });

    const unique = fingerprints(result);
    expect(new Set(unique).size).toBe(unique.length);

    const injected: Record<string, number> = {};
    for (const entry of result.candidates) injected[entry.fingerprint] = 7;
    expect(Object.keys(injected)).toHaveLength(result.candidates.length);
  });
});

describe("depth and the replaceable strategy", () => {
  test("both arms are cut to the same depth", () => {
    const lexical = Array.from({ length: 60 }, (_, index) =>
      candidate(`lex:${index}`, 60 - index),
    );
    const vector = [candidate("vec:0", 0.9)];

    const result = fuseRecallCandidates({ lexical, vector });
    expect(result.candidates).toHaveLength(51);
    expect(fingerprints(result)).toContain("lex:49");
    expect(fingerprints(result)).not.toContain("lex:50");

    const shallow = fuseRecallCandidates(
      { lexical, vector },
      { candidateDepth: 2 },
    );
    expect(fingerprints(shallow).sort()).toEqual(["lex:0", "lex:1", "vec:0"]);
  });

  test("a replacement strategy is used without changing the call shape", () => {
    const reverseStrategy: RecallFusionStrategy = {
      id: "reverse",
      fuse(input) {
        return [...input.lexical].reverse().map((entry) => ({
          ...entry,
          score: 1,
          arms: ["lexical"],
          armRanks: { lexical: 1 },
          armScores: { lexical: entry.score },
        }));
      },
    };

    const result = fuseRecallCandidates(
      { lexical: [candidate("a", 1), candidate("b", 2)], vector: [] },
      { minScoreRatio: 0.5 },
      reverseStrategy,
    );

    expect(result.candidates.map((entry) => entry.fingerprint)).toEqual([
      "b",
      "a",
    ]);
    expect(result.threshold).toBeCloseTo(0.5, 12);
    expect(rrfFusionStrategy.id).toBe("rrf");
  });

  test("the default strategy is RRF and its result carries the fused score", () => {
    const result = fuseRecallCandidates(
      {
        lexical: [candidate("a", 5), candidate("b", 4)],
        vector: [candidate("a", 0.9)],
      },
      {},
      rrfFusionStrategy,
    );
    const top: RecallFusedCandidate | undefined = result.candidates[0];

    expect(top?.fingerprint).toBe("a");
    expect(top?.score).toBeCloseTo(1 / 61, 12);
  });
});
