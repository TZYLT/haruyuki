import { afterEach, describe, expect, test } from "bun:test";
import type { StaticItem } from "@/cli/app/types";
import {
  beginSelection,
  clearSelection,
  copySourceFor,
  extendSelection,
  getSelectedText,
  getSelection,
  getSelectionVersion,
  hasSelection,
  lastAnswerText,
  resetViewportSelectionForTests,
  subscribeToSelection,
} from "@/cli/app/viewport-selection";
import { resetTerminalFrameForTests } from "@/cli/helpers/terminal-frame";

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
