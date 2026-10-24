/**
 * The row model against `EventMessage`, for both `event` kinds that exist.
 *
 * This lives outside `row-model.fidelity.test.tsx` for a boring reason — that file
 * is at the 1,000-line ceiling — but it belongs to the same differential family:
 * it renders the real component, measures the laid-out element, and compares it
 * with what the model predicted for the same item.
 *
 * Why it is worth a file of its own: a finished compaction has **two** display
 * gates and the model used to honour neither. A task notification has none — it
 * is always one summary row — and the model used to count the compaction body for
 * it (2026-10-24).
 *
 * - `showCompactionsEnabled` off (the default) ⇒ `TranscriptItemView` renders
 *   `null`. Not a short row — **no row at all**.
 * - shown, but `HARUYUKI_DEBUG` unset ⇒ `EventMessage` paints one line and hides
 *   the summary body.
 * - shown and `HARUYUKI_DEBUG=1` ⇒ header row, blank row, then the body, which is
 *   routinely dozens of rows.
 *
 * The model counted `1 + summaryRows` in all three. On a published build (no
 * debug) a compacted conversation therefore reserved the whole band for rows that
 * are never painted: the viewport concluded the transcript was full and drew
 * mostly blank (`《34》3.11` had already flagged this branch as the one needing a
 * display-state input; 《34》§19.3 is the same family).
 */
import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, type DOMElement, measureElement, render } from "ink";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  measureTranscriptItemRows,
  type RowMeasureOptions,
} from "@/cli/app/row-model";
import { TranscriptItemView } from "@/cli/app/TranscriptItem";
import type { StaticItem } from "@/cli/app/types";
import { getCompactionSummaryVisible } from "@/cli/components/transcript-display-state";

/** The renderers read the ambient terminal, so the test renders at the same size. */
const COLUMNS = process.stdout.columns ?? 80;
const ROWS = process.stdout.rows ?? 24;
const PROMPT = ">";

class CaptureStream extends Writable {
  columns = COLUMNS;
  rows = ROWS;
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

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

/** Renders `node` and reports the laid-out height of its wrapper. */
async function measureHeight(node: ReactNode): Promise<number> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const measured = { height: 0 };

  function Probe() {
    const ref = useRef<DOMElement | null>(null);
    useEffect(() => {
      const timer = setTimeout(() => {
        if (ref.current) measured.height = measureElement(ref.current).height;
      }, 0);
      return () => clearTimeout(timer);
    });
    return <Box ref={ref}>{node}</Box>;
  }

  const instance = render(<Probe />, {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();
  return measured.height;
}

/** The body a real compaction writes: a long bulleted summary. */
const SUMMARY = Array.from(
  { length: 40 },
  (_, index) => `- summary line ${index}`,
).join("\n");

const EVENT_ITEM = {
  kind: "event",
  id: "ev-compaction",
  eventType: "compaction",
  eventData: {},
  phase: "finished",
  summary: SUMMARY,
} as unknown as StaticItem;

/** The node `ViewportTranscript` renders for the item, and what the model sees. */
function mount(
  options: { shown: boolean; summaryVisible: boolean },
  measure: Partial<RowMeasureOptions> = {},
) {
  const index = 1;
  const predicted = measureTranscriptItemRows(EVENT_ITEM, {
    columns: COLUMNS,
    index,
    terminalRows: ROWS,
    showCompactionsEnabled: options.shown,
    compactionSummaryVisible: options.summaryVisible,
    ...measure,
  });
  const node = (
    <TranscriptItemView
      item={EVENT_ITEM}
      index={index}
      columns={COLUMNS}
      statusLinePrompt={PROMPT}
      showCompactionsEnabled={options.shown}
      precomputedDiffs={new Map()}
    />
  );
  return { predicted, node };
}

/** Run `body` with `HARUYUKI_DEBUG` set, restoring the previous value after. */
async function withDebug(value: string, body: () => Promise<void>) {
  const before = process.env.HARUYUKI_DEBUG;
  process.env.HARUYUKI_DEBUG = value;
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env.HARUYUKI_DEBUG;
    else process.env.HARUYUKI_DEBUG = before;
  }
}

/**
 * A task notification is the other `event` kind, and it has no body to gate.
 *
 * `EventMessage` returns after one bold summary row for it; the model used to
 * fall through to the compaction branch and count a header, a blank and the body
 * that only `HARUYUKI_DEBUG=1` paints — for a *compaction*. Under debug, every
 * notification was therefore measured several rows taller than it drew, and the
 * viewport's shortfall lands at the top of the band (2026-10-24).
 */
describe("a task notification", () => {
  const NOTIFICATION_ITEM = {
    kind: "event",
    id: "ev-task",
    eventType: "task_notification",
    eventData: {},
    phase: "finished",
    summary:
      'Background command "Record the original translation comparison" completed',
  } as unknown as StaticItem;

  test("is its summary row plus the gap, even while the debug body is on", async () => {
    await withDebug("1", async () => {
      expect(getCompactionSummaryVisible()).toBe(true);
      const index = 1;
      const predicted = measureTranscriptItemRows(NOTIFICATION_ITEM, {
        columns: COLUMNS,
        index,
        terminalRows: ROWS,
        showCompactionsEnabled: true,
        compactionSummaryVisible: true,
      });
      const painted = await measureHeight(
        <TranscriptItemView
          item={NOTIFICATION_ITEM}
          index={index}
          columns={COLUMNS}
          statusLinePrompt={PROMPT}
          showCompactionsEnabled={true}
          precomputedDiffs={new Map()}
        />,
      );
      // At the width this suite renders at the summary fits one row: gap + 1.
      expect(painted).toBe(2);
      expect(predicted).toBe(painted);
    });
  });
});

describe("a compaction event", () => {
  test("is not a row at all while compactions are hidden", async () => {
    await withDebug("0", async () => {
      // `TranscriptItemView` returns null, so the only painted row is the item's own
      // gap. Counting the one-line header here was the phantom row.
      const { predicted, node } = mount({
        shown: false,
        summaryVisible: false,
      });
      expect(predicted).toBe(1);
      expect(await measureHeight(node)).toBe(1);
    });
  });

  test("is one row (plus the gap) when its body is hidden", async () => {
    await withDebug("0", async () => {
      const { predicted, node } = mount({
        shown: true,
        summaryVisible: false,
      });
      const painted = await measureHeight(node);
      // Pinned exactly: the failure this guards against is a *large* over-count,
      // and a ±1 tolerance would let a 39-row error through.
      expect(predicted).toBe(2);
      expect(painted).toBe(2);
    });
  });

  test("includes its body when HARUYUKI_DEBUG prints it", async () => {
    await withDebug("1", async () => {
      expect(getCompactionSummaryVisible()).toBe(true);
      const { predicted, node } = mount(
        { shown: true, summaryVisible: true },
        { compactionSummaryVisible: true },
      );
      const painted = await measureHeight(node);
      // The debug body is dev-only, so it keeps the family's ±1 tolerance rather
      // than a pinned number: what matters is that the model now *sees* the body.
      expect(Math.abs(painted - predicted)).toBeLessThanOrEqual(1);
    });
  });
});
