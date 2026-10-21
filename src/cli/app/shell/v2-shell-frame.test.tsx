import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import { useRef } from "react";
import { SessionStats } from "@/agent/stats";
import {
  ChromeHeightContext,
  useMeasuredChromeHeight,
} from "@/cli/app/chrome-height";
import { resetOlderHistoryForTests } from "@/cli/app/older-history";
import { ContextSidebarScope } from "@/cli/app/shell/sidebar-scope";
import { sidebarGeometry } from "@/cli/app/shell/sidebar-sections";
import { TabStrip } from "@/cli/app/shell/tab-strip";
import { TAB_STRIP_ROWS } from "@/cli/app/shell/tab-strip-layout";
import { FullScreenFrame } from "@/cli/app/shell/V2Shell";
import { openConversationTab, resetTabsForTests } from "@/cli/app/tabs";
import type { StaticItem } from "@/cli/app/types";
import { ViewportTranscript } from "@/cli/app/ViewportTranscript";
import { resetViewportScroll } from "@/cli/app/viewport-scroll";
import {
  ROW_SAFETY_COLUMNS,
  visibleWidth,
} from "@/cli/display/statusline/formatting";
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
function Shell({
  chromeRows,
  items = [],
  reportedChrome,
}: {
  chromeRows: number;
  items?: StaticItem[];
  /** Override the chrome height the band is told about (the frame it lags by). */
  reportedChrome?: number;
}) {
  const { ref, rows } = useMeasuredChromeHeight();
  const buffersRef = useRef(createBuffers());
  const sessionStatsRef = useRef(new SessionStats());
  return (
    <FullScreenFrame>
      <ContextSidebarScope.Provider value>
        <TabStrip
          onSelect={() => {}}
          onClose={() => {}}
          frameColumns={TERMINAL_COLUMNS}
        />
        <Box flexDirection="column">
          <ChromeHeightContext.Provider value={reportedChrome ?? rows}>
            <ViewportTranscript
              {...({
                staticItems: items,
                liveItems: [],
                columns: TERMINAL_COLUMNS,
                agentId: "agent-1",
                conversationId: "conv-1",
                buffersRef,
                sessionStatsRef,
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
      </ContextSidebarScope.Provider>
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
        // markdown table, a memory diff's prose and the rule under the tabs
        // (2026-10-20), so the whole frame is held to it — and to the margin the
        // rest of the shell already spends, because a row that ends *on* the last
        // column is the pending-wrap state that costs the same line.
        for (const line of frame) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(
            TERMINAL_COLUMNS - ROW_SAFETY_COLUMNS,
          );
        }
        // And the two rows above the band are always on it. The rule carries the
        // rail's junction (`《38》§2.2`) at the column the same geometry puts the
        // divider in — at 100 columns the rail is 30 wide, the band 67, and the
        // divider column 69.
        expect(frame[0]).toContain("Settings");
        const geometry = sidebarGeometry(TERMINAL_COLUMNS, TERMINAL_ROWS);
        expect(geometry.railWidth).toBe(30);
        expect(geometry.bandColumns).toBe(67);
        expect(geometry.junctionColumn).toBe(69);
        const junction = geometry.junctionColumn - 1;
        expect(frame[1]).toBe(
          `${"─".repeat(junction)}┬${"─".repeat(TERMINAL_COLUMNS - ROW_SAFETY_COLUMNS - junction - 1)}`,
        );
        // The rail itself is on the frame, its divider standing in the junction's
        // column for **every** band row — including the rows below the last
        // section, which is what makes the rule continuous instead of stopping
        // where the content does.
        const bandRows = frame.slice(TAB_STRIP_ROWS);
        expect(bandRows.join("\n")).toContain("Context");
        const dividerRows = bandRows.filter(
          (line) => line.at(junction) === "│",
        );
        expect(dividerRows.length).toBeGreaterThanOrEqual(15);
        // Nothing to the left of the divider is rail text: the band's own columns
        // stay the transcript's.
        expect(
          bandRows.some((line) => line.slice(junction).includes("ctx ")),
        ).toBe(true);
      }
    } finally {
      unsubscribe();
      instance.unmount();
      instance.cleanup();
      restore();
    }
  });

  test("a tall transcript with a rail is clipped inside the band", async () => {
    // The machine reported this after the rail moved into the band: the band's
    // rows stopped being the clipping box's direct children, the extra rows were
    // laid out at their own height, the frame grew past the terminal, and the
    // alternate screen scrolled the strip off the top. More items than the band
    // can show is the state that reproduces it.
    openConversationTab("conv-1", "M6 shell");
    const restore = resizeProcessStdout(TERMINAL_ROWS, TERMINAL_COLUMNS);
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    installTerminalFrameCapture(stdout);
    const items: StaticItem[] = Array.from({ length: 60 }, (_, index) => ({
      kind: "assistant",
      id: `answer-${index}`,
      text: `answer ${index}`,
      phase: "finished",
    }));

    const frames: string[][] = [];
    const unsubscribe = subscribeToTerminalFrame(() => {
      const frame = getTerminalFrame();
      if (frame) frames.push([...frame.text]);
    });

    const instance = render(<Shell chromeRows={CHROME_ROWS} items={items} />, {
      stdin: fakeStdin(),
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
      alternateScreen: true,
    });

    try {
      await waitForRender();
      await waitForRender();
      for (const frame of frames.slice(-3)) {
        // The frame is exactly the terminal, never taller: a taller one is what
        // scrolls the top away.
        expect(frame.length).toBeLessThanOrEqual(TERMINAL_ROWS);
        // And the two top rows never move: the strip, then the rule with the
        // rail's junction.
        expect(frame[0]).toContain("Settings");
        expect(frame[1]).toContain("┬");
        // The transcript really is tall here, so the band is not empty by
        // accident.
        expect(frame.join("\n")).toContain("answer 59");
      }
    } finally {
      unsubscribe();
      instance.unmount();
      instance.cleanup();
      restore();
    }
  });

  test("an item taller than the band is clipped by the band, not over it", async () => {
    // The machine showed the strip painted over by transcript rows: `顺带一句` on
    // the tab row, the rule running through the same line, and the rail two rows
    // below the text. The cause is an item taller than the band — the window is
    // then a slice through the middle of it, `contentOffset` goes **negative**, and
    // that offset used to be the `marginTop` of the box that also clipped the rows.
    // Ink applies only the innermost clip (`output.js`: `clips.at(-1)`), so a
    // shifted box clips against its own, shifted rectangle — as good as no clip at
    // all, and every row above the band edge lands on the shell's chrome.
    openConversationTab("conv-1", "M6 shell");
    const restore = resizeProcessStdout(TERMINAL_ROWS, TERMINAL_COLUMNS);
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    installTerminalFrameCapture(stdout);
    // 20 rows each in a 22-row band: the window holds one item and cannot fit it.
    const items: StaticItem[] = Array.from({ length: 8 }, (_, index) => ({
      kind: "assistant",
      id: `long-${index}`,
      text: Array.from(
        { length: 20 },
        (_, line) => `long ${index} line ${line}`,
      ).join("\n"),
      phase: "finished",
    }));

    const frames: string[][] = [];
    const unsubscribe = subscribeToTerminalFrame(() => {
      const frame = getTerminalFrame();
      if (frame) frames.push([...frame.text]);
    });

    const instance = render(<Shell chromeRows={CHROME_ROWS} items={items} />, {
      stdin: fakeStdin(),
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
      alternateScreen: true,
    });

    try {
      await waitForRender();
      await waitForRender();
      const geometry = sidebarGeometry(TERMINAL_COLUMNS, TERMINAL_ROWS);
      const junction = geometry.junctionColumn - 1;
      for (const frame of frames.slice(-3)) {
        expect(frame.length).toBeLessThanOrEqual(TERMINAL_ROWS);
        // The two shell rows are exactly what they are: tabs, then the rule. A
        // transcript row on either of them is the defect, not a cosmetic drift.
        expect(frame[0]).toContain("Settings");
        expect(frame[0]).not.toContain("long ");
        expect(frame[1]).toContain("┬");
        expect(frame[1]).not.toContain("long ");
        // And the rail starts where the band starts, so its rows and the text's
        // rows are the same rows — the other half of what the machine showed.
        expect(frame[TAB_STRIP_ROWS]?.at(junction)).toBe("│");
        expect(frame.join("\n")).toContain("long ");
      }
    } finally {
      unsubscribe();
      instance.unmount();
      instance.cleanup();
      restore();
    }
  });

  test("a band sized from a stale chrome is clipped at the band, not at the chrome", async () => {
    // The machine's screenshot: the composer's popup and the agent-info block appear
    // together (twelve rows at once) when the draft turns into a slash command, and a
    // `/font-width` help line was painted *inside* the input row — only `> /` of the
    // composer on top of it, while the two dividers cut the help lines above and below
    // clean.
    //
    // The band is sized from the chrome measured on the **previous** frame
    // (`chrome-height.ts`), so the frame that first draws the popup asks for a band
    // twelve rows taller than the room left; the pinned frame makes Yoga take those
    // rows back from the band. The band's clip box was `flexShrink={0}`, so it kept
    // the taller rectangle and every transcript row below the squeezed band landed on
    // the composer instead of being clipped — Ink clips against the innermost
    // rectangle only (`output.js`: `clips.at(-1)`), so the box that gives way has to
    // be the one holding the clip.
    //
    // `reportedChrome: 2` is that stale frame held still: the harness tells the band
    // it has 26 rows while the chrome below it really takes 18.
    openConversationTab("conv-1", "M6 shell");
    const restore = resizeProcessStdout(TERMINAL_ROWS, TERMINAL_COLUMNS);
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    installTerminalFrameCapture(stdout);
    const items: StaticItem[] = Array.from({ length: 3 }, (_, index) => ({
      kind: "assistant",
      id: `tall-${index}`,
      // Indented past the chrome's own text. Ink writes only the cells a node
      // covers — a row is a grid, not a string — so a transcript line that reaches
      // further right than the composer's `> /` keeps its right-hand cells on the
      // composer's row. That is the half-painted row the photograph shows.
      text: Array.from(
        { length: 12 },
        (_, line) => `${" ".repeat(12)}tall ${index} line ${line}`,
      ).join("\n"),
      phase: "finished",
    }));

    const frames: string[][] = [];
    const unsubscribe = subscribeToTerminalFrame(() => {
      const frame = getTerminalFrame();
      if (frame) frames.push([...frame.text]);
    });

    const grownChrome = 18;
    const instance = render(
      <Shell chromeRows={grownChrome} reportedChrome={2} items={items} />,
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
      await waitForRender();

      expect(frames.length).toBeGreaterThan(0);
      const chromeTop = TERMINAL_ROWS - grownChrome;
      for (const frame of frames.slice(-3)) {
        expect(frame.length).toBeLessThanOrEqual(TERMINAL_ROWS);
        // The strip is still the first row: the frame is pinned to the terminal.
        expect(frame[0]).toContain("Settings");
        // And the chrome is on the frame at all — the band gives the rows up rather
        // than pushing the composer past the bottom edge.
        expect(frame.join("\n")).toContain(`chrome ${grownChrome - 1}`);
        // And every chrome row belongs to the chrome. A transcript row below the
        // band's last row is the defect the machine photographed.
        expect(frame.slice(chromeTop).join("\n")).not.toContain("tall ");
        // The rail is part of the band and has the same problem in the same frame:
        // its rows are painted from the stale height, so the ledger line and the
        // divider used to continue down over the composer as well.
        expect(frame.slice(chromeTop).join("\n")).not.toContain("today");
        // The band is not empty by accident: its own rows do carry the transcript.
        expect(frame.slice(TAB_STRIP_ROWS, chromeTop).join("\n")).toContain(
          "tall ",
        );
      }
    } finally {
      unsubscribe();
      instance.unmount();
      instance.cleanup();
      restore();
    }
  });
});
