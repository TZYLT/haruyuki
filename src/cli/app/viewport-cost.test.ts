/**
 * Viewport frame-cost gate (M2).
 *
 * The full-screen shell makes two claims about cost: what it *renders* does not
 * grow with history length, and what it *measures* per frame stays cheap enough
 * to run on every frame. `row-model.fidelity.test.tsx` pins the per-item heights
 * themselves, but it renders a handful of items, so it cannot see either claim.
 *
 * Measurement is deliberately O(history): every item's height is recomputed each
 * frame so the window is chosen from real numbers. Rendering is bounded by
 * `MAX_VIEWPORT_ITEMS`. The timing guard is loose on purpose — an anti-quadratic
 * net, not a frame budget, because a wall-clock threshold in a unit test is a
 * flake waiting to happen. **The printed table is the gate's real evidence**, and
 * the per-item figure it reports is what the shell pays per streaming frame.
 * Single-run numbers are not comparable across runs (see the repo guide's note on
 * measured figures).
 */

import { describe, expect, test } from "bun:test";
import { measureTranscriptItemRows } from "@/cli/app/row-model";
import type { StaticItem } from "@/cli/app/types";
import {
  CHROME_RESERVE_ROWS,
  MAX_VIEWPORT_ITEMS,
} from "@/cli/app/ViewportTranscript";
import { fitWholeItems } from "@/cli/app/viewport-window";
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
  heights: number[];
  window: { start: number; end: number };
  rows: number;
  ms: number;
}

/** One frame of the viewport: measure every item, then pick the window. */
function measureFrame(
  items: StaticItem[],
  viewportRows = VIEWPORT_HEIGHT,
): FrameCost {
  const started = performance.now();
  const heights = items.map((item, index) =>
    measureTranscriptItemRows(item, {
      columns: COLUMNS,
      index,
      terminalRows: TERMINAL_ROWS,
    }),
  );
  const window = fitWholeItems(heights, viewportRows, MAX_VIEWPORT_ITEMS);
  const ms = performance.now() - started;

  let rows = 0;
  for (let index = window.start; index < window.end; index += 1) {
    rows += heights[index] ?? 0;
  }
  return { heights, window, rows, ms };
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

  test("the rendered window fits the viewport rows", () => {
    for (const { frame } of frames) {
      expect(frame.rows).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
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
  });

  test("per-frame measurement stays linear in the history", () => {
    const short = frames[0]?.frame as FrameCost;
    const long = frames[frames.length - 1]?.frame as FrameCost;

    // 16x the items may cost 16x the time; the allowance is 2x that plus a fixed
    // floor, so a noisy machine cannot fail the gate.
    expect(long.ms).toBeLessThan(short.ms * 32 + 50);

    // The gate's evidence: what one measured frame costs at each history size.
    for (const { size, frame } of frames) {
      console.log(
        `viewport frame cost: ${String(size).padStart(6)} items ` +
          `${frame.ms.toFixed(1).padStart(6)}ms ` +
          `(${((frame.ms / size) * 1_000).toFixed(1).padStart(4)}us/item) ` +
          `rendered ${renderedItems(frame)} items / ${frame.rows} rows`,
      );
    }
  });
});
