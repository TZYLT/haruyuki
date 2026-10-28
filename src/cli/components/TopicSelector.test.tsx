/**
 * Row coverage for the topic picker (D-111), plus one mount test.
 *
 * The picker's copy is what tells a user which block is which and how much
 * context each one keeps, so the rows are built by pure functions and asserted
 * here rather than by rendering Ink. The mount test at the end covers the part
 * pure functions cannot see: the picker hands its hint line to
 * `SingleSelectPicker` as a raw string prop, and Ink rejects a string child
 * that is not wrapped in `<Text>`. Without a mount, that mistake is invisible
 * until a user opens `/compact`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import {
  buildTopicPickItems,
  buildTopicPickRows,
  initialTopicPickIndex,
  TOPIC_TRIM_CANCEL_KEY,
  TopicSelector,
} from "@/cli/components/TopicSelector";
import type { TopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

function block(overrides: Partial<TopicBlock> & { index: number }): TopicBlock {
  return {
    title: null,
    markerId: null,
    createdBy: null,
    anchorMessageId: null,
    absorbedTitles: [],
    boundaryMessageId: `m${overrides.index}`,
    startIndex: 0,
    endIndex: 0,
    rewindTurns: 0,
    startMarkerAnchorMessageId: null,
    messageCount: 1,
    tokens: 1,
    startsAt: "2026-01-01T10:00:00.000Z",
    sparse: false,
    ...overrides,
  };
}

const BLOCKS: TopicBlock[] = [
  block({
    index: 1,
    title: "Auth token refresh",
    messageCount: 8,
    tokens: 612,
    startsAt: "2026-01-01T10:00:00.000Z",
  }),
  block({
    index: 2,
    messageCount: 6,
    tokens: 480,
    startIndex: 8,
    endIndex: 14,
    rewindTurns: 2,
    startMarkerAnchorMessageId: "message-local-anchor",
    startsAt: "2026-01-01T10:04:00.000Z",
  }),
];

describe("buildTopicPickRows", () => {
  test("labels every block, and block 1 is selectable like any other", () => {
    const rows = buildTopicPickRows(BLOCKS);

    expect(rows.map((row) => row.key)).toEqual(["1", "2"]);
    expect(rows[0]?.label).toBe("1. Auth token refresh");
    expect(rows[0]?.disabled).toBeUndefined();
    expect(rows[1]?.label).toBe("2. Current topic (not marked finished)");
    expect(rows[1]?.disabled).toBeUndefined();
  });

  test("leads the description with the summarizer's section when there is one", () => {
    // F-04's reason for touching this face at all: the user decides on the
    // summary, so it comes before the counts and the boundary note.
    const rows = buildTopicPickRows([
      block({
        index: 1,
        title: "Auth token refresh",
        summary: "  The refresh landed;\n  the retry storm is unresolved.  ",
        messageCount: 8,
        tokens: 612,
      }),
    ]);

    expect(rows[0]?.description).toBe(
      "The refresh landed; the retry storm is unresolved. · 8 messages · ~612 tokens · open since 2026-01-01 10:00 · the start of the context",
    );
  });

  test("describes size, time, and how the boundary was derived", () => {
    const rows = buildTopicPickRows(BLOCKS);

    expect(rows[0]?.description).toBe(
      "8 messages · ~612 tokens · open since 2026-01-01 10:00 · the start of the context",
    );
    expect(rows[1]?.description).toContain("6 messages · ~480 tokens");
    expect(rows[1]?.description).toContain(
      'marker "Auth token refresh" at message-local-anchor, rewound 2 user turns',
    );
  });

  test("a written block says when its topic was tagged, not when its content starts", () => {
    // The picker and `/topic list` share the wording: a block's content can
    // predate its marker by days, so the row names the marker's time.
    const rows = buildTopicPickRows([
      block({
        index: 1,
        title: "Alpha",
        taggedAt: "2026-01-03T09:00:00.000Z",
        startsAt: "2026-01-01T10:00:00.000Z",
      }),
    ]);

    expect(rows[0]?.description).toContain("tagged at 2026-01-03 09:00");
    expect(rows[0]?.description).not.toContain("from 2026-01-01");
  });

  test("names the boundary's author when a marker created it", () => {
    const rows = buildTopicPickRows([
      block({ index: 1, title: "Alpha", createdBy: "agent" }),
      block({
        index: 2,
        startIndex: 2,
        endIndex: 4,
        startMarkerAnchorMessageId: "a",
      }),
      block({ index: 3, title: "Gamma", createdBy: "user" }),
      block({
        index: 4,
        startIndex: 6,
        endIndex: 8,
        startMarkerAnchorMessageId: "b",
      }),
    ]);

    // Row 2's boundary is the marker that ends block 1, so it is the agent's.
    expect(rows[1]?.description).toContain("marked by the agent at a");
    expect(rows[3]?.description).toContain("marked by the user at b");
  });

  test("a one-turn rewind is not pluralised, and zero says no rewind", () => {
    const single = buildTopicPickRows([
      block({ index: 1, title: "Alpha" }),
      block({
        index: 2,
        startIndex: 2,
        endIndex: 4,
        rewindTurns: 1,
        startMarkerAnchorMessageId: "a",
      }),
    ]);
    expect(single[1]?.description).toContain("rewound 1 user turn");

    const none = buildTopicPickRows([
      block({ index: 1, title: "Alpha" }),
      block({
        index: 2,
        startIndex: 2,
        endIndex: 4,
        rewindTurns: 0,
        startMarkerAnchorMessageId: "a",
      }),
    ]);
    expect(none[1]?.description).toContain("no rewind");
  });

  test("an unparseable start time is shown as-is", () => {
    const rows = buildTopicPickRows([
      block({ index: 1, startsAt: "not-a-date" }),
    ]);
    expect(rows[0]?.description).toContain("open since not-a-date");
  });
});

describe("buildTopicPickItems", () => {
  test("appends a cancel row that is never a block number", () => {
    const items = buildTopicPickItems(BLOCKS);

    expect(items).toHaveLength(3);
    expect(items.at(-1)?.key).toBe(TOPIC_TRIM_CANCEL_KEY);
    expect(items.at(-1)?.label).toBe("Cancel");
  });
});

describe("initialTopicPickIndex", () => {
  test("lands on the suggested block, including block 1", () => {
    // Block 1 is a legal pick: the compression rate caps what it may keep, so the
    // cursor can sit on it (D-119 + the rate-is-the-limit rule).
    expect(initialTopicPickIndex(buildTopicPickItems(BLOCKS), 1)).toBe(0);
    expect(initialTopicPickIndex(buildTopicPickItems(BLOCKS), 2)).toBe(1);
  });

  test("falls back to the oldest block when the suggestion is unknown", () => {
    expect(initialTopicPickIndex(buildTopicPickItems(BLOCKS), 99)).toBe(0);
  });

  test("a single block still leaves Cancel reachable by one move down", () => {
    const items = buildTopicPickItems([block({ index: 1, title: "Only" })]);
    expect(items).toHaveLength(2);
    expect(items[1]?.key).toBe(TOPIC_TRIM_CANCEL_KEY);
  });
});

/** Mounts the picker against a pinned fake TTY, at both widths. */
function mountPicker(columns: number, rows = 24) {
  const request: TopicTrimRequest = {
    blocks: BLOCKS,
    suggestionIndex: 2,
    onPick: () => {},
  };
  return mountInkTty(<TopicSelector request={request} onCancel={() => {}} />, {
    columns,
    rows,
  });
}

describe("TopicSelector mount", () => {
  afterEach(resetInkTtyState);

  test("renders the hint line in a narrow terminal without an Ink text error", async () => {
    const tty = mountPicker(100);
    try {
      const rows = await tty.rows();
      const output = rows.join("\n");

      // The hint line is the regression: it is passed as a plain string prop, so
      // the picker must wrap it in `<Text>`. Rendered raw, Ink throws during
      // commit and the tree never paints — which fails every assertion below.
      expect(output).toContain("Enter trim");
      expect(output).toContain("navigate");
      expect(output).toContain("Esc cancel");
      expect(output).not.toContain("must be rendered inside");

      // Still paints the overlay and every row when the row copy is clipped.
      expect(output).toContain("Choose the topic block to keep");
      expect(output).toContain("1. Auth token refresh");
      expect(output).toContain("Current topic (not marked");
      expect(output).toContain("Cancel · keep the context as it is");
      // The footer carries the rule that caps a greedy pick.
      expect(output).toContain("compression rate");

      // The point of `renderItem`: a long description is clipped, not wrapped.
      // Two blocks and Cancel are three rows, and every one of them is one line
      // — the window's height budget is built on that.
      const pickRows = rows.filter((row) => /^\s*>?\s*\d+\. /.test(row));
      expect(pickRows).toHaveLength(2);
      for (const row of pickRows) {
        expect(row.length).toBeLessThanOrEqual(100);
      }
      expect(rows.some((row) => row.endsWith("..."))).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("shows the full row copy in a wide terminal", async () => {
    const tty = mountPicker(200);
    try {
      const output = (await tty.rows()).join("\n");

      expect(output).toContain(
        "2. Current topic (not marked finished) · 6 messages · ~480 tokens",
      );
      expect(output).toContain(
        'marker "Auth token refresh" at message-local-anchor, rewound 2 user turns',
      );
      expect(output).toContain(" Enter trim · ↑↓/jk navigate · Esc cancel");
    } finally {
      tty.stop();
    }
  });

  test("puts the summary on the row and keeps the row one line long", async () => {
    // The face's whole reason for changing (F-04 §5.1 step 3): the summary is
    // visible *and* the row does not grow, so ten rows stay ten lines.
    const request: TopicTrimRequest = {
      blocks: [
        block({
          index: 1,
          title: "Auth token refresh",
          summary: "The refresh landed; the retry storm is still unresolved.",
        }),
        block({ index: 2, startIndex: 4, endIndex: 6 }),
      ],
      suggestionIndex: 1,
      onPick: () => {},
    };
    const tty = mountInkTty(
      <TopicSelector request={request} onCancel={() => {}} />,
      { columns: 100, rows: 24 },
    );
    try {
      const rows = await tty.rows();
      const summaryRow = rows.findIndex((row) =>
        row.includes("1. Auth token refresh"),
      );
      expect(summaryRow).toBeGreaterThan(-1);
      expect(rows[summaryRow]).toContain("The refresh landed; the retry");
      // The row after it is the *next* block, not the rest of this one.
      expect(rows[summaryRow + 1]).toContain("2. Current topic");
    } finally {
      tty.stop();
    }
  });

  test("windows a long block list at ten and says what is below", async () => {
    // A conversation with a block per topic used to render every one of them:
    // the frame grew past the screen and pushed the hint line — and the composer
    // behind it — out of view. The window is the one visible change this face was
    // signed off for, so it is pinned here rather than left to the toolkit.
    const blocks = Array.from({ length: 14 }, (_, i) =>
      block({ index: i + 1, title: `Topic ${i + 1}` }),
    );
    const request: TopicTrimRequest = {
      blocks,
      suggestionIndex: 1,
      onPick: () => {},
    };
    const tty = mountInkTty(
      <TopicSelector request={request} onCancel={() => {}} />,
      {
        columns: 100,
        rows: 40,
      },
    );
    try {
      const rows = await tty.rows();
      const painted = rows.join("\n");
      // Ten block rows on screen, the eleventh and beyond behind the indicator.
      const blockRows = rows.filter((row) => /^\s*>?\s*\d+\. Topic /.test(row));
      expect(blockRows).toHaveLength(10);
      expect(painted).not.toContain("Topic 11");
      expect(painted).toContain("↓ 5 more");
      // Cancel rides with the window: it is a row like any other.
      expect(painted).not.toContain("Cancel · keep the context as it is");
    } finally {
      tty.stop();
    }
  });
});
