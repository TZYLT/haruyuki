import {
  type AnsiToken,
  scanAnsi,
  visibleText,
  visibleWidth,
} from "./ansi-scan";

/**
 * The frame Ink last drew, read from the bytes it wrote.
 *
 * The selection needs the characters that are *on screen*, and this app has no
 * second renderer to ask: every transcript item is arbitrary JSX (markdown,
 * diffs, boxes), so a text projection would be a second implementation of a
 * layout the row model already fights to keep single-sourced. Reading Ink's own
 * output has none of that risk — it is the same text the user is looking at.
 *
 * It is affordable because Ink 7's default render mode is not incremental
 * (`render.js` sets `incrementalRendering: false`), so a frame arrives as one
 * `stdout.write` of the whole frame.
 *
 * ## What makes a write a frame, and where its rows are
 *
 * A frame is a write that clears the screen or spans several lines. Its rows are
 * the write's lines, and the only question that matters is **whether row 1 of the
 * write is row 1 of the screen** (`anchored`), because everything the selection
 * does — copying, highlighting — is expressed in screen coordinates.
 *
 * Three cases, all measured against Ink 7 rather than assumed:
 *
 * 1. **The write clears the screen** (`ESC[2J`, which Ink emits on Windows for
 *    every full-height frame and elsewhere whenever a frame grows into or out of
 *    the screen). Clearing homes the cursor, so the rows are rows 1..n.
 * 2. **The write follows the alternate-screen entry.** Ink writes `ESC[?1049h`,
 *    the terminal hands over a fresh screen with the cursor at row 1, and the
 *    first frame drawn on it therefore starts there whatever its shape.
 * 3. **Neither, but the previous frame was anchored and has the same number of
 *    rows.** Ink erases the previous frame first (`eraseLines`), which walks the
 *    cursor back up to that frame's first row — the same row this frame starts
 *    at, provided the height did not change.
 *
 * Anything else is recorded as unanchored, and the selection refuses to work on
 * an unanchored frame: a highlight painted on the wrong rows, or a copy of the
 * wrong text, is worse than no selection.
 */

export interface TerminalFrame {
  /** Each row's bytes, cursor and erase sequences stripped, ready to repaint. */
  lines: readonly string[];
  /** The characters each row puts on screen. */
  text: readonly string[];
  /** The display width of each row's text. */
  widths: readonly number[];
  /** Whether these rows are known to be the screen's rows 1..n. */
  anchored: boolean;
}

export interface FrameStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

const ESC = "\u001B";
const CLEAR_SCREEN = `${ESC}[2J`;
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;

/**
 * Sequences that only move or erase: the erase prefix Ink puts in front of a
 * frame body. They never occur at the start of a row's own content, so removing
 * them is what makes a row paintable without also erasing the row above it.
 *
 * Composed from the escape character rather than written as a regex literal: a
 * literal may not contain control characters.
 */
const CURSOR_ESCAPE_PREFIX = new RegExp(`^(${ESC}\\[[0-9;?]*[ABCDEFGHJKfdlh])`);

let frame: TerminalFrame | null = null;
let version = 0;
let capturedStream: FrameStream | null = null;
let painting = false;
/** Set by the alternate-screen entry, consumed by the first frame after it. */
let freshScreen = false;
const listeners = new Set<() => void>();

const installations = new WeakMap<
  FrameStream,
  {
    count: number;
    originalWrite: FrameStream["write"];
    wrapper: FrameStream["write"];
    /** Whether the stream had its own `write` before we wrapped it. */
    hadOwnWrite: boolean;
  }
>();
/** Installed streams, so the test seam can restore all of them. */
const installedStreams = new Set<FrameStream>();

function parseRows(chunk: string): string[] {
  const rows: string[] = [];
  let current: AnsiToken[] = [];

  for (const token of scanAnsi(chunk)) {
    if (token.kind === "control") {
      // Only a newline ends a row. A carriage return would mean the row is drawn
      // twice, which Ink does not do; ignoring it keeps the text already read.
      if (token.value === "\n") {
        rows.push(current.map((entry) => entry.value).join(""));
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  // A body that ends with a newline leaves the cursor on a row of its own, which
  // is not content.
  if (current.length > 0)
    rows.push(current.map((entry) => entry.value).join(""));

  return rows.map(stripLeadingCursorEscapes);
}

/** Drop the erase-and-move prefix Ink writes in front of a frame body. */
function stripLeadingCursorEscapes(row: string): string {
  let rest = row;
  for (;;) {
    const match = CURSOR_ESCAPE_PREFIX.exec(rest);
    if (!match?.[1]) return rest;
    rest = rest.slice(match[1].length);
  }
}

function looksLikeFrame(chunk: string): boolean {
  return chunk.includes(CLEAR_SCREEN) || chunk.includes("\n");
}

function recordFrame(chunk: string, fromFreshScreen: boolean): void {
  const lines = parseRows(chunk);
  if (lines.length === 0) return;

  const cleared = chunk.includes(CLEAR_SCREEN);
  const anchored =
    cleared ||
    fromFreshScreen ||
    (frame?.anchored === true && frame.lines.length === lines.length);

  frame = {
    lines,
    text: lines.map(visibleText),
    widths: lines.map(visibleWidth),
    anchored,
  };
  version += 1;
  for (const listener of listeners) listener();
}

function handleWrite(chunk: unknown): void {
  if (typeof chunk !== "string") return;
  if (chunk.includes(ENTER_ALT_SCREEN)) {
    // The terminal is handing over a fresh screen; the frame that follows is the
    // first thing drawn on it, at row 1.
    freshScreen = true;
  }
  if (!looksLikeFrame(chunk)) return;
  recordFrame(chunk, freshScreen);
  freshScreen = false;
}

/**
 * Start capturing the frames written to `stream`.
 *
 * Idempotent and reference-counted per stream, like the input router: more than
 * one consumer may want the frame, and the last release restores the stream's own
 * `write`.
 */
export function installTerminalFrameCapture(stream: FrameStream): () => void {
  const existing = installations.get(stream);
  if (existing) {
    existing.count += 1;
    return () => releaseTerminalFrameCapture(stream);
  }
  if (stream.isTTY !== true) return () => {};

  const originalWrite = stream.write;
  const hadOwnWrite = Object.hasOwn(stream, "write");
  const wrapper: FrameStream["write"] = function (
    this: FrameStream,
    chunk: string,
  ) {
    const result = originalWrite.call(this, chunk);
    // Our own highlight writes are decorations, not frames: reading them back
    // would make the selection copy its own inverse markers.
    if (!painting) handleWrite(chunk);
    return result;
  };

  installations.set(stream, { count: 1, originalWrite, wrapper, hadOwnWrite });
  installedStreams.add(stream);
  stream.write = wrapper;
  capturedStream = stream;
  return () => releaseTerminalFrameCapture(stream);
}

function releaseTerminalFrameCapture(stream: FrameStream): void {
  const installation = installations.get(stream);
  if (!installation) return;
  installation.count -= 1;
  if (installation.count > 0) return;
  installations.delete(stream);
  installedStreams.delete(stream);
  if (stream.write === installation.wrapper) {
    if (installation.hadOwnWrite) stream.write = installation.originalWrite;
    // Otherwise the stream's `write` was inherited; removing our own property is
    // what restores it.
    else delete (stream as { write?: FrameStream["write"] }).write;
  }
  if (capturedStream === stream) {
    capturedStream = null;
    frame = null;
    freshScreen = false;
  }
}

/** The last frame Ink drew, or `null` when nothing has been captured. */
export function getTerminalFrame(): TerminalFrame | null {
  return frame;
}

/** Bumped on every frame, so a consumer can tell a repaint from a change. */
export function getTerminalFrameVersion(): number {
  return version;
}

export function subscribeToTerminalFrame(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Write to the captured terminal *outside* the frame bookkeeping.
 *
 * This is how the highlight is drawn: it is a decoration on top of the frame, not
 * a frame, and it must not become the text the selection reads.
 */
export function writeToTerminal(text: string): boolean {
  if (!capturedStream) return false;
  painting = true;
  try {
    capturedStream.write(text);
  } finally {
    painting = false;
  }
  return true;
}

/** Whether a stream is being captured; the painter needs one to exist. */
export function isCapturingTerminalFrame(): boolean {
  return capturedStream !== null;
}

/** Test seam: drop every installation, the frame and the subscribers. */
export function resetTerminalFrameForTests(): void {
  for (const stream of [...installedStreams]) {
    const installation = installations.get(stream);
    if (installation && stream.write === installation.wrapper) {
      delete (stream as { write?: FrameStream["write"] }).write;
    }
    installations.delete(stream);
  }
  installedStreams.clear();
  capturedStream = null;
  frame = null;
  version = 0;
  freshScreen = false;
  painting = false;
  listeners.clear();
}
