/**
 * The full-screen frame never draws past the terminal.
 *
 * The band is sized from the chrome and panel measured on the *previous* frame —
 * Ink paints during the commit and React's layout effects run after it — so a
 * frame that grows (a pinned approval, the exit stats, a taller input) came out
 * taller than the terminal: measured on the machine at 50 rows into a 46-row
 * screen. A terminal scrolls such a frame, which shifts the whole layout up for
 * that one frame; the user reported it as the input bar jumping while the wheel
 * scrolled. The frame's own height is pinned and clipped for that reason, and this
 * test grows a child past the terminal to hold it in place.
 */

import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
  subscribeToTerminalFrame,
} from "@/cli/helpers/terminal-frame";
import { FullScreenFrame } from "./V2Shell";

const TERMINAL_ROWS = 10;
const TERMINAL_COLUMNS = 80;

class CaptureStream extends Writable {
  columns = TERMINAL_COLUMNS;
  rows = TERMINAL_ROWS;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

/**
 * `useTerminalRows` follows `process.stdout`, which the shell in production writes
 * to; a test writing to its own stream has to move the process's numbers to match.
 */
function resizeProcessStdout(rows: number, columns: number): () => void {
  const saved = {
    rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
  };
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: rows,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  process.stdout.emit("resize");
  return () => {
    for (const key of ["rows", "columns"] as const) {
      const descriptor = saved[key];
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      } else {
        delete (process.stdout as { rows?: number; columns?: number })[key];
      }
    }
    process.stdout.emit("resize");
  };
}

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

/** A child that stands in for the chrome: its row count is what the caller says. */
function Content({ rows }: { rows: number }) {
  const lines = Array.from({ length: rows }, (_, index) => `content ${index}`);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line) => (
        <Text key={line}>{line}</Text>
      ))}
    </Box>
  );
}

const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 80));

test("a child taller than the terminal is clipped to the terminal", async () => {
  const restore = resizeProcessStdout(TERMINAL_ROWS, TERMINAL_COLUMNS);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  // Installed before Ink's first write, as the process entry does it.
  installTerminalFrameCapture(stdout);

  const heights: number[] = [];
  const unsubscribe = subscribeToTerminalFrame(() => {
    const frame = getTerminalFrame();
    if (frame) heights.push(frame.lines.length);
  });

  const instance = render(
    <FullScreenFrame>
      <Content rows={4} />
    </FullScreenFrame>,
    {
      stdin: fakeStdin(),
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
      alternateScreen: true,
    },
  );

  try {
    await waitForRender();
    const mark = heights.length;
    // The chrome grew after the frame the band was sized for: without the pinned
    // height this frame is 16 rows in a 10-row terminal.
    instance.rerender(
      <FullScreenFrame>
        <Content rows={TERMINAL_ROWS + 6} />
      </FullScreenFrame>,
    );
    await waitForRender();

    const grown = heights.slice(mark);
    expect(grown.length).toBeGreaterThan(0);
    expect(Math.max(...grown)).toBeLessThanOrEqual(TERMINAL_ROWS);
    // Clipped, not scaled: the rows that fit are the top ones and the last screen
    // row is the last row that fits.
    expect(getTerminalFrame()?.text.at(-1)).toBe(
      `content ${TERMINAL_ROWS - 1}`,
    );
  } finally {
    unsubscribe();
    instance.unmount();
    instance.cleanup();
    resetTerminalFrameForTests();
    restore();
  }
});
