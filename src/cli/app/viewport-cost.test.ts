/**
 * Viewport frame-cost gate (M2).
 *
 * The full-screen shell makes two claims about cost: what it *renders* does not
 * grow with history length, and what it *measures* per frame stays cheap enough
 * to run on every frame. `row-model.fidelity.test.tsx` pins the per-item heights
 * themselves, but it renders a handful of items, so it cannot see either claim.
 *
 * Both claims are asserted here over the real measure path with a synthetic
 * history. Measuring used to be a full pass over the transcript (`items.map`),
 * which cost ~18us per item on every streaming frame — ~22ms at 1000 items and
 * ~280ms at 16000. The window is now fitted from the end with a lazy measure, so
 * the work is bounded by the window instead of the history, and the assertions
 * below fail if that regresses to a full pass.
 *
 * The timing guard is loose on purpose — an anti-quadratic net, not a frame
 * budget, because a wall-clock threshold in a unit test is a flake waiting to
 * happen. **The printed table is the gate's real evidence.** Single-run numbers
 * are not comparable across runs (see the repo guide's note on measured figures).
 */

import { describe, expect, test } from "bun:test";
import { measureTranscriptItemRows } from "@/cli/app/row-model";
import type { StaticItem } from "@/cli/app/types";
import {
  CHROME_RESERVE_ROWS,
  MAX_VIEWPORT_ITEMS,
} from "@/cli/app/ViewportTranscript";
import { fitScrolledItemsFromEnd } from "@/cli/app/viewport-window";
import type { Line } from "@/cli/helpers/accumulator";

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
