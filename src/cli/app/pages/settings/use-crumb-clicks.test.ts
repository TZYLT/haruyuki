import { describe, expect, test } from "bun:test";
import {
  CRUMB_SEPARATOR,
  crumbAt,
  crumbText,
} from "@/cli/app/pages/settings/use-crumb-clicks";

/**
 * Where a click on the breadcrumb lands.
 *
 * The header is one row of text, so the pointer's answer is arithmetic on the same
 * string that is drawn: offsets are counted in terminal cells (`terminalTextWidth`
 * — a CJK label is two), and the separators between the segments belong to nobody.
 * The reported defect this answers is simpler than the arithmetic: there was no
 * pointer target for "one level up" at all.
 */
const CRUMBS = [
  { label: "Settings", target: "root" as const },
  { label: "Permissions", target: "permissions" as const },
  { label: "Allow" },
];

describe("crumb hit testing", () => {
  test("the line is the labels joined by one separator", () => {
    expect(crumbText(CRUMBS)).toBe(
      `Settings${CRUMB_SEPARATOR}Permissions${CRUMB_SEPARATOR}Allow`,
    );
  });

  test("each segment's own cells point at it", () => {
    // "Settings" occupies 0..7.
    expect(crumbAt(CRUMBS, 0)).toBe(CRUMBS[0]);
    expect(crumbAt(CRUMBS, 7)).toBe(CRUMBS[0]);
    // " / " is 8..10 and belongs to neither segment.
    expect(crumbAt(CRUMBS, 8)).toBeUndefined();
    expect(crumbAt(CRUMBS, 10)).toBeUndefined();
    // "Permissions" starts at 11.
    expect(crumbAt(CRUMBS, 11)).toBe(CRUMBS[1]);
    expect(crumbAt(CRUMBS, 21)).toBe(CRUMBS[1]);
    expect(crumbAt(CRUMBS, 22)).toBeUndefined();
    // "Allow" is the last segment and has no target: clicking it goes nowhere.
    expect(crumbAt(CRUMBS, 25)).toBe(CRUMBS[2]);
    expect(crumbAt(CRUMBS, 25)?.target).toBeUndefined();
  });

  test("past the end of the line there is no segment", () => {
    expect(crumbAt(CRUMBS, 40)).toBeUndefined();
  });

  test("a two-cell label is measured as two cells", () => {
    const wide = [{ label: "设置", target: "root" as const }, { label: "x" }];
    // Both characters take two columns: the separator starts at 4.
    expect(crumbAt(wide, 3)).toBe(wide[0]);
    expect(crumbAt(wide, 4)).toBeUndefined();
    expect(crumbAt(wide, 7)).toBe(wide[1]);
  });
});
