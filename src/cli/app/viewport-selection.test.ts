import { afterEach, describe, expect, test } from "bun:test";
import type { StaticItem } from "@/cli/app/types";
import {
  reportViewportPosition,
  resetViewportScroll,
  scrollTranscriptWheel,
  setViewportRows,
} from "@/cli/app/viewport-scroll";
import {
  beginSelection,
  canSelectOnScreen,
  clearSelection,
  copySourceFor,
  extendSelection,
  getSelectedText,
  getSelection,
  getSelectionVersion,
  hasSelection,
  lastAnswerText,
  resetViewportSelectionForTests,
  setBandColumns,
  subscribeToSelection,
  visibleSelection,
} from "@/cli/app/viewport-selection";
import {
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";

const ANSWER: StaticItem = {
  kind: "assistant",
  id: "assistant-1",
  text: "the first answer",
  phase: "finished",
};
const TOOL: StaticItem = {
  kind: "tool_call",
  id: "tool-1",
  name: "Read",
  phase: "finished",
};
const CONTINUATION_ANSWER: StaticItem[] = [
  { kind: "assistant", id: "assistant-2", text: "part one", phase: "finished" },
  {
    kind: "assistant",
    id: "assistant-3",
    text: "part two",
    phase: "finished",
    isContinuation: true,
  },
];

afterEach(() => {
  resetViewportSelectionForTests();
  resetTerminalFrameForTests();
  resetViewportScroll();
});

describe("viewport selection", () => {
  test("starts at the pressed cell and grows with the pointer", () => {
    const seen: number[] = [];
    subscribeToSelection(() => {
      seen.push(getSelectionVersion());
    });

    beginSelection({ row: 3, column: 4 });
    expect(getSelection()).toEqual({
      anchor: { row: 3, column: 4 },
      head: { row: 3, column: 4 },
    });

    extendSelection({ row: 5, column: 2 });
    expect(getSelection()).toEqual({
      anchor: { row: 3, column: 4 },
      head: { row: 5, column: 2 },
    });

    // Three changes, three notifications (and no more: a drag that reports the
    // same cell repeatedly must not repaint).
    extendSelection({ row: 5, column: 2 });
    clearSelection();

    expect(seen).toEqual([1, 2, 3]);
    expect(hasSelection()).toBe(false);
  });

  test("moving the pointer with nothing selected does nothing", () => {
    extendSelection({ row: 2, column: 2 });
    expect(getSelection()).toBeNull();
  });

  test("reads the text from the frame at copy time", () => {
    // Without a frame there is nothing to read, and the copy key falls back to
    // the answer rather than copying stale text.
    beginSelection({ row: 1, column: 1 });
    extendSelection({ row: 1, column: 5 });
    expect(getSelectedText()).toBe("");
  });

  test("refuses a drag the screen cannot place", () => {
    const stream = {
      isTTY: true,
      write(_chunk: string) {
        return true;
      },
    };
    installTerminalFrameCapture(stream);

    // No clear and no fresh screen: the rows cannot be proven to be screen rows,
    // so the painter refuses such a frame. The drag is refused with it — what a
    // copy returns is read from the frame the drag was made on, so a drag on a
    // frame that cannot be placed has nothing to remember.
    stream.write("alpha bravo\nsecond\n");
    expect(canSelectOnScreen()).toBe(false);
    beginSelection({ row: 1, column: 1 });
    extendSelection({ row: 1, column: 5 });
    expect(getSelectedText()).toBe("");

    // A frame that clears the screen can be placed, and the same drag reads from
    // it.
    stream.write(`\u001B[2J\u001B[Halpha bravo\nsecond\n`);
    expect(canSelectOnScreen()).toBe(true);
    beginSelection({ row: 1, column: 1 });
    extendSelection({ row: 1, column: 5 });
    expect(getSelectedText()).toBe("alpha");
  });

  test("the copy is what the drag covered, whatever the frame does after", () => {
    const stream = {
      isTTY: true,
      write(_chunk: string) {
        return true;
      },
    };
    installTerminalFrameCapture(stream);
    const draw = (rows: readonly string[]) =>
      stream.write(`\u001B[2J\u001B[H${rows.join("\n")}\n`);
    setViewportRows(3);

    draw(["alpha bravo", "charlie delta", "echo", "input row"]);
    beginSelection({ row: 1, column: 1 });
    extendSelection({ row: 3, column: 4 });
    expect(getSelectedText()).toBe("alpha bravo\ncharlie delta\necho");
    expect(visibleSelection()).toEqual({
      anchor: { row: 1, column: 1 },
      head: { row: 3, column: 4 },
    });

    // The leader's hint takes a row off the band, so the transcript moves up by
    // one: the highlight follows the rows that still read as the drag did, and
    // the row that left the band is not drawn (but is still copied).
    setViewportRows(2);
    draw(["charlie delta", "echo", "input row", "hint row"]);
    expect(visibleSelection()).toEqual({
      anchor: { row: 0, column: 1 },
      head: { row: 2, column: 4 },
    });
    expect(getSelectedText()).toBe("alpha bravo\ncharlie delta\necho");

    // A frame that reflowed (rows arriving while the view follows the newest)
    // matches neither: nothing is drawn, and the copy is still the drag.
    draw(["something", "else", "entirely", "here"]);
    expect(visibleSelection()).toBeNull();
    expect(getSelectedText()).toBe("alpha bravo\ncharlie delta\necho");
  });

  test("a scroll keeps the drag on the same text", () => {
    const stream = {
      isTTY: true,
      write(_chunk: string) {
        return true;
      },
    };
    installTerminalFrameCapture(stream);
    const draw = (rows: readonly string[]) =>
      stream.write(`\u001B[2J\u001B[H${rows.join("\n")}\n`);
    setViewportRows(4);

    draw(["r1", "r2", "r3", "r4", "r5", "r6"]);
    beginSelection({ row: 2, column: 1 });
    extendSelection({ row: 3, column: 2 });
    expect(getSelectedText()).toBe("r2\nr3");

    // Three rows up: older rows come in at the top, so everything moved down by
    // three and the drag is now on rows 5 and 6.
    scrollTranscriptWheel("up");
    reportViewportPosition({ rows: 3, anchor: { end: 6, delta: 0 } });
    draw(["older", "older", "older", "r1", "r2", "r3"]);
    expect(visibleSelection()).toEqual({
      anchor: { row: 5, column: 1 },
      head: { row: 6, column: 2 },
    });
    expect(getSelectedText()).toBe("r2\nr3");
  });

  test("the copy stops at the transcript band", () => {
    const stream = {
      isTTY: true,
      write(_chunk: string) {
        return true;
      },
    };
    installTerminalFrameCapture(stream);
    stream.write(
      `\u001B[2J\u001B[Halpha\nbravo\ncharlie\ninput row one\ninput row two\n`,
    );

    // Two rows belong to the transcript; the rest is the input and its chrome.
    setViewportRows(2);
    beginSelection({ row: 1, column: 1 });
    extendSelection({ row: 4, column: 5 });
    expect(getSelectedText()).toBe("alpha\nbravo");

    // A selection that is entirely below the band covers nothing at all.
    clearSelection();
    beginSelection({ row: 3, column: 1 });
    extendSelection({ row: 5, column: 3 });
    expect(getSelectedText()).toBe("");
  });

  test("the copy stops at the rail, not at the edge of the screen", () => {
    const stream = {
      isTTY: true,
      write(_chunk: string) {
        return true;
      },
    };
    installTerminalFrameCapture(stream);
    stream.write(
      `\u001B[2J\u001B[Halpha bravo│ ctx 62%\ncharlie delta│ 12 steps\n`,
    );

    setViewportRows(2);
    // The rail is ten columns in from the right; the transcript owns the rest.
    setBandColumns(11);
    beginSelection({ row: 1, column: 1 });
    extendSelection({ row: 1, column: 30 });
    // `alpha bravo` is eleven columns; the divider and everything after it is
    // chrome and must not be appended to the copy.
    expect(getSelectedText()).toBe("alpha bravo");

    // A drag that runs onto the next row is clamped on both.
    clearSelection();
    beginSelection({ row: 1, column: 1 });
    extendSelection({ row: 2, column: 30 });
    expect(getSelectedText()).toBe("alpha bravo\ncharlie del");
  });

  test("finds the last answer, not the last line", () => {
    // A streamed answer arrives as a run of lines, and the transcript usually
    // ends with tool output: both cases must still find the answer.
    expect(lastAnswerText([ANSWER, TOOL, ANSWER])).toBe("the first answer");
    // A continuation line belongs to the answer above it …
    expect(lastAnswerText([ANSWER, ...CONTINUATION_ANSWER])).toBe(
      "part one\npart two",
    );
    // … while a line that is not a continuation is its own answer.
    expect(lastAnswerText([ANSWER, CONTINUATION_ANSWER[0] as StaticItem])).toBe(
      "part one",
    );
    expect(lastAnswerText([TOOL])).toBe("");
    expect(lastAnswerText([])).toBe("");
  });

  test("prefers the selection, then the answer, then nothing", () => {
    expect(copySourceFor("dragged text", "answer")).toEqual({
      source: "selection",
      text: "dragged text",
    });
    expect(copySourceFor("", "answer")).toEqual({
      source: "answer",
      text: "answer",
    });
    expect(copySourceFor("", "")).toEqual({ source: "none", text: "" });
  });
});
