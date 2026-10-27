import { afterEach, describe, expect, test } from "bun:test";
import type { TopicIndexEntry } from "@/backend/local/topic-index";
import { TopicListOverlay } from "@/cli/components/TopicListOverlay";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * `/topic list --all`, judged on the frame (requirement §5.11.10).
 *
 * Three claims are the face: one line per marker with its time, conversation and
 * source; a window that scrolls with the cursor and pages with PgUp/PgDn; and a
 * `q` that closes it. The rows come from a fixture rather than from an index
 * file, because what is under test is the paint — the index has its own suite.
 */

const AGENT_ID = "agent-topics";

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const PAGE_DOWN = "\u001B[6~";
const ESCAPE = "\u001B";
const QUIT = "q";

function entry(
  index: number,
  overrides: Partial<TopicIndexEntry> = {},
): TopicIndexEntry {
  return {
    conversationId: "conv-a",
    agentId: AGENT_ID,
    topicId: `topic-${index}`,
    title: `Topic ${index}`,
    createdAt: `2026-10-0${(index % 9) + 1}T09:0${index % 10}:00.000Z`,
    anchorMessageId: `message-${index}`,
    createdBy: "user",
    hidden: false,
    evicted: false,
    ...overrides,
  };
}

function mount(options: {
  entries?: readonly TopicIndexEntry[];
  unavailable?: boolean;
  columns?: number;
  rows?: number;
  onClose?: () => void;
}) {
  const entries = options.entries ?? [entry(1), entry(2), entry(3)];
  const tty = mountInkTty(
    <TopicListOverlay
      agentId={AGENT_ID}
      onClose={options.onClose ?? (() => {})}
      source={() =>
        options.unavailable
          ? { kind: "unavailable" }
          : { kind: "rows", entries }
      }
    />,
    { columns: options.columns ?? 100, rows: options.rows ?? 24 },
  );
  return tty;
}

afterEach(resetInkTtyState);

describe("the topic list panel", () => {
  test("paints one line per marker: title, time, conversation, source", async () => {
    const tty = mount({
      entries: [
        entry(1, {
          title: "Auth token refresh",
          createdAt: "2026-10-03T09:31:00.000Z",
          conversationId: "conv-a",
          createdBy: "user",
        }),
      ],
    });
    try {
      const rows = await tty.rows();
      const row = rows.find((line) => line.includes("Auth token refresh"));
      expect(row).toBeDefined();
      // The cursor row carries the bar; the rest of the line is the row copy.
      expect(row).toContain("2026-10-03 09:31");
      expect(row).toContain("conv-a");
      expect(row).toContain("user");
      // One line: the next painted row is the next item, not a continuation.
      const at = rows.indexOf(row as string);
      expect(rows[at + 1] ?? "").not.toContain("conv-a");
    } finally {
      tty.stop();
    }
  });

  test("a trimmed marker says so instead of pretending it is current", async () => {
    const tty = mount({
      entries: [entry(1, { title: "Folded topic", evicted: true })],
    });
    try {
      const text = await tty.text();
      expect(text).toContain("Folded topic");
      expect(text).toContain("trimmed");
    } finally {
      tty.stop();
    }
  });

  test("the footer carries the standing notes and the count", async () => {
    const tty = mount({ entries: [entry(1), entry(2)] });
    try {
      const text = await tty.text();
      expect(text).toContain("2 markers");
      // The notes are clipped to the footer's width, so each is asserted by a
      // fragment that fits: the point is that both are on the face at all.
      expect(text).toContain("A trimmed marker stays on disk");
      expect(text).toContain("defines no block of its own");
      expect(text).toContain("q close");
    } finally {
      tty.stop();
    }
  });

  test("q closes the face, and so does Escape", async () => {
    let closes = 0;
    const tty = mount({
      onClose: () => {
        closes += 1;
      },
    });
    try {
      await tty.press(QUIT);
      expect(closes).toBe(1);
      await tty.press(ESCAPE);
      expect(closes).toBe(2);
    } finally {
      tty.stop();
    }
  });

  test("windows the list and pages with PgDn", async () => {
    // 30 markers in a 24-row terminal: the window is what fits, and the two
    // indicator rows say how much is below.
    const entries = Array.from({ length: 30 }, (_, index) => entry(index + 1));
    const tty = mount({ entries });
    try {
      const first = await tty.rows();
      expect(first.some((row) => row.includes("Topic 1"))).toBe(true);
      expect(first.some((row) => row.includes("Topic 30"))).toBe(false);
      const more = first.find((row) => row.includes("more"));
      expect(more).toBeDefined();

      await tty.press(PAGE_DOWN);
      const paged = await tty.rows();
      expect(paged.some((row) => row.includes("Topic 1 ·"))).toBe(false);
    } finally {
      tty.stop();
    }
  });

  test("the cursor moves one row at a time and the window follows it", async () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(index + 1));
    const tty = mount({ entries, rows: 24 });
    try {
      const first = await tty.rows();
      expect(first.find((row) => row.startsWith("> Topic"))).toContain(
        "Topic 1",
      );

      for (let step = 0; step < 15; step += 1) {
        await tty.press(DOWN);
      }
      const moved = await tty.rows();
      expect(moved.find((row) => row.startsWith("> Topic"))).toContain(
        "Topic 16",
      );

      await tty.press(UP);
      const back = await tty.rows();
      expect(back.find((row) => row.startsWith("> Topic"))).toContain(
        "Topic 15",
      );
    } finally {
      tty.stop();
    }
  });

  test("an empty index says how to make a marker", async () => {
    const tty = mount({ entries: [] });
    try {
      const text = await tty.text();
      expect(text).toContain("No topic markers in this agent's conversations");
      expect(text).toContain("/topic <title>");
    } finally {
      tty.stop();
    }
  });

  test("a backend without a local storage root is reported, not read", async () => {
    // The red line: `queryTopicIndex` falls back to the default root when it is
    // not handed one, so a face that cannot name its root must not query.
    const tty = mount({ unavailable: true });
    try {
      const text = await tty.text();
      expect(text).toContain("only available on the local backend");
      expect(text).not.toContain("Topic 1");
    } finally {
      tty.stop();
    }
  });

  test("a narrow terminal clips every row instead of wrapping it", async () => {
    const longTitle =
      "A very long topic title that would certainly wrap in a narrow terminal";
    const tty = mount({
      entries: [
        entry(1, { title: longTitle }),
        entry(2, { title: "Second topic" }),
      ],
      columns: 48,
      rows: 24,
    });
    try {
      const rows = await tty.rows();
      const marked = rows.filter(
        (row) => row.startsWith(">") || row.startsWith("  "),
      );
      for (const row of marked) {
        expect(row.length).toBeLessThanOrEqual(48);
      }
      expect(rows.join("\n")).toContain("A very long topic title");
      expect(rows.some((row) => row.endsWith("..."))).toBe(true);
      // Two markers, two rows — not four.
      const topicRows = rows.filter(
        (row) => row.includes("Topic") || row.includes("Second topic"),
      );
      expect(topicRows).toHaveLength(2);
    } finally {
      tty.stop();
    }
  });
});
