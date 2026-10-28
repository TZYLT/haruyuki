import { afterEach, describe, expect, test } from "bun:test";
import type { LocalTopicList } from "@/backend/local/local-topic-trim";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import type { TopicIndexEntry } from "@/backend/local/topic-index";
import {
  TopicListOverlay,
  type TopicPanelData,
} from "@/cli/components/TopicListOverlay";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The one topic panel, judged on the frame.
 *
 * Four claims are the face, one per view plus the shared chrome: the blocks are
 * numbered like `/compact`, the marker rows follow the context while keeping the
 * text order's numbers, the index is newest first — and Tab moves between the
 * three without remounting anything, because the whole point of merging the
 * faces is that a user does not have to retype a command to look at the next
 * view.
 *
 * The data comes from a fixture rather than from a transcript or an index file:
 * what is under test is the paint, and both reads have their own suites.
 */

const AGENT_ID = "agent-topics";
const CONVERSATION_ID = "conv-a";

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const PAGE_DOWN = "\u001B[6~";
const ESCAPE = "\u001B";
const QUIT = "q";
const TAB = "\t";
const SHIFT_TAB = "\u001B[Z";
const ENTER = "\r";

function block(index: number, overrides: Partial<TopicBlock> = {}): TopicBlock {
  return {
    index,
    title: null,
    markerId: null,
    createdBy: null,
    anchorMessageId: null,
    absorbedTitles: [],
    boundaryMessageId: `message-${index}`,
    startIndex: 0,
    endIndex: 1,
    rewindTurns: 0,
    startMarkerAnchorMessageId: null,
    messageCount: 2,
    tokens: 120,
    startsAt: "2026-10-02T09:00:00.000Z",
    sparse: false,
    ...overrides,
  };
}

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

/** Two blocks and two markers, one of each absorbed and one folded away. */
function topicList(overrides: Partial<LocalTopicList> = {}): LocalTopicList {
  return {
    blocks: [
      block(1, {
        title: "Auth token refresh",
        markerId: "marker-1",
        createdBy: "user",
        taggedAt: "2026-10-03T09:31:00.000Z",
        absorbedTitles: ["Folded away"],
      }),
      block(2, { rewindTurns: 2, startMarkerAnchorMessageId: "message-9" }),
    ],
    markers: [
      {
        marker: {
          id: "marker-1",
          title: "Auth token refresh",
          createdBy: "user",
          anchorMessageId: "message-9",
          createdAt: "2026-10-03T09:31:00.000Z",
        },
        anchorIndex: 3,
      },
      {
        marker: {
          id: "marker-2",
          title: "Folded away",
          createdBy: "summarizer",
          anchorMessageId: null,
          createdAt: "2026-10-04T09:31:00.000Z",
        },
        anchorIndex: null,
      },
    ],
    contextMessageCount: 6,
    contextTokens: 600,
    retentionCapTokens: 420,
    suggestedBlockIndex: 1,
    ...overrides,
  };
}

function data(overrides: Partial<LocalTopicList> = {}): TopicPanelData {
  return {
    kind: "loaded",
    list: topicList(overrides),
    entries: [entry(1), entry(2)],
  };
}

function mount(options: {
  view?: "blocks" | "context" | "all";
  panel?: TopicPanelData;
  unavailable?: boolean;
  columns?: number;
  rows?: number;
  onClose?: () => void;
}) {
  const tty = mountInkTty(
    <TopicListOverlay
      agentId={AGENT_ID}
      conversationId={CONVERSATION_ID}
      view={options.view ?? "blocks"}
      onClose={options.onClose ?? (() => {})}
      source={() =>
        options.unavailable
          ? { kind: "unavailable" }
          : (options.panel ?? data())
      }
    />,
    { columns: options.columns ?? 100, rows: options.rows ?? 24 },
  );
  return tty;
}

afterEach(resetInkTtyState);

describe("the topic panel", () => {
  test("the blocks view numbers blocks as /compact does and labels the time", async () => {
    const tty = mount({ view: "blocks" });
    try {
      const rows = await tty.rows();
      const first = rows.find((line) => line.includes("1. Auth token refresh"));
      expect(first).toBeDefined();
      expect(first).toContain("2 messages");
      expect(first).toContain("~120 tokens");
      expect(first).toContain("tagged at 2026-10-03 09:31");
      // The trailing block has no marker: it says when it opened instead.
      expect(rows.some((line) => line.includes("2. Current topic"))).toBe(true);
      expect(
        rows.some((line) => line.includes("open since 2026-10-02 09:00")),
      ).toBe(true);
      // One line per block: two blocks, exactly two rows carry their counts.
      const descriptionRows = rows.filter((line) => line.includes("messages"));
      expect(descriptionRows).toHaveLength(2);
    } finally {
      tty.stop();
    }
  });

  test("the context view follows the context but keeps the write-order numbers", async () => {
    const tty = mount({ view: "context" });
    try {
      const text = await tty.text();
      // The summarizer's marker was written second but folded into the leading
      // summary, so in the context it comes first — and keeps its number.
      const folded = text.indexOf("#2  Folded away");
      const late = text.indexOf("#1  Auth token refresh");
      expect(folded).toBeGreaterThan(-1);
      expect(late).toBeGreaterThan(folded);
      expect(text).toContain("in the current context");
      expect(text).toContain("trimmed: its anchor is no longer in the context");
    } finally {
      tty.stop();
    }
  });

  test("the all view paints one line per marker: title, time, conversation, source", async () => {
    const panel = data();
    const tty = mount({ view: "all", panel });
    try {
      const rows = await tty.rows();
      const row = rows.find((line) => line.includes("Topic 1"));
      expect(row).toBeDefined();
      expect(row).toContain("2026-10-02 09:01");
      expect(row).toContain("conv-a");
      expect(row).toContain("user");
    } finally {
      tty.stop();
    }
  });

  test("Enter opens the row's detail, Escape comes back, Escape again closes", async () => {
    let closes = 0;
    const tty = mount({
      view: "blocks",
      onClose: () => {
        closes += 1;
      },
    });
    try {
      await tty.press(ENTER);
      const detail = await tty.text();
      expect(detail).toContain("boundary: the start of the context");
      expect(detail).toContain("content starts at 2026-10-02 09:00");
      expect(detail).toContain("absorbed markers: Folded away");
      expect(detail).toContain("Esc back to the list");

      await tty.press(ESCAPE);
      const back = await tty.text();
      expect(back).toContain("1. Auth token refresh");
      expect(closes).toBe(0);

      await tty.press(ESCAPE);
      expect(closes).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("Tab cycles the views and Shift+Tab goes back", async () => {
    const tty = mount({ view: "blocks" });
    try {
      expect(await tty.text()).toContain("Topic blocks (context order)");

      await tty.press(TAB);
      expect(await tty.text()).toContain("This conversation's markers");

      await tty.press(TAB);
      expect(await tty.text()).toContain(
        "Every marker this agent has recorded",
      );

      await tty.press(TAB);
      expect(await tty.text()).toContain("Topic blocks (context order)");

      await tty.press(SHIFT_TAB);
      expect(await tty.text()).toContain(
        "Every marker this agent has recorded",
      );
    } finally {
      tty.stop();
    }
  });

  test("q closes the face, and so does Escape", async () => {
    let closes = 0;
    const tty = mount({
      view: "all",
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
    const tty = mount({
      view: "all",
      panel: { kind: "loaded", list: topicList(), entries },
    });
    try {
      const first = await tty.rows();
      expect(first.some((row) => row.includes("Topic 1"))).toBe(true);
      expect(first.some((row) => row.includes("Topic 30"))).toBe(false);
      expect(first.some((row) => row.includes("more"))).toBe(true);

      await tty.press(PAGE_DOWN);
      const paged = await tty.rows();
      expect(paged.some((row) => row.includes("Topic 1 ·"))).toBe(false);
    } finally {
      tty.stop();
    }
  });

  test("the cursor moves one row at a time and the window follows it", async () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(index + 1));
    const tty = mount({
      view: "all",
      panel: { kind: "loaded", list: topicList(), entries },
    });
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

  test("an empty conversation says how to make a marker", async () => {
    const tty = mount({
      view: "context",
      panel: {
        kind: "loaded",
        list: topicList({ blocks: [], markers: [], contextMessageCount: 0 }),
        entries: [],
      },
    });
    try {
      const text = await tty.text();
      expect(text).toContain("No topic markers in this conversation yet.");
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
      expect(text).not.toContain("Auth token refresh");
    } finally {
      tty.stop();
    }
  });

  test("a narrow terminal clips every row instead of wrapping it", async () => {
    const longTitle =
      "A very long topic title that would certainly wrap in a narrow terminal";
    const tty = mount({
      view: "blocks",
      panel: data({
        blocks: [
          block(1, { title: longTitle, markerId: "marker-1" }),
          block(2),
        ],
        markers: [],
      }),
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
      const topicRows = rows.filter(
        (row) =>
          row.includes("A very long topic title") ||
          row.includes("Current topic"),
      );
      expect(topicRows).toHaveLength(2);
    } finally {
      tty.stop();
    }
  });
});
