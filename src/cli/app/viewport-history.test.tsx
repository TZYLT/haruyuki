import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { Box, render, Text } from "ink";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import {
  composeTranscriptItems,
  getOlderHistoryItems,
  historyItemsForMessages,
  olderHistoryCursor,
  olderHistoryPrefixItems,
  requestOlderHistory,
  resetOlderHistoryForTests,
  setOlderHistoryFetcherForTests,
  setOlderHistoryProvider,
  subscribeToOlderHistory,
} from "@/cli/app/older-history";
import { ViewportTranscript } from "@/cli/app/ViewportTranscript";
import {
  getViewportScrollRequest,
  getViewportScrollVersion,
  jumpTranscriptToNewest,
  jumpTranscriptToOldest,
  reportViewportPosition,
  resetViewportScroll,
  scrollTranscriptBy,
  scrollTranscriptWheel,
  setViewportRows,
  subscribeToViewportScroll,
  subscribeToViewportTop,
} from "@/cli/app/viewport-scroll";
import { fitScrolledItemsFromEnd } from "@/cli/app/viewport-window";
import type { Line } from "@/cli/helpers/accumulator";
import { createBuffers } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";

/**
 * Older history, on a real frame.
 *
 * The store tests pin the arithmetic; this file pins what the user sees, because
 * that is where this feature can fail invisibly: rows paged in at the top can
 * leave the band empty (the window was not fitted to the wider list), or shove the
 * text the reader was on off the screen (the parked position was not re-based). So
 * both cases are asserted on the frame's own rows, not on the store's numbers.
 */

const VIEWPORT_ROWS = 12;
const CONVERSATION = "conv-history";

class Capture extends Writable {
  columns = 40;
  rows = 14;
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

/** Six four-row core rows: taller than the band, so there is somewhere to page from. */
const CORE: Line[] = Array.from({ length: 6 }, (_, index) => ({
  kind: "user" as const,
  id: `c${index}`,
  text: `core ${index}`,
  messageId: `core-${index}`,
}));

/** One tall row in the older page, so its position on screen is readable. */
const ROWS_BY_ID: Record<string, number> = {
  c0: 4,
  c1: 4,
  c2: 4,
  c3: 4,
  c4: 4,
  c5: 4,
  h0: 10,
};

function historyMessage(id: string, text: string): Message {
  return {
    id,
    message_type: "user_message",
    content: [{ type: "text", text }],
  } as unknown as Message;
}

/**
 * The viewport, with the real composition, the real scroll store and the real
 * paging store — only the fetch and the row renderer are stubs.
 */
function MiniHistoryViewport() {
  useSyncExternalStore(subscribeToViewportScroll, getViewportScrollVersion);

  useEffect(() => {
    setOlderHistoryProvider(() => ({
      conversationId: CONVERSATION,
      agentId: "agent-1",
      cursor: olderHistoryCursor(CORE),
    }));
    return () => {
      setOlderHistoryProvider(null);
    };
  }, []);
  useEffect(
    () =>
      subscribeToViewportTop((rows) => {
        void requestOlderHistory(rows);
      }),
    [],
  );

  // Subscribed to the rows themselves, like the viewport: a publish that only moved
  // `loading` changes no reference and costs no render.
  const olderItems = useSyncExternalStore(subscribeToOlderHistory, () =>
    getOlderHistoryItems(CONVERSATION),
  );
  const items = composeTranscriptItems(olderItems, CORE);
  const request = getViewportScrollRequest();
  const scrollRows = request.kind === "rows" ? request.rows : 0;
  const anchor = request.kind === "anchor" ? request.anchor : undefined;
  // The production weight: the row model counts each item's own leading gap.
  const window = fitScrolledItemsFromEnd(
    items.length,
    VIEWPORT_ROWS,
    200,
    scrollRows,
    (index) => (ROWS_BY_ID[items[index]?.id ?? ""] ?? 1) + (index > 0 ? 1 : 0),
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

  const visible: string[] = [];
  for (let index = window.start; index < window.end; index += 1) {
    visible.push(items[index]?.id ?? "");
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
        {visible.map((id, offset) => {
          const index = window.start + offset;
          const rows = ROWS_BY_ID[id] ?? 1;
          return (
            <Box
              key={id}
              flexDirection="column"
              flexShrink={0}
              marginTop={index > 0 ? 1 : 0}
            >
              {Array.from({ length: rows }, (_, row) => `${id} ${row}`).map(
                (label) => (
                  <Text key={label}>{label}</Text>
                ),
              )}
            </Box>
          );
        })}
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

async function mountViewport(): Promise<{
  stdout: Capture;
  stop: () => void;
}> {
  const stdout = new Capture();
  installTerminalFrameCapture(stdout);
  const instance = render(<MiniHistoryViewport />, {
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

/** The rows the last frame drew. */
function frameRows(): readonly string[] {
  return getTerminalFrame()?.text ?? [];
}

/** Frame writes carry the frame's newlines; the sync markers do not. */
function frames(chunks: readonly string[]): string[] {
  return chunks.filter((chunk) => chunk.includes("\n"));
}

/** Page in one tall older row: the shape a page of the oldest messages has. */
function pageIn(messages: (id: string) => Message[]): void {
  setOlderHistoryFetcherForTests(async (request) => messages(request.before));
}

afterEach(() => {
  resetOlderHistoryForTests();
  resetViewportScroll();
  resetTerminalFrameForTests();
});

describe("paging older history onto a real frame", () => {
  test("a page above the parked view does not move the view", async () => {
    pageIn(() => [historyMessage("h0", "the oldest thing")]);
    const { stop } = await mountViewport();
    try {
      jumpTranscriptToOldest();
      await sleep(150);
      const parked = frameRows();
      // The tallest position the loaded history has: its first row at the top.
      expect(parked[0]).toBe("c0 0");

      expect(await requestOlderHistory(0)).toBe("start");
      await sleep(150);

      // The rows arrived above the view, and the frame is the same one: the parked
      // position is held in content, so the rows that came in do not push the text
      // the reader was on. Without the anchor re-base this frame starts five rows
      // further up.
      expect(frameRows()).toEqual(parked);
      expect(getOlderHistoryItems(CONVERSATION).map((item) => item.id)).toEqual(
        ["h0"],
      );
    } finally {
      stop();
    }
  });

  test("one more notch at the top brings the older rows in, and still moves the text", async () => {
    pageIn(() => [historyMessage("h0", "the oldest thing")]);
    const { stdout, stop } = await mountViewport();
    try {
      jumpTranscriptToOldest();
      await sleep(150);
      expect(frameRows()[0]).toBe("c0 0");

      const mark = stdout.chunks.length;
      // At the top, the move is refused — and that refusal is what asks for the
      // page. Holding the wheel there would otherwise flash an identical frame.
      scrollTranscriptWheel("up");
      await sleep(250);

      const after = frameRows();
      // Three rows above where the reader was (the notch), and it is the page that
      // moved into view rather than the whole page's worth of rows jumping in.
      expect(after[0]).toBe("h0 8");
      expect(after.at(-1)).toBe("c1 3");
      expect(frames(stdout.chunks.slice(mark)).length).toBeLessThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test("the page is fetched once per notch, not once per refused frame", async () => {
    pageIn(() => [historyMessage("h0", "the oldest thing")]);
    const { stop } = await mountViewport();
    let fetches = 0;
    try {
      setOlderHistoryFetcherForTests(async () => {
        fetches += 1;
        return [historyMessage("h0", "the oldest thing")];
      });
      jumpTranscriptToOldest();
      await sleep(150);

      // A spin at the top: every notch is refused, and each one asks for the page
      // the previous one already asked for while it is in flight.
      for (let notch = 0; notch < 20; notch += 1) scrollTranscriptWheel("up");
      await sleep(250);

      expect(fetches).toBe(1);
    } finally {
      stop();
    }
  });
});

/**
 * The wiring inside the viewport itself.
 *
 * A perfect paging store still ships nothing if the component does not install the
 * cursor, does not compose the two lists, or does not hear the refused up-move —
 * and none of that shows up in a store test. So the real `ViewportTranscript` is
 * mounted here with the props it reads, over the real stores and a real frame.
 */
const REAL_CORE: Message[] = Array.from(
  { length: 12 },
  (_, index) =>
    ({
      id: `core-${index}`,
      message_type: "user_message",
      content: [{ type: "text", text: `core message ${index}` }],
    }) as unknown as Message,
);

function RealHistoryViewport() {
  const buffersRef = useRef<ReturnType<typeof createBuffers> | null>(null);
  if (buffersRef.current === null) {
    // The resume path's own assembler, so the cursor is derived exactly as the app
    // derives it: from the live buffer, not from a prop.
    const buffers = createBuffers();
    backfillBuffers(buffers, REAL_CORE);
    buffersRef.current = buffers;
  }
  const staticItems = useMemo(() => historyItemsForMessages(REAL_CORE), []);

  return (
    <ViewportTranscript
      {...({
        staticItems,
        liveItems: [],
        columns: 40,
        agentId: "agent-1",
        conversationId: CONVERSATION,
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
  );
}

async function mountRealViewport(): Promise<{ stop: () => void }> {
  const stdout = new Capture();
  installTerminalFrameCapture(stdout);
  const instance = render(<RealHistoryViewport />, {
    stdin: fakeStdin(),
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  await sleep(150);
  return {
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

function frameText(): string {
  return frameRows().join("\n");
}

describe("the paging wiring inside the viewport", () => {
  test("a notch at the oldest loaded row loads the page and draws it", async () => {
    pageIn(() => [historyMessage("h0", "the oldest thing")]);
    const { stop } = await mountRealViewport();
    try {
      jumpTranscriptToOldest();
      await sleep(150);
      expect(frameText()).toContain("core message 0");
      expect(frameText()).not.toContain("the oldest thing");

      // The move is refused at the top, and that refusal is the request: without
      // the viewport's subscription nothing would ever be fetched.
      scrollTranscriptWheel("up");
      await sleep(250);

      expect(getOlderHistoryItems(CONVERSATION).length).toBe(1);
      expect(frameText()).toContain("the oldest thing");
    } finally {
      stop();
    }
  });

  test("a page landing above the parked view does not move the frame", async () => {
    pageIn(() => [historyMessage("h0", "the oldest thing")]);
    const { stop } = await mountRealViewport();
    try {
      jumpTranscriptToOldest();
      await sleep(150);
      const parked = frameText();

      expect(await requestOlderHistory(0)).toBe("start");
      await sleep(150);

      expect(getOlderHistoryItems(CONVERSATION).length).toBe(1);
      expect(frameText()).toBe(parked);
    } finally {
      stop();
    }
  });
});

/**
 * Residency, on a real frame.
 *
 * A page whose items are dropped still occupies item numbers in the walk, so the
 * band has to be read with that offset and the page has to come back before a window
 * can land inside it. Both failures are invisible in a store test and both end in the
 * same report from the machine: the reader cannot get back to the older rows.
 */
describe("a page dropped behind the view", () => {
  const PAGES = 4;
  const PAGE_SIZE = 50;

  function pageFetcher(): { fetches: () => number } {
    let fetches = 0;
    setOlderHistoryFetcherForTests(async () => {
      fetches += 1;
      const page = fetches;
      return Array.from({ length: PAGE_SIZE }, (_, index) =>
        historyMessage(`p${page}-${index}`, `older page ${page} item ${index}`),
      );
    });
    return { fetches: () => fetches };
  }

  test("the rows behind the reader coming back do not empty the band", async () => {
    pageFetcher();
    const { stop } = await mountRealViewport();
    try {
      for (let page = 0; page < PAGES; page += 1) {
        expect(await requestOlderHistory(0)).toBe("loaded");
      }
      await sleep(150);

      // Read up to the oldest loaded row first: a page's height is only known once the
      // walk has measured it, and an unmeasured page is never dropped.
      jumpTranscriptToOldest();
      await sleep(250);

      // Now park in the middle of the loaded history: pages sit on both sides of the
      // window, which is what makes eviction drop the ones behind it.
      jumpTranscriptToNewest();
      await sleep(150);
      scrollTranscriptBy(80);
      await sleep(250);
      expect(olderHistoryPrefixItems()).toBeGreaterThan(0);

      // Whatever the residency did, the band is drawing rows and the reader's
      // position still resolves to content.
      expect(frameText().trim().length).toBeGreaterThan(0);

      // And the oldest rows the walk can reach are reachable again: the pages that
      // were reduced to a count have to be materialized from what is held, not
      // dropped for good.
      jumpTranscriptToOldest();
      await sleep(250);
      expect(frameText()).toContain(`older page ${PAGES} item 0`);
    } finally {
      stop();
    }
  });
});
