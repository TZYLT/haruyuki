import { useEffect } from "react";
import type { StaticItem } from "@/cli/app/types";
import { getViewportRows } from "@/cli/app/viewport-scroll";
import {
  beginSelection,
  type CopySource,
  canSelectOnScreen,
  clearSelection,
  copySourceFor,
  extendSelection,
  getBandColumns,
  getBandTopRow,
  getSelectedText,
  lastAnswerText,
  setBandColumns,
  setBandTopRow,
  subscribeToSelection,
  visibleSelection,
} from "@/cli/app/viewport-selection";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import { showNotice } from "@/cli/helpers/notice";
import {
  type ClipboardResult,
  copyText,
} from "@/cli/helpers/terminal-clipboard";
import {
  type FrameStream,
  getTerminalFrame,
  getTerminalFrameVersion,
  isCapturingTerminalFrame,
  subscribeToTerminalFrame,
  writeToTerminal,
} from "@/cli/helpers/terminal-frame";
import {
  highlightRow,
  orderSelection,
  rowSelectionSpan,
} from "@/cli/helpers/text-selection";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { debugWarn } from "@/utils/debug";

/**
 * Drag selection over the rendered transcript, its highlight, and the copy key.
 *
 * The design decision this file carries out: what the drag covers is read from
 * the bytes Ink actually wrote (`terminal-frame.ts`) rather than from a second
 * renderer of the transcript. That is what makes the copied text exactly what the
 * user dragged over — diffs, boxes and highlighted code included — and it is why
 * the highlight can be painted by splicing two escape sequences into the row's
 * own bytes instead of re-rendering it.
 *
 * Five consequences worth knowing before changing anything here:
 *
 * 1. **The highlight is a terminal write, never React state.** A drag calls
 *    `writeToTerminal` directly; nothing re-renders, so a drag cannot cause the
 *    flicker the TUI guidance puts a red line around.
 * 2. **A frame erases the highlight.** Ink rewrites the frame (and on Windows in
 *    the alternate screen, clears it), so the painter repaints after every frame:
 *    it subscribes to the frame store, which is notified from inside the write
 *    that carried the frame. It paints where `visibleSelection` says the drag is
 *    now, which follows the layout — a scroll, or the band losing a row — and
 *    paints nothing when the rows no longer read as they did.
 * 3. **An unanchored frame is refused.** When the capture cannot prove which
 *    screen rows a frame occupies, no highlight is painted and the drag is not
 *    remembered either — a wrong highlight over the wrong text is worse than none.
 * 4. **The capture is installed by the process entry**, not here
 *    (`full-screen-terminal.ts`): Ink writes its first frame inside `render()`,
 *    before any React effect runs, so a capture installed in an effect would miss
 *    the frame that is already on screen.
 * 5. **OSC 52 cannot report failure.** The copy writes OSC 52 *and* runs the
 *    platform command, because a terminal that blocks OSC 52 (Windows Terminal
 *    ships that way) is indistinguishable from one that honoured it; the notice
 *    says what was attempted rather than claiming success.
 *
 * Selection rows are clamped to the transcript band, whose rows are 1..n by
 * construction: the full-screen shell renders the transcript region first, so the
 * band is the top of the frame (`getViewportRows`).
 */

const CURSOR_TO_LINE_START = (row: number) => `\u001B[${row};1H`;
const ERASE_TO_END = "\u001B[K";

/**
 * Rows the painter has marked, and which frame that marking belongs to. Module
 * state, like the selection itself: one shell is mounted at a time.
 */
let painted = new Map<number, string>();
let paintedFrame = -1;

function paintSelection(): void {
  const frame = getTerminalFrame();
  if (!isCapturingTerminalFrame() || !frame || !frame.anchored) {
    // Nothing can be located (or nothing is being captured): leave the screen
    // alone rather than paint rows we cannot place.
    painted.clear();
    paintedFrame = -1;
    return;
  }

  const frameVersion = getTerminalFrameVersion();
  if (frameVersion !== paintedFrame) {
    // A new frame repainted every row, so the old marks are gone with it.
    painted.clear();
    paintedFrame = frameVersion;
  }

  const selection = visibleSelection();
  const target = new Map<number, string>();
  if (selection) {
    const { start, end } = orderSelection(selection);
    // Rows outside the band are chrome — the tab row and its rule above, the
    // input and the status line below. The band can shrink under a standing
    // selection (the leader hint appears on the key press before the copy), and a
    // highlight drawn over the input would both look wrong and be copied.
    const top = getBandTopRow();
    const band = Math.max(1, getViewportRows());
    const columns = getBandColumns();
    const lastRow = Math.min(end.row, frame.lines.length, top + band);
    for (let row = Math.max(top + 1, start.row); row <= lastRow; row += 1) {
      const frameWidth = frame.widths[row - 1] ?? 0;
      const limit = columns > 0 ? Math.min(frameWidth, columns) : frameWidth;
      const span = rowSelectionSpan(selection, row, limit);
      if (!span) continue;
      const marked = highlightRow(
        frame.lines[row - 1] ?? "",
        span.from,
        span.to,
      );
      if (marked.changed) target.set(row, marked.line);
    }
  }

  let out = "";
  // Rows that were marked and no longer are: put the row's own bytes back.
  for (const [row] of painted) {
    if (target.has(row)) continue;
    const plain = frame.lines[row - 1];
    if (plain === undefined) continue;
    out += CURSOR_TO_LINE_START(row) + plain + ERASE_TO_END;
  }
  for (const [row, bytes] of target) {
    if (painted.get(row) === bytes) continue;
    out += CURSOR_TO_LINE_START(row) + bytes + ERASE_TO_END;
  }

  painted = target;
  if (out.length === 0) return;

  // Leave the cursor exactly where the frame write left it. Ink erases this frame
  // on its next write by counting up from the bottom of its output, so a painter
  // that left the cursor on a painted row would displace every frame after it.
  writeToTerminal(out + CURSOR_TO_LINE_START(frame.cursorRow));
}

/**
 * Where a drag's column has to stop: the last transcript column when the rail is
 * drawn (`0` means "no rail, the whole screen is text").
 */
function clampColumn(column: number): number {
  const band = getBandColumns();
  return band > 0 ? Math.min(Math.max(1, column), band) : Math.max(1, column);
}

function isInsideBand(row: number): boolean {
  const top = getBandTopRow();
  return row > top && row <= top + getViewportRows();
}

function clampedToBand(
  row: number,
  column: number,
): {
  row: number;
  column: number;
} {
  const top = getBandTopRow();
  const rows = Math.max(1, getViewportRows());
  return {
    row: Math.min(Math.max(top + 1, row), top + rows),
    column: Math.max(1, column),
  };
}

function methodLabel(method: ClipboardResult["method"]): string {
  if (method === "osc52+local") return "OSC 52 ＋ 本地";
  if (method === "osc52") return "OSC 52";
  if (method === "local") return "本地剪贴板";
  return "未送达";
}

/** What the notice says after a copy attempt. */
export function copyNotice(
  result: ClipboardResult,
  source: CopySource,
  text: string,
): string {
  if (source === "none" || result.method === "none") {
    return "没有复制成功：终端不支持 OSC 52，本地剪贴板命令也不可用";
  }
  const what = source === "selection" ? "选区" : "最后一条回答";
  const lines = text.split("\n").length;
  return `已复制${what}（${lines} 行，${methodLabel(result.method)}）`;
}

export interface TerminalSelectionOptions {
  /** The stream Ink writes to; the frame is read from it. Defaults to stdout. */
  stream?: FrameStream;
  /** The transcript items, for the "copy the last answer" fallback. */
  items?: () => readonly StaticItem[];
  /**
   * The platform clipboard command. A seam for tests, which must not overwrite the
   * clipboard of the machine they run on.
   */
  copyLocally?: (text: string) => boolean;
  /**
   * Screen rows the shell draws above the band: the M6 tab strip and its rule.
   *
   * Zero — the append shell and every M3-era frame — means the band starts at the
   * top of the screen, which is what the whole selection path used to assume.
   */
  bandTopRow?: number;
  /**
   * Screen columns the transcript owns. The M6 rail occupies the rest of the band
   * and is chrome, so a selection stops at this column (`0` = the whole width).
   */
  bandColumns?: number;
}

export function useTerminalSelection(
  options: TerminalSelectionOptions = {},
): void {
  const {
    stream = process.stdout,
    items,
    copyLocally,
    bandTopRow = 0,
    bandColumns = 0,
  } = options;

  // The offset is read by mouse reports and by the painter, both of which run
  // long after this effect, so setting it from an effect (rather than passing it
  // down) cannot race with a report.
  useEffect(() => {
    setBandTopRow(bandTopRow);
    setBandColumns(bandColumns);
    return () => {
      setBandTopRow(0);
      setBandColumns(0);
    };
  }, [bandTopRow, bandColumns]);

  useEffect(() => {
    const repaint = () => paintSelection();
    const unsubscribeFrame = subscribeToTerminalFrame(repaint);
    const unsubscribeSelection = subscribeToSelection(repaint);
    // A frame may already have been drawn before this effect ran.
    repaint();
    return () => {
      unsubscribeFrame();
      unsubscribeSelection();
      painted.clear();
      paintedFrame = -1;
    };
  }, []);

  useEffect(() => {
    return registerMouseHandler(
      (report) => {
        // Rows above the band are the shell's chrome — the tab row and the rule
        // under it. They are not text, so this layer declines them outright rather
        // than reading a press there as "the user clicked outside the transcript,
        // end the selection": the chrome layer owns that row (it is consulted
        // first), and the two layers disagreeing about a row is how a click gets
        // swallowed twice over.
        if (getBandTopRow() > 0 && report.row <= getBandTopRow()) return false;
        // The wheel belongs to the scroll layer, which runs before this one.
        if (report.wheel) return false;
        if (report.kind === "press") {
          if (report.button !== "left") return false;
          // A press on the rail is a press on chrome: it ends a selection the way
          // clicking the input does, and it never starts one — the rail is not
          // text and has nothing to drag over.
          if (getBandColumns() > 0 && report.column > getBandColumns()) {
            clearSelection();
            return true;
          }
          if (!isInsideBand(report.row)) {
            // A click outside the transcript (the input, the status line) ends the
            // selection, the way clicking away from a selection does anywhere else.
            clearSelection();
            return true;
          }
          if (!canSelectOnScreen()) {
            // A drag that does nothing looks exactly like a broken key path, and this
            // is the only state where the app deliberately draws nothing.
            debugWarn(
              "selection",
              "no anchored frame: the drag cannot be placed on screen",
            );
            return true;
          }
          beginSelection({
            row: report.row,
            column: clampColumn(report.column),
          });
          return true;
        }
        if (report.kind === "move") {
          // `1002` reports motion only while a button is held, so a move is a drag.
          extendSelection(
            clampedToBand(report.row, clampColumn(report.column)),
          );
          return true;
        }
        // A release keeps what was dragged: the copy key is what commits it, so a
        // stray drag never overwrites the clipboard on its own.
        return true;
      },
      { name: "selection" },
    );
  }, []);

  useKeyBindings("selection", [
    {
      scope: "app",
      bindings: [
        {
          id: "leader.copySelection",
          leader: true,
          chords: LEADER_KEY_CHORDS.copySelection,
          label: "复制选区 / 最后一条回答",
          run: () => {
            const { source, text } = copySourceFor(
              getSelectedText(),
              items ? lastAnswerText(items()) : "",
            );
            if (source === "none") {
              showNotice("没有可复制的内容");
              return "consumed";
            }
            showNotice(
              copyNotice(copyText(text, { stream, copyLocally }), source, text),
            );
            return "consumed";
          },
        },
      ],
    },
  ]);
}
