import { describe, expect, test } from "bun:test";
import { lineText, segmentAt } from "@/cli/app/pages/click-line";

/**
 * Where a click on a page header's line lands.
 *
 * The header is one row of text, so the pointer's answer is arithmetic on the
 * same string that is drawn: offsets are counted in terminal cells (a wide label
 * is two), and the words are the only segments with somewhere to go. Two pages
 * aim through this module — the settings breadcrumb and the usage screen
 * switcher — so the cases are stated on a line shaped like the usage header,
 * where a prefix, a word, a gap, the other word and a trailing hint all appear.
 */
const HEADER = [
  { label: "Usage / " },
  { label: "Overview", target: "overview" as const },
  { label: "   " },
  { label: "Detail", target: "detail" as const },
  { label: "   2026-10-22   Tab switch" },
];

describe("lineText", () => {
  test("joins the labels with the separator the header draws", () => {
    expect(lineText([{ label: "Settings" }, { label: "Allow" }], " / ")).toBe(
      "Settings / Allow",
    );
    // Abutting segments (the usage header) need no separator.
    expect(lineText([{ label: "a" }, { label: "b" }])).toBe("ab");
  });
});

describe("segmentAt", () => {
  test("only a word's own cells point at it", () => {
    // "Usage / " is 0..7 and names the page, not a destination.
    expect(segmentAt(HEADER, 0)).toBe(HEADER[0]);
    expect(segmentAt(HEADER, 7)?.target).toBeUndefined();
    // "Overview" is 8..15.
    expect(segmentAt(HEADER, 8)).toBe(HEADER[1]);
    expect(segmentAt(HEADER, 15)).toBe(HEADER[1]);
    // The three-cell gap at 16..18 is its own segment, with no target.
    expect(segmentAt(HEADER, 16)).toBe(HEADER[2]);
    expect(segmentAt(HEADER, 18)).toBe(HEADER[2]);
    // "Detail" is 19..24.
    expect(segmentAt(HEADER, 19)).toBe(HEADER[3]);
    expect(segmentAt(HEADER, 24)).toBe(HEADER[3]);
    // The date and the key hint after it are told, not aimed at.
    expect(segmentAt(HEADER, 25)?.target).toBeUndefined();
    expect(segmentAt(HEADER, 60)).toBeUndefined();
  });

  test("a separator's cells belong to neither segment", () => {
    const crumbs = [
      { label: "Settings", target: "root" as const },
      { label: "Allow" },
    ];
    expect(segmentAt(crumbs, 0, " / ")).toEqual(crumbs[0]);
    expect(segmentAt(crumbs, 7, " / ")).toEqual(crumbs[0]);
    // " / " is 8..10 and belongs to neither segment.
    expect(segmentAt(crumbs, 8, " / ")).toBeUndefined();
    expect(segmentAt(crumbs, 10, " / ")).toBeUndefined();
    expect(segmentAt(crumbs, 11, " / ")).toEqual(crumbs[1]);
  });

  test("a two-cell label occupies two cells", () => {
    const wide = [
      { label: "设置", target: "overview" as const },
      { label: "x" },
    ];
    expect(segmentAt(wide, 3)).toEqual(wide[0]);
    expect(segmentAt(wide, 4)).toEqual(wide[1]);
  });

  test("past the end of the line there is no segment", () => {
    expect(segmentAt([], 0)).toBeUndefined();
  });
});
