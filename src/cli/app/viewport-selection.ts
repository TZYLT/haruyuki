import { getTerminalFrame } from "@/cli/helpers/terminal-frame";
import {
  type FramePoint,
  type FrameSelection,
  orderSelection,
  selectionText,
} from "@/cli/helpers/text-selection";
import type { StaticItem } from "./types";
import { getViewportRows } from "./viewport-scroll";

/**
 * The transcript selection, and what `Ctrl+X y` copies.
 *
 * A module store, not React state, for the usual reason in this codebase: it is
 * written by mouse reports that arrive outside the component tree, and reading it
 * must not re-render the composer or the transcript (the flicker red line). The
 * highlight is painted into the terminal directly by `use-terminal-selection`,
 * which subscribes here.
 *
 * The selection is stored in **screen coordinates** — a row and a column — because
 * that is what the mouse reports and what the user dragged over. The text is
 * *derived* from the frame that is on screen when the copy happens
 * (`getSelectedText`), never captured at drag time, so what is copied is exactly
 * what the highlight covers.
 *
 * Position alone cannot keep that promise: a screen row is not content, and
 * anything that moves the transcript — a scroll, rows arriving while the view
 * follows the newest, a chrome row appearing under the band — moves the text
 * beneath those rows. Two consequences are handled here and one is deliberately
 * not:
 *
 * - What the selection may cover stops at the transcript band
 *   (`selectionWithinBand`): rows below it belong to the input, and the band
 *   shrinks by a row whenever the leader's hint appears — which is the key press
 *   right before the copy.
 * - A frame that could not be placed on screen yields no text at all
 *   (`getSelectedText`), the same refusal the painter makes.
 * - **A selection the transcript moved under is still read by position.** It
 *   highlights whatever now sits on those rows and copies that. Making it follow
 *   the content instead, or end when the content moves, is a behaviour decision
 *   that has not been taken yet — and one worth taking deliberately, because the
 *   two options differ in what the user gets after scrolling away from a drag.
 */

let selection: FrameSelection | null = null;
let version = 0;
const listeners = new Set<() => void>();

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function samePoint(a: FramePoint, b: FramePoint): boolean {
  return a.row === b.row && a.column === b.column;
}

/**
 * The selection as the transcript band allows it, or `null` when it is entirely
 * below the band.
 *
 * Rows past the band are chrome — the input, the status line — and the band can
 * shrink while a selection is standing: the leader's own hint line appears on the
 * key press that precedes the copy, which costs the band its top row. Without
 * this, a selection that touched the band's last row would cover a row of the
 * input and copy its text, and the painter would draw a highlight over it.
 */
export function selectionWithinBand(
  frameSelection: FrameSelection,
): FrameSelection | null {
  const band = Math.max(1, getViewportRows());
  const { start, end } = orderSelection(frameSelection);
  if (start.row > band) return null;
  if (end.row <= band) return frameSelection;
  return {
    anchor: {
      ...frameSelection.anchor,
      row: Math.min(frameSelection.anchor.row, band),
    },
    head: {
      ...frameSelection.head,
      row: Math.min(frameSelection.head.row, band),
    },
  };
}

export function getSelection(): FrameSelection | null {
  return selection;
}

export function getSelectionVersion(): number {
  return version;
}

export function subscribeToSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasSelection(): boolean {
  return selection !== null;
}

/** Start a selection: the anchor and the head are the same cell. */
export function beginSelection(point: FramePoint): void {
  if (
    selection &&
    samePoint(selection.anchor, point) &&
    samePoint(selection.head, point)
  ) {
    return;
  }
  selection = { anchor: point, head: point };
  publish();
}

/** Move the head of an existing selection. Does nothing when none is active. */
export function extendSelection(point: FramePoint): void {
  if (!selection) return;
  if (samePoint(selection.head, point)) return;
  selection = { anchor: selection.anchor, head: point };
  publish();
}

export function clearSelection(): void {
  if (selection === null) return;
  selection = null;
  publish();
}

/**
 * The text the selection covers, read from the frame that is on screen now.
 *
 * An unanchored frame yields nothing, for the same reason the painter refuses to
 * draw on one: if the capture cannot prove which screen rows the frame occupies,
 * the selection's rows may point at different text, and copying the wrong text is
 * worse than copying nothing.
 */
export function getSelectedText(): string {
  const frame = getTerminalFrame();
  if (!frame?.anchored) return "";
  const withinBand = selection && selectionWithinBand(selection);
  return selectionText(frame, withinBand || null);
}

/** Whether a selection could be placed on the screen right now. */
export function canSelectOnScreen(): boolean {
  return getTerminalFrame()?.anchored === true;
}

/**
 * The last answer in the transcript, as source text.
 *
 * This is the fallback for `Ctrl+X y` when nothing is selected: the answer the
 * user most likely wants is the one they just read. It is the *source* text — the
 * markdown as the model wrote it — not the rendered text, which is what makes
 * copying a code block or a stack trace come out verbatim.
 *
 * Several transcript lines can belong to one answer: a streamed answer arrives as
 * a run of `assistant` lines, and the line that continues a previous one says so
 * (`isContinuation`). A new answer is a line that is not a continuation, which is
 * what keeps two answers in a row from being copied as one.
 */
export function lastAnswerText(items: readonly StaticItem[]): string {
  let last = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "assistant") {
      last = index;
      break;
    }
  }
  if (last < 0) return "";

  let first = last;
  while (first > 0) {
    const item = items[first];
    const previous = items[first - 1];
    if (item?.kind !== "assistant" || item.isContinuation !== true) break;
    if (previous?.kind !== "assistant") break;
    first -= 1;
  }

  const lines: string[] = [];
  for (let index = first; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== "assistant") break;
    if (item.text.length > 0) lines.push(item.text);
  }
  return lines.join("\n");
}

/** Where a copy came from, for the notice. */
export type CopySource = "selection" | "answer" | "none";

export function copySourceFor(
  selectedText: string,
  answerText: string,
): { source: CopySource; text: string } {
  if (selectedText.length > 0)
    return { source: "selection", text: selectedText };
  if (answerText.length > 0) return { source: "answer", text: answerText };
  return { source: "none", text: "" };
}

/** Test seam. */
export function resetViewportSelectionForTests(): void {
  selection = null;
  version = 0;
  listeners.clear();
}
