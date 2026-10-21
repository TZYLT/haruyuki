import { afterEach, describe, expect, test } from "bun:test";
import {
  clearHoverIn,
  getHoverTarget,
  isRowHovered,
  resetHoverForTests,
  setHoverTarget,
  subscribeToHover,
} from "@/cli/helpers/hover-store";

afterEach(() => {
  resetHoverForTests();
});

/**
 * The hover store's whole contract is "one row, and only on a change".
 *
 * The second half is the one that matters on a real terminal: any-motion reports
 * a cell every time the pointer crosses one, and a store that published on every
 * report would repaint the row under the pointer dozens of times a second — the
 * per-motion re-render 《38》§19.3 5 forbids.
 */
describe("the hover store", () => {
  test("holds one row at a time", () => {
    setHoverTarget({ area: "page", index: 3 });
    expect(isRowHovered("page", 3)).toBe(true);
    expect(isRowHovered("page", 2)).toBe(false);
    // The area matters: two surfaces can both have a row 3.
    expect(isRowHovered("tabs", 3)).toBe(false);

    setHoverTarget({ area: "tabs", index: 1 });
    expect(isRowHovered("page", 3)).toBe(false);
    expect(isRowHovered("tabs", 1)).toBe(true);
  });

  test("publishes only when the row actually changes", () => {
    let publishes = 0;
    const unsubscribe = subscribeToHover(() => {
      publishes += 1;
    });

    setHoverTarget({ area: "page", index: 3 });
    setHoverTarget({ area: "page", index: 3 });
    setHoverTarget({ area: "page", index: 3 });
    expect(publishes).toBe(1);

    setHoverTarget({ area: "page", index: 4 });
    expect(publishes).toBe(2);

    // Clearing when nothing is hovered is not a change either.
    setHoverTarget(null);
    setHoverTarget(null);
    expect(publishes).toBe(3);

    unsubscribe();
  });

  test("clearing one area leaves another alone", () => {
    setHoverTarget({ area: "tabs", index: 0 });
    clearHoverIn("page");
    expect(getHoverTarget()).toEqual({ area: "tabs", index: 0 });

    clearHoverIn("tabs");
    expect(getHoverTarget()).toBeNull();
  });
});
