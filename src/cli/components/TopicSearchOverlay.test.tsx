import { afterEach, describe, expect, test } from "bun:test";
import type { TopicIndexEntry } from "@/backend/local/topic-index";
import { TopicSearchOverlay } from "@/cli/components/TopicSearchOverlay";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * `/topic search <kw>`, judged on the frame (requirement §5.11.9).
 *
 * The face is `/search`'s shape over a different corpus: a keyword, a result
 * list, and Enter to read a hit's full section. What is asserted here is the
 * paint and the keys — the index has its own suite, and the "search never writes
 * a marker" claim is asserted where the write would have happened
 * (`submit-topic-commands.test.ts`).
 */

const AGENT_ID = "agent-topics";

const ENTER = "\r";
const ESCAPE = "\u001B";
const DOWN = "\u001B[B";

function entry(
  index: number,
  overrides: Partial<TopicIndexEntry> = {},
): TopicIndexEntry {
  return {
    conversationId: "conv-a",
    agentId: AGENT_ID,
    topicId: `topic-${index}`,
    title: `Topic ${index}`,
    createdAt: "2026-10-03T09:31:00.000Z",
    anchorMessageId: `message-${index}`,
    createdBy: "user",
    hidden: false,
    evicted: false,
    ...overrides,
  };
}

const ROWS: TopicIndexEntry[] = [
  entry(1, {
    title: "Auth token refresh",
    createdBy: "user",
    section:
      "The refresh landed; the retry storm is still unresolved, and the backoff schedule is the next thing to look at.",
  }),
  entry(2, {
    title: "Deploy check",
    conversationId: "conv-b",
    createdBy: "summarizer",
  }),
];

function mount(options: {
  keyword?: string;
  entries?: readonly TopicIndexEntry[];
  unavailable?: boolean;
  columns?: number;
  terminalRows?: number;
  onClose?: () => void;
}) {
  const keywords: string[] = [];
  const tty = mountInkTty(
    <TopicSearchOverlay
      agentId={AGENT_ID}
      onClose={options.onClose ?? (() => {})}
      {...(options.keyword === undefined
        ? {}
        : { initialQuery: options.keyword })}
      source={(keyword) => {
        keywords.push(keyword);
        if (options.unavailable) return { kind: "unavailable" };
        const pool = options.entries ?? ROWS;
        const needle = keyword.trim().toLowerCase();
        return {
          kind: "rows",
          entries: needle
            ? pool.filter((row) => row.title.toLowerCase().includes(needle))
            : pool,
        };
      }}
    />,
    { columns: options.columns ?? 100, rows: options.terminalRows ?? 30 },
  );
  return { tty, keywords };
}

afterEach(resetInkTtyState);

describe("the topic search face", () => {
  test("opens on the command's keyword and paints one line per hit", async () => {
    const { tty, keywords } = mount({ keyword: "auth" });
    try {
      const rows = await tty.rows();
      const painted = rows.join("\n");

      expect(keywords).toEqual(["auth"]);
      expect(painted).toContain("Keyword: auth");
      expect(painted).toContain("Auth token refresh");
      expect(painted).toContain("2026-10-03 09:31");
      expect(painted).toContain("conv-a");
      expect(painted).toContain("user");
      // The other row does not match the keyword.
      expect(painted).not.toContain("Deploy check");
      expect(painted).toContain("1/1 results");
    } finally {
      tty.stop();
    }
  });

  test("an empty keyword lists everything the index has", async () => {
    const { tty } = mount({});
    try {
      const painted = await tty.text();
      expect(painted).toContain("Auth token refresh");
      expect(painted).toContain("Deploy check");
      // The cursor is on the first of the two hits.
      expect(painted).toContain("1/2 results");
    } finally {
      tty.stop();
    }
  });

  test("Enter re-runs the search for what was typed", async () => {
    const { tty, keywords } = mount({ keyword: "auth" });
    try {
      await tty.press(ESCAPE); // clear the keyword first
      await Bun.sleep(60);
      // One key at a time: the field is a controlled editor, so a burst faster
      // than a frame would be applied against stale values (a human types slower
      // than this, and the harness should model the human).
      for (const char of "deploy") {
        await tty.press(char);
        await Bun.sleep(60);
      }
      await tty.press(ENTER);
      const painted = await tty.text();

      expect(keywords[0]).toBe("auth");
      expect(keywords).toContain("");
      expect(keywords.at(-1)).toBe("deploy");
      expect(painted).toContain("Deploy check");
      expect(painted).not.toContain("Auth token refresh");
    } finally {
      tty.stop();
    }
  });

  test("Enter on a hit expands its full section, and Escape goes back", async () => {
    const { tty } = mount({ keyword: "auth" });
    try {
      await tty.press(ENTER);
      const expanded = await tty.text();
      expect(expanded).toContain("Auth token refresh");
      // The section is the whole point of expanding: it is longer than the row.
      expect(expanded).toContain("the backoff schedule");
      expect(expanded).toContain("thing to look at");
      expect(expanded).toContain("Esc back to results");
      expect(expanded).not.toContain("1/1 results");

      await tty.press(ESCAPE);
      const back = await tty.text();
      expect(back).toContain("1/1 results");
      expect(back).not.toContain("the backoff schedule");
    } finally {
      tty.stop();
    }
  });

  test("the cursor moves through the hits and Enter expands the one under it", async () => {
    const { tty } = mount({});
    try {
      await tty.press(DOWN);
      const rows = await tty.rows();
      const cursorRow = rows.find(
        (row) => row.startsWith("> Auth") || row.startsWith("> Deploy"),
      );
      expect(cursorRow).toContain("Deploy check");

      await tty.press(ENTER);
      const expanded = await tty.text();
      expect(expanded).toContain("Deploy check");
      expect(expanded).toContain("No section was recorded for this topic");
    } finally {
      tty.stop();
    }
  });

  test("Escape clears the keyword first and only then closes", async () => {
    let closes = 0;
    const { tty } = mount({
      keyword: "auth",
      onClose: () => {
        closes += 1;
      },
    });
    try {
      await tty.press(ESCAPE);
      expect(closes).toBe(0);
      const cleared = await tty.text();
      expect(cleared).toContain("Keyword: ");
      // The cleared field lists everything again.
      expect(cleared).toContain("Deploy check");

      await tty.press(ESCAPE);
      expect(closes).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("a keyword with no hits says so instead of showing an empty list", async () => {
    const { tty } = mount({ keyword: "nothing-matches" });
    try {
      const painted = await tty.text();
      expect(painted).toContain('No topic markers match "nothing-matches".');
      expect(painted).toContain("Esc clears the keyword");
    } finally {
      tty.stop();
    }
  });

  test("an empty index points at how a marker is made", async () => {
    const { tty } = mount({ entries: [] });
    try {
      const painted = await tty.text();
      expect(painted).toContain("No topic markers indexed for this agent yet.");
      expect(painted).toContain("/topic <title>");
    } finally {
      tty.stop();
    }
  });

  test("a backend without a local storage root is reported, not read", async () => {
    const { tty } = mount({ unavailable: true });
    try {
      const painted = await tty.text();
      expect(painted).toContain("only available on the local backend");
      expect(painted).not.toContain("Auth token refresh");
    } finally {
      tty.stop();
    }
  });

  test("a narrow terminal clips every row instead of wrapping it", async () => {
    const { tty } = mount({ columns: 40, terminalRows: 30 });
    try {
      const rows = await tty.rows();
      for (const row of rows) {
        expect(row.length).toBeLessThanOrEqual(40);
      }
      // One row per hit: two hits, two rows.
      const hits = rows.filter(
        (row) => row.includes("Auth token") || row.includes("Deploy check"),
      );
      expect(hits).toHaveLength(2);
    } finally {
      tty.stop();
    }
  });
});
