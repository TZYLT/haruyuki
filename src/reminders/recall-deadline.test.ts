import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchMemoryFiles } from "@/backend/local/memory-search";
import { loadRecallCorpus } from "@/backend/local/recall-index";
import {
  parseQuery,
  type RankableSearchRecord,
  rankMatches,
} from "@/backend/local/transcript-search";
import { withRecallFixture } from "@/test-utils/recall-fixture";
import { createRecallDeadline } from "./recall-deadline";

/**
 * The budget itself, and the three walks that honour it.
 *
 * The deadline is the easy half; the half worth a test is that each loop
 * actually asks. A checkpoint that was forgotten is invisible in normal use — the
 * turn simply takes longer than the budget says it may — so every walk gets a
 * signal that is already spent and is expected to come back empty.
 */

describe("the recall deadline", () => {
  test("a zero budget never expires", () => {
    let now = 0;
    const deadline = createRecallDeadline(0, () => now);
    now = 10 ** 12;
    expect(deadline.timeoutMs).toBe(0);
    expect(deadline.expired()).toBe(false);
  });

  test("an unusable budget means unlimited, not instant", () => {
    // A corrupt setting must not become "recall can never finish a turn".
    expect(createRecallDeadline(-5, () => 0).timeoutMs).toBe(0);
    expect(createRecallDeadline(Number.NaN, () => 0).timeoutMs).toBe(0);
    expect(
      createRecallDeadline(Number.POSITIVE_INFINITY, () => 0).expired(),
    ).toBe(false);
  });

  test("expires once the clock passes the budget", () => {
    let now = 1_000;
    const deadline = createRecallDeadline(1_000, () => now);
    expect(deadline.expired()).toBe(false);
    now = 1_999;
    expect(deadline.expired()).toBe(false);
    now = 2_000;
    expect(deadline.expired()).toBe(true);
  });

  test("reports the budget it was built from", () => {
    expect(createRecallDeadline(1_500, () => 0).timeoutMs).toBe(1_500);
    expect(createRecallDeadline(1_500.7, () => 0).timeoutMs).toBe(1_500);
  });
});

function record(text: string): RankableSearchRecord {
  const tokens = text.split(" ");
  return { normalizedText: tokens.join(" "), tokens, isSearchEcho: false };
}

describe("the cooperative checkpoints", () => {
  test("ranking stops between records and keeps what it already scored", () => {
    const records = [
      record("alpha"),
      record("alpha"),
      record("alpha"),
      record("alpha"),
    ];
    const query = parseQuery("alpha");

    // No signal: every record is scored.
    expect(rankMatches(records, query)).toHaveLength(4);

    // A spent signal: nothing is scored, and the caller gets an empty ranking
    // rather than an exception.
    expect(rankMatches(records, query, { shouldStop: () => true })).toEqual([]);

    // A signal that trips part-way through leaves a shorter ranking, not a
    // corrupt one: the scores that do come back are the real scores, in order.
    const scoredWithin = (checks: number) => {
      let calls = 0;
      return rankMatches(records, query, {
        shouldStop: () => ++calls > checks,
      });
    };
    const lengths = [0, 1, 2, 3, 4, 5, 6, 7].map(
      (checks) => scoredWithin(checks).length,
    );
    // More budget never scores fewer records, and the ramp really does stop
    // part-way rather than jumping from nothing to everything.
    expect(lengths).toEqual([...lengths].sort((left, right) => left - right));
    expect(lengths[0]).toBe(0);
    expect(lengths.at(-1)).toBe(4);
    expect(new Set(lengths).size).toBeGreaterThan(1);

    let calls = 0;
    const partial = rankMatches(records, query, {
      shouldStop: () => ++calls > 3,
    });
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(4);
    expect(partial[0]?.score).toBeGreaterThan(0);
    expect(partial[0]?.score).toBe(partial[1]?.score as number);
  });

  test("the memory scan stops between files", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "haru-recall-deadline-"));
    try {
      for (const name of ["a", "b", "c"]) {
        await writeFile(
          join(memoryDir, `${name}.md`),
          "# notes\n\nthe ledger is reconciled daily\n",
        );
      }
      const query = { terms: ["ledger"], phrases: [] };

      const complete = searchMemoryFiles(memoryDir, query);
      expect(complete.entries.length).toBeGreaterThan(0);

      // The scan reads each file with `readFileSync`; a spent signal must stop it
      // before the first read, so not even the corpus statistics are produced.
      const stopped = searchMemoryFiles(memoryDir, query, {
        shouldStop: () => true,
      });
      expect(stopped.entries).toEqual([]);
      expect(stopped.stats.files).toBe(0);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  test("the corpus load stops between conversations", async () => {
    // The fixture's store is a real one — a conversation record, a transcript, and
    // a sidecar — so this is the same walk a turn performs.
    await withRecallFixture(async (fixture) => {
      const complete = loadRecallCorpus(fixture.storageDir, {
        agentId: fixture.agentId,
      });
      expect(complete.records.length).toBeGreaterThan(0);
      expect(complete.conversations).toBeGreaterThan(1);

      // A spent signal stops the loop before the first conversation, so nothing is
      // read and nothing is reported as a problem: a budget is not a fault.
      const stopped = loadRecallCorpus(fixture.storageDir, {
        agentId: fixture.agentId,
        shouldStop: () => true,
      });
      expect(stopped.records).toEqual([]);
      expect(stopped.conversations).toBe(0);
      expect(stopped.unavailable).toEqual([]);
    });
  }, 60_000);
});
