import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import { type ReactElement, useEffect } from "react";
import {
  acquireInputScope,
  owningInputScope,
} from "@/cli/helpers/focus-ledger";
import { getHoverTarget, resetHoverForTests } from "@/cli/helpers/hover-store";
import {
  registeredMouseHandlers,
  registerMouseHandler,
  resetMouseHandlers,
} from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
} from "@/cli/helpers/terminal-frame";
import { useInputRouter } from "@/cli/hooks/use-input-router";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import {
  type OverlayListMouse,
  OverlayListView,
} from "@/cli/overlay/list-view";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The rows the list actually paints.
 *
 * Asserted on the rendered frame rather than on the component's return value,
 * because the interesting failures here are layout ones: rows that are filtered
 * but still drawn, a window that moves without an indicator, an indicator row
 * that appears only when it has something to say (which changes the overlay's
 * measured height and shoves the frame around under the user's cursor).
 */

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Rows the component painted, with the frame's unused trailing rows dropped. */
async function paint(element: ReactElement): Promise<string[]> {
  const stdout = new CaptureStream() as unknown as NodeJS.WriteStream;
  const release = installTerminalFrameCapture(stdout);
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const instance = render(element, {
    stdin,
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  try {
    await tick();
    // Only trailing blanks are dropped. A reserved indicator row is a blank row
    // *inside* the component's output and has to survive: dropping it here would
    // hide exactly the invariant the window tests assert.
    const rows = [...(getTerminalFrame()?.text ?? [])];
    while (rows.length > 0 && rows.at(-1) === "") rows.pop();
    return rows;
  } finally {
    instance.unmount();
    instance.cleanup();
    release();
  }
}

function rows(count: number, description = true): OverlayListItem[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `k${index}`,
    label: `Row ${index + 1}`,
    ...(description ? { description: `desc ${index + 1}` } : {}),
  }));
}

afterEach(() => {
  // The pointer seam's stores are module-level like the frame capture: a hover
  // target or a handler left behind by one test would answer the next one.
  resetInkTtyState();
  resetHoverForTests();
  resetMouseHandlers();
  resetMouseTrackingForTests();
});

describe("OverlayListView", () => {
  test("renders every row whole when no window is asked for", async () => {
    const painted = await paint(
      <OverlayListView items={rows(30)} cursor={0} />,
    );

    expect(painted).toHaveLength(30);
    expect(painted[0]).toBe("> Row 1 · desc 1");
    expect(painted[29]).toBe("  Row 30 · desc 30");
  });

  test("marks the cursor and the current value, and mirrors the picker's row", async () => {
    const painted = await paint(
      <OverlayListView
        items={[
          { key: "a", label: "Alpha", description: "first", isCurrent: true },
          { key: "b", label: "Beta", dimLabel: true },
          // The marker belongs to the row, not to the list: the toolset `Auto`
          // row names the preset it resolves to instead of saying `(current)`.
          {
            key: "c",
            label: "Auto",
            description: "auto-select",
            isCurrent: true,
            currentLabel: " (current - Claude)",
          },
        ]}
        cursor={0}
      />,
    );

    expect(painted).toEqual([
      "> Alpha (current) · first",
      "  Beta",
      "  Auto (current - Claude) · auto-select",
    ]);
  });

  test("renders only the window, with the hidden counts on either side", async () => {
    const painted = await paint(
      <OverlayListView items={rows(10)} cursor={5} rows={3} />,
    );

    expect(painted).toEqual([
      " ↑ 3 more",
      "  Row 4 · desc 4",
      "  Row 5 · desc 5",
      "> Row 6 · desc 6",
      " ↓ 4 more",
    ]);
  });

  test("reserves both indicator rows, so scrolling cannot change the height", async () => {
    const atTop = await paint(
      <OverlayListView items={rows(10)} cursor={2} rows={3} />,
    );
    const atMiddle = await paint(
      <OverlayListView items={rows(10)} cursor={5} rows={3} />,
    );

    // Above the fold there is nothing hidden, and the row still exists — an
    // overlay's height is measured chrome, so a list that grows a row when the
    // cursor moves drags the whole frame with it. Ink trims trailing whitespace,
    // so the reserved row reads back as an empty one.
    expect(atTop).toHaveLength(atMiddle.length);
    expect(atTop).toEqual([
      "",
      "  Row 1 · desc 1",
      "  Row 2 · desc 2",
      "> Row 3 · desc 3",
      " ↓ 7 more",
    ]);
  });

  test("drops the indicator rows entirely when the list fits", async () => {
    const painted = await paint(
      <OverlayListView items={rows(3)} cursor={0} rows={5} />,
    );

    expect(painted).toEqual([
      "> Row 1 · desc 1",
      "  Row 2 · desc 2",
      "  Row 3 · desc 3",
    ]);
  });

  test("paints nothing for an empty list, or the caller's label instead", async () => {
    expect(await paint(<OverlayListView items={[]} cursor={0} />)).toEqual([]);
    expect(
      await paint(
        <OverlayListView items={[]} cursor={0} emptyLabel="No worktrees." />,
      ),
    ).toEqual(["No worktrees."]);
  });

  test("a caller that says the count itself can turn the indicators off", async () => {
    const painted = await paint(
      <OverlayListView
        items={rows(10)}
        cursor={5}
        rows={3}
        indicators={false}
      />,
    );

    // The window is the same; only the two rows the face does not want are gone.
    // `/resume` and `/search` print the position in their own footer.
    expect(painted).toEqual([
      "  Row 4 · desc 4",
      "  Row 5 · desc 5",
      "> Row 6 · desc 6",
    ]);
  });

  test("the centered anchor holds the cursor in the middle of the window", async () => {
    const painted = await paint(
      <OverlayListView
        items={rows(10)}
        cursor={5}
        rows={5}
        anchor="center"
        indicators={false}
      />,
    );

    expect(painted).toEqual([
      "  Row 4 · desc 4",
      "  Row 5 · desc 5",
      "> Row 6 · desc 6",
      "  Row 7 · desc 7",
      "  Row 8 · desc 8",
    ]);
  });

  test("hands a custom row its index in the full list, not in the window", async () => {
    const seen: number[] = [];
    const painted = await paint(
      <OverlayListView
        items={rows(10)}
        cursor={5}
        rows={3}
        renderRow={(item, index, isCursor) => {
          seen.push(index);
          return <Text>{`${isCursor ? "*" : "-"}${item.label}`}</Text>;
        }}
      />,
    );

    expect(seen).toEqual([3, 4, 5]);
    expect(painted).toEqual([
      " ↑ 3 more",
      "-Row 4",
      "-Row 5",
      "*Row 6",
      " ↓ 4 more",
    ]);
  });
});

// --- The pointer seam -------------------------------------------------------
//
// One row-level hit test for every selector: the geometry is measured from the
// box this component drew, so the tests below press *screen* cells (the frame is
// pinned to the terminal) and judge what the list decided. `mouse` is a stub in
// this file — the cursor and the confirm live in `useOverlayList`; what is under
// test here is the mapping (row → full-list index, indicator lines excluded), the
// hover store, the wheel fall-through, and the modal stacking guard.

const ESC = "\u001B";
/** A left press / release at a cell (1-based screen coordinates). */
const pressAt = (column: number, row: number) => `${ESC}[<0;${column};${row}M`;
const releaseAt = (column: number, row: number) =>
  `${ESC}[<0;${column};${row}m`;
/** Any-motion (`1003`): the pointer moved, no button down. */
const moveTo = (column: number, row: number) => `${ESC}[<35;${column};${row}M`;
/** A wheel notch: 64 = up, 65 = down. */
const wheelAt = (direction: "up" | "down", column: number, row: number) =>
  `${ESC}[<${direction === "up" ? 64 : 65};${column};${row}M`;

interface MouseProbe extends OverlayListMouse {
  calls: string[];
}

function mouseProbe(overrides: Partial<OverlayListMouse> = {}): MouseProbe {
  const calls: string[] = [];
  return {
    area: "list-view-test",
    activate: (index) => {
      calls.push(`activate:${index}`);
    },
    wheel: (direction) => {
      calls.push(`wheel:${direction}`);
    },
    blocked: () => false,
    calls,
    ...overrides,
  };
}

/** Mount the list with the router installed, so stdin mouse reports are routed. */
function mountMouseList(options: {
  mouse: OverlayListMouse;
  items?: OverlayListItem[];
  cursor?: number;
  rows?: number;
  renderRow?: (
    item: OverlayListItem,
    index: number,
    isCursor: boolean,
  ) => ReactElement | null;
  /** A lower-layer handler, to prove a report the list declines still travels. */
  fallback?: string[];
}) {
  function Harness() {
    useInputRouter();
    const fallback = options.fallback;
    useEffect(() => {
      if (!fallback) return undefined;
      return registerMouseHandler(
        (report) => {
          if (!report.wheel) return false;
          fallback.push(`fallback:${report.wheel}`);
          return true;
        },
        { layer: "content", name: "test-fallback" },
      );
    }, [fallback]);
    return (
      <OverlayListView
        items={options.items ?? rows(5)}
        cursor={options.cursor ?? 0}
        rows={options.rows}
        renderRow={options.renderRow}
        mouse={options.mouse}
      />
    );
  }
  return mountInkTty(<Harness />, { columns: 60, rows: 24 });
}

/** Paint a bare element and return its frame rows, trailing blanks included. */
async function paintedRows(element: ReactElement): Promise<string[]> {
  const tty = mountInkTty(element, { columns: 60, rows: 20 });
  try {
    return await tty.rows({ keepTrailingBlanks: true });
  } finally {
    tty.stop();
    resetInkTtyState();
  }
}

describe("the pointer seam", () => {
  test("a click is that row's Enter, a blocked row included", async () => {
    const mouse = mouseProbe();
    const tty = mountMouseList({
      mouse,
      items: [
        { key: "a", label: "Alpha" },
        { key: "b", label: "Beta", disabled: true },
        { key: "c", label: "Gamma" },
      ],
    });
    try {
      await tty.press(pressAt(2, 1), releaseAt(2, 1));
      await tty.press(pressAt(2, 2), releaseAt(2, 2));
      // The list does not decide what a blocked row means; it hands over the
      // index exactly as `Enter` does (`useOverlayList` calls the same callback).
      expect(mouse.calls).toEqual(["activate:0", "activate:1"]);
    } finally {
      tty.stop();
    }
  });

  test("hover lights the row under the pointer, never a blocked one", async () => {
    const mouse = mouseProbe();
    const tty = mountMouseList({
      mouse,
      items: [
        { key: "a", label: "Alpha" },
        { key: "b", label: "Beta", disabled: true },
        { key: "c", label: "Gamma" },
      ],
    });
    try {
      await tty.press(moveTo(2, 1));
      expect(getHoverTarget()).toEqual({ area: "list-view-test", index: 0 });

      // A blocked row does not light, and the row left behind must clear.
      await tty.press(moveTo(2, 2));
      expect(getHoverTarget()).toBeNull();

      await tty.press(moveTo(2, 3));
      expect(getHoverTarget()).toEqual({ area: "list-view-test", index: 2 });

      // Out of the list: the highlight goes with the pointer.
      await tty.press(moveTo(2, 10));
      expect(getHoverTarget()).toBeNull();
    } finally {
      tty.stop();
    }
  });

  test("a wheel notch is one cursor step; outside the rows it falls through", async () => {
    const fallback: string[] = [];
    const mouse = mouseProbe();
    const tty = mountMouseList({ mouse, fallback });
    try {
      await tty.press(wheelAt("down", 2, 2));
      await tty.press(wheelAt("up", 2, 3));
      expect(mouse.calls).toEqual(["wheel:down", "wheel:up"]);
      expect(fallback).toEqual([]);

      // Below the last row: the list declines, so the page/transcript layer gets
      // the notch (《38》§19.4 `chrome > page > content`).
      await tty.press(wheelAt("down", 2, 10));
      expect(mouse.calls).toEqual(["wheel:down", "wheel:up"]);
      expect(fallback).toEqual(["fallback:down"]);
    } finally {
      tty.stop();
    }
  });

  test("the window mapping survives the indicator rows", async () => {
    const mouse = mouseProbe();
    // A windowed list of 10 at cursor 5 draws `↑ 3 more`, items 3-5, `↓ 4 more`.
    const tty = mountMouseList({
      mouse,
      items: rows(10),
      cursor: 5,
      rows: 3,
    });
    try {
      // Screen row 1 is the indicator; the items are screen rows 2-4.
      await tty.press(pressAt(2, 2), releaseAt(2, 2));
      await tty.press(pressAt(2, 3), releaseAt(2, 3));
      await tty.press(pressAt(2, 4), releaseAt(2, 4));
      expect(mouse.calls).toEqual(["activate:3", "activate:4", "activate:5"]);

      // Neither indicator line is a row: no press is claimed, so no click.
      await tty.press(pressAt(2, 1), releaseAt(2, 1));
      await tty.press(pressAt(2, 5), releaseAt(2, 5));
      expect(mouse.calls).toHaveLength(3);

      // The wheel over the indicator still scrolls the list it belongs to.
      await tty.press(wheelAt("down", 2, 1));
      expect(mouse.calls.at(-1)).toBe("wheel:down");
    } finally {
      tty.stop();
    }
  });

  test("a modal above the list refuses the whole frame", async () => {
    // An approval (or any exclusive modal) outranks a selector that is still
    // mounted behind it: the pointer must not click through it.
    const releaseModal = acquireInputScope("modal");
    const fallback: string[] = [];
    const mouse = mouseProbe({
      blocked: () => owningInputScope() === "modal",
    });
    const tty = mountMouseList({ mouse, fallback });
    try {
      await tty.press(moveTo(2, 1));
      expect(getHoverTarget()).toBeNull();

      await tty.press(pressAt(2, 1), releaseAt(2, 1));
      expect(mouse.calls).toEqual([]);

      // Declined, not swallowed: the wheel still reaches the layer below.
      await tty.press(wheelAt("down", 2, 1));
      expect(mouse.calls).toEqual([]);
      expect(fallback).toEqual(["fallback:down"]);
    } finally {
      tty.stop();
      releaseModal();
    }
  });

  test("a multi-line row answers every one of its lines", async () => {
    // `/resume` and `/agent` draw a summary, a preview and a timestamp: a hit
    // test that assumed one line per item would activate the row below (or
    // nothing) on the second line.
    const mouse = mouseProbe();
    const tty = mountMouseList({
      mouse,
      items: rows(4),
      renderRow: (item, index) => (
        <Box flexDirection="column">
          <Text>{`${index}:${item.label}`}</Text>
          <Text dimColor>{"  second line"}</Text>
        </Box>
      ),
    });
    try {
      // Items occupy screen rows 1-2, 3-4, 5-6, 7-8.
      await tty.press(pressAt(2, 4), releaseAt(2, 4));
      expect(mouse.calls).toEqual(["activate:1"]);

      await tty.press(moveTo(2, 6));
      expect(getHoverTarget()?.index).toBe(2);

      await tty.press(pressAt(2, 1), releaseAt(2, 1));
      expect(mouse.calls).toEqual(["activate:1", "activate:0"]);
    } finally {
      tty.stop();
    }
  });

  test("an empty list registers no handler and asks for no hover reporting", async () => {
    const mouse = mouseProbe();
    const tty = mountMouseList({ mouse, items: [] });
    try {
      await tty.rows();
      expect(registeredMouseHandlers()).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("unhovered, the seam paints the bytes the list painted without it", async () => {
    // The acceptance property behind the 19 `renderRow` sites: turning the
    // pointer seam on may not move a single cell until a row is hovered.
    const mouse = mouseProbe();
    const shapes: Array<(pointer?: OverlayListMouse) => ReactElement> = [
      (pointer) => (
        <OverlayListView items={rows(10)} cursor={5} rows={3} mouse={pointer} />
      ),
      (pointer) => (
        <OverlayListView
          items={[
            { key: "a", label: "Alpha", description: "first", isCurrent: true },
            { key: "b", label: "Beta", dimLabel: true },
            { key: "c", label: "Blocked", disabled: true },
          ]}
          cursor={0}
          mouse={pointer}
        />
      ),
      (pointer) => (
        <OverlayListView
          items={rows(6)}
          cursor={2}
          rows={3}
          indicators={false}
          mouse={pointer}
          renderRow={(item, index, isCursor) => (
            <Text>{`${isCursor ? "*" : "-"}${item.label}:${index}`}</Text>
          )}
        />
      ),
      (pointer) => (
        <OverlayListView
          items={[]}
          cursor={0}
          emptyLabel="No worktrees."
          mouse={pointer}
        />
      ),
    ];

    for (const shape of shapes) {
      expect(await paintedRows(shape(mouse))).toEqual(
        await paintedRows(shape(undefined)),
      );
    }
  });
});
