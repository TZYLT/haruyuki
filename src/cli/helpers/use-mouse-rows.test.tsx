import { afterEach, describe, expect, test } from "bun:test";
import { Box, type DOMElement, Text } from "ink";
import { useRef } from "react";
import {
  getHoverTarget,
  resetHoverForTests,
  useRowHovered,
} from "@/cli/helpers/hover-store";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { useMouseRows } from "@/cli/helpers/use-mouse-rows";
import { useInputRouter } from "@/cli/hooks/use-input-router";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The row half of the pointer: a click is the row's `Enter`, hover is one row,
 * and rows a surface does not act on are transparent.
 *
 * The geometry here is real, not stubbed: the rows sit in a Box the component
 * measures with Ink's own `measureElement`, so what is judged is the conversion
 * from the layout tree (0-based) to mouse coordinates (1-based) as well. That
 * conversion is off by one in one of the two directions whenever it has been
 * wrong in this tree, and the screen is where it shows.
 */

const ESC = "\u001B";

/** A left press / release at a cell. */
const pressAt = (column: number, row: number) => `${ESC}[<0;${column};${row}M`;
const releaseAt = (column: number, row: number) =>
  `${ESC}[<0;${column};${row}m`;
/** Any-motion (`1003`), which is what a hover sees: no button down. */
const moveTo = (column: number, row: number) => `${ESC}[<35;${column};${row}M`;

type Harness = {
  activated: number[];
};

function Row({
  area,
  index,
  label,
}: {
  area: string;
  index: number;
  label: string;
}) {
  // The same subscription a real row uses (`useRowHovered`): a boolean snapshot,
  // so only the two rows a move involves re-render. The frame is asserted, so the
  // hover has to be visible in it — a background colour is stripped by the frame
  // reader, a marker is not.
  const hovered = useRowHovered(area, index);
  return (
    <Text>
      {label}
      {hovered ? "*" : " "}
    </Text>
  );
}

function List({
  harness,
  interactive = () => true,
}: {
  harness: Harness;
  interactive?: (index: number) => boolean;
}) {
  useInputRouter();
  const ref = useRef<DOMElement | null>(null);
  useMouseRows({
    area: "test",
    ref,
    rowCount: 3,
    isInteractive: interactive,
    activate: (index) => {
      harness.activated.push(index);
    },
  });
  return (
    <Box ref={ref} flexDirection="column">
      {["a", "b", "c"].map((label, index) => (
        <Row key={label} area="test" index={index} label={label} />
      ))}
    </Box>
  );
}

function mount(options: { interactive?: (index: number) => boolean } = {}) {
  const harness: Harness = { activated: [] };
  const tty = mountInkTty(<List harness={harness} {...options} />, {
    columns: 40,
    rows: 10,
  });
  return { harness, tty };
}

afterEach(() => {
  resetInkTtyState();
  resetMouseHandlers();
  resetHoverForTests();
  resetMouseTrackingForTests();
  resetBindingOwners();
});

describe("a block of rows", () => {
  test("a click on row N runs row N's Enter exactly once", async () => {
    const { harness, tty } = mount();
    try {
      // Row 0 is screen row 1: the layout tree's y is 0 and a report is 1-based.
      await tty.press(pressAt(2, 2), releaseAt(2, 2));
      expect(harness.activated).toEqual([1]);
    } finally {
      tty.stop();
    }
  });

  test("a drag that starts on a row is not a click", async () => {
    const { harness, tty } = mount();
    try {
      await tty.press(pressAt(2, 1), releaseAt(2, 3));
      expect(harness.activated).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("a press outside the block is declined, so the layer below can have it", async () => {
    const { harness, tty } = mount();
    try {
      // Below the three rows: nothing of this block is there.
      await tty.press(pressAt(2, 8), releaseAt(2, 8));
      expect(harness.activated).toEqual([]);
      // Left of the block's first column.
      await tty.press(pressAt(1, 2), releaseAt(1, 2));
      expect(harness.activated).toEqual([1]);
    } finally {
      tty.stop();
    }
  });

  test("hover lights one row at a time, and leaving clears it", async () => {
    const { tty } = mount();
    try {
      await tty.press(moveTo(2, 2));
      expect(getHoverTarget()).toEqual({ area: "test", index: 1 });
      expect(await tty.text()).toContain("b*");

      await tty.press(moveTo(2, 3));
      expect(getHoverTarget()).toEqual({ area: "test", index: 2 });
      const rows = await tty.text();
      expect(rows).toContain("c*");
      expect(rows).not.toContain("b*");

      // Off the block entirely.
      await tty.press(moveTo(2, 9));
      expect(getHoverTarget()).toBeNull();
    } finally {
      tty.stop();
    }
  });

  test("a row the surface does not act on is transparent to the pointer", async () => {
    // The same rule `↑↓` follows: a group title or a disabled row cannot be the
    // cursor, so it cannot be clicked or lit either.
    const { harness, tty } = mount({
      interactive: (index) => index !== 1,
    });
    try {
      await tty.press(pressAt(2, 2), releaseAt(2, 2));
      expect(harness.activated).toEqual([]);

      await tty.press(moveTo(2, 2));
      expect(getHoverTarget()).toBeNull();

      // Its neighbours still work, which is what proves the row was skipped rather
      // than the block being dead.
      await tty.press(pressAt(2, 1), releaseAt(2, 1));
      expect(harness.activated).toEqual([0]);
    } finally {
      tty.stop();
    }
  });
});
