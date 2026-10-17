import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import type { ReactElement } from "react";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";

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
  resetTerminalFrameForTests();
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
        ]}
        cursor={0}
      />,
    );

    expect(painted).toEqual(["> Alpha (current) · first", "  Beta"]);
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
