/**
 * Copy coverage for the topic list (D-110).
 *
 * The table has to survive the awkward shapes a real transcript produces: an
 * unmarked context, a marker whose anchor was trimmed away, absorbed markers,
 * and the "the agent cannot mark anything" switch. Each of those gets its own
 * assertion because each reads differently to a user.
 */
import { describe, expect, test } from "bun:test";
import type { LocalTopicList } from "@/backend/local/local-topic-trim";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import {
  buildTopicBlockRows,
  buildTopicMarkerRows,
  formatTopicBlockList,
  formatTopicMarkerHistory,
  topicMarkerHint,
} from "@/cli/helpers/topic-list";

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

function list(overrides: Partial<LocalTopicList> = {}): LocalTopicList {
  return {
    blocks: [block({ index: 1 })],
    markers: [],
    contextMessageCount: 2,
    contextTokens: 2,
    retentionCapTokens: 300,
    suggestedBlockIndex: 1,
    ...overrides,
  };
}

describe("topicMarkerHint", () => {
  test("offers both marking channels while the agent can mark", () => {
    const hint = topicMarkerHint(true);
    expect(hint).toContain("/topic <title>");
    expect(hint).toContain("TopicMark");
  });

  test("stops advertising the agent channel when it is switched off", () => {
    const hint = topicMarkerHint(false);
    expect(hint).toContain("switched off");
    expect(hint).not.toContain("TopicMark");
  });
});

describe("formatTopicBlockList", () => {
  test("an empty context says so instead of showing a table", () => {
    expect(
      formatTopicBlockList(list({ blocks: [], contextMessageCount: 0 })),
    ).toBe("There is nothing in this conversation's context yet.");
  });

  test("an unmarked context explains how to mark one", () => {
    const output = formatTopicBlockList(list(), { topicMarkingEnabled: true });
    expect(output).toContain("No topic markers in this conversation yet.");
    expect(output).toContain("TopicMark");
  });

  test("an unmarked context with marking off says why", () => {
    const output = formatTopicBlockList(list(), { topicMarkingEnabled: false });
    expect(output).toContain("switched off");
  });

  test("lists blocks with counts, tokens, time, and boundary", () => {
    const output = formatTopicBlockList(
      list({
        blocks: [
          block({
            index: 1,
            title: "Auth token refresh",
            messageCount: 8,
            tokens: 612,
            startsAt: "2026-01-01T10:00:00.000Z",
          }),
          block({
            index: 2,
            rewindTurns: 2,
            startMarkerAnchorMessageId: "message-local-anchor",
          }),
        ],
        markers: [
          {
            marker: {
              id: "t1",
              title: "Auth token refresh",
              createdBy: "agent",
              anchorMessageId: "message-local-anchor",
              createdAt: "2026-01-01T10:00:00.000Z",
            },
            anchorIndex: 11,
          },
        ],
      }),
    );

    expect(output).toContain("Topic blocks in the current context");
    expect(output).toContain("Auth token refresh");
    expect(output).toContain("8 messages");
    expect(output).toContain("~   612 tokens");
    expect(output).toContain("2026-01-01 10:00");
    expect(output).toContain("boundary: the start of the context");
    expect(output).toContain("Current topic (not marked finished)");
    expect(output).toContain(
      'boundary: marker "Auth token refresh" at message-local-anchor, rewound 2 user turns',
    );
    expect(output).toContain("/compact <n> keeps block n");
    // The first block is not trimmable, so only block 2 carries the marker.
    expect(output).toContain("* = a block you can trim from.");
  });

  test("a tagged block shows when it was tagged, and the open one when it started", () => {
    // A compaction summary is stamped at fold time while the retained messages
    // keep their own (older) dates, so "when the content starts" would read as
    // if the table were out of order. The row says what it actually knows.
    const output = formatTopicBlockList(
      list({
        blocks: [
          block({
            index: 1,
            title: "Folded",
            taggedAt: "2026-01-03T09:00:00.000Z",
            startsAt: "2026-01-05T09:00:00.000Z",
          }),
          block({ index: 2 }),
        ],
        markers: [
          {
            marker: {
              id: "t1",
              title: "Folded",
              createdBy: "agent",
              anchorMessageId: "a1",
              createdAt: "2026-01-03T09:00:00.000Z",
            },
            anchorIndex: 0,
          },
        ],
      }),
    );

    expect(output).toContain("tagged at 2026-01-03 09:00");
    expect(output).not.toContain("from 2026-01-05");
    expect(output).toContain("open since 2026-01-01 10:00");
  });

  test("reports absorbed markers instead of hiding them", () => {
    const output = formatTopicBlockList(
      list({
        blocks: [
          block({
            index: 1,
            title: "Alpha",
            absorbedTitles: ["Beta", "Gamma"],
          }),
          block({ index: 2 }),
        ],
        markers: [
          {
            marker: {
              id: "t1",
              title: "Alpha",
              createdBy: "agent",
              anchorMessageId: null,
              createdAt: "2026-01-01T10:00:00.000Z",
            },
            anchorIndex: null,
          },
        ],
      }),
    );

    expect(output).toContain("absorbed markers: Beta, Gamma");
    // The phrase needs explaining once, and only when a block has absorbed names.
    expect(output).toContain("did not get a row of their own");
  });

  test("says when a block starts at a compaction summary", () => {
    // After a `/compact` the folded region is one message, and the marker that
    // ends the block was written before the fold — so without this line the row
    // looks like an ordinary topic that happens to have no messages left.
    const output = formatTopicBlockList(
      list({
        blocks: [
          block({ index: 1, title: "Alpha", compaction: true }),
          block({ index: 2 }),
        ],
        markers: [
          {
            marker: {
              id: "t1",
              title: "Alpha",
              createdBy: "user",
              anchorMessageId: null,
              createdAt: "2026-01-01T10:00:00.000Z",
            },
            anchorIndex: null,
          },
        ],
      }),
    );

    expect(output).toContain("starts at a compaction summary");
  });

  test("a single rewind turn is not pluralised", () => {
    const rows = buildTopicBlockRows(
      list({
        blocks: [
          block({ index: 1, title: "Alpha" }),
          block({
            index: 2,
            rewindTurns: 1,
            startMarkerAnchorMessageId: "anchor",
          }),
        ],
      }),
    );
    expect(rows[1]?.boundary).toContain("rewound 1 user turn");
    expect(rows[1]?.boundary).not.toContain("turns");
  });

  test("no rewind says so rather than showing 0 turns", () => {
    const rows = buildTopicBlockRows(
      list({
        blocks: [
          block({ index: 1, title: "Alpha" }),
          block({ index: 2, rewindTurns: 0, startMarkerAnchorMessageId: "a" }),
        ],
      }),
    );
    expect(rows[1]?.boundary).toContain("no rewind");
  });

  test("names the agent when the boundary came from its own marker", () => {
    const rows = buildTopicBlockRows(
      list({
        blocks: [
          block({ index: 1, title: "Alpha", createdBy: "agent" }),
          block({
            index: 2,
            rewindTurns: 0,
            startMarkerAnchorMessageId: "anchor",
          }),
        ],
      }),
    );
    expect(rows[1]?.boundary).toBe(
      'marker "Alpha" marked by the agent at anchor, no rewind',
    );
  });
});

describe("formatTopicMarkerHistory", () => {
  test("no markers says so", () => {
    const output = formatTopicMarkerHistory(list());
    expect(output).toContain("No topic markers in this conversation.");
  });

  test("distinguishes markers whose anchor is still in context", () => {
    const output = formatTopicMarkerHistory(
      list({
        markers: [
          {
            marker: {
              id: "t1",
              title: "Alpha",
              createdBy: "agent",
              anchorMessageId: "a6",
              createdAt: "2026-01-01T09:00:00.000Z",
            },
            anchorIndex: 11,
          },
          {
            marker: {
              id: "t2",
              title: "Beta",
              createdBy: "user",
              anchorMessageId: "gone",
              createdAt: "2026-01-01T09:30:00.000Z",
            },
            anchorIndex: null,
          },
        ],
      }),
    );

    expect(output).toContain("2, context order");
    expect(output).toContain("in the current context");
    expect(output).toContain("trimmed: its anchor is no longer in the context");
    expect(output).toContain("still searchable with /search");
    // The two orders are stated, not left implicit: rows follow the context,
    // numbers follow the transcript (`/topic show`).
    expect(output).toContain("write order");
  });

  test("rows follow the context while the numbers keep the write order", () => {
    // The shape a summarizer produces: its row is written last, but its topic
    // was folded into the leading summary, so in the context it comes first.
    const output = formatTopicMarkerHistory(
      list({
        markers: [
          {
            marker: {
              id: "t1",
              title: "Late written, early in the context",
              createdBy: "user",
              anchorMessageId: "a3",
              createdAt: "2026-01-01T09:00:00.000Z",
            },
            anchorIndex: 3,
          },
          {
            marker: {
              id: "t2",
              title: "Folded away",
              createdBy: "summarizer",
              anchorMessageId: null,
              createdAt: "2026-01-01T10:00:00.000Z",
            },
            anchorIndex: null,
          },
        ],
      }),
    );

    const folded = output.indexOf("Folded away");
    const late = output.indexOf("Late written");
    expect(folded).toBeGreaterThan(-1);
    expect(late).toBeGreaterThan(folded);
    // ... and the folded marker still carries its write-order number.
    expect(output).toContain("#2  Folded away");
    expect(output).toContain("#1  Late written");
  });

  test("rows carry author, time, and status", () => {
    const rows = buildTopicMarkerRows(
      list({
        markers: [
          {
            marker: {
              id: "t1",
              title: "Alpha",
              createdBy: "user",
              anchorMessageId: "a6",
              createdAt: "not-a-date",
            },
            anchorIndex: 11,
          },
        ],
      }),
    );
    expect(rows).toEqual([
      {
        index: 1,
        key: "t1",
        title: "Alpha",
        createdBy: "user",
        createdAt: "not-a-date",
        status: "in the current context",
        anchorIndex: 11,
      },
    ]);
  });
});
