import { afterEach, expect, test } from "bun:test";
import {
  resetAmbiguousWidthForTests,
  setAmbiguousWidth,
  terminalTextWidth,
} from "@/cli/helpers/char-width";
import { padStatusSpinnerFrame } from "./StreamingStatusSpinner";

afterEach(() => {
  resetAmbiguousWidthForTests();
});

test("the fallback frame is centered by the terminal's columns, not string-width's", () => {
  // `·` is ambiguous: one column under Consolas, two under a CJK console face.
  // Padding it by one column leaves a two-column glyph in a one-column slot, and
  // everything after the spinner moves.
  setAmbiguousWidth(1);
  const narrow = padStatusSpinnerFrame("\u00b7", 3);
  expect(narrow).toBe(" \u00b7 ");
  expect(terminalTextWidth(narrow)).toBe(3);

  setAmbiguousWidth(2);
  const wide = padStatusSpinnerFrame("\u00b7", 3);
  expect(wide).toBe("\u00b7 ");
  expect(terminalTextWidth(wide)).toBe(3);
});

test("an unambiguous braille frame is centered the same way", () => {
  setAmbiguousWidth(2);
  expect(padStatusSpinnerFrame("\u280b", 3)).toBe(" \u280b ");
  // A frame wider than the slot is not padded negative.
  expect(padStatusSpinnerFrame("\u280b\u280b", 1)).toBe("\u280b\u280b");
});
