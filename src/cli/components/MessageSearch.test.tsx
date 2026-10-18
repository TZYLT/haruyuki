import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
} from "@/backend/local/local-transcript";
import { MessageSearch } from "@/cli/components/MessageSearch";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * `/search` on the toolkit, judged on the frame.
 *
 * Two things can only be seen here: that the results list windows the way this
 * face's own arithmetic did (the cursor in the middle, no toolkit indicator rows),
 * and that the query field is a real editor now — the four keys this face used to
 * splice into a string by hand (`backspace`, `delete`, and any printable
 * character) belong to the editor, which is what makes a paste into the field
 * land at the caret instead of nowhere.
 *
 * The local search reads durable transcripts, so the fixture is a storage
 * directory with two hand-written conversations; the same shape
 * `src/backend/message-search.test.ts` uses.
 */

const AGENT_ID = "agent-search";
const NOW = "2026-03-01T12:00:00.000Z";

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESCAPE = "\u001B";
const TAB = "\t";
const SHIFT_TAB = "\u001B[Z";
const BACKSPACE = "\u007F";

class TranscriptBackend extends FakeHeadlessBackend {
  constructor(private readonly storageDir: string) {
    super();
  }

  // Not `override`: the base class does not implement this optional `Backend`
  // seam, and adding it is how a test says where the transcripts live.
  getLocalStorageDir(): string {
    return this.storageDir;
  }
}

async function writeTranscript(input: {
  storageDir: string;
  directory: string;
  conversationId: string;
  texts: string[];
}) {
  const dir = join(input.storageDir, "conversations", input.directory);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "conversation.json"),
    `${JSON.stringify({ id: input.conversationId, agent_id: AGENT_ID })}\n`,
  );
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify({
      schema_version: LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION,
      message_format: LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
      provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
      created_at: NOW,
    })}\n`,
  );
  await writeFile(
    join(dir, "messages.jsonl"),
    `${input.texts
      .map((text, index) =>
        JSON.stringify({
          id: `${input.directory}-${index}`,
          // User rows only: the local search indexes what the reader sees in the
          // transcript, and assistant rows with the same needle would not all
          // come back.
          role: "user",
          content: text,
          timestamp: 1,
        }),
      )
      .join("\n")}\n`,
  );
}

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  rows: () => Promise<string[]>;
  press: (...keys: string[]) => Promise<void>;
  stop: () => void;
  closed: () => number;
  opened: string[];
}

async function mount(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "b7a-search-"));
  const storageDir = join(dir, "transcripts");
  await writeTranscript({
    storageDir,
    directory: "one",
    conversationId: "conv-search-1",
    texts: ["needle 01", "needle 02"],
  });
  await writeTranscript({
    storageDir,
    directory: "two",
    conversationId: "conv-search-2",
    texts: ["needle 03", "needle 04", "needle 05"],
  });
  await writeTranscript({
    storageDir,
    directory: "three",
    conversationId: "conv-search-3",
    texts: ["needle 06", "needle 07"],
  });
  testDirs.push(dir);

  __testSetBackend(new TranscriptBackend(storageDir));
  let closes = 0;
  const opened: string[] = [];
  const tty = mountInkTty(
    <MessageSearch
      onClose={() => {
        closes += 1;
      }}
      agentId={AGENT_ID}
      conversationId="conv-search-1"
      onOpenConversation={(agentId, conversationId) =>
        opened.push(`${agentId}/${conversationId}`)
      }
    />,
    { columns: 80, rows: 40 },
  );
  await settle(250);
  return {
    rows: async () => {
      await settle(120);
      return tty.rows();
    },
    press: tty.press,
    stop: tty.stop,
    closed: () => closes,
    opened,
  };
}

const testDirs: string[] = [];

/** Run a query and wait until its hits are on screen. */
async function search(harness: Harness, query = "needle") {
  await harness.press(...query.split(""), ENTER);
  // The search is asynchronous (it reads durable transcripts), and the list's key
  // table only holds the hits once they are rendered — so a key pressed before
  // this would be offered to an empty list.
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await harness.rows();
    if (rows.some((row) => row.includes("results"))) return;
  }
  throw new Error("the search never landed");
}

/**
 * The one row carrying `text`, or the empty string.
 *
 * Not a placeholder: `expect(rowWith(...)).toBeTruthy()` on a "<no such row>"
 * string passes, which is how a helper hides the very miss it was written to
 * catch.
 */
function rowWith(rows: string[], text: string): string {
  return rows.find((row) => row.includes(text)) ?? "";
}

/**
 * The hit rows the list painted. The footer is computed from the controller's
 * window, so a view that stopped windowing would still print `1/7 results` while
 * painting all seven.
 */
function hitRows(rows: string[]): string[] {
  return rows.filter((row) => row.includes("👤") || row.includes("👾"));
}

afterEach(async () => {
  resetInkTtyState();
  __testSetBackend(null);
  for (const dir of testDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("MessageSearch", () => {
  test("shows the hits in a window, counted in its own footer", async () => {
    const harness = await mount();
    await search(harness);
    const rows = await harness.rows();

    // Seven hits, five rows: this face's window is `VISIBLE_ITEMS`, and it prints
    // the position itself instead of the toolkit's `↑/↓ N more` rows.
    expect(hitRows(rows)).toHaveLength(5);
    expect(hitRows(rows)[0]).toContain(">");
    expect(rowWith(rows, "1/7 results")).toBeTruthy();
    expect(rows.some((row) => row.includes("more"))).toBe(false);
    harness.stop();
  });

  test("the window holds the cursor in the middle", async () => {
    const harness = await mount();
    await search(harness);
    const atTop = await harness.rows();
    const firstPainted = hitRows(atTop)[0] as string;
    // The marker moves with the cursor, so the text is what has to disappear.
    const firstText = firstPainted.replace(/^[> ]+/, "");

    // Three steps from the top: a centered window has already scrolled one row,
    // where an edge-anchored one would still be showing the first hit.
    await harness.press(DOWN, DOWN, DOWN);
    const scrolled = await harness.rows();

    expect(hitRows(scrolled)).toHaveLength(5);
    expect(scrolled.join("\n")).not.toContain(firstText);
    expect(rowWith(scrolled, "4/7 results")).toBeTruthy();
    harness.stop();
  });

  test("the query field is an editor: letters type, backspace deletes", async () => {
    const harness = await mount();
    await harness.press("j", "k");
    const typed = await harness.rows();

    // No rows on screen yet, so `j`/`k` could only be the query's — but the point
    // is the case *with* results below: this face leaves them to the field even
    // then (`vimKeys: false`), since the field is always live.
    expect(rowWith(typed, "Search: jk")).toBeTruthy();

    await harness.press(BACKSPACE);
    expect(rowWith(await harness.rows(), "Search: j")).toBeTruthy();

    await harness.press(BACKSPACE, BACKSPACE);
    expect(rowWith(await harness.rows(), "(type to search)")).toBeTruthy();
    harness.stop();
  });

  test("j types even while the hits are on screen", async () => {
    const harness = await mount();
    await search(harness);
    await harness.press("j");
    const rows = await harness.rows();

    expect(rowWith(rows, "Search: needlej")).toBeTruthy();
    expect(rowWith(rows, "(press Enter to search)")).toBeTruthy();
    harness.stop();
  });

  test("Enter expands the hit, Escape collapses it, and the sub-view has no title", async () => {
    const harness = await mount();
    await search(harness);
    await harness.press(ENTER);
    const expanded = await harness.rows();

    expect(rowWith(expanded, "User message, sent")).toBeTruthy();
    expect(rowWith(expanded, "Enter to open conversation")).toBeTruthy();
    // The frame's title is omitted while the sub-view is up, as it always was.
    expect(expanded.join("\n")).not.toContain(
      "Search messages across all agents",
    );

    await harness.press(ESCAPE);
    const collapsed = await harness.rows();

    expect(
      rowWith(collapsed, "Search messages across all agents"),
    ).toBeTruthy();
    expect(rowWith(collapsed, "1/7 results")).toBeTruthy();
    expect(harness.closed()).toBe(0);
    harness.stop();
  });

  test("Enter on the expanded hit opens its conversation", async () => {
    const harness = await mount();
    await search(harness);
    await harness.press(ENTER, ENTER);

    expect(harness.opened).toHaveLength(1);
    expect(harness.opened[0]).toMatch(
      new RegExp(`^${AGENT_ID}/conv-search-[123]$`),
    );
    harness.stop();
  });

  test("Tab cycles the range and Shift+Tab the mode", async () => {
    const harness = await mount();
    await search(harness);

    await harness.press(TAB, TAB);
    const cycled = await harness.rows();
    // The key changed the range rather than becoming query text: the query line
    // still holds the search that was run.
    expect(rowWith(cycled, "Search: needle")).toBeTruthy();
    expect(rowWith(cycled, "Range (tab):")).toBeTruthy();

    await harness.press(SHIFT_TAB);
    const mode = await harness.rows();
    // Shift+Tab reaches the mode cycler, which the local backend refuses: the
    // face reports the error rather than dropping the key.
    expect(mode.join("\n")).toContain('Use "fts"');
    harness.stop();
  });

  test("Escape clears the query, and closes when there is nothing left", async () => {
    const harness = await mount();
    await search(harness);
    await harness.press(ESCAPE);
    const cleared = await harness.rows();

    expect(rowWith(cleared, "(type to search)")).toBeTruthy();
    expect(harness.closed()).toBe(0);

    await harness.press(ESCAPE);
    expect(harness.closed()).toBe(1);
    harness.stop();
  });
});
