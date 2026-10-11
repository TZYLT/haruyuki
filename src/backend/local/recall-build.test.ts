import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRecallCorpus } from "@/backend/local/recall-build";
import { recallIndexPath } from "@/backend/local/recall-index";
import {
  RECALL_FIXTURE_HISTORY_TEXT,
  withRecallFixture,
} from "@/test-utils/recall-fixture";

/**
 * `build` against a real store.
 *
 * The command exists because the lazy path deliberately does not create a missing
 * index (《26》§6.10), so the two claims worth testing are that it *does* create
 * them, and that it treats the conversations it cannot use as skips rather than
 * failures — a receipt full of errors for directories that were never transcripts
 * would train the user to ignore it.
 */

describe("buildRecallCorpus", () => {
  test("indexes every conversation that has a transcript", async () => {
    await withRecallFixture(async (fixture) => {
      const result = await buildRecallCorpus(fixture.storageDir);

      expect(result.conversations).toBeGreaterThanOrEqual(2);
      expect(result.indexed).toBe(result.conversations);
      expect(result.failures).toEqual([]);
      expect(result.records).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });

  test("rebuilds an index the lazy path would refuse to create", async () => {
    await withRecallFixture(async (fixture) => {
      // This is the state a fresh install is in: real conversations, no sidecars.
      const historyDir = join(
        fixture.storageDir,
        "conversations",
        fixture.historyDirectory,
      );
      rmSync(recallIndexPath(historyDir), { force: true });

      const result = await buildRecallCorpus(fixture.storageDir);
      expect(result.indexed).toBe(result.conversations);
      expect(result.failures).toEqual([]);

      // And the rebuilt sidecar really carries the passage.
      const { readFileSync } = await import("node:fs");
      const sidecar = JSON.parse(
        readFileSync(recallIndexPath(historyDir), "utf8"),
      ) as { records: Array<{ nt: string }> };
      expect(
        sidecar.records.some((record) =>
          record.nt.includes(RECALL_FIXTURE_HISTORY_TEXT),
        ),
      ).toBe(true);
    });
  });

  test("a directory that is not a conversation is skipped, not failed", async () => {
    await withRecallFixture(async (fixture) => {
      // A stray directory under `conversations/` has no conversation record and no
      // transcript. Counting it as a failure would make every receipt look broken.
      mkdirSync(
        join(fixture.storageDir, "conversations", "not-a-conversation"),
        {
          recursive: true,
        },
      );

      const result = await buildRecallCorpus(fixture.storageDir);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.failures).toEqual([]);
      expect(result.indexed).toBe(result.conversations);
    });
  });

  test("reports progress once per directory walked, skips included", async () => {
    await withRecallFixture(async (fixture) => {
      // A directory the build skips, so the counter has to reach its total without
      // an index being written for it: a progress line that stops short of the total
      // reads as a hang, and the caller has no other way to know it finished.
      mkdirSync(
        join(fixture.storageDir, "conversations", "not-a-conversation"),
        { recursive: true },
      );

      const seen: Array<{ done: number; total: number }> = [];
      const result = await buildRecallCorpus(fixture.storageDir, {
        onProgress: (progress) =>
          seen.push({ done: progress.done, total: progress.total }),
      });

      const total = seen[0]?.total ?? 0;
      expect(total).toBeGreaterThan(result.conversations);
      expect(seen.map((entry) => entry.done)).toEqual(
        Array.from({ length: total }, (_, index) => index + 1),
      );
      expect(seen.every((entry) => entry.total === total)).toBe(true);
    });
  });

  test("a damaged conversation.json is reported, not skipped", async () => {
    await withRecallFixture(async (fixture) => {
      const historyDir = join(
        fixture.storageDir,
        "conversations",
        fixture.historyDirectory,
      );
      writeFileSync(join(historyDir, "conversation.json"), "{ not json");

      const result = await buildRecallCorpus(fixture.storageDir);

      // The run completes and names the record it could not use: `skipped` would
      // tell the user there is no transcript there, when what they have is a record
      // that needs repairing.
      expect(result.failures.map((failure) => failure.conversationKey)).toEqual(
        [fixture.historyDirectory],
      );
      expect(result.failures[0]?.reason).toContain("conversation.json");
    });
  });

  test("yields the event loop so an interactive caller can repaint", async () => {
    await withRecallFixture(async (fixture) => {
      // The loop is synchronous work, so the only proof that it lets go is that a
      // timer scheduled before it gets to run *between* two conversations rather
      // than after the whole build.
      const order: string[] = [];
      setTimeout(() => order.push("timer"), 0);

      await buildRecallCorpus(fixture.storageDir, {
        yieldEvery: 1,
        onProgress: () => order.push("progress"),
      });

      expect(order[0]).toBe("progress");
      expect(order[1]).toBe("timer");
      expect(order.filter((entry) => entry === "timer")).toHaveLength(1);
    });
  });

  test("no yields when the caller has nothing to repaint", async () => {
    await withRecallFixture(async (fixture) => {
      const order: string[] = [];
      setTimeout(() => order.push("timer"), 0);

      const result = await buildRecallCorpus(fixture.storageDir, {
        yieldEvery: 0,
      });
      // Every conversation was indexed before the timer could run.
      expect(order).toEqual([]);
      expect(result.indexed).toBe(result.conversations);
    });
  });

  test("reports elapsed time from the injected clock", async () => {
    await withRecallFixture(async (fixture) => {
      let now = 1_000;
      const result = await buildRecallCorpus(fixture.storageDir, {
        now: () => {
          now += 25;
          return now;
        },
      });
      expect(result.elapsedMs).toBe(25);
    });
  });
});
