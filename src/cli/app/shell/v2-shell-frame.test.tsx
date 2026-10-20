import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import { useRef } from "react";
import {
  ChromeHeightContext,
  useMeasuredChromeHeight,
} from "@/cli/app/chrome-height";
import { resetOlderHistoryForTests } from "@/cli/app/older-history";
import { TabStrip } from "@/cli/app/shell/tab-strip";
import { TAB_STRIP_ROWS } from "@/cli/app/shell/tab-strip-layout";
import { FullScreenFrame } from "@/cli/app/shell/V2Shell";
import { openConversationTab, resetTabsForTests } from "@/cli/app/tabs";
import { ViewportTranscript } from "@/cli/app/ViewportTranscript";
import { resetViewportScroll } from "@/cli/app/viewport-scroll";
import { visibleWidth } from "@/cli/display/statusline/formatting";
import { createBuffers } from "@/cli/helpers/accumulator";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
  subscribeToTerminalFrame,
} from "@/cli/helpers/terminal-frame";

/**
 * The tab row survives the frame that first draws the composer.
 *
 * The machine reported it twice: with the strip alone the row could wrap off the
 * screen, and once that was fixed the row was still gone — visible while the app
 * was loading, then "收上去" the moment the transcript and the composer appeared.
 * Both are the same shape: the frame stops fitting the terminal for one frame, and
 * the rows that live at the top are the ones the alternate screen scrolls away.
 *
 * `frame-chrome-rows.test.tsx` holds the composer's side of that contract without
 * the strip; this holds it with the strip mounted, at the sizes the shell actually
 * uses, so "the band gives way and the chrome keeps its rows" is judged with the
 * two rows above the band also on the frame.
 */

const TERMINAL_ROWS = 30;
const TERMINAL_COLUMNS = 100;
/** The idle composer: the gap above it, two dividers, the draft, status and hint. */
const CHROME_ROWS = 6;

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
    getWindowSize: Object.getOwnPropertyDescriptor(
      process.stdout,
      "getWindowSize",
    ),
  };
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: rows,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  Object.defineProperty(process.stdout, "getWindowSize", {
    configurable: true,
    value: () => [columns, rows],
  });
  process.stdout.emit("resize");
  return () => {
    for (const key of ["rows", "columns", "getWindowSize"] as const) {
      const descriptor = saved[key];
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      } else {
        delete (
          process.stdout as {
            rows?: number;
            columns?: number;
            getWindowSize?: unknown;
          }
        )[key];
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

/** Stands in for the composer: as many rigid rows as the caller says. */
function ChromeRows({ rows }: { rows: number }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {Array.from({ length: rows }, (_, index) => `chrome ${index}`).map(
        (line) => (
          <Text key={line}>{line}</Text>
        ),
      )}
    </Box>
  );
}

/** The shell's frame: the strip, the transcript band, and the measured chrome. */
function Shell({ chromeRows }: { chromeRows: number }) {
  const { ref, rows } = useMeasuredChromeHeight();
  const buffersRef = useRef(createBuffers());
  return (
    <FullScreenFrame>
      <TabStrip onSelect={() => {}} onClose={() => {}} />
      <Box flexDirection="column">
        <ChromeHeightContext.Provider value={rows}>
          <ViewportTranscript
            {...({
              staticItems: [],
              liveItems: [],
              columns: TERMINAL_COLUMNS,
              agentId: "agent-1",
              conversationId: "conv-1",
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
              reserveTopRows: TAB_STRIP_ROWS,
            } as unknown as Parameters<typeof ViewportTranscript>[0])}
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

afterEach(() => {
  resetTabsForTests();
  resetOlderHistoryForTests();
  resetViewportScroll();
  resetTerminalFrameForTests();
});

describe("the frame with the tab strip on it", () => {
  test("the tab row is never the rows the frame gives up", async () => {
    openConversationTab("conv-1", "M6 shell");
    const restore = resizeProcessStdout(TERMINAL_ROWS, TERMINAL_COLUMNS);
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    installTerminalFrameCapture(stdout);

    const frames: string[][] = [];
    const unsubscribe = subscribeToTerminalFrame(() => {
      const frame = getTerminalFrame();
      if (frame) frames.push([...frame.text]);
    });

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
      // Loading: the composer has not mounted, so the band owns the terminal.
      expect(frames.at(-1)?.[0]).toContain("Settings");

      const mark = frames.length;
      instance.rerender(<Shell chromeRows={CHROME_ROWS} />);
      await waitForRender();
      await waitForRender();

      const after = frames.slice(mark);
      expect(after.length).toBeGreaterThan(0);
      for (const frame of after) {
        // Never taller than the terminal: that is what scrolls the alternate
        // screen and takes the top rows with it.
        expect(frame.length).toBeLessThanOrEqual(TERMINAL_ROWS);
        // And **never wider than the terminal either** — this is the invariant
        // that keeps costing the top row: a line one column past the edge is
        // wrapped by the terminal (not by Ink), which adds a physical line and
        // scrolls the frame. It has now been broken by a tab title's ellipsis, a
        // markdown table and a memory diff's prose (2026-10-20), so the whole
        // frame is held to it.
        for (const line of frame) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(TERMINAL_COLUMNS);
        }
        // And the two rows above the band are always on it.
        expect(frame[0]).toContain("Settings");
        expect(frame[1]).toBe("─".repeat(TERMINAL_COLUMNS));
      }
    } finally {
      unsubscribe();
      instance.unmount();
      instance.cleanup();
      restore();
    }
  });
});
