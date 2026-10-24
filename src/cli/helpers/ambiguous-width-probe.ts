// src/cli/helpers/ambiguous-width-probe.ts

import { debugLog } from "@/utils/debug";
import {
  type AmbiguousWidth,
  getAmbiguousWidth,
  getAmbiguousWidthMode,
  getAmbiguousWidthSource,
  repaintForAmbiguousWidth,
  setAmbiguousWidth,
} from "./char-width";

/**
 * Ask the terminal how wide it draws Unicode's ambiguous characters.
 *
 * The question cannot be answered from the strings the app has: the width is a
 * property of the terminal *and the font it is drawing with*. Measured on the
 * machine this is developed on, the same build aligns under Consolas and drifts
 * under 等宽楷体 (2026-10-21) — so any constant is wrong for one of them, and the
 * app has to ask instead of assume.
 *
 * There is exactly one way to ask: print one such character where the cursor
 * position is known, then ask where the cursor ended up (`CSI 6n`, the "device
 * status report", answered by every VT-style terminal with `CSI row ; col R`). A
 * one-column glyph leaves the cursor in the next column; a two-column one, two
 * columns on.
 *
 * **It cannot move the cursor vertically.** Ink tracks where it left the cursor
 * and builds its erase/redraw arithmetic from that (`cursor-helpers.js`:
 * `buildReturnToBottom`), so a probe that jumps to the home cell corrupts the next
 * frame. The probe therefore writes `\r` — carriage return, same row — prints its
 * character, and asks. The glyph lands over the frame's bottom-left cell for the
 * few milliseconds before the next frame repaints it; the answer also forces that
 * repaint (the width version), so it never stays.
 *
 * **It writes nothing outside the alternate screen.** The probe is armed by the
 * full-screen shell's mount, i.e. after Ink has taken the screen, so nothing of it
 * can end up in the user's scrollback when the app exits.
 *
 * **It claims its reply.** A DSR reply nobody reads is not ignored — Ink has no
 * parser for it, so it reaches the input path and gets typed. `input-router.ts`
 * claims the shape (before its mouse grammar) and calls
 * `claimAmbiguousWidthReply`; a stray reply is still claimed, and only completes
 * the answer when a probe is armed.
 */

/** The character the probe prints. Ambiguous: one column or two, never three. */
const PROBE_CHARACTER = "\u2014";

/** Same row, first column, print the character, ask where the cursor went. */
export const AMBIGUOUS_WIDTH_PROBE_BYTES = `\r${PROBE_CHARACTER}\u001B[6n`;

/** How long a probe stays armed. Long enough for a real terminal, short enough to
 * not swallow a DSR reply that arrives a frame later. */
export const AMBIGUOUS_WIDTH_PROBE_TIMEOUT_MS = 120;

const ESC = "\u001B";

/**
 * `CSI row ; col R`, built from a constant for the reason `mouse-sequence.ts`
 * does the same: a literal regexp cannot carry the escape byte
 * (`noControlCharactersInRegex`), and the parser it belongs to has to read the
 * exact bytes a terminal sends.
 */
const DSR_REPLY = new RegExp(`${ESC}\\[(\\d+);(\\d+)R`);

/**
 * The column a `CSI row ; col R` reply reports, or `null` when the payload is not
 * a reply.
 *
 * Pure, and the only part of the protocol worth testing without a terminal.
 */
export function probeReplyColumn(reply: string): number | null {
  const match = DSR_REPLY.exec(reply);
  if (!match) return null;
  const column = Number.parseInt(match[2] ?? "", 10);
  return Number.isSafeInteger(column) ? column : null;
}

/**
 * The ambiguous width a reported column implies, or `null` when it implies none.
 *
 * The probe printed in column 1, so one column spent leaves the cursor in column
 * 2 and two columns leave it in column 3. Anything else is a terminal saying
 * something this module does not understand, and is treated as no answer.
 */
export function columnToAmbiguousWidth(column: number): AmbiguousWidth | null {
  if (column === 2) return 1;
  if (column === 3) return 2;
  return null;
}

/** Whether a payload is a cursor-position report, whoever asked for it. */
export function isCursorPositionReply(payload: string): boolean {
  return DSR_REPLY.test(payload);
}

let armed = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function isAmbiguousWidthProbeArmed(): boolean {
  return armed;
}

/** Disarm without an answer (a timeout, an unmount, a test). */
export function disarmAmbiguousWidthProbe(): void {
  armed = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

export type AmbiguousWidthProbeStart =
  | { kind: "armed" }
  | { kind: "skipped"; reason: "not-a-tty" | "disabled" | "already-resolved" };

/**
 * Arm the probe and write it.
 *
 * Called once, from the full-screen shell's mount. A session whose width is
 * already known (a mode or a previous answer) does not probe again: the answer
 * cannot change mid-session without a resize, and a resize re-arms this.
 */
export function startAmbiguousWidthProbe(
  options: {
    stdin?: NodeJS.ReadStream;
    stdout?: { write(chunk: string): unknown; isTTY?: boolean };
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): AmbiguousWidthProbeStart {
  const env = options.env ?? process.env;
  if (env.HARUYUKI_AMBIGUOUS_WIDTH_PROBE === "0") {
    return { kind: "skipped", reason: "disabled" };
  }
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    return { kind: "skipped", reason: "not-a-tty" };
  }
  if (armed) disarmAmbiguousWidthProbe();
  armed = true;
  timer = setTimeout(() => {
    // No answer: stop waiting, and repaint to erase the glyph the probe printed.
    // The number is left alone — a terminal that answered once (a wide font) must
    // not be downgraded because one later probe went unanswered.
    disarmAmbiguousWidthProbe();
    repaintForAmbiguousWidth();
    debugLog(
      "char-width",
      "probe unanswered; keeping the width table's current answer",
    );
  }, options.timeoutMs ?? AMBIGUOUS_WIDTH_PROBE_TIMEOUT_MS);
  // Never let a pending probe hold the process open.
  timer.unref?.();
  stdout.write(AMBIGUOUS_WIDTH_PROBE_BYTES);
  return { kind: "armed" };
}

/**
 * Read a raw payload as the probe's answer.
 *
 * Returns `true` for **any** cursor-position report: an unread one is typed into
 * the draft (`[1;3R`) exactly like an unread mouse report, so claiming the shape is
 * worth doing whether or not this one is the answer the module is waiting for.
 */
export function claimAmbiguousWidthReply(payload: string): boolean {
  if (!isCursorPositionReply(payload)) return false;
  if (!armed) return true;
  disarmAmbiguousWidthProbe();
  const column = probeReplyColumn(payload);
  const width = column === null ? null : columnToAmbiguousWidth(column);
  if (width === null) {
    debugLog(
      "char-width",
      `probe reply unreadable: ${JSON.stringify(payload)}; keeping the current answer`,
    );
    repaintForAmbiguousWidth();
    return true;
  }
  // **A re-probe may widen, never narrow.** The two mistakes are not equal: a row
  // laid out one column too wide is a column of right margin, while one laid out a
  // column too narrow is a row the terminal wraps — which costs a physical line and
  // scrolls the top of the alternate screen (the tab strip) away for good. The
  // session log shows the answer flipping `3 -> 2 -> 1` across resizes on a terminal
  // whose font nobody changed (2026-10-21), so a lone "narrower" reply is not
  // evidence worth that risk. `narrow` stays reachable: `/config font-width narrow` pins it.
  if (
    width < getAmbiguousWidth() &&
    getAmbiguousWidthSource() === "probe" &&
    getAmbiguousWidthMode() === "auto"
  ) {
    repaintForAmbiguousWidth();
    debugLog(
      "char-width",
      `probe: cursor column ${column} -> ${width} column(s), but ${getAmbiguousWidth()} is in force; keeping the wider answer (pin it with /config font-width narrow)`,
    );
    return true;
  }
  setAmbiguousWidth(width);
  debugLog(
    "char-width",
    `probe: cursor column ${column} -> ambiguous characters are ${width} column(s)`,
  );
  return true;
}

/** Test seam: no probe armed, nothing waiting. */
export function resetAmbiguousWidthProbeForTests(): void {
  disarmAmbiguousWidthProbe();
}
