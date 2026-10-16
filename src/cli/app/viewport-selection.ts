import { getTerminalFrame } from "@/cli/helpers/terminal-frame";
import {
  type FramePoint,
  type FrameSelection,
  orderSelection,
  selectionText,
} from "@/cli/helpers/text-selection";
import type { StaticItem } from "./types";
import { getViewportRows, getViewportScrollRows } from "./viewport-scroll";

/**
 * The transcript selection, and what `Ctrl+X y` copies.
 *
 * A module store, not React state, for the usual reason in this codebase: it is
 * written by mouse reports that arrive outside the component tree, and reading it
 * must not re-render the composer or the transcript (the flicker red line). The
 * highlight is painted into the terminal directly by `use-terminal-selection`,
 * which subscribes here.
 *
 * The drag is remembered in **screen coordinates** — a row and a column, which is
 * what the mouse reports — and in the **text** it covered, read from the frame at
 * the moment the drag was made. What `Ctrl+X y` copies is that text, never the
 * text that happens to sit on those rows later. That is the terminal's own
 * contract: the selection is what you dragged over, and it survives the
 * transcript moving underneath it (a scroll, rows arriving while the view follows
 * the newest, the leader's hint line taking a row off the band on the very key
 * press before the copy).
 *
 * The *highlight* cannot be remembered that way — it has to be drawn on the frame
 * in front of the user — so it is placed by following the layout: the band
 * shrinking by a row moves the transcript up by a row, and a scroll offset
 * growing by N moves it down by N. `visibleSelection` returns the rows that
 * relocation lands on, and only when they still read what the drag covered; a
 * selection the transcript has moved out from under (or reflowed, which no layout
 * number describes) is simply not drawn. It is still copied, which is the one
 * thing that must never be wrong.
 */

let selection: FrameSelection | null = null;
let version = 0;
const listeners = new Set<() => void>();

/**
 * What the drag covered, and the layout it was read under.
 *
 * Rows are the whole-row text of the drag's rows, used to recognise the selection
 * on a later frame; `text` is what a copy returns.
 */
interface CapturedSelection {
  text: string;
  rows: string[];
  bandRows: number;
  scrollRows: number;
}

let captured: CapturedSelection | null = null;

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function samePoint(a: FramePoint, b: FramePoint): boolean {
  return a.row === b.row && a.column === b.column;
}

/** The same selection, with every row moved by `rows`. Columns are untouched. */
function shiftedBy(
  frameSelection: FrameSelection,
  rows: number,
): FrameSelection {
  return {
    anchor: { ...frameSelection.anchor, row: frameSelection.anchor.row + rows },
    head: { ...frameSelection.head, row: frameSelection.head.row + rows },
  };
}

/**
 * Read a selection off the frame it was dragged on.
 *
 * Rows past the band are chrome — the input, the status line — so they are not
 * part of a selection at all, and a frame that cannot be located yields nothing:
 * the same refusal the painter makes, for the same reason (a wrong row is worse
 * than no row). The band is the limit here rather than a later clamp, because
 * this text is what a copy returns and it must not be allowed to contain the
 * input's own text.
 */
function captureSelection(
  frameSelection: FrameSelection,
): CapturedSelection | null {
  const frame = getTerminalFrame();
  if (!frame?.anchored) return null;
  const band = Math.max(1, getViewportRows());
  const { start, end } = orderSelection(frameSelection);
  if (start.row > band) return null;
  const last = Math.min(end.row, band, frame.lines.length);
  const rows: string[] = [];
  for (let row = Math.max(1, start.row); row <= last; row += 1) {
    rows.push(frame.lines[row - 1] ?? "");
  }
  if (rows.length === 0) return null;
  return {
    text: selectionText(frame, {
      anchor: {
        ...frameSelection.anchor,
        row: Math.min(frameSelection.anchor.row, last),
      },
      head: {
        ...frameSelection.head,
        row: Math.min(frameSelection.head.row, last),
      },
    }),
    rows,
    bandRows: getViewportRows(),
    scrollRows: getViewportScrollRows(),
  };
}

/**
 * Where the selection is on screen now, or `null` when the frame no longer holds
 * it.
 *
 * Relocated from the layout the drag was made under, not from the last frame: the
 * band losing a row moves the transcript up by a row, and the scroll offset
 * growing by N moves it down by N. The rows it lands on are then checked against
 * the ones the drag covered, so a frame that moved for some other reason (rows
 * arriving while the view follows the newest) draws nothing instead of a
 * highlight over text nobody selected.
 */
export function visibleSelection(): FrameSelection | null {
  if (selection === null || captured === null) return null;
  const frame = getTerminalFrame();
  if (frame === null) return null;
  const shift =
    getViewportScrollRows() -
    captured.scrollRows +
    (getViewportRows() - captured.bandRows);
  const candidate = shift === 0 ? selection : shiftedBy(selection, shift);

  const { start, end } = orderSelection(candidate);
  let compared = 0;
  for (let index = 0; index < captured.rows.length; index += 1) {
    const row = start.row + index;
    if (row > end.row) break;
    if (row < 1 || row > frame.lines.length) continue;
    if (frame.lines[row - 1] !== captured.rows[index]) return null;
    compared += 1;
  }
  return compared > 0 ? candidate : null;
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
  captured = captureSelection(selection);
  publish();
}

/** Move the head of an existing selection. Does nothing when none is active. */
export function extendSelection(point: FramePoint): void {
  if (!selection) return;
  if (samePoint(selection.head, point)) return;
  selection = { anchor: selection.anchor, head: point };
  // Re-read on every move: a drag that grows over a frame boundary (the newest
  // item just streamed a row) would otherwise keep a stale row of text.
  captured = captureSelection(selection);
  publish();
}

export function clearSelection(): void {
  if (selection === null) return;
  selection = null;
  captured = null;
  publish();
}

/**
 * What `Ctrl+X y` copies: the text the drag covered.
 *
 * Read at drag time, so it is the same text however the transcript moved since —
 * which is what a terminal does with a selection, and the only reading that
 * cannot copy something the user never dragged over.
 */
export function getSelectedText(): string {
  return captured?.text ?? "";
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
  captured = null;
  version = 0;
  listeners.clear();
}
