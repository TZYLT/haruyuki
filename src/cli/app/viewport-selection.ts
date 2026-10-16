import { getTerminalFrame } from "@/cli/helpers/terminal-frame";
import {
  type FramePoint,
  type FrameSelection,
  selectionText,
} from "@/cli/helpers/text-selection";
import type { StaticItem } from "./types";

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
 * *derived* from the last frame at the moment it is copied (`getSelectedText`),
 * so a selection that survives under streaming text copies what is highlighted
 * then, not what happened to be there when the drag ended. The two cannot drift:
 * both come from the same frame.
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
  return selectionText(frame, selection);
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
