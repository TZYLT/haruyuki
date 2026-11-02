// src/cli/app/pages/overview/overview-rows.test.ts

import { describe, expect, test } from "bun:test";
import {
  type PageRow,
  pageWindow,
  rowHeight,
  rowLineOffsets,
  selectableRows,
  stepSelectableRow,
} from "@/cli/app/pages/page-model";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import {
  agentRowId,
  buildAgentRows,
  buildConversationRows,
  conversationRowId,
  formatConversationCount,
  formatRelativeTime,
  NEW_AGENT_ROW_ID,
  NEW_SESSION_ROW_ID,
  OVERVIEW_EMPTY,
  overviewRowTarget,
} from "./overview-rows";
import type {
  OverviewAgentRecord,
  OverviewConversationRecord,
} from "./overview-types";

/**
 * The overview's row building, as pure arithmetic over the frozen data contract.
 *
 * What the tests pin is what the page shell (W-15) and the frame depend on:
 * the fixed first rows are ordinary selectable items; an agent is `1 + 2`
 * terminal lines and a conversation `1 + 3`; every continuation line is already
 * indented and clipped to the width it was handed; relative times are anchored
 * on the passed `nowMs` and nothing else; and the builders preserve the order
 * the data layer produced instead of re-sorting it per frame.
 */

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function agent(
  overrides: Partial<OverviewAgentRecord> = {},
): OverviewAgentRecord {
  return {
    agentId: "agent-1",
    name: "Haru",
    description: "the house agent",
    conversationCount: 2,
    totalConversationCount: 2,
    conversationCountTruncated: false,
    lastActivityAtMs: NOW - 5 * MINUTE,
    ...overrides,
  };
}

function conversation(
  overrides: Partial<OverviewConversationRecord> = {},
): OverviewConversationRecord {
  return {
    conversationId: "conv-1",
    agentId: "agent-1",
    title: "Fixing the build",
    lastActivityAtMs: NOW - 5 * MINUTE,
    createdAtMs: NOW - 2 * DAY,
    lastUserMessage: "what broke?",
    lastAgentMessage: "the lockfile",
    ...overrides,
  };
}

type ItemRow = Extract<PageRow, { kind: "item" }>;

function items(rows: readonly PageRow[]): ItemRow[] {
  return rows.filter((row): row is ItemRow => row.kind === "item");
}

function itemAt(rows: readonly PageRow[], index: number): ItemRow {
  const row = rows[index];
  if (row === undefined || row.kind !== "item") {
    throw new Error(`row ${index} is not an item`);
  }
  return row;
}

/** Every continuation line of every item must fit the width it was built for. */
function expectLinesWithin(rows: readonly PageRow[], width: number): void {
  for (const row of items(rows)) {
    for (const line of row.lines ?? []) {
      expect(terminalTextWidth(line)).toBeLessThanOrEqual(width);
    }
  }
}

describe("formatRelativeTime", () => {
  test("reads in the compact English the status faces use", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW, NOW - 59_999)).toBe("just now");
    expect(formatRelativeTime(NOW, NOW - MINUTE)).toBe("1m ago");
    expect(formatRelativeTime(NOW, NOW - 59 * MINUTE)).toBe("59m ago");
    expect(formatRelativeTime(NOW, NOW - HOUR)).toBe("1h ago");
    expect(formatRelativeTime(NOW, NOW - 23 * HOUR)).toBe("23h ago");
    expect(formatRelativeTime(NOW, NOW - DAY)).toBe("1d ago");
    expect(formatRelativeTime(NOW, NOW - 3 * DAY)).toBe("3d ago");
  });

  test("clamps a future timestamp to just now (clock skew, not tomorrow)", () => {
    expect(formatRelativeTime(NOW, NOW + HOUR)).toBe("just now");
  });

  test("missing or unusable timestamps are the em dash", () => {
    expect(formatRelativeTime(NOW, null)).toBe(OVERVIEW_EMPTY);
    expect(formatRelativeTime(NOW, Number.NaN)).toBe(OVERVIEW_EMPTY);
    expect(formatRelativeTime(NOW, Number.POSITIVE_INFINITY)).toBe(
      OVERVIEW_EMPTY,
    );
    expect(formatRelativeTime(Number.NaN, NOW)).toBe(OVERVIEW_EMPTY);
  });

  test("is anchored on the passed now, not on a fixed one", () => {
    const at = NOW - 5 * MINUTE;
    expect(formatRelativeTime(NOW, at)).toBe("5m ago");
    expect(formatRelativeTime(NOW + HOUR, at)).toBe("1h ago");
    expect(formatRelativeTime(NOW + DAY, at)).toBe("1d ago");
  });
});

describe("formatConversationCount", () => {
  test("renders the aggregate with the conv unit", () => {
    expect(formatConversationCount(0, false)).toBe("0 conv");
    expect(formatConversationCount(3, false)).toBe("3 conv");
    expect(formatConversationCount(1200, false)).toBe("1200 conv");
  });

  test("marks a capped aggregation pass with N+ (Q-37)", () => {
    expect(formatConversationCount(40, true)).toBe("40+ conv");
    // A zero count must not imply unseen conversations (Lead integration fix).
    expect(formatConversationCount(0, true)).toBe("0 conv");
  });

  test("keeps bad numbers off the row", () => {
    expect(formatConversationCount(-1, false)).toBe("0 conv");
    expect(formatConversationCount(2.9, false)).toBe("2 conv");
    expect(formatConversationCount(Number.NaN, false)).toBe("0 conv");
  });
});

describe("the agent level", () => {
  test("opens with the fixed New Agent row", () => {
    const rows = buildAgentRows({ agents: [], nowMs: NOW, width: 80 });
    expect(rows).toEqual([
      { kind: "item", id: NEW_AGENT_ROW_ID, label: "New Agent" },
    ]);
    // Selectable, and no continuation line: `Enter`/a click has to reach it.
    expect(itemAt(rows, 0).disabled).toBeUndefined();
    expect(rowHeight(itemAt(rows, 0))).toBe(1);
    expect(selectableRows(rows)).toEqual([0]);
  });

  test("separates the fixed row from the list with a paintable blank row", () => {
    const rows = buildAgentRows({
      agents: [agent()],
      nowMs: NOW,
      width: 80,
    });
    // Not `note`/`header`: only a `text` row keeps its height when empty
    // (`page-frame.tsx` paints `""` as one space).
    expect(rows[1]).toEqual({ kind: "text", text: "" });
  });

  test("is name + conversation count + last activity on the first line", () => {
    const rows = buildAgentRows({
      agents: [
        agent({
          totalConversationCount: 12,
          conversationCountTruncated: true,
          lastActivityAtMs: NOW - 30 * MINUTE,
        }),
      ],
      nowMs: NOW,
      width: 80,
    });
    const row = itemAt(rows, 2);
    expect(row.label).toBe("Haru");
    expect(row.hint).toBe("12+ conv");
    expect(row.value).toBe("30m ago");
  });

  test("shows the description indented, then the blank spacer line", () => {
    const rows = buildAgentRows({ agents: [agent()], nowMs: NOW, width: 80 });
    const row = itemAt(rows, 2);
    expect(row.lines).toEqual(["  the house agent", ""]);
    // The frozen multi-line contract: the composed first line plus `lines`.
    expect(rowHeight(row)).toBe(3);
  });

  test("missing description / activity / conversations degrade to the dash", () => {
    const rows = buildAgentRows({
      agents: [
        agent({
          description: null,
          lastActivityAtMs: null,
          conversationCount: 0,
          totalConversationCount: 0,
        }),
      ],
      nowMs: NOW,
      width: 80,
    });
    const row = itemAt(rows, 2);
    expect(row.lines?.[0]).toBe(`  ${OVERVIEW_EMPTY}`);
    expect(row.value).toBe(OVERVIEW_EMPTY);
    expect(row.hint).toBe("0 conv");
  });

  test("treats a blank description as missing and folds newlines", () => {
    const blank = buildAgentRows({
      agents: [agent({ description: "   " })],
      nowMs: NOW,
      width: 80,
    });
    expect(itemAt(blank, 2).lines?.[0]).toBe(`  ${OVERVIEW_EMPTY}`);

    const folded = buildAgentRows({
      agents: [agent({ name: "Haru\nAgent", description: "two\nlines" })],
      nowMs: NOW,
      width: 80,
    });
    expect(itemAt(folded, 2).label).toBe("Haru Agent");
    expect(itemAt(folded, 2).lines?.[0]).toBe("  two lines");
  });

  test("preserves the data layer's order instead of re-sorting per frame", () => {
    // Deliberately out of order: the snapshot is documented as already sorted by
    // last activity, and the row builder must not move a row under the cursor.
    const rows = buildAgentRows({
      agents: [
        agent({ agentId: "agent-older", lastActivityAtMs: NOW - 3 * HOUR }),
        agent({ agentId: "agent-newer", lastActivityAtMs: NOW - MINUTE }),
      ],
      nowMs: NOW,
      width: 80,
    });
    expect(items(rows).map((row) => row.id)).toEqual([
      NEW_AGENT_ROW_ID,
      agentRowId("agent-older"),
      agentRowId("agent-newer"),
    ]);
  });

  test("leaves label clipping to the frame, which owns that column", () => {
    const name = "A very long agent name that the label column will clip";
    const rows = buildAgentRows({
      agents: [agent({ name })],
      nowMs: NOW,
      width: 80,
    });
    expect(itemAt(rows, 2).label).toBe(name);
  });

  test("clips every continuation line to the page body width", () => {
    const long = agent({
      description:
        "a description long enough that a narrow band has to clip it somewhere",
    });
    for (const width of [12, 20, 40, 80]) {
      const rows = buildAgentRows({ agents: [long], nowMs: NOW, width });
      expectLinesWithin(rows, width);
    }
  });
});

describe("the conversation level", () => {
  test("opens with the fixed New Session row", () => {
    const rows = buildConversationRows({
      conversations: [],
      nowMs: NOW,
      width: 80,
    });
    expect(rows).toEqual([
      { kind: "item", id: NEW_SESSION_ROW_ID, label: "New Session" },
    ]);
    expect(itemAt(rows, 0).disabled).toBeUndefined();
    expect(rowHeight(itemAt(rows, 0))).toBe(1);
    expect(selectableRows(rows)).toEqual([0]);
  });

  test("is title + last activity + creation time on the first line", () => {
    const rows = buildConversationRows({
      conversations: [conversation()],
      nowMs: NOW,
      width: 80,
    });
    const row = itemAt(rows, 2);
    expect(row.label).toBe("Fixing the build");
    // `hint` is the sort key, `value` the creation age; the prefix keeps them
    // apart in reading order (R-10.3).
    expect(row.hint).toBe("5m ago");
    expect(row.value).toBe("created 2d ago");
  });

  test("shows both message snippets indented two columns, then the spacer", () => {
    const rows = buildConversationRows({
      conversations: [conversation()],
      nowMs: NOW,
      width: 80,
    });
    const row = itemAt(rows, 2);
    expect(row.lines).toEqual(["  what broke?", "  the lockfile", ""]);
    expect(rowHeight(row)).toBe(4);
  });

  test("keeps the snippet lines when a preview has not loaded", () => {
    const rows = buildConversationRows({
      conversations: [
        conversation({ lastUserMessage: null, lastAgentMessage: null }),
      ],
      nowMs: NOW,
      width: 80,
    });
    const row = itemAt(rows, 2);
    // Height is independent of the lazy preview: two dashes, not two fewer rows.
    expect(row.lines).toEqual([
      `  ${OVERVIEW_EMPTY}`,
      `  ${OVERVIEW_EMPTY}`,
      "",
    ]);
    expect(rowHeight(row)).toBe(4);
  });

  test("folds a multi-line message into its one snippet line", () => {
    const rows = buildConversationRows({
      conversations: [
        conversation({ lastUserMessage: "first line\n\nsecond line" }),
      ],
      nowMs: NOW,
      width: 80,
    });
    expect(itemAt(rows, 2).lines?.[0]).toBe("  first line second line");
  });

  test("missing activity / creation degrade to the dash", () => {
    const rows = buildConversationRows({
      conversations: [
        conversation({ lastActivityAtMs: null, createdAtMs: null }),
      ],
      nowMs: NOW,
      width: 80,
    });
    const row = itemAt(rows, 2);
    expect(row.hint).toBe(OVERVIEW_EMPTY);
    expect(row.value).toBe(OVERVIEW_EMPTY);
  });

  test("preserves the data layer's order instead of re-sorting per frame", () => {
    const rows = buildConversationRows({
      conversations: [
        conversation({ conversationId: "older", lastActivityAtMs: NOW - DAY }),
        conversation({
          conversationId: "newer",
          lastActivityAtMs: NOW - MINUTE,
        }),
      ],
      nowMs: NOW,
      width: 80,
    });
    expect(items(rows).map((row) => row.id)).toEqual([
      NEW_SESSION_ROW_ID,
      conversationRowId("older"),
      conversationRowId("newer"),
    ]);
  });

  test("clips every continuation line to the page body width", () => {
    const long = conversation({
      title: "a conversation title long enough to be clipped by the frame",
      lastUserMessage:
        "a user message long enough that a narrow band has to clip it too",
      lastAgentMessage:
        "an agent message long enough that a narrow band has to clip it too",
    });
    for (const width of [12, 20, 40, 80]) {
      const rows = buildConversationRows({
        conversations: [long],
        nowMs: NOW,
        width,
      });
      expectLinesWithin(rows, width);
    }
  });
});

describe("row targets", () => {
  test("round-trips ids to the action the page has to take", () => {
    expect(overviewRowTarget(NEW_AGENT_ROW_ID)).toEqual({ kind: "new-agent" });
    expect(overviewRowTarget(NEW_SESSION_ROW_ID)).toEqual({
      kind: "new-session",
    });
    expect(overviewRowTarget(agentRowId("agent:with:colons"))).toEqual({
      kind: "agent",
      agentId: "agent:with:colons",
    });
    expect(overviewRowTarget(conversationRowId("conv-1"))).toEqual({
      kind: "conversation",
      conversationId: "conv-1",
    });
  });

  test("rejects ids this module did not build", () => {
    expect(overviewRowTarget("overview:unknown")).toBeNull();
    expect(overviewRowTarget("")).toBeNull();
    expect(overviewRowTarget(agentRowId(""))).toBeNull();
    expect(overviewRowTarget(conversationRowId(""))).toBeNull();
  });
});

describe("heights and the page window", () => {
  test("agent rows are one line plus three, and select by item", () => {
    const rows = buildAgentRows({
      agents: [agent({ agentId: "a1" }), agent({ agentId: "a2" })],
      nowMs: NOW,
      width: 80,
    });
    const heights = rows.map(rowHeight);
    expect(heights).toEqual([1, 1, 3, 3]);
    expect(rowLineOffsets(rows)).toEqual([0, 1, 2, 5, 8]);

    // A body of exactly the eight lines fits; one line shorter reserves the two
    // markers and shows only what fits (`page-window` owns that arithmetic).
    const fits = pageWindow({
      count: rows.length,
      height: 8,
      offset: 0,
      heights,
    });
    expect(fits).toEqual({
      start: 0,
      end: 4,
      above: 0,
      below: 0,
      reserved: false,
    });
    const overflow = pageWindow({
      count: rows.length,
      height: 6,
      offset: 0,
      heights,
    });
    expect(overflow).toMatchObject({
      start: 0,
      end: 2,
      above: 0,
      below: 2,
      reserved: true,
    });

    // `↑↓` move by item (R-10.6): the blank `text` row is skipped.
    expect(stepSelectableRow(rows, 0, 1)).toBe(2);
    expect(stepSelectableRow(rows, 2, -1)).toBe(0);
    expect(stepSelectableRow(rows, 3, 1)).toBe(3);
  });

  test("conversation rows are one line plus four", () => {
    const rows = buildConversationRows({
      conversations: [
        conversation({ conversationId: "c1" }),
        conversation({ conversationId: "c2" }),
      ],
      nowMs: NOW,
      width: 80,
    });
    expect(rows.map(rowHeight)).toEqual([1, 1, 4, 4]);
    expect(rowLineOffsets(rows)).toEqual([0, 1, 2, 6, 10]);
    const fits = pageWindow({
      count: rows.length,
      height: 10,
      offset: 0,
      heights: rows.map(rowHeight),
    });
    expect(fits).toMatchObject({ start: 0, end: 4, reserved: false });
  });

  test("builds the same rows whatever the wall clock says", () => {
    const agents = [agent()];
    const conversations = [conversation()];
    const agentRows = buildAgentRows({ agents, nowMs: NOW, width: 80 });
    const conversationRows = buildConversationRows({
      conversations,
      nowMs: NOW,
      width: 80,
    });

    const realDateNow = Date.now;
    Date.now = () => NOW + 10 * 365 * DAY;
    try {
      expect(buildAgentRows({ agents, nowMs: NOW, width: 80 })).toEqual(
        agentRows,
      );
      expect(
        buildConversationRows({ conversations, nowMs: NOW, width: 80 }),
      ).toEqual(conversationRows);
    } finally {
      Date.now = realDateNow;
    }
  });
});
