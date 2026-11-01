/**
 * Dream notes storage (F-06 §2.2–§2.7).
 *
 * Every case pins one of the queue's promises: a note is one JSON line under the
 * harness home, the limits refuse instead of truncating, a corrupt line never
 * takes the rest of the queue down, and consumption deletes only what the run
 * actually applied. `HARUYUKI_HOME` is redirected to a fresh temp directory per
 * case so nothing here can touch the operator's real harness home.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendNote,
  claimNotes,
  clearNotes,
  consumeNotes,
  createDreamNoteId,
  DREAM_NOTE_MAX_QUEUE,
  DREAM_NOTE_MAX_TEXT_CHARS,
  getDreamNotesPath,
  listNotes,
  removeNote,
  renderNotesSection,
} from "@/agent/dream/dream-notes";

const AGENT_ID = "agent-dream-notes";
const NOW = Date.parse("2026-10-31T13:20:00.000Z");

let homeDir: string;
let previousHaruyukiHome: string | undefined;

beforeEach(async () => {
  previousHaruyukiHome = process.env.HARUYUKI_HOME;
  homeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-notes-"));
  process.env.HARUYUKI_HOME = homeDir;
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(homeDir, { recursive: true, force: true });
});

async function readQueueFile(path: string): Promise<string[]> {
  const body = await readFile(path, "utf8");
  return body.split("\n").filter((line) => line.trim().length > 0);
}

describe("the queue file", () => {
  test("lives under the harness home, not the memory repo or the project", () => {
    const path = getDreamNotesPath(AGENT_ID);
    expect(path).toBe(join(homeDir, "dream", "notes", `${AGENT_ID}.jsonl`));
    expect(path).not.toContain(".haruyuki");
  });

  test("sanitizes an agent id that would otherwise introduce a path segment", async () => {
    const path = getDreamNotesPath("../evil/agent:1");
    expect(dirname(path)).toBe(join(homeDir, "dream", "notes"));
    expect(path.endsWith(".._evil_agent_1.jsonl")).toBe(true);

    const appended = await appendNote("../evil/agent:1", {
      text: "one",
      author: "user",
    });
    expect(appended.ok).toBe(true);
    expect(await listNotes("../evil/agent:1")).toHaveLength(1);
  });

  test("writes one single-line JSON object per note", async () => {
    const appended = await appendNote(AGENT_ID, {
      text: "  tidy the projects folder  ",
      author: "user",
      now: NOW,
      id: "note-0a1b2c3d",
      source: { conversationId: "conv-1" },
    });
    expect(appended).toEqual({
      ok: true,
      note: {
        version: 1,
        id: "note-0a1b2c3d",
        createdAt: NOW,
        author: "user",
        text: "tidy the projects folder",
        source: { conversationId: "conv-1" },
      },
    });

    const lines = await readQueueFile(getDreamNotesPath(AGENT_ID));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      version: 1,
      id: "note-0a1b2c3d",
      text: "tidy the projects folder",
    });
    // `source` is always present; a note without a conversation still has one.
    expect(JSON.parse(lines[0] ?? "").source).toEqual({
      conversationId: "conv-1",
    });
  });

  test("reads in file order, oldest first", async () => {
    for (const text of ["first", "second", "third"]) {
      const appended = await appendNote(AGENT_ID, {
        text,
        author: "agent",
        now: NOW,
      });
      expect(appended.ok).toBe(true);
    }
    expect((await listNotes(AGENT_ID)).map((note) => note.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("a missing file is an empty queue", async () => {
    expect(await listNotes("nobody")).toEqual([]);
  });

  test("skips corrupt lines instead of failing the queue", async () => {
    const path = getDreamNotesPath(AGENT_ID);
    await mkdir(dirname(path), { recursive: true });
    const good = JSON.stringify({
      version: 1,
      id: "note-11111111",
      createdAt: NOW,
      author: "user",
      text: "still readable",
      source: {},
    });
    await writeFile(
      path,
      `${good}\nnot json\n{"version":1,"id":"note-22222222"}\n\n${good}\n`,
      "utf8",
    );
    const notes = await listNotes(AGENT_ID);
    expect(notes.map((note) => note.id)).toEqual([
      "note-11111111",
      "note-11111111",
    ]);
  });

  test("sequential concurrent appends do not lose a line", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendNote(AGENT_ID, {
          text: `note ${index}`,
          author: "user",
          now: NOW,
        }),
      ),
    );
    const notes = await listNotes(AGENT_ID);
    expect(notes).toHaveLength(20);
    expect(await readQueueFile(getDreamNotesPath(AGENT_ID))).toHaveLength(20);
  });
});

describe("the limits refuse instead of truncating", () => {
  test("text is measured after trimming and must be 1–2000 characters", async () => {
    expect(
      await appendNote(AGENT_ID, { text: "   ", author: "user" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("empty") });

    const atLimit = await appendNote(AGENT_ID, {
      text: "x".repeat(DREAM_NOTE_MAX_TEXT_CHARS),
      author: "user",
    });
    expect(atLimit.ok).toBe(true);

    const overLimit = await appendNote(AGENT_ID, {
      text: "x".repeat(DREAM_NOTE_MAX_TEXT_CHARS + 1),
      author: "user",
    });
    expect(overLimit.ok).toBe(false);
    expect(overLimit).toMatchObject({
      error: expect.stringContaining(String(DREAM_NOTE_MAX_TEXT_CHARS)),
    });
    // Nothing was added by the refused append.
    expect(await listNotes(AGENT_ID)).toHaveLength(1);
  });

  test("a full queue refuses the append and keeps every existing note", async () => {
    for (let index = 0; index < DREAM_NOTE_MAX_QUEUE; index += 1) {
      const appended = await appendNote(AGENT_ID, {
        text: `note ${index}`,
        author: "user",
        now: NOW,
      });
      expect(appended.ok).toBe(true);
    }
    const refused = await appendNote(AGENT_ID, {
      text: "one too many",
      author: "user",
      now: NOW,
    });
    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({
      error: expect.stringContaining("full"),
    });
    expect(await listNotes(AGENT_ID)).toHaveLength(DREAM_NOTE_MAX_QUEUE);
  });

  test("the id generator uses the note-<8hex> shape", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(createDreamNoteId()).toMatch(/^note-[0-9a-f]{8}$/);
    }
  });
});

describe("removing notes", () => {
  test("removeNote deletes one note and reports whether it existed", async () => {
    const appended = await appendNote(AGENT_ID, {
      text: "keep",
      author: "user",
      now: NOW,
      id: "note-aaaaaaaa",
    });
    expect(appended.ok).toBe(true);
    await appendNote(AGENT_ID, {
      text: "drop",
      author: "agent",
      now: NOW,
      id: "note-bbbbbbbb",
    });

    expect(await removeNote(AGENT_ID, "note-bbbbbbbb")).toBe(true);
    expect((await listNotes(AGENT_ID)).map((note) => note.id)).toEqual([
      "note-aaaaaaaa",
    ]);
    expect(await removeNote(AGENT_ID, "note-bbbbbbbb")).toBe(false);
  });

  test("clearNotes empties the queue and reports the count", async () => {
    for (const text of ["a", "b", "c"]) {
      await appendNote(AGENT_ID, { text, author: "user", now: NOW });
    }
    expect(await clearNotes(AGENT_ID)).toBe(3);
    expect(await listNotes(AGENT_ID)).toEqual([]);
    expect(await clearNotes(AGENT_ID)).toBe(0);
    expect(await clearNotes("never-existed")).toBe(0);
  });
});

describe("claiming and consuming", () => {
  test("claimNotes marks the notes without removing them", async () => {
    await appendNote(AGENT_ID, {
      text: "look at projects",
      author: "user",
      now: NOW,
      id: "note-cccccccc",
    });
    const claimed = await claimNotes(AGENT_ID, "run-1", NOW + 1_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.claimedByRunId).toBe("run-1");
    expect(claimed[0]?.claimedAt).toBe(NOW + 1_000);

    // The marker is persisted, and the note is still queued.
    const reread = await listNotes(AGENT_ID);
    expect(reread).toHaveLength(1);
    expect(reread[0]?.claimedByRunId).toBe("run-1");
  });

  test("consumeNotes deletes only applied notes and stamps the rest", async () => {
    for (const [id, text] of [
      ["note-00000001", "applied note"],
      ["note-00000002", "not applicable note"],
      ["note-00000003", "needs authorization note"],
      ["note-00000004", "unanswered note"],
    ] as const) {
      await appendNote(AGENT_ID, { text, author: "user", now: NOW, id });
    }

    const result = await consumeNotes(AGENT_ID, "run-2", {
      "note-00000001": "applied",
      "note-00000002": "not-applicable",
      "note-00000003": "needs-authorization",
    });
    expect(result).toEqual({
      consumed: ["note-00000001"],
      kept: ["note-00000002", "note-00000003"],
    });

    const remaining = await listNotes(AGENT_ID);
    expect(remaining.map((note) => note.id)).toEqual([
      "note-00000002",
      "note-00000003",
      "note-00000004",
    ]);
    const kept = remaining[0];
    expect(kept?.lastAttemptRunId).toBe("run-2");
    expect(kept?.lastOutcome).toBe("not-applicable");
    expect(kept?.claimedByRunId).toBeUndefined();
    // A note the report did not answer is untouched, not deleted.
    expect(remaining[2]?.lastAttemptRunId).toBeUndefined();
  });

  test("consumeNotes accepts a Map of outcomes", async () => {
    await appendNote(AGENT_ID, {
      text: "map answered",
      author: "agent",
      now: NOW,
      id: "note-00000005",
    });
    const result = await consumeNotes(
      AGENT_ID,
      "run-3",
      new Map([["note-00000005", "applied" as const]]),
    );
    expect(result.consumed).toEqual(["note-00000005"]);
    expect(await listNotes(AGENT_ID)).toEqual([]);
  });

  test("an empty queue consumes nothing", async () => {
    expect(await consumeNotes(AGENT_ID, "run-4", {})).toEqual({
      consumed: [],
      kept: [],
    });
  });
});

describe("renderNotesSection", () => {
  test("renders an empty queue as no section at all", () => {
    expect(renderNotesSection([])).toBe("");
  });

  test("renders the English block with the three response words", async () => {
    await appendNote(AGENT_ID, {
      text: "tidy\n\nthe projects folder",
      author: "user",
      now: NOW,
      id: "note-1234abcd",
    });
    await appendNote(AGENT_ID, {
      text: "check the archive",
      author: "dream",
      now: NOW,
      id: "note-5678abcd",
    });
    const notes = await listNotes(AGENT_ID);
    const section = renderNotesSection(notes);

    expect(section.startsWith("## Pending notes")).toBe(true);
    expect(section).toContain(
      "- note-1234abcd (user, 10-31 13:20): tidy the projects folder",
    );
    expect(section).toContain(
      "- note-5678abcd (dream, 10-31 13:20): check the archive",
    );
    expect(section).toContain("`applied`");
    expect(section).toContain("`not-applicable`");
    expect(section).toContain("`needs-authorization`");
    // Multi-line note text stays on one bullet line.
    expect(section).not.toContain("tidy\n\nthe");
  });
});
