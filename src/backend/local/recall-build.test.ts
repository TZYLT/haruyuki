import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
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

  test("reports progress once per indexed conversation", async () => {
    await withRecallFixture(async (fixture) => {
      const seen: number[] = [];
      const result = await buildRecallCorpus(fixture.storageDir, {
        onProgress: (progress) => seen.push(progress.done),
      });
      expect(seen).toEqual(
        Array.from({ length: result.conversations }, (_, index) => index + 1),
      );
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
