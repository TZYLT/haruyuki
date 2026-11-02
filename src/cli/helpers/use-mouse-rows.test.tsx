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

/**
 * A windowed block: the shape a page draws when its body overflows — an optional
 * `↑ N more` marker, the items, an optional `↓ N more` marker.
 *
 * `heights` is the same `rowHeight` list a page hands `pageWindow`, so this is
 * the real combination W-09 wired: item lines (multi-line items), a marker row
 * inside the measured box (`firstRow`), and the identity mapping the pre-T-10
 * surfaces use (`spans` omitted).
 */
type WindowProps = {
  harness: Harness;
  heights: readonly number[];
  above?: number;
  below?: number;
  /** Omit to exercise the identity mapping. */
  spans?: boolean;
  firstRow?: number;
  interactive?: (index: number) => boolean;
};

const LETTERS = ["a", "b", "c", "d", "e", "f"];

function WindowedList({
  harness,
  heights,
  above = 0,
  below = 0,
  spans = true,
  firstRow = 0,
  interactive,
}: WindowProps) {
  useInputRouter();
  const ref = useRef<DOMElement | null>(null);
  useMouseRows({
    area: "test",
    ref,
    rowCount: heights.length,
    firstRow,
    ...(spans ? { spans: heights } : {}),
    ...(interactive === undefined ? {} : { isInteractive: interactive }),
    activate: (index) => {
      harness.activated.push(index);
    },
  });
  return (
    <Box ref={ref} flexDirection="column">
      {above > 0 && <Text dimColor>{`↑ ${above} more`}</Text>}
      {heights.map((height, index) => (
        <Box key={LETTERS[index]} flexDirection="column">
          {Array.from({ length: height }, (_, line) => (
            <Text key={`${LETTERS[index]}:${line}`}>
              {LETTERS[index]}
              {line === 0 ? "" : `.${line}`}
            </Text>
          ))}
        </Box>
      ))}
      {below > 0 && <Text dimColor>{`↓ ${below} more`}</Text>}
    </Box>
  );
}

function mountWindow(props: Omit<WindowProps, "harness">) {
  const harness: Harness = { activated: [] };
  const tty = mountInkTty(<WindowedList harness={harness} {...props} />, {
    columns: 40,
    rows: 12,
  });
  return { harness, tty };
}

describe("a block of multi-line items", () => {
  test("a click on any line of an item activates that item", async () => {
    // Three items: a three-line one, a one-line one, a two-line one.
    const { harness, tty } = mountWindow({ heights: [3, 1, 2] });
    try {
      // Screen rows 1–3 are item 0, 4 is item 1, 5–6 are item 2.
      for (const row of [1, 2, 3, 4, 5, 6]) {
        await tty.press(pressAt(2, row), releaseAt(2, row));
      }
      expect(harness.activated).toEqual([0, 0, 0, 1, 2, 2]);
    } finally {
      tty.stop();
    }
  });

  test("hover on any line of an item lights that item", async () => {
    const { tty } = mountWindow({ heights: [3, 1, 2] });
    try {
      for (const [row, index] of [
        [2, 0],
        [3, 0],
        [4, 1],
        [6, 2],
      ] as const) {
        await tty.press(moveTo(2, row));
        expect(getHoverTarget()).toEqual({ area: "test", index });
      }
      // One line past the last item: no item, so the hover is cleared.
      await tty.press(moveTo(2, 7));
      expect(getHoverTarget()).toBeNull();
    } finally {
      tty.stop();
    }
  });

  test("a line below the items — the `↓ N more` row — is not a target", async () => {
    const { harness, tty } = mountWindow({ heights: [2, 1], below: 5 });
    try {
      // Rows 1–2 are item 0, row 3 is item 1, row 4 is the marker.
      await tty.press(pressAt(2, 4), releaseAt(2, 4));
      await tty.press(moveTo(2, 4));
      expect(harness.activated).toEqual([]);
      expect(getHoverTarget()).toBeNull();

      // The items themselves still answer, so the block is not dead.
      await tty.press(pressAt(2, 3), releaseAt(2, 3));
      expect(harness.activated).toEqual([1]);
    } finally {
      tty.stop();
    }
  });

  test("a disabled item is transparent on every line it draws", async () => {
    const { harness, tty } = mountWindow({
      heights: [2, 2],
      interactive: (index) => index !== 0,
    });
    try {
      await tty.press(pressAt(2, 1), releaseAt(2, 1));
      await tty.press(pressAt(2, 2), releaseAt(2, 2));
      expect(harness.activated).toEqual([]);
      await tty.press(moveTo(2, 2));
      expect(getHoverTarget()).toBeNull();

      await tty.press(pressAt(2, 4), releaseAt(2, 4));
      expect(harness.activated).toEqual([1]);
      await tty.press(moveTo(2, 3));
      expect(getHoverTarget()).toEqual({ area: "test", index: 1 });
    } finally {
      tty.stop();
    }
  });
});

describe("a windowed block with a `↑ N more` marker", () => {
  test("firstRow keeps the marker row out of the item mapping", async () => {
    // The marker is drawn inside the measured box, so the items start one row
    // down: this is the page-frame wiring, without which every pointer row
    // answers the item above it.
    const { harness, tty } = mountWindow({
      heights: [1, 2, 1],
      above: 4,
      below: 9,
      firstRow: 1,
    });
    try {
      // Screen rows: 1 marker, 2 item 0, 3–4 item 1, 5 item 2, 6 marker.
      await tty.press(pressAt(2, 1), releaseAt(2, 1));
      expect(harness.activated).toEqual([]);
      await tty.press(pressAt(2, 2), releaseAt(2, 2));
      await tty.press(pressAt(2, 3), releaseAt(2, 3));
      await tty.press(pressAt(2, 4), releaseAt(2, 4));
      await tty.press(pressAt(2, 5), releaseAt(2, 5));
      expect(harness.activated).toEqual([0, 1, 1, 2]);

      // Both markers are chrome: no click, no hover.
      await tty.press(pressAt(2, 6), releaseAt(2, 6));
      expect(harness.activated).toEqual([0, 1, 1, 2]);
      await tty.press(moveTo(2, 1));
      expect(getHoverTarget()).toBeNull();
      await tty.press(moveTo(2, 4));
      expect(getHoverTarget()).toEqual({ area: "test", index: 1 });
      await tty.press(moveTo(2, 6));
      expect(getHoverTarget()).toBeNull();
    } finally {
      tty.stop();
    }
  });
});

describe("without spans", () => {
  test("every line is its own item, exactly as before T-10", async () => {
    const { harness, tty } = mountWindow({ heights: [1, 1, 1], spans: false });
    try {
      for (const row of [1, 2, 3]) {
        await tty.press(pressAt(2, row), releaseAt(2, row));
      }
      expect(harness.activated).toEqual([0, 1, 2]);
      // Past the end there is no row at all.
      await tty.press(pressAt(2, 4), releaseAt(2, 4));
      expect(harness.activated).toEqual([0, 1, 2]);
      await tty.press(moveTo(2, 4));
      expect(getHoverTarget()).toBeNull();
    } finally {
      tty.stop();
    }
  });

  test("omitting spans paints and answers exactly like all-one spans", async () => {
    // The identity guarantee W-01 froze: an old page (no `spans`) and a page
    // that passes `rowHeight` for its one-line rows must be indistinguishable.
    const plain = mountWindow({ heights: [1, 1, 1], spans: false });
    let plainText = "";
    let plainActivated: number[] = [];
    try {
      plainText = await plain.tty.text();
      for (const row of [1, 2, 3, 4]) {
        await plain.tty.press(pressAt(2, row), releaseAt(2, row));
      }
      plainActivated = plain.harness.activated;
    } finally {
      plain.tty.stop();
    }

    const spanned = mountWindow({ heights: [1, 1, 1], spans: true });
    try {
      expect(await spanned.tty.text()).toBe(plainText);
      for (const row of [1, 2, 3, 4]) {
        await spanned.tty.press(pressAt(2, row), releaseAt(2, row));
      }
      expect(spanned.harness.activated).toEqual(plainActivated);
    } finally {
      spanned.tty.stop();
    }
  });
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

  test("a surface that unmounts while hovered does not leave the row lit", async () => {
    // The store outlives the component: a target left behind is painted again the
    // next time a surface with the same area name mounts — a row the pointer is
    // nowhere near, lit until the next motion report.
    const { tty } = mount();
    try {
      await tty.press(moveTo(2, 2));
      expect(getHoverTarget()).toEqual({ area: "test", index: 1 });
    } finally {
      tty.stop();
    }
    expect(getHoverTarget()).toBeNull();
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
