import { describe, expect, test } from "bun:test";
import {
  buildVisibleItems,
  hasFocusedApprovalItem,
  shouldRenderLiveItem,
} from "@/cli/app/live-items";
import type { StaticItem } from "@/cli/app/types";
import type { Line } from "@/cli/helpers/accumulator";

const EMPTY_IDS: ReadonlySet<string> = new Set();

function plainToolCall(id: string): Line {
  return {
    kind: "tool_call",
    id,
    toolCallId: id,
    name: "Read",
    phase: "ready",
  };
}

function shellToolCall(id: string): Line {
  return {
    kind: "tool_call",
    id,
    toolCallId: id,
    name: "Bash",
    phase: "streaming",
  };
}

const COMMITTED: StaticItem = { kind: "separator", id: "separator" };

describe("buildVisibleItems", () => {
  test("commits first, then the live items that draw a row", () => {
    const items = buildVisibleItems({
      staticItems: [COMMITTED],
      liveItems: [plainToolCall("read-1")],
      currentApprovalToolCallId: undefined,
      pendingIds: EMPTY_IDS,
      queuedIds: EMPTY_IDS,
    });

    expect(items.map((item) => item.id)).toEqual(["separator", "read-1"]);
  });

  test("drops the live items the filter rejects", () => {
    const streamingShell = shellToolCall("bash-1");

    expect(
      shouldRenderLiveItem(streamingShell, {
        currentApprovalToolCallId: undefined,
        pendingIds: EMPTY_IDS,
        queuedIds: EMPTY_IDS,
      }),
    ).toBe(false);

    expect(
      buildVisibleItems({
        staticItems: [COMMITTED],
        liveItems: [streamingShell],
        currentApprovalToolCallId: undefined,
        pendingIds: EMPTY_IDS,
        queuedIds: EMPTY_IDS,
      }).map((item) => item.id),
    ).toEqual(["separator"]);
  });

  test("keeps a shell tool call whose approval owns focus", () => {
    expect(
      buildVisibleItems({
        staticItems: [],
        liveItems: [shellToolCall("bash-1")],
        currentApprovalToolCallId: "bash-1",
        pendingIds: EMPTY_IDS,
        queuedIds: EMPTY_IDS,
      }).map((item) => item.id),
    ).toEqual(["bash-1"]);
  });
});

describe("hasFocusedApprovalItem", () => {
  const items: StaticItem[] = [COMMITTED, plainToolCall("read-1")];

  test("is true when nothing is focused", () => {
    expect(hasFocusedApprovalItem(items, undefined)).toBe(true);
    expect(hasFocusedApprovalItem([], undefined)).toBe(true);
  });

  test("finds the focused tool call among the items", () => {
    expect(hasFocusedApprovalItem(items, "read-1")).toBe(true);
  });

  test("is false when the item list has no such tool call", () => {
    // The backfill cap can drop the tool call and the window can scroll past it:
    // both leave the approval without a row of its own.
    expect(hasFocusedApprovalItem(items, "gap-9")).toBe(false);
    expect(hasFocusedApprovalItem([], "gap-9")).toBe(false);
    expect(hasFocusedApprovalItem([COMMITTED], "gap-9")).toBe(false);
  });
});
