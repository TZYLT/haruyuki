import { describe, expect, test } from "bun:test";
import { selectRecallEntries } from "@/reminders/recall-orchestrator";
import type { RecallCandidate } from "@/reminders/recall-port";

/**
 * The acceptance for M3 is "given a fixture, assert exactly what would be injected
 * and what would not". These fixtures are the whole reason the selection step is a
 * pure function: no store, no corpus, no turn.
 */

function candidate(input: {
  source: "transcript" | "memory";
  file: string;
  score: number;
  fingerprint?: string;
  text?: string;
}): RecallCandidate {
  return {
    source: input.source,
    fingerprint: input.fingerprint ?? `${input.source}:${input.file}`,
    file: input.file,
    text: input.text ?? `${input.file} body`,
    score: input.score,
    ...(input.source === "transcript"
      ? { messageId: `msg-${input.file}` }
      : {}),
  };
}

const base = {
  limit: 3,
  minScoreRatio: 0,
  diversity: "none" as const,
  excerptCharacters: 400,
  totalCharacters: 1200,
  suppressed: new Set<string>(),
};

describe("dedup window", () => {
  test("drops suppressed fingerprints before anything else", () => {
    const selection = selectRecallEntries({
      ...base,
      candidates: [
        candidate({ source: "transcript", file: "a", score: 9 }),
        candidate({ source: "memory", file: "b", score: 8 }),
      ],
      suppressed: new Set(["transcript:a"]),
    });
    expect(selection.entries.map((entry) => entry.file)).toEqual(["b"]);
    expect(selection.deduped).toBe(1);
  });
});

describe("score floor", () => {
  test("is relative to the best surviving score", () => {
    const selection = selectRecallEntries({
      ...base,
      minScoreRatio: 0.5,
      candidates: [
        candidate({ source: "transcript", file: "a", score: 10 }),
        candidate({ source: "transcript", file: "b", score: 6 }),
        candidate({ source: "transcript", file: "c", score: 4 }),
      ],
    });
    expect(selection.threshold).toBe(5);
    expect(selection.entries.map((entry) => entry.file)).toEqual(["a", "b"]);
    expect(selection.belowThreshold).toBe(1);
  });

  test("measures the floor against what is still available, not a spent hit", () => {
    // The 10 was already injected inside the window. The floor is `2 * 0.5`, not
    // `10 * 0.5`: silencing a real second match because the *best* match is spent
    // would turn the window into "stop recalling this topic", which is not what it
    // is for. The window's job is to stop repeating the same item.
    const selection = selectRecallEntries({
      ...base,
      minScoreRatio: 0.5,
      candidates: [
        candidate({ source: "transcript", file: "a", score: 10 }),
        candidate({ source: "transcript", file: "b", score: 2 }),
      ],
      suppressed: new Set(["transcript:a"]),
    });
    expect(selection.deduped).toBe(1);
    expect(selection.threshold).toBe(1);
    expect(selection.entries.map((entry) => entry.file)).toEqual(["b"]);
  });

  test("ratio zero keeps everything", () => {
    const selection = selectRecallEntries({
      ...base,
      candidates: [candidate({ source: "memory", file: "a", score: 0.01 })],
    });
    expect(selection.entries).toHaveLength(1);
  });
});

describe("slot allocation", () => {
  // Three paragraphs of ONE memory document plus one transcript hit, which is the
  // shape the paragraph-level corpus actually produces.
  const spread = [
    candidate({
      source: "memory",
      file: "m.md",
      fingerprint: "memory:m.md#1",
      score: 9,
    }),
    candidate({
      source: "memory",
      file: "m.md",
      fingerprint: "memory:m.md#2",
      score: 8,
    }),
    candidate({
      source: "memory",
      file: "m.md",
      fingerprint: "memory:m.md#3",
      score: 7,
    }),
    candidate({ source: "transcript", file: "t1", score: 6 }),
  ];
  const fingerprints = (
    input: Parameters<typeof selectRecallEntries>[0],
  ): string[] =>
    selectRecallEntries(input).entries.map((entry) => entry.fingerprint);

  test("none takes the top scores, even from one file", () => {
    expect(fingerprints({ ...base, candidates: spread })).toEqual([
      "memory:m.md#1",
      "memory:m.md#2",
      "memory:m.md#3",
    ]);
  });

  test("file keeps one entry per file and does not refill the slot", () => {
    // The third slot stays empty: refilling it from m.md would defeat the setting.
    expect(
      fingerprints({ ...base, diversity: "file", candidates: spread }),
    ).toEqual(["memory:m.md#1", "transcript:t1"]);
  });

  test("split gives each source half and the odd slot to the better score", () => {
    expect(
      fingerprints({ ...base, diversity: "split", candidates: spread }),
    ).toEqual(["memory:m.md#1", "memory:m.md#2", "transcript:t1"]);
  });

  test("limit zero and an empty candidate list both yield nothing", () => {
    expect(
      selectRecallEntries({ ...base, limit: 0, candidates: spread }).entries,
    ).toEqual([]);
    expect(selectRecallEntries({ ...base, candidates: [] }).entries).toEqual(
      [],
    );
  });
});

describe("budget", () => {
  test("truncates one entry to the per-entry budget", () => {
    const selection = selectRecallEntries({
      ...base,
      excerptCharacters: 10,
      candidates: [
        candidate({
          source: "memory",
          file: "a",
          score: 1,
          text: "0123456789abcdef",
        }),
      ],
    });
    expect(selection.entries[0]?.text).toBe("0123456...");
  });

  test("drops from the lowest score until the total fits", () => {
    const selection = selectRecallEntries({
      ...base,
      excerptCharacters: 10,
      totalCharacters: 25,
      candidates: [
        candidate({
          source: "memory",
          file: "a",
          score: 3,
          text: "aaaaaaaaaa",
        }),
        candidate({
          source: "memory",
          file: "b",
          score: 2,
          text: "bbbbbbbbbb",
        }),
        candidate({
          source: "memory",
          file: "c",
          score: 1,
          text: "cccccccccc",
        }),
      ],
    });
    // 30 characters over a 25 budget: the lowest score goes, not the first found.
    expect(selection.entries.map((entry) => entry.file)).toEqual(["a", "b"]);
  });

  test("keeps the single best entry even when it alone exceeds the total", () => {
    const selection = selectRecallEntries({
      ...base,
      excerptCharacters: 40,
      totalCharacters: 10,
      candidates: [
        candidate({
          source: "memory",
          file: "a",
          score: 2,
          // Longer than the whole budget: dropping to zero entries would be worse
          // than sending one over-long excerpt, so the loop stops at one.
          text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
        candidate({
          source: "memory",
          file: "b",
          score: 1,
          text: "bbbbbbbbbb",
        }),
      ],
    });
    expect(selection.entries.map((entry) => entry.file)).toEqual(["a"]);
  });

  test("a budget of zero injects nothing rather than empty entries", () => {
    // `0` is a supported setting meaning "no excerpt text". An entry whose text was
    // cut to nothing must not survive: it would claim a passage in the summary line
    // and suppress its fingerprint for the whole dedup window without ever showing
    // a reader anything.
    const selection = selectRecallEntries({
      ...base,
      excerptCharacters: 0,
      totalCharacters: 0,
      candidates: [
        candidate({ source: "transcript", file: "a", score: 9 }),
        candidate({ source: "memory", file: "b", score: 8 }),
      ],
    });
    expect(selection.entries).toEqual([]);
  });
});

describe("determinism", () => {
  test("ties break by source, file, then line", () => {
    const selection = selectRecallEntries({
      ...base,
      candidates: [
        candidate({ source: "transcript", file: "t2", score: 5 }),
        candidate({ source: "memory", file: "m9", score: 5 }),
        candidate({ source: "memory", file: "m1", score: 5 }),
      ],
    });
    expect(selection.entries.map((entry) => entry.file)).toEqual([
      "m1",
      "m9",
      "t2",
    ]);
  });
});
