/**
 * Row models for the one topic panel.
 *
 * The frame suite (`TopicListOverlay.test.tsx`) judges the paint; this file
 * judges the rows, which is where the three views can quietly disagree with the
 * printed forms or with each other. The claims worth pinning:
 *
 * - blocks are numbered like `/compact` and labelled "tagged at";
 * - the context view sorts by anchor position while keeping write-order numbers;
 * - a marker's detail says which block it ends (or what absorbed it), so the two
 *   numbering schemes are never ambiguous;
 * - the index view is the same one-line record the search face and the printed
 *   list use.
 */
import { describe, expect, test } from "bun:test";
import type { LocalTopicList } from "@/backend/local/local-topic-trim";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import type { TopicIndexEntry } from "@/backend/local/topic-index";
import {
  buildTopicBlockPanelRows,
  buildTopicContextPanelRows,
  buildTopicIndexPanelRows,
  buildTopicPanelRows,
  TOPIC_PANEL_VIEWS,
  topicPanelCommand,
  topicPanelCount,
  topicPanelEmpty,
  topicPanelNotes,
  topicPanelTitle,
} from "@/cli/helpers/topic-panel";

function block(index: number, overrides: Partial<TopicBlock> = {}): TopicBlock {
  return {
    index,
    title: null,
    markerId: null,
    createdBy: null,
    anchorMessageId: null,
    absorbedTitles: [],
    boundaryMessageId: `m${index}`,
    startIndex: 0,
    endIndex: 1,
    rewindTurns: 0,
    startMarkerAnchorMessageId: null,
    messageCount: 2,
    tokens: 120,
    startsAt: "2026-01-02T10:00:00.000Z",
    sparse: false,
    ...overrides,
  };
}

function list(overrides: Partial<LocalTopicList> = {}): LocalTopicList {
  return {
    blocks: [block(1)],
    markers: [],
    contextMessageCount: 4,
    contextTokens: 400,
    retentionCapTokens: 280,
    suggestedBlockIndex: 1,
    ...overrides,
  };
}

function entry(overrides: Partial<TopicIndexEntry> = {}): TopicIndexEntry {
  return {
    conversationId: "conv-a",
    agentId: "agent-1",
    topicId: "topic-1",
    title: "Auth token refresh",
    createdAt: "2026-01-03T09:31:00.000Z",
    anchorMessageId: "m1",
    createdBy: "user",
    hidden: false,
    evicted: false,
    ...overrides,
  };
}

describe("the three views", () => {
  test("each view names its own command, title and two standing notes", () => {
    expect(TOPIC_PANEL_VIEWS).toEqual(["blocks", "context", "all"]);
    expect(topicPanelCommand("blocks")).toBe("/topic list");
    expect(topicPanelCommand("context")).toBe("/topic list --context");
    expect(topicPanelCommand("all")).toBe("/topic list --all");
    expect(topicPanelTitle("blocks")).toContain("context order");
    expect(topicPanelTitle("context")).toContain("context order");
    expect(topicPanelTitle("all")).toContain("newest first");
    // The frame's height is measured from a constant footer, so every view has
    // to carry exactly the same number of note lines.
    for (const view of TOPIC_PANEL_VIEWS) {
      expect(topicPanelNotes(view)).toHaveLength(2);
      expect(topicPanelEmpty(view).hint).toContain("/topic <title>");
    }
  });

  test("counts say what the rows are, and singular is not pluralised", () => {
    expect(topicPanelCount("blocks", 1)).toBe("1 block");
    expect(topicPanelCount("blocks", 3)).toBe("3 blocks");
    expect(topicPanelCount("context", 1)).toBe("1 marker");
    expect(topicPanelCount("all", 2)).toBe("2 markers");
  });
});

describe("buildTopicBlockPanelRows", () => {
  test("numbers blocks as /compact does and labels the tag time", () => {
    const rows = buildTopicBlockPanelRows(
      list({
        blocks: [
          block(1, {
            title: "Alpha",
            markerId: "t1",
            createdBy: "user",
            taggedAt: "2026-01-03T09:00:00.000Z",
            absorbedTitles: ["Beta"],
          }),
          block(2, { rewindTurns: 2 }),
        ],
      }),
    );

    expect(rows[0]?.label).toBe("1. Alpha");
    expect(rows[0]?.description).toContain("tagged at 2026-01-03 09:00");
    // The trailing block has no marker, so it says when it opened instead.
    expect(rows[1]?.label).toBe("2. Current topic (not marked finished)");
    expect(rows[1]?.description).toContain("open since 2026-01-02 10:00");
  });

  test("the detail carries what no longer fits on the row", () => {
    const rows = buildTopicBlockPanelRows(
      list({
        blocks: [
          block(1, {
            title: "Alpha",
            markerId: "t1",
            taggedAt: "2026-01-03T09:00:00.000Z",
            absorbedTitles: ["Beta"],
            summary: "  The retry storm\n  is unresolved.  ",
            compaction: true,
          }),
          block(2, { rewindTurns: 2, startMarkerAnchorMessageId: "anchor" }),
        ],
      }),
    );

    const detail = rows[0]?.detail ?? [];
    expect(detail).toContain("boundary: the start of the context");
    expect(detail).toContain("content starts at 2026-01-02 10:00");
    expect(detail).toContain("absorbed markers: Beta");
    expect(
      detail.some((line) => line.startsWith("starts at a compaction summary")),
    ).toBe(true);
    expect(detail).toContain("topic summary: The retry storm is unresolved.");
  });
});

describe("buildTopicContextPanelRows", () => {
  test("sorts by the context while the numbers keep the write order", () => {
    const rows = buildTopicContextPanelRows(
      list({
        blocks: [
          block(1, { title: "Late", markerId: "t1" }),
          block(2, { title: "Early", markerId: "t2" }),
        ],
        markers: [
          {
            marker: {
              id: "t1",
              title: "Late",
              createdBy: "user",
              anchorMessageId: "m3",
              createdAt: "2026-01-01T09:00:00.000Z",
            },
            anchorIndex: 3,
          },
          {
            marker: {
              id: "t2",
              title: "Early",
              createdBy: "summarizer",
              anchorMessageId: null,
              createdAt: "2026-01-01T10:00:00.000Z",
            },
            anchorIndex: null,
          },
        ],
      }),
    );

    expect(rows.map((row) => row.key)).toEqual(["t2", "t1"]);
    expect(rows.map((row) => row.label)).toEqual(["#2  Early", "#1  Late"]);
    expect(rows[0]?.description).toContain("trimmed");
  });

  test("the detail says which block a marker ends, and what absorbed the others", () => {
    const rows = buildTopicContextPanelRows(
      list({
        blocks: [
          block(1, {
            title: "Alpha",
            markerId: "t1",
            absorbedTitles: ["Beta"],
          }),
          block(2),
        ],
        markers: [
          {
            marker: {
              id: "t1",
              title: "Alpha",
              createdBy: "user",
              anchorMessageId: "m1",
              createdAt: "2026-01-01T09:00:00.000Z",
            },
            anchorIndex: 1,
          },
          {
            marker: {
              id: "t2",
              title: "Beta",
              createdBy: "user",
              anchorMessageId: "m2",
              createdAt: "2026-01-01T09:30:00.000Z",
            },
            anchorIndex: 2,
          },
        ],
      }),
    );

    const alpha = rows.find((row) => row.key === "t1");
    expect(alpha?.detail[2]).toBe("ends block 1");
    const beta = rows.find((row) => row.key === "t2");
    expect(beta?.detail[2]).toBe("absorbed into block 1");
    expect(beta?.detail.some((line) => line.startsWith("absorbed:"))).toBe(
      true,
    );
    // The position is stated against the context length, so "3rd of 4" is readable.
    expect(alpha?.detail[1]).toBe("anchor: message 2 of 4 in the context");
  });

  test("a marker with no block says so instead of guessing one", () => {
    const rows = buildTopicContextPanelRows(
      list({
        blocks: [block(1)],
        markers: [
          {
            marker: {
              id: "t1",
              title: "Orphan",
              createdBy: "user",
              anchorMessageId: null,
              createdAt: "2026-01-01T09:00:00.000Z",
            },
            anchorIndex: null,
          },
        ],
      }),
    );
    expect(rows[0]?.detail[2]).toBe("defines no block of its own");
    expect(rows[0]?.detail[1]).toContain("no longer in the context");
  });
});

describe("buildTopicIndexPanelRows", () => {
  test("keeps the index's one-line record and opens the section", () => {
    const rows = buildTopicIndexPanelRows([
      entry({ section: "What the retry storm left behind." }),
    ]);

    expect(rows[0]?.label).toBe(
      "Auth token refresh · 2026-01-03 09:31 · conv-a · user",
    );
    expect(rows[0]?.detail).toContain("What the retry storm left behind.");
  });

  test("a trimmed index record still says trimmed", () => {
    const rows = buildTopicIndexPanelRows([entry({ evicted: true })]);
    expect(rows[0]?.detail[0]).toContain("trimmed");
  });
});

describe("buildTopicPanelRows", () => {
  test("picks the rows of the view it is asked for", () => {
    const data = {
      list: list({
        blocks: [block(1, { title: "Alpha", markerId: "t1" })],
        markers: [
          {
            marker: {
              id: "t1",
              title: "Alpha",
              createdBy: "user",
              anchorMessageId: "m1",
              createdAt: "2026-01-01T09:00:00.000Z",
            },
            anchorIndex: 1,
          },
        ],
      }),
      entries: [entry()],
    };

    expect(buildTopicPanelRows("blocks", data)[0]?.label).toBe("1. Alpha");
    expect(buildTopicPanelRows("context", data)[0]?.label).toBe("#1  Alpha");
    expect(buildTopicPanelRows("all", data)[0]?.label).toContain(
      "Auth token refresh",
    );
  });
});
