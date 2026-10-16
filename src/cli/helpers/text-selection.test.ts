import { describe, expect, test } from "bun:test";
import type { TerminalFrame } from "@/cli/helpers/terminal-frame";
import {
  highlightRow,
  orderSelection,
  rowSelectionSpan,
  selectionText,
  sliceByColumns,
} from "@/cli/helpers/text-selection";

const ESC = "\u001B";

function frame(text: readonly string[]): TerminalFrame {
  return {
    lines: text,
    text,
    widths: text.map((line) => line.length),
    anchored: true,
    cursorRow: text.length + 1,
  };
}

const point = (row: number, column: number) => ({ row, column });

describe("selection geometry", () => {
  test("orders the two ends however the drag went", () => {
    expect(orderSelection({ anchor: point(3, 5), head: point(1, 2) })).toEqual({
      start: point(1, 2),
      end: point(3, 5),
    });
    expect(orderSelection({ anchor: point(2, 9), head: point(2, 1) })).toEqual({
      start: point(2, 1),
      end: point(2, 9),
    });
    expect(orderSelection({ anchor: point(1, 1), head: point(1, 1) })).toEqual({
      start: point(1, 1),
      end: point(1, 1),
    });
  });

  test("a row contributes a span only where the selection crosses it", () => {
    const selection = { anchor: point(2, 4), head: point(4, 2) };

    // Above and below the selection: not part of it.
    expect(rowSelectionSpan(selection, 1, 20)).toBeNull();
    expect(rowSelectionSpan(selection, 5, 20)).toBeNull();

    // The first row starts at the anchor, the middle rows are whole, the last
    // ends at the head.
    expect(rowSelectionSpan(selection, 2, 20)).toEqual({ from: 4, to: 20 });
    expect(rowSelectionSpan(selection, 3, 20)).toEqual({ from: 1, to: 20 });
    expect(rowSelectionSpan(selection, 4, 20)).toEqual({ from: 1, to: 2 });
  });

  test("clamps to the row's real width", () => {
    const selection = { anchor: point(1, 1), head: point(1, 99) };
    expect(rowSelectionSpan(selection, 1, 5)).toEqual({ from: 1, to: 5 });
    // A blank row has nothing to contribute.
    expect(rowSelectionSpan(selection, 1, 0)).toBeNull();
  });
});

describe("selection text", () => {
  test("copies what was dragged over, whole rows in between", () => {
    const transcript = frame(["hello world", "second line", "third"]);

    expect(
      selectionText(transcript, { anchor: point(1, 7), head: point(3, 3) }),
    ).toBe("world\nsecond line\nthi");

    // Dragging upwards selects the same text.
    expect(
      selectionText(transcript, { anchor: point(3, 3), head: point(1, 7) }),
    ).toBe("world\nsecond line\nthi");
  });

  test("drops the padding at the end of each row", () => {
    const transcript = frame(["padded   ", "more     "]);
    expect(
      selectionText(transcript, { anchor: point(1, 1), head: point(2, 9) }),
    ).toBe("padded\nmore");
  });

  test("snaps a wide character instead of splitting it", () => {
    const transcript = frame(["中文测试", "abc"]);
    // A drag ending inside 文 (columns 3-4) takes the whole character.
    expect(
      selectionText(transcript, { anchor: point(1, 1), head: point(1, 3) }),
    ).toBe("中文");
    expect(
      selectionText(transcript, { anchor: point(1, 2), head: point(1, 2) }),
    ).toBe("中");
  });

  test("stops at the end of the transcript", () => {
    const transcript = frame(["only row"]);
    expect(
      selectionText(transcript, { anchor: point(1, 1), head: point(9, 4) }),
    ).toBe("only row");
  });

  test("an empty selection, or no frame, copies nothing", () => {
    expect(selectionText(frame(["x"]), null)).toBe("");
    expect(
      selectionText(null, { anchor: point(1, 1), head: point(1, 5) }),
    ).toBe("");
  });

  test("slices by column, not by string index", () => {
    expect(sliceByColumns("abcdef", 2, 4)).toBe("bcd");
    expect(sliceByColumns("abcdef", 1, 1)).toBe("a");
    // The wide character straddling the boundary comes along.
    expect(sliceByColumns("中文", 2, 3)).toBe("中文");
    expect(sliceByColumns("abcdef", 9, 12)).toBe("");
  });
});

describe("selection highlight", () => {
  test("wraps the dragged columns in inverse video", () => {
    const marked = highlightRow("hello world", 7, 11);
    expect(marked.changed).toBe(true);
    expect(marked.line).toBe(`hello ${ESC}[7mworld${ESC}[27m`);
  });

  test("keeps the row's own colours while splicing", () => {
    const marked = highlightRow(`${ESC}[31mhello${ESC}[0m`, 1, 2);
    expect(marked.line).toBe(`${ESC}[31m${ESC}[7mhe${ESC}[27mllo${ESC}[0m`);
  });

  test("does not count escape sequences as columns", () => {
    // The green text starts at column 1: a span over columns 1-2 covers `ok`.
    const marked = highlightRow(`${ESC}[32mok${ESC}[0m then`, 1, 2);
    expect(marked.line).toBe(`${ESC}[32m${ESC}[7mok${ESC}[27m${ESC}[0m then`);
  });

  test("marks a partial wide character whole", () => {
    const marked = highlightRow("中文测试", 1, 3);
    expect(marked.line).toBe(`${ESC}[7m中文${ESC}[27m测试`);
  });

  test("leaves a row alone when the span is past its content", () => {
    expect(highlightRow("short", 20, 30)).toEqual({
      line: "short",
      changed: false,
    });
    expect(highlightRow("short", 4, 2)).toEqual({
      line: "short",
      changed: false,
    });
  });
});
