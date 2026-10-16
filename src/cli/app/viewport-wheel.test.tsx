import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import { useEffect, useSyncExternalStore } from "react";
import {
  getViewportScrollRequest,
  getViewportScrollVersion,
  reportViewportPosition,
  resetViewportScroll,
  scrollTranscriptWheel,
  setViewportRows,
  subscribeToViewportScroll,
  WHEEL_ROWS_PER_NOTCH,
} from "@/cli/app/viewport-scroll";
import { fitScrolledItemsFromEnd } from "@/cli/app/viewport-window";
import {
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";

/**
 * The wheel, end to end: real Ink frames over the real scroll store.
 *
 * Why this file exists rather than another store test: the bug it pins is only
 * visible through the whole path. A wheel spin arrives as many reports in **one
 * stdin read**, Ink emits them in one batch, and React renders the store's state
 * once — so a relative move measured from the last *reported* position loses
 * every notch after the first. Measured before the fix: 40 notches in one batch
 * moved 3 rows. The store cannot see the batching; the frame can.
 *
 * The second thing pinned here is what a scroll frame costs on Windows: a frame
 * that fills the terminal is fully cleared (`ESC[2J`) before it is redrawn, once
 * per frame. That is Ink's own behaviour for Windows consoles (its comment
 * explains why the erase-and-rewrite path desynchronizes there), and it is the
 * reason a spinning wheel can look like a flashing screen — the number of frames
 * is what a scroll cost is measured in, so it is asserted rather than assumed.
 */

const ESC = "\u001B";
const CLEAR = `${ESC}[2J`;

class Capture extends Writable {
  columns = 40;
  rows = 12;
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

const VIEWPORT_ROWS = 12;
const ITEM_ROWS = 4;
const ITEM_COUNT = 100;

/** A viewport that renders the window the store asks for, like the real one. */
function MiniViewport() {
  useSyncExternalStore(subscribeToViewportScroll, getViewportScrollVersion);
  const request = getViewportScrollRequest();
  const scrollRows = request.kind === "rows" ? request.rows : 0;
  const anchor = request.kind === "anchor" ? request.anchor : undefined;
  const window = fitScrolledItemsFromEnd(
    ITEM_COUNT,
    VIEWPORT_ROWS,
    200,
    scrollRows,
    () => ITEM_ROWS,
    anchor,
  );
  useEffect(() => {
    setViewportRows(VIEWPORT_ROWS);
  }, []);
  useEffect(() => {
    reportViewportPosition({
      rows: window.scrollFromBottom,
      anchor: window.anchor,
    });
  }, [window]);

  const visible: number[] = [];
  for (let index = window.start; index < window.end; index += 1) {
    visible.push(index);
  }

  return (
    <Box
      height={VIEWPORT_ROWS}
      flexDirection="column"
      justifyContent="flex-end"
      overflow="hidden"
      flexShrink={0}
    >
      {visible.map((index) => (
        <Box key={index} flexDirection="column" flexShrink={0}>
          {[0, 1, 2, 3].map((line) => (
            <Text key={line}>{`item ${index} line ${line}`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

async function mountViewport(): Promise<{
  stdout: Capture;
  stop: () => void;
}> {
  const stdout = new Capture();
  // Installed before Ink's first write, exactly as the process entry does it.
  installTerminalFrameCapture(stdout);
  const instance = render(<MiniViewport />, {
    stdin: fakeStdin(),
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  await sleep(150);
  return {
    stdout,
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How far above the newest row the store's final position sits. */
function appliedRows(): number {
  const request = getViewportScrollRequest();
  if (request.kind === "rows") return request.rows;
  const below = (ITEM_COUNT - request.anchor.end) * ITEM_ROWS;
  return below + request.anchor.delta;
}

/** Frame writes carry the frame's newlines; the sync markers do not. */
function frames(chunks: readonly string[]): string[] {
  return chunks.filter((chunk) => chunk.includes("\n"));
}

afterEach(() => {
  resetViewportScroll();
  resetTerminalFrameForTests();
});

describe("wheel scrolling on a real frame", () => {
  test("a batch of notches moves the whole distance in one frame", async () => {
    const { stdout, stop } = await mountViewport();
    try {
      const mark = stdout.chunks.length;
      const notches = 40;
      // One task, no await: this is what a spin looks like after Ink has read a
      // single chunk that carried many reports.
      for (let index = 0; index < notches; index += 1) {
        scrollTranscriptWheel("up");
      }
      await sleep(250);

      expect(appliedRows()).toBe(notches * WHEEL_ROWS_PER_NOTCH);
      // The batch is one paint, not one per notch: React batches the published
      // state, and the frame that follows covers every row of it.
      expect(frames(stdout.chunks.slice(mark)).length).toBeLessThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test("a notch that is followed by a report still measures from the reported row", async () => {
    const { stdout, stop } = await mountViewport();
    try {
      const mark = stdout.chunks.length;
      scrollTranscriptWheel("up");
      await sleep(150);
      scrollTranscriptWheel("up");
      await sleep(250);

      expect(appliedRows()).toBe(2 * WHEEL_ROWS_PER_NOTCH);
      expect(frames(stdout.chunks.slice(mark)).length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("a full-height frame is cleared before it is redrawn on Windows", async () => {
    const { stdout, stop } = await mountViewport();
    try {
      const mark = stdout.chunks.length;
      scrollTranscriptWheel("up");
      await sleep(250);

      const written = frames(stdout.chunks.slice(mark));
      expect(written.length).toBeGreaterThan(0);
      if (process.platform === "win32") {
        // The cost of one scroll frame, and the reason the wheel can flash: the
        // whole screen is cleared and repainted rather than erased and rewritten.
        expect(written.join("")).toContain(CLEAR);
      }
    } finally {
      stop();
    }
  });
});
