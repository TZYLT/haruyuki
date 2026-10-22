import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearMessageHistory,
  getMessageHistorySnapshot,
  loadMessageHistory,
  MESSAGE_HISTORY_DAYS,
  MESSAGE_HISTORY_DISK_ENTRIES,
  MESSAGE_HISTORY_RING,
  type MessageHistoryEntry,
  markMessageHistoryRead,
  messageHistoryPath,
  pruneMessageHistory,
  readMessageHistory,
  recordMessageHistory,
  resetMessageHistoryForTests,
  subscribeToMessageHistory,
} from "@/cli/notifications/history-store";

/**
 * The history's four guarantees (`docs/38` §15.2): it survives a restart, it is a
 * ring of {@link MESSAGE_HISTORY_RING} in memory, it is pruned lazily on read to
 * 500 entries or 30 days, and it counts what the face has not shown yet.
 *
 * The disk half runs against a temporary `HARUYUKI_HOME`, which is the only
 * supported way to move user-level harness state (`src/utils/app-paths.ts`).
 * Timestamps are relative to the run because a load prunes anything older than
 * the retention window — an absolute date in a fixture becomes a dropped row a
 * month later.
 */

const tempRoots: string[] = [];
const originalHome = process.env.HARUYUKI_HOME;
const BASE = Date.now() - 60 * 60 * 1_000;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "haruyuki-history-"));
  tempRoots.push(root);
  return root;
}

function settle(): Promise<void> {
  // The append is fire-and-forget; one event-loop turn is enough for it.
  return new Promise((resolve) => setTimeout(resolve, 40));
}

beforeEach(async () => {
  process.env.HARUYUKI_HOME = await makeTempRoot();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHome;
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  resetMessageHistoryForTests();
});

function entry(at: number, text = "Turn finished"): MessageHistoryEntry {
  return { at, kind: "turn", text };
}

describe("the message history", () => {
  test("records what the band announced and counts it as unread", () => {
    const seen: number[] = [];
    subscribeToMessageHistory(() =>
      seen.push(getMessageHistorySnapshot().unread),
    );

    recordMessageHistory("turn", "Turn finished", { at: BASE });

    expect(getMessageHistorySnapshot().entries).toEqual([
      { at: BASE, kind: "turn", text: "Turn finished" },
    ]);
    expect(getMessageHistorySnapshot().unread).toBe(1);
    expect(seen).toEqual([1]);
  });

  test("lists the newest first, because that is the row the face opens on", () => {
    recordMessageHistory("turn", "first", { at: BASE });
    recordMessageHistory("error", "second", { at: BASE + 1_000 });

    expect(
      getMessageHistorySnapshot().entries.map((item) => item.text),
    ).toEqual(["second", "first"]);
  });

  test("a blank text is not history", () => {
    recordMessageHistory("turn", "   ");

    expect(getMessageHistorySnapshot().entries).toEqual([]);
  });

  test("the ring keeps the newest entries and no more", () => {
    for (let index = 0; index < MESSAGE_HISTORY_RING + 5; index += 1) {
      recordMessageHistory("turn", `entry ${index}`, { at: BASE + index });
    }

    const { entries } = getMessageHistorySnapshot();
    expect(entries).toHaveLength(MESSAGE_HISTORY_RING);
    expect(entries[0]?.text).toBe(`entry ${MESSAGE_HISTORY_RING + 4}`);
  });

  test("opening the face clears the unread count, not the rows", () => {
    recordMessageHistory("turn", "first", { at: BASE });
    recordMessageHistory("turn", "second", { at: BASE + 1_000 });

    markMessageHistoryRead();

    expect(getMessageHistorySnapshot().unread).toBe(0);
    expect(getMessageHistorySnapshot().entries).toHaveLength(2);
  });

  test("writes a line that a later load reads back", async () => {
    recordMessageHistory("turn", "Turn finished", { at: BASE });
    await settle();
    resetMessageHistoryForTests();

    await loadMessageHistory();

    expect(getMessageHistorySnapshot().entries).toEqual([
      { at: BASE, kind: "turn", text: "Turn finished" },
    ]);
    // Loaded rows are old news: they do not reopen the unread count.
    expect(getMessageHistorySnapshot().unread).toBe(0);
  });

  test("loading twice does not duplicate the same lines", async () => {
    recordMessageHistory("turn", "Turn finished", { at: BASE });
    await settle();

    await loadMessageHistory();
    await loadMessageHistory();

    expect(getMessageHistorySnapshot().entries).toHaveLength(1);
  });

  test("clearing takes the rows, the count and the file", async () => {
    recordMessageHistory("turn", "Turn finished", { at: BASE });
    await settle();

    clearMessageHistory();
    await settle();

    expect(getMessageHistorySnapshot()).toEqual({ entries: [], unread: 0 });
    expect(await readFile(messageHistoryPath(), "utf8")).toBe("");
  });

  test("the file lives under the harness root the app resolves", () => {
    expect(messageHistoryPath()).toBe(
      join(
        process.env.HARUYUKI_HOME ?? "",
        "notifications",
        "message-history.jsonl",
      ),
    );
  });

  test("a malformed line costs one row, not the file", async () => {
    const path = messageHistoryPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(entry(BASE))}\nnot json\n{"at":"x"}\n`,
      "utf8",
    );

    const read = await readMessageHistory({ prune: false });

    expect(read).toEqual([entry(BASE)]);
  });

  test("prunes by age and by count, keeping the newest", () => {
    const now = new Date(BASE + 60 * 60 * 1_000);
    const day = 24 * 60 * 60 * 1_000;
    const old = entry(now.getTime() - (MESSAGE_HISTORY_DAYS + 1) * day, "old");
    const fresh = Array.from(
      { length: MESSAGE_HISTORY_DISK_ENTRIES + 5 },
      (_value, index) => entry(now.getTime() - day + index, `fresh ${index}`),
    );

    const { kept, dropped } = pruneMessageHistory([old, ...fresh], now);

    expect(kept).toHaveLength(MESSAGE_HISTORY_DISK_ENTRIES);
    expect(kept[kept.length - 1]?.text).toBe("fresh 504");
    expect(kept[0]?.text).toBe("fresh 5");
    expect(dropped).toBe(6);
  });

  test("a read that pruned rewrites the file", async () => {
    const path = messageHistoryPath();
    const now = new Date(BASE + 60 * 60 * 1_000);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(entry(now.getTime() - 40 * 24 * 60 * 60 * 1_000, "stale"))}\n${JSON.stringify(entry(BASE, "fresh"))}\n`,
      "utf8",
    );

    const read = await readMessageHistory({ now });

    expect(read.map((item) => item.text)).toEqual(["fresh"]);
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain("stale");
  });
});
