import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@/cli/display/statusline/formatting";
import {
  layoutTabStrip,
  TAB_STRIP_ROWS,
  TAB_TITLE_COLUMNS,
  type TabStripItem,
  type TabStripLayout,
  type TabStripRegion,
} from "./tab-strip-layout";

/**
 * The tab row's geometry, which the frame and the click hit-test both read.
 *
 * The strip is the one place where a wrong answer is invisible in a state
 * assertion and obvious on screen: a title cut at the wrong column, a `+N` that
 * covers a tab the user can still click, a `×` hot zone one column off. So the
 * assertions are about the painted columns, and the click regions are checked
 * against the same text the row draws.
 */

function conversation(
  id: string,
  overrides: Partial<TabStripItem> = {},
): TabStripItem {
  return {
    id,
    kind: "conversation",
    title: id,
    active: false,
    unread: false,
    closeable: true,
    ...overrides,
  };
}

function page(id: "usage" | "settings", active = false): TabStripItem {
  return {
    id,
    kind: "page",
    title: id === "usage" ? "Usage" : "Settings",
    active,
    unread: false,
    closeable: false,
  };
}

function draw(layout: TabStripLayout): string {
  return layout.segments.map((segment) => segment.text).join("");
}

/** The text a region covers, i.e. what a click on it lands on. */
function covered(layout: TabStripLayout, region: TabStripRegion): string {
  return draw(layout).slice(region.from - 1, region.to);
}

const TAB_STRIP_ROWS_ARE_TWO = () => expect(TAB_STRIP_ROWS).toBe(2);

describe("the tab row", () => {
  test("a conversation tab strip fills exactly its columns", () => {
    TAB_STRIP_ROWS_ARE_TWO();
    const layout = layoutTabStrip(
      [
        conversation("a", { title: "M6 shell", active: true }),
        conversation("b", { title: "Ledger" }),
        conversation("c", { title: "Diff face" }),
        page("usage"),
        page("settings"),
      ],
      100,
    );

    const text = draw(layout);
    expect(visibleWidth(text)).toBe(100);
    // The current tab is marked, the others are not.
    expect(text).toStartWith("> M6 shell");
    expect(text).toContain("Ledger");
    expect(text).toContain("Diff face");
    // Pages pinned right, `Usage` immediately left of `Settings`.
    expect(text).toEndWith("Settings");
    expect(text.indexOf("Usage")).toBeGreaterThan(-1);
    expect(text.indexOf("Usage")).toBeLessThan(text.indexOf("Settings"));
    // One row of segments, one row of nothing: the rule is the component's.
    expect(
      layout.segments.every((segment) => !segment.text.includes("\n")),
    ).toBe(true);
  });

  test("a title is truncated to twelve columns and wide characters survive", () => {
    const layout = layoutTabStrip(
      [
        conversation("a", {
          title: "数据库迁移与回滚策略的完整评审记录",
          active: true,
        }),
      ],
      100,
    );
    const name = layout.segments.find((segment) => segment.part === "name");
    expect(name).toBeDefined();
    // `> ` plus one unread column of marker is not part of the title budget.
    const title = (name?.text ?? "").replace(/^> /, "");
    expect(visibleWidth(title)).toBeLessThanOrEqual(TAB_TITLE_COLUMNS);
    expect(title).toEndWith("…");
  });

  test("tabs that do not fit collapse into +N from the right", () => {
    const items = [
      conversation("a", { title: "long name one", active: true }),
      conversation("b", { title: "long name two" }),
      conversation("c", { title: "long name three" }),
      conversation("d", { title: "long name four" }),
      conversation("e", { title: "long name five" }),
      page("usage"),
      page("settings"),
    ];
    const layout = layoutTabStrip(items, 80);
    const text = draw(layout);

    expect(visibleWidth(text)).toBe(80);
    // Some tabs were dropped and counted.
    const marker = /\+(\d+)/.exec(text);
    expect(marker).not.toBeNull();
    const dropped = Number(marker?.[1] ?? 0);
    expect(dropped).toBeGreaterThan(0);
    // The current tab is never the one dropped, and the pages stay pinned.
    expect(text).toStartWith("> long name");
    expect(text).toEndWith("Settings");
    expect(text.indexOf("Usage")).toBeLessThan(text.indexOf("Settings"));
    // The count matches what is missing: every conversation tab is either drawn
    // with its `×` or counted in the marker.
    const drawnTabs = layout.regions.filter(
      (region) => region.part === "close",
    ).length;
    expect(drawnTabs + dropped).toBe(5);
    // Even at 80 columns the row is not overrun.
    expect(text.length).toBeLessThanOrEqual(80 + 8);
  });

  test("the current tab is kept even when it is the last of many", () => {
    const items = [
      conversation("a", { title: "alpha bravo" }),
      conversation("b", { title: "charlie delta" }),
      conversation("c", { title: "echo foxtrot" }),
      conversation("d", { title: "golf hotel", active: true }),
      page("settings"),
    ];
    const layout = layoutTabStrip(items, 60);
    const text = draw(layout);
    expect(text).toContain("> golf hotel");
    expect(visibleWidth(text)).toBe(60);
  });

  test("an unread conversation is marked before its title", () => {
    const layout = layoutTabStrip(
      [
        conversation("a", { title: "M6 shell", active: true }),
        conversation("b", { title: "Ledger", unread: true }),
      ],
      100,
    );
    const text = draw(layout);
    expect(text).toContain("• Ledger");
    // The unread mark is reserved on every cell, so the names still line up.
    expect(text).toContain("> M6 shell");
  });

  test("a closeable tab carries a × hot zone, one column wider than the glyph", () => {
    const layout = layoutTabStrip(
      [
        conversation("a", { title: "M6 shell", active: true }),
        conversation("b", { title: "Ledger", closeable: false }),
        page("settings"),
      ],
      100,
    );
    const closes = layout.regions.filter((region) => region.part === "close");
    expect(closes.map((region) => region.id)).toEqual(["a"]);
    expect(covered(layout, closes[0] as TabStripRegion)).toBe(" ×");
  });

  test("every region covers exactly the text it names", () => {
    const layout = layoutTabStrip(
      [
        conversation("a", { title: "M6 shell", active: true }),
        conversation("b", { title: "Ledger", unread: true }),
        page("usage"),
        page("settings", true),
      ],
      90,
    );
    const names = layout.regions.filter((region) => region.part === "name");
    expect(names.map((region) => region.id)).toEqual([
      "a",
      "b",
      "usage",
      "settings",
    ]);
    expect(covered(layout, names[0] as TabStripRegion)).toBe("> M6 shell");
    expect(covered(layout, names[1] as TabStripRegion)).toBe("  • Ledger");
    expect(covered(layout, names[2] as TabStripRegion)).toBe("  Usage");
    expect(covered(layout, names[3] as TabStripRegion)).toBe("> Settings");

    // Regions do not overlap and stay inside the row.
    for (const region of layout.regions) {
      expect(region.from).toBeLessThanOrEqual(region.to);
      expect(region.to).toBeLessThanOrEqual(layout.columns);
    }
  });

  test("the pages are admitted from the right: Usage first to go", () => {
    // Wide enough for both pages plus the current tab, narrow enough that
    // keeping `Usage` would not leave room for a second conversation.
    const items = [
      conversation("a", { title: "M6 shell", active: true }),
      conversation("b", { title: "Ledger" }),
      page("usage"),
      page("settings"),
    ];
    const withBoth = layoutTabStrip(items, 100);
    expect(draw(withBoth)).toContain("Usage");
    expect(draw(withBoth)).toContain("Settings");

    // Squeeze until only `Settings` fits; `Usage` is the one that goes.
    const narrow = layoutTabStrip(items, 26);
    const text = draw(narrow);
    expect(text).toContain("Settings");
    expect(text).not.toContain("Usage");
    expect(text).toContain("> M6 shell");

    // Too narrow even for that: the conversation tabs keep the row.
    const tiny = layoutTabStrip(items, 12);
    expect(draw(tiny)).toContain("> M6 shell");
    expect(draw(tiny)).not.toContain("Settings");
  });

  test("no items and no columns draw nothing", () => {
    expect(layoutTabStrip([], 80).segments).toEqual([]);
    expect(
      layoutTabStrip([conversation("a", { active: true })], 0).segments,
    ).toEqual([]);
  });

  test("a row that fills the terminal exactly is not pushed past it", () => {
    // `> ` plus a six-column title is eight columns; at eight columns the row is
    // the whole terminal, so there is no room for a padding column. Padding there
    // anyway put the tab's last column outside the screen — painted clipped, and
    // its click region unreachable.
    const layout = layoutTabStrip(
      [conversation("a", { title: "abcdef", active: true, closeable: false })],
      8,
    );
    const text = draw(layout);
    expect(visibleWidth(text)).toBe(8);
    expect(layout.regions.map((region) => [region.from, region.to])).toEqual([
      [1, 8],
    ]);
  });
});

/**
 * The row's invariants, at every width a terminal is actually opened at: it fills
 * the columns it was given, every click rectangle stays inside them, and the
 * current tab is never the one that collapsed away.
 *
 * A layout is the one thing here that a state assertion cannot judge — before the
 * exact-fill case above, every unit test passed while an eight-column terminal drew
 * nine columns.
 */
describe("the tab row, at every width", () => {
  const ITEMS: TabStripItem[] = [
    conversation("a", { title: "M6 shell work", active: true, unread: true }),
    conversation("b", { title: "Ledger" }),
    conversation("c", { title: "Diff face review" }),
    conversation("d", { title: "数据库迁移与回滚策略", unread: true }),
    page("usage"),
    page("settings"),
  ];

  test("the row fills the terminal and its regions stay inside it", () => {
    for (let columns = 24; columns <= 140; columns += 1) {
      const layout = layoutTabStrip(ITEMS, columns);
      // The pair carries `columns` into the failure message: a bare `toBe` on 140
      // iterations reports "expected 57, got 58" with no way to tell which width.
      expect({ columns, width: visibleWidth(draw(layout)) }).toEqual({
        columns,
        width: columns,
      });

      let previousTo = 0;
      for (const region of layout.regions) {
        // An explicit message: "expected 57, got 58" over 117 widths names neither
        // the width nor the region.
        if (region.from <= previousTo || region.to > columns) {
          throw new Error(
            `columns ${columns}: region ${JSON.stringify(region)} is outside the row`,
          );
        }
        previousTo = region.to;
      }
    }
  });

  test("the current tab is never the one collapsed away", () => {
    for (let columns = 24; columns <= 140; columns += 1) {
      const layout = layoutTabStrip(ITEMS, columns);
      const names = layout.regions
        .filter((region) => region.part === "name")
        .map((region) => region.id);
      expect({ columns, hasCurrent: names.includes("a") }).toEqual({
        columns,
        hasCurrent: true,
      });
    }
  });
});
