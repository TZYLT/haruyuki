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
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";

/**
 * The wheel, end to end: real Ink frames over the real scroll store.
 *
 * Why this file exists rather than another store test: the bugs it pins are only
 * visible through the whole path, and both of them showed up as "the wheel
 * sometimes does nothing".
 *
 * 1. **A spin arrives as one batch.** Many reports come in one stdin read, Ink
 *    emits them in one batch, and React renders the store's state once — so a
 *    relative move measured from the last *reported* position loses every notch
 *    after the first. Measured before the fix: 40 notches moved 3 rows.
 * 2. **The offset has to move the drawn rows.** The band is a row band, so a
 *    notch inside an item taller than the band must move the content; when the
 *    band was merely bottom-aligned, the offset moved while the frame stayed
 *    byte-identical. Measured before the fix: eight notches, no frame changed at
 *    all — which is also why a scroll that "did nothing" flashed the screen (on
 *    Windows an unchanged frame is still cleared and repainted).
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

/** A viewport that renders the window the store asks for, like the real one. */
function MiniViewport({ rows }: { rows: readonly number[] }) {
  useSyncExternalStore(subscribeToViewportScroll, getViewportScrollVersion);
  const request = getViewportScrollRequest();
  const scrollRows = request.kind === "rows" ? request.rows : 0;
  const anchor = request.kind === "anchor" ? request.anchor : undefined;
  const window = fitScrolledItemsFromEnd(
    rows.length,
    VIEWPORT_ROWS,
    200,
    scrollRows,
    // Mirrors the production measure: the row model counts the item's own gap,
    // and the viewport wraps each item in a box carrying the same gap again.
    (index) => (rows[index] ?? 0) + (index > 0 ? 1 : 0),
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
      overflow="hidden"
      flexShrink={0}
    >
      <Box
        flexDirection="column"
        flexShrink={0}
        marginTop={window.contentOffset}
      >
        {visible.map((index) => (
          <Box
            key={index}
            flexDirection="column"
            flexShrink={0}
            marginTop={index > 0 ? 1 : 0}
          >
            {Array.from(
              { length: rows[index] ?? 0 },
              (_, line) => `item ${index} row ${line}`,
            ).map((text) => (
              <Text key={text}>{text}</Text>
            ))}
          </Box>
        ))}
      </Box>
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountViewport(rows: readonly number[]): Promise<{
  stdout: Capture;
  stop: () => void;
}> {
  const stdout = new Capture();
  // Installed before Ink's first write, exactly as the process entry does it.
  installTerminalFrameCapture(stdout);
  const instance = render(<MiniViewport rows={rows} />, {
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

/** How far above the newest row the store's final position sits. */
function appliedRows(rows: readonly number[]): number {
  const request = getViewportScrollRequest();
  if (request.kind === "rows") return request.rows;
  // The same weights the window itself is fitted with (see `MiniViewport`).
  const weighted = (index: number) => (rows[index] ?? 0) + (index > 0 ? 1 : 0);
  let below = 0;
  for (let index = request.anchor.end; index < rows.length; index += 1) {
    below += weighted(index);
  }
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
    const rows = Array.from({ length: 100 }, () => 4);
    const { stdout, stop } = await mountViewport(rows);
    try {
      const mark = stdout.chunks.length;
      const notches = 40;
      // One task, no await: this is what a spin looks like after Ink has read a
      // single chunk that carried many reports.
      for (let index = 0; index < notches; index += 1) {
        scrollTranscriptWheel("up");
      }
      await sleep(250);

      expect(appliedRows(rows)).toBe(notches * WHEEL_ROWS_PER_NOTCH);
      // The batch is one paint, not one per notch: React batches the published
      // state, and the frame that follows covers every row of it.
      expect(frames(stdout.chunks.slice(mark)).length).toBeLessThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test("a notch that is followed by a report still measures from the reported row", async () => {
    const rows = Array.from({ length: 100 }, () => 4);
    const { stdout, stop } = await mountViewport(rows);
    try {
      const mark = stdout.chunks.length;
      scrollTranscriptWheel("up");
      await sleep(150);
      scrollTranscriptWheel("up");
      await sleep(250);

      expect(appliedRows(rows)).toBe(2 * WHEEL_ROWS_PER_NOTCH);
      expect(frames(stdout.chunks.slice(mark)).length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("every notch moves the drawn rows, inside one tall item", async () => {
    // The bottom item is taller than the band, so every notch of the first ten
    // stays inside it: the item set does not change, and only the window's offset
    // can move the text. Each notch must move it by exactly one notch.
    const rows = [4, 4, 4, 30, 30];
    const { stop } = await mountViewport(rows);
    try {
      const firstLineAfter: string[] = [];
      for (let notch = 0; notch < 5; notch += 1) {
        scrollTranscriptWheel("up");
        await sleep(150);
        firstLineAfter.push(getTerminalFrame()?.text[0] ?? "");
      }

      // Starting from the item's last screen and walking up three rows a notch.
      expect(firstLineAfter).toEqual([
        "item 4 row 15",
        "item 4 row 12",
        "item 4 row 9",
        "item 4 row 6",
        "item 4 row 3",
      ]);
    } finally {
      stop();
    }
  });

  test("a full-height frame is cleared before it is redrawn on Windows", async () => {
    const rows = Array.from({ length: 100 }, () => 4);
    const { stdout, stop } = await mountViewport(rows);
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
