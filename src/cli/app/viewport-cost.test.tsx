/**
 * Viewport frame-cost gate (M2 and 建议 4).
 *
 * The full-screen shell makes three claims about cost: what it *renders* does not
 * grow with history length, what it *measures* per frame stays cheap enough to run
 * on every frame, and what it *assembles* per frame is the band rather than the
 * transcript. `row-model.fidelity.test.tsx` pins the per-item heights themselves,
 * but it renders a handful of items, so it cannot see any of the three.
 *
 * The first two are asserted here over the real measure path with a synthetic
 * history. Measuring used to be a full pass over the transcript (`items.map`),
 * which cost ~18us per item on every streaming frame — ~22ms at 1000 items and
 * ~280ms at 16000. The window is now fitted from the end with a lazy measure, so
 * the work is bounded by the window instead of the history, and the assertions
 * below fail if that regresses to a full pass.
 *
 * The third is asserted over the **real** assembly path: the last block mounts
 * `ViewportTranscript` itself over a committed list whose index reads are counted,
 * drives it the way streaming does (a new live list per chunk) and reads the
 * counter. Composition used to build `[...committed, ...live]` plus a `Set` over
 * every committed id on every chunk, which is O(session) per chunk for as long as
 * the session runs; the view in `composed-transcript.ts` answers the band's
 * indices and leaves the rest of the list where it is. Counting reads of the
 * committed array itself is what makes that a gate rather than a hope: a
 * regression to a copy shows up as one read per committed row per render.
 *
 * The timing guard is loose on purpose — an anti-quadratic net, not a frame
 * budget, because a wall-clock threshold in a unit test is a flake waiting to
 * happen. **The printed table is the gate's real evidence.** Single-run numbers
 * are not comparable across runs (see the repo guide's note on measured figures).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { useMemo, useRef, useState } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import { MAX_VIEWPORT_ITEMS } from "@/cli/app/history-window";
import { resetOlderHistoryForTests } from "@/cli/app/older-history";
import { measureTranscriptItemRows } from "@/cli/app/row-model";
import type { StaticItem } from "@/cli/app/types";
import {
  CHROME_RESERVE_ROWS,
  ViewportTranscript,
} from "@/cli/app/ViewportTranscript";
import { resetViewportScroll } from "@/cli/app/viewport-scroll";
import { fitScrolledItemsFromEnd } from "@/cli/app/viewport-window";
import { createBuffers, type Line } from "@/cli/helpers/accumulator";
import {
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";

const COLUMNS = 100;
const TERMINAL_ROWS = 30;
const VIEWPORT_HEIGHT = TERMINAL_ROWS - CHROME_RESERVE_ROWS;

/** Rows available in the tall-terminal scenario that pins the residency cap. */
const TALL_VIEWPORT_ROWS = 1_000;

/** A fresh session, a long one, and two well past "thousand rounds". */
const HISTORY_SIZES = [1_000, 2_000, 8_000, 16_000];

/** Deterministic filler, so two runs measure the same transcript. */
function filler(seed: number, length: number): string {
  const alphabet = "abcdefghijkl mnopqrst uvwxyz";
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += alphabet[(seed + index * 7) % alphabet.length];
  }
  return text;
}

/** A realistic mix: the kinds a long session accumulates, at realistic sizes. */
function syntheticHistory(count: number): StaticItem[] {
  const items: StaticItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `item-${index}`;
    switch (index % 5) {
      case 0: {
        const line: Line = {
          kind: "user",
          id,
          text: filler(index, 80 + (index % 60)),
        };
        items.push(line);
        break;
      }
      case 1: {
        const line: Line = {
          kind: "assistant",
          id,
          phase: "finished",
          text: `## Heading ${index}\n\n${filler(index, 120)}\n\n- one\n- two\n\n\`\`\`ts\nconst a = ${index};\nconst b = a + 1;\n\`\`\`\n`,
        };
        items.push(line);
        break;
      }
      case 2: {
        const line: Line = {
          kind: "reasoning",
          id,
          phase: "finished",
          text: filler(index, 200),
        };
        items.push(line);
        break;
      }
      case 3: {
        const line: Line = {
          kind: "tool_call",
          id,
          toolCallId: `call-${index}`,
          name: "Read",
          argsText: `{"file_path":"/tmp/file-${index}.ts"}`,
          resultText: filler(index, 150),
          resultOk: true,
          phase: "finished",
        };
        items.push(line);
        break;
      }
      default: {
        const line: Line = {
          kind: "error",
          id,
          text: filler(index, 60),
        };
        items.push(line);
      }
    }
  }
  return items;
}

/** The cheapest possible item: one row, plus the one-row inter-item gap. */
function separatorHistory(count: number): StaticItem[] {
  const items: StaticItem[] = [];
  for (let index = 0; index < count; index += 1) {
    items.push({ kind: "separator", id: `sep-${index}` });
  }
  return items;
}

interface FrameCost {
  window: { start: number; end: number };
  /** Rows the rendered window occupies. */
  rows: number;
  /** Rows of the first rendered item — the one the band may clip. */
  topItemRows: number;
  /** How many items the frame had to measure. */
  measured: number;
  ms: number;
}

/** One frame of the viewport: measure what fits, then pick the window. */
function measureFrame(
  items: StaticItem[],
  viewportRows = VIEWPORT_HEIGHT,
  scrollFromBottom = 0,
): FrameCost {
  const heights = new Map<number, number>();
  const started = performance.now();
  const window = fitScrolledItemsFromEnd(
    items.length,
    viewportRows,
    MAX_VIEWPORT_ITEMS,
    scrollFromBottom,
    (index) => {
      const item = items[index];
      const rows =
        item === undefined
          ? 0
          : measureTranscriptItemRows(item, {
              columns: COLUMNS,
              index,
              terminalRows: TERMINAL_ROWS,
            });
      heights.set(index, rows);
      return rows;
    },
  );
  const ms = performance.now() - started;

  let rows = 0;
  for (let index = window.start; index < window.end; index += 1) {
    rows += heights.get(index) ?? 0;
  }
  return {
    window,
    rows,
    topItemRows: heights.get(window.start) ?? 0,
    measured: heights.size,
    ms,
  };
}

function renderedItems(frame: FrameCost): number {
  return frame.window.end - frame.window.start;
}

describe("viewport frame cost", () => {
  const frames = HISTORY_SIZES.map((size) => {
    const history = syntheticHistory(size);
    return { size, frame: measureFrame(history) };
  });

  test("rendering stays bounded however long the history is", () => {
    for (const { frame } of frames) {
      // Every item occupies at least one row, so a window of `height` rows can
      // never hold more items than that, and the residency cap binds above it.
      expect(renderedItems(frame)).toBeLessThanOrEqual(
        Math.min(VIEWPORT_HEIGHT, MAX_VIEWPORT_ITEMS),
      );
    }

    // 16x the history must not mean 16x the rendered items.
    const first = renderedItems(frames[0]?.frame as FrameCost);
    const last = renderedItems(frames[frames.length - 1]?.frame as FrameCost);
    expect(last).toBeLessThanOrEqual(first + 2);
    expect(last * 100).toBeLessThan(frames[frames.length - 1]?.size ?? 0);
  });

  test("measuring stays bounded however long the history is", () => {
    for (const { frame } of frames) {
      // The window plus the one item that turned out not to fit.
      expect(frame.measured).toBeLessThanOrEqual(renderedItems(frame) + 1);
      expect(frame.measured).toBeLessThanOrEqual(MAX_VIEWPORT_ITEMS + 1);
    }

    // This is the regression net: a full pass over the transcript would measure
    // as many items as the history has, so the largest history would dwarf the
    // smallest instead of matching it.
    const first = frames[0]?.frame as FrameCost;
    const last = frames[frames.length - 1]?.frame as FrameCost;
    expect(last.measured).toBeLessThanOrEqual(first.measured + 2);
    expect(last.measured * 100).toBeLessThan(
      frames[frames.length - 1]?.size ?? 0,
    );
  });

  test("the rendered window fills the viewport without clipping an item away", () => {
    for (const { frame } of frames) {
      // The band is exact, so the window covers the viewport...
      expect(frame.rows).toBeGreaterThanOrEqual(VIEWPORT_HEIGHT);
      // ...overflowing only by the part of the first item that sits above it.
      // Anything more would mean the window is not the band it claims to be.
      expect(frame.rows - VIEWPORT_HEIGHT).toBeLessThan(
        Math.max(1, frame.topItemRows),
      );
    }
  });

  test("stays pinned to the newest item (sticky to bottom)", () => {
    for (const { size, frame } of frames) {
      expect(frame.window.end).toBe(size);
    }
  });

  test("the residency cap binds when whole items would otherwise fit", () => {
    const small = measureFrame(separatorHistory(4_000), TALL_VIEWPORT_ROWS);
    const large = measureFrame(separatorHistory(32_000), TALL_VIEWPORT_ROWS);

    expect(renderedItems(small)).toBe(MAX_VIEWPORT_ITEMS);
    expect(renderedItems(large)).toBe(MAX_VIEWPORT_ITEMS);
    // The cap bounds the measuring too, so even a zero-row-item history cannot
    // walk to the start of the transcript.
    expect(small.measured).toBe(MAX_VIEWPORT_ITEMS);
    expect(large.measured).toBe(MAX_VIEWPORT_ITEMS);
  });

  test("lazy windowing renders exactly what the full pass rendered", () => {
    // The full-pass algorithm, kept here as the reference oracle: measure every
    // item, then take the row band the window is defined by. The lazy walk has to
    // pick the same window on a real transcript, not only on hand-written height
    // arrays.
    const fullPass = (
      rows: readonly number[],
    ): { start: number; end: number } => {
      const total = rows.reduce((sum, value) => sum + Math.max(0, value), 0);
      const windowBottom = total;
      const windowTop = Math.max(0, windowBottom - VIEWPORT_HEIGHT);

      let start = 0;
      let cumulative = 0;
      while (
        start < rows.length &&
        cumulative + Math.max(0, rows[start] ?? 0) <= windowTop
      ) {
        cumulative += Math.max(0, rows[start] ?? 0);
        start += 1;
      }

      let end = start;
      let running = cumulative;
      while (end < rows.length && running < windowBottom) {
        running += Math.max(0, rows[end] ?? 0);
        end += 1;
      }
      if (end - start > MAX_VIEWPORT_ITEMS) start = end - MAX_VIEWPORT_ITEMS;
      return { start, end };
    };

    for (const size of HISTORY_SIZES) {
      const items = syntheticHistory(size);
      const allHeights = items.map((item, index) =>
        measureTranscriptItemRows(item, {
          columns: COLUMNS,
          index,
          terminalRows: TERMINAL_ROWS,
        }),
      );
      const window = measureFrame(items).window;
      expect({ start: window.start, end: window.end }).toEqual(
        fullPass(allHeights),
      );
    }
  });

  test("per-frame cost does not follow the history", () => {
    const short = frames[0]?.frame as FrameCost;
    const long = frames[frames.length - 1]?.frame as FrameCost;

    // 16x the history may cost 4x the time, plus a fixed floor for timer noise.
    expect(long.ms).toBeLessThan(short.ms * 4 + 50);

    // The gate's evidence: what one measured frame costs at each history size.
    for (const { size, frame } of frames) {
      console.log(
        `viewport frame cost: ${String(size).padStart(6)} items ` +
          `${frame.ms.toFixed(3).padStart(8)}ms | ` +
          `measured ${String(frame.measured).padStart(3)} items | ` +
          `rendered ${renderedItems(frame)} items / ${frame.rows} rows`,
      );
    }
  });
});

/**
 * Assembly cost, on the real component and a real frame.
 *
 * `staticItems` is the list that grows for the whole session, and it is the list a
 * frame must not walk. So the committed array handed to the mounted viewport is a
 * `Proxy` that counts every index read, and each chunk is a real re-render: a new
 * live list, exactly as a streaming update produces.
 *
 * The counted quantity is reads of the committed array per render, because that is
 * the shape of the defect: a frame that copies the composition reads every committed
 * row, a frame that reads the band reads the band. It is also what makes the gate
 * faithful — the counter sits on the input the component is given, so it cannot be
 * satisfied by the component reporting its own work.
 */
const ASSEMBLY_HISTORY_SIZES = [1_000, 16_000];

/** Chunks driven through the mounted viewport, each one a streaming update. */
const CHUNKS = 12;

class Capture extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    void chunk;
    callback();
  }
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

interface CommittedHistory {
  items: StaticItem[];
  reads: () => number;
  reset: () => void;
}

/** A committed list of `count` rows, counting every index read of it. */
function countedHistory(count: number): CommittedHistory {
  const items: StaticItem[] = Array.from({ length: count }, (_, index) => ({
    kind: "user",
    id: `item-${index}`,
    text: `row ${index}`,
  }));
  let reads = 0;
  const instrumented = new Proxy(items, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    items: instrumented,
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

/** Set by the mounted viewport so the test can push one chunk at a time. */
let pushChunk: () => void = () => undefined;
/** Renders of the mounted tree, counted in the component body. */
let rendered = 0;

function StreamingViewport({ history }: { history: CommittedHistory }) {
  const [, setChunk] = useState(0);
  rendered += 1;
  pushChunk = () => setChunk((chunk) => chunk + 1);

  const buffersRef = useRef<ReturnType<typeof createBuffers> | null>(null);
  if (buffersRef.current === null) buffersRef.current = createBuffers();
  const staticItems = history.items;
  const liveItems = useMemo<Line[]>(
    () => [{ kind: "assistant", id: "live", phase: "streaming", text: "…" }],
    [],
  );

  return (
    <ViewportTranscript
      {...({
        staticItems,
        liveItems,
        columns: 100,
        agentId: "agent-1",
        conversationId: "conv-cost",
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

async function streamHistory(count: number): Promise<{
  reads: number;
  renders: number;
}> {
  const history = countedHistory(count);
  const stdout = new Capture();
  installTerminalFrameCapture(stdout);
  pushChunk = () => undefined;
  rendered = 0;
  const instance = render(<StreamingViewport history={history} />, {
    stdin: fakeStdin(),
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  await sleep(150);

  // Drive the stream: one update per chunk, which is what a turn's streaming
  // updates do. The counter starts here, so it weighs the streaming frames rather
  // than the mount's.
  history.reset();
  const rendersBefore = rendered;
  for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
    pushChunk();
    await sleep(30);
  }
  const reads = history.reads();
  const renders = rendered - rendersBefore;
  instance.unmount();
  instance.cleanup();

  return { reads, renders };
}

afterEach(() => {
  resetOlderHistoryForTests();
  resetViewportScroll();
  resetTerminalFrameForTests();
});

describe("the assembly a frame pays for", () => {
  test("is the band, not the committed list", async () => {
    const runs: Array<{ size: number; reads: number; renders: number }> = [];
    for (const size of ASSEMBLY_HISTORY_SIZES) {
      runs.push({ size, ...(await streamHistory(size)) });
    }

    for (const run of runs) {
      expect(run.renders).toBeGreaterThan(0);
      // Per render, the committed list is touched at most what the residency cap
      // allows, plus a constant for the walk's own probes. A copy, a `Set` over the
      // ids or a full pass shows up as one read per committed row per render — 74x
      // this bound at the largest history below.
      expect(run.reads).toBeLessThanOrEqual(
        run.renders * (MAX_VIEWPORT_ITEMS + 16),
      );
      // The sharper claim, and the one 建议 4 makes: the whole streaming burst —
      // every chunk, every render — touches the committed array fewer times than a
      // *single* frame that copies the composition would.
      expect(run.reads).toBeLessThan(run.size);
    }

    // The gate's evidence: what a stream of chunks costs, per history size.
    for (const run of runs) {
      console.log(
        `viewport assembly cost: ${String(run.size).padStart(6)} committed items ` +
          `| ${run.renders} renders | ${run.reads} index reads ` +
          `(${(run.reads / Math.max(1, run.renders)).toFixed(1)} per render)`,
      );
    }
  });
});
