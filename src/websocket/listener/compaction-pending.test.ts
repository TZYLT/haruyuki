/**
 * The listener's prepared-compaction store (M5-A stage 2, F-04).
 *
 * The wire contract keeps a preview alive between `prepare` and
 * `commit`/`cancel`; the store is what makes that safe. This file pins the three
 * properties the protocol depends on and that a map alone would get wrong:
 *
 * - one pending preview per conversation, and a second prepare makes the old id
 *   unreachable immediately;
 * - consume-once — a committed/cancelled/expired id never comes back;
 * - exactly one usage row per summarizer call: every way an entry can go away
 *   (`commit`, `cancel`, supersede, TTL) settles the spend once, as the ones
 *   nobody can commit any more are `cancelled`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionPreview } from "@/backend/local/compaction-preview";
import { readUsageLedger, type UsageOutcome } from "@/usage/ledger";
import {
  __testCompactionPendingCount,
  __testResetCompactionPending,
  __testSetCompactionPendingTtl,
  cancelCompactionPending,
  discardCompactionPending,
  peekCompactionPending,
  recordListenerCompactionSpend,
  storeCompactionPending,
  takeCompactionPending,
} from "@/websocket/listener/compaction-pending";

const temporaryDirectories: string[] = [];
const originalHaruyukiHome = process.env.HARUYUKI_HOME;

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "listener-compact-pending-"));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(async () => {
  // 《31》red line A: the ledger must never reach the real `~/.haruyuki`.
  process.env.HARUYUKI_HOME = await createStorageDirectory();
});

afterEach(async () => {
  __testResetCompactionPending();
  if (originalHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHaruyukiHome;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function preview(agentId = "agent-1"): CompactionPreview {
  return {
    conversationId: "conv-1",
    agentId,
    model: "openai/gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: [],
    overview: {
      restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
      narrative: "They talked.",
    },
    blocks: [],
    numberedBlocks: 0,
    suggestionIndex: 1,
    usage: {
      promptTokens: 900,
      cachedInputTokens: 400,
      completionTokens: 120,
      wallMs: 2000,
    },
    degraded: null,
  };
}

async function store(
  conversationId = "conv-1",
  agentId: string | null = "agent-1",
): Promise<string> {
  const entry = await storeCompactionPending({
    conversationId,
    preview: preview(),
    agentId,
  });
  return entry.prepareId;
}

async function outcomesOf(): Promise<Array<UsageOutcome | undefined>> {
  const rows = await readUsageLedger({ prune: false });
  return rows.map((row) => row.outcome);
}

describe("compaction pending store", () => {
  test("peek reads without consuming, and take consumes exactly once", async () => {
    const prepareId = await store();

    expect(peekCompactionPending("conv-1", prepareId)?.prepareId).toBe(
      prepareId,
    );
    const taken = await takeCompactionPending("conv-1", prepareId);
    expect(taken.kind).toBe("taken");
    expect(taken.kind === "taken" ? taken.entry.preview.model : null).toBe(
      "openai/gpt-5.5",
    );
    // Nothing was settled: the caller still owns the outcome (commit writes it).
    expect(await outcomesOf()).toHaveLength(0);
    expect(peekCompactionPending("conv-1", prepareId)).toBeNull();

    expect((await takeCompactionPending("conv-1", prepareId)).kind).toBe(
      "pending_expired",
    );
    expect(await outcomesOf()).toHaveLength(0);
    expect(__testCompactionPendingCount()).toBe(0);
  });

  test("a second prepare supersedes the old id and settles its spend", async () => {
    const first = await store();
    const second = await store();

    expect(second).not.toBe(first);
    expect((await takeCompactionPending("conv-1", first)).kind).toBe(
      "pending_expired",
    );
    const rows = await readUsageLedger({ prune: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("cancelled");
    expect(rows[0]?.source).toBe("compaction");
    expect(rows[0]?.sessionId).toBe("conv-1");
    expect(rows[0]?.prompt).toBe(900);
    expect(rows[0]?.cachedInput).toBe(400);

    // The replacement is still committable.
    expect((await takeCompactionPending("conv-1", second)).kind).toBe("taken");
  });

  test("discard settles the pending spend as cancelled", async () => {
    const prepareId = await store();

    expect(await discardCompactionPending("conv-1")).toBe(true);
    expect(await discardCompactionPending("conv-1")).toBe(false);
    expect((await takeCompactionPending("conv-1", prepareId)).kind).toBe(
      "pending_expired",
    );
    expect(await outcomesOf()).toEqual(["cancelled"]);
  });

  test("cancel settles the spend, and a second cancel is a no-op", async () => {
    const prepareId = await store();

    expect(await cancelCompactionPending("conv-1", prepareId)).toBe(true);
    expect(await cancelCompactionPending("conv-1", prepareId)).toBe(false);
    expect(await outcomesOf()).toEqual(["cancelled"]);
  });

  test("cancel of an unknown id writes nothing", async () => {
    expect(await cancelCompactionPending("conv-1", "not-a-preview")).toBe(
      false,
    );
    expect(await outcomesOf()).toHaveLength(0);
  });

  test("a commit path that finds an expired entry settles it as cancelled", async () => {
    __testSetCompactionPendingTtl(0);
    const prepareId = await store();

    // With the TTL disarmed (0) there is no timer; the store's own age check is
    // what must expire the entry — the classic "timer never ran" path.
    expect((await takeCompactionPending("conv-1", prepareId)).kind).toBe(
      "pending_expired",
    );
    expect(await outcomesOf()).toEqual(["cancelled"]);
    expect(__testCompactionPendingCount()).toBe(0);
  });

  test("the TTL timer settles an abandoned preview without any further call", async () => {
    __testSetCompactionPendingTtl(5);
    await store();

    const deadline = Date.now() + 2000;
    let rows = await readUsageLedger({ prune: false });
    while (rows.length === 0 && Date.now() < deadline) {
      await Bun.sleep(10);
      rows = await readUsageLedger({ prune: false });
    }
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("cancelled");
    expect(__testCompactionPendingCount()).toBe(0);
  });

  test("an entry with no nameable agent writes no row (§5.9.1)", async () => {
    const prepareId = (
      await storeCompactionPending({
        conversationId: "conv-1",
        preview: preview(""),
        agentId: null,
      })
    ).prepareId;

    const entry = await takenEntry(prepareId);
    expect(entry.agentId).toBeNull();
    await recordListenerCompactionSpend(entry, "cancelled");
    expect(await outcomesOf()).toHaveLength(0);
  });
});

async function takenEntry(prepareId: string) {
  const taken = await takeCompactionPending("conv-1", prepareId);
  if (taken.kind !== "taken") throw new Error("entry was not pending");
  return taken.entry;
}
