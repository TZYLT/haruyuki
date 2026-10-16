/**
 * The frame's chrome keeps its rows when the band's height is one frame stale.
 *
 * `ViewportTranscript` sizes its band as `terminalRows - chrome - panel`, and both
 * measures come from the *previous* frame: Ink paints during the commit and React's
 * layout effects run after it. The pinned frame (`FullScreenFrame`) then has to
 * drop the rows that do not fit, and *where* it takes them from is a flex decision
 * — a decision that was wrong, and wrong in a way that never recovered:
 *
 * the chrome box was shrinkable, so Yoga squeezed it to zero rows, `measureElement`
 * reported that squeezed zero, the band was sized from the zero as `rows - 0`, the
 * chrome was squeezed again, and the input stayed off the bottom of the frame for
 * the rest of the session. The user reported it as "nothing I type appears" —
 * `resizeProcessStdout` + a real Ink render reproduces it exactly, and this test
 * fails on that revision with an empty `input` row.
 *
 * So the rule this pins: the band is the frame's **one elastic box**, and every box
 * that gets measured is rigid. `AppView`'s chrome box is `flexShrink={0}` for the
 * same reason; it cannot be mounted here without its hundred-prop bag, so the
 * contract is held from the band's side (which is the deciding side: with the band
 * elastic there is nothing left for Yoga to take from the chrome).
 */

import { afterEach, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import { useRef } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import {
  ChromeHeightContext,
  useMeasuredChromeHeight,
} from "@/cli/app/chrome-height";
import { resetOlderHistoryForTests } from "@/cli/app/older-history";
import { ViewportTranscript } from "@/cli/app/ViewportTranscript";
import { resetViewportScroll } from "@/cli/app/viewport-scroll";
import { createBuffers } from "@/cli/helpers/accumulator";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
  subscribeToTerminalFrame,
} from "@/cli/helpers/terminal-frame";
import { FullScreenFrame } from "./V2Shell";

const TERMINAL_ROWS = 10;
const TERMINAL_COLUMNS = 80;
/** The input's own chrome: a divider, the draft row, a divider and the footer. */
const CHROME_ROWS = 5;

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

/** Stands in for the composer: as many rows as the caller says, and rigid. */
function ChromeRows({ rows }: { rows: number }) {
  const lines = Array.from({ length: rows }, (_, index) => `input ${index}`);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line) => (
        <Text key={line}>{line}</Text>
      ))}
    </Box>
  );
}

/** Measured chrome heights, in render order, for the assertions below. */
let measured: (number | null)[] = [];

/**
 * `AppView`'s box structure without its plumbing: the transcript behind the
 * chrome-height context, and the measured chrome under it.
 */
function Shell({ chromeRows }: { chromeRows: number }) {
  const { ref, rows } = useMeasuredChromeHeight();
  measured.push(rows);
  const buffersRef = useRef(createBuffers());

  return (
    <FullScreenFrame>
      <Box flexDirection="column">
        <ChromeHeightContext.Provider value={rows}>
          <ViewportTranscript
            {...({
              staticItems: [],
              liveItems: [],
              columns: TERMINAL_COLUMNS,
              agentId: "agent-1",
              conversationId: "conversation-1",
              buffersRef,
              statusLinePrompt: ">",
              showCompactionsEnabled: false,
              precomputedDiffsRef: { current: new Map() },
              expandedToolCallId: null,
              lastShellToolCallId: null,
              loadingState: "ready",
              continueSession: false,
              agentState: null,
              currentApproval: undefined,
              currentApprovalContext: undefined,
              approvalMap: new Map(),
              pendingIds: new Set(),
              queuedIds: new Set(),
              queuedDecisions: new Map(),
              stubDescriptions: new Map(),
              showApprovalPreview: false,
            } as unknown as AppViewProps)}
          />
        </ChromeHeightContext.Provider>
        <Box ref={ref} flexDirection="column" flexShrink={0}>
          {chromeRows > 0 ? <ChromeRows rows={chromeRows} /> : null}
        </Box>
      </Box>
    </FullScreenFrame>
  );
}

const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 90));

/** The rows the last frame drew. */
function frameRows(): readonly string[] {
  return getTerminalFrame()?.text ?? [];
}

afterEach(() => {
  measured = [];
  resetOlderHistoryForTests();
  resetViewportScroll();
  resetTerminalFrameForTests();
});

test("the input's rows survive the frame that first draws them", async () => {
  const restore = resizeProcessStdout(TERMINAL_ROWS, TERMINAL_COLUMNS);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  // Installed before Ink's first write, as the process entry does it.
  installTerminalFrameCapture(stdout);

  /** Every frame written, as it was written. */
  const frames: string[][] = [];
  const unsubscribe = subscribeToTerminalFrame(() => {
    const frame = getTerminalFrame();
    if (frame) frames.push([...frame.text]);
  });

  // Nothing below the band yet, which is the loading screen: the chrome measures
  // zero, so the band is sized to the whole terminal.
  const instance = render(<Shell chromeRows={0} />, {
    stdin: fakeStdin(),
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
    alternateScreen: true,
  });

  try {
    await waitForRender();
    expect(measured.at(-1)).toBe(0);
    // The band owns the whole terminal, and there is no input yet.
    expect(frameRows().filter((row) => row.startsWith("input"))).toEqual([]);

    // The composer mounts: the chrome needs five rows the band was not told about.
    // The frame that draws it is the *stale* one — the band was sized before the
    // chrome existed — and that is the frame the input has to survive, not just
    // the frame after the measurement has caught up.
    const mark = frames.length;
    instance.rerender(<Shell chromeRows={CHROME_ROWS} />);
    await waitForRender();
    await waitForRender();

    const after = frames.slice(mark);
    expect(after.length).toBeGreaterThan(0);
    const expected = ["input 0", "input 1", "input 2", "input 3", "input 4"];
    for (const frame of after) {
      // Never past the terminal: the frame's pinned height is what keeps the layout
      // from scrolling, and the rows it gives up have to be the band's.
      expect(frame.length).toBeLessThanOrEqual(TERMINAL_ROWS);
      // The last rows of every frame are the chrome, in full and in order. Squeezing
      // the chrome instead hides every one of them, and clips the input off the
      // pinned frame for good: `measureElement` reports the squeezed height, the
      // band is sized from it, and the squeeze repeats.
      expect(frame.slice(-CHROME_ROWS)).toEqual(expected);
    }
    // And it is measured at what it needs, not at what Yoga squeezed it to: that
    // measurement is what sizes the band on the next frame.
    expect(measured.at(-1)).toBe(CHROME_ROWS);
  } finally {
    unsubscribe();
    instance.unmount();
    instance.cleanup();
    restore();
  }
});
