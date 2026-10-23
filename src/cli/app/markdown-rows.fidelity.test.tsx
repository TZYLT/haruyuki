import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, type DOMElement, measureElement, render } from "ink";
import { useEffect, useRef } from "react";
import { measureTranscriptItemRows } from "@/cli/app/row-model";
import { TranscriptItemView } from "@/cli/app/TranscriptItem";
import type { StaticItem } from "@/cli/app/types";
import { TranscriptColumnsScope } from "@/cli/hooks/transcript-columns";

/**
 * The transcript row model against the thing it measures.
 *
 * The full-screen viewport fits its window from `measureTranscriptItemRows`, so a
 * measurement larger than the draw does not cost a blank row at the end of the
 * transcript — it costs a **blank band**: the model thinks the window is full,
 * the rows paint short, and the gap lands above the content. The machine reported
 * that shape twice (2026-10-20, 2026-10-23: "large blank area, this time from the
 * top"). This file weighs the model against a real render of the same item for
 * the two transforms that produced the second one:
 *
 * - inline markdown markers (`**`, `` ` ``) are not painted, so a line the model
 *   thinks overflows the band can paint on one row;
 * - a long word is filled across rows by Ink's wrapper, and the words after it
 *   continue on the last row, so the model must not open an extra row for them;
 * - `AssistantMessage` collapses a run of blank lines before rendering.
 *
 * The width the item is *drawn* at is 40 (the band), while the terminal is 80:
 * that is exactly how `ViewportTranscript` runs, and the reason the case mounts
 * `TranscriptColumnsScope` instead of passing `columns` alone.
 */

const BAND_COLUMNS = 40;
const TERMINAL_COLUMNS = 80;
const TERMINAL_ROWS = 24;

class Capture extends Writable {
  columns = TERMINAL_COLUMNS;
  rows = TERMINAL_ROWS;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
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

async function drawnRows(item: StaticItem, index: number): Promise<number> {
  const measured = { height: 0 };
  function Probe() {
    const ref = useRef<DOMElement | null>(null);
    useEffect(() => {
      if (ref.current) measured.height = measureElement(ref.current).height;
    });
    return (
      <Box ref={ref}>
        <TranscriptColumnsScope.Provider value={BAND_COLUMNS}>
          <TranscriptItemView
            item={item}
            index={index}
            columns={BAND_COLUMNS}
            statusLinePrompt="> "
            showCompactionsEnabled={false}
            precomputedDiffs={new Map()}
          />
        </TranscriptColumnsScope.Provider>
      </Box>
    );
  }

  const instance = render(<Probe />, {
    stdin: fakeStdin(),
    stdout: new Capture() as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await sleep(80);
  instance.unmount();
  instance.cleanup();
  return measured.height;
}

function measuredRows(item: StaticItem, index: number): number {
  return measureTranscriptItemRows(item, {
    columns: BAND_COLUMNS,
    index,
    terminalRows: TERMINAL_ROWS,
    diffs: new Map(),
    showCompactionsEnabled: false,
    compactionSummaryVisible: false,
    userPromptPrefix: "> ",
  });
}

const saved = {
  columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
  rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
};

function pinTerminal(): void {
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: TERMINAL_COLUMNS,
  });
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: TERMINAL_ROWS,
  });
  process.stdout.emit("resize");
}

function restoreTerminal(): void {
  for (const key of ["columns", "rows"] as const) {
    const descriptor = saved[key];
    if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
    else delete (process.stdout as { columns?: number; rows?: number })[key];
  }
  process.stdout.emit("resize");
}

afterEach(() => {
  restoreTerminal();
});

/** The item's own leading gap, so both sides count the same thing. */
const INDEX = 1;

const cases: Array<{ name: string; text: string }> = [
  {
    // 37 visible columns plus four markers: the model used to wrap it to two
    // rows, while the renderer paints one.
    name: "a bold run that only overflows through its markers",
    text: `**${"a".repeat(35)}**`,
  },
  {
    name: "an inline-code run that only overflows through its backticks",
    text: `\`${"b".repeat(35)}\``,
  },
  {
    // Ink fills the tail of a hard-wrapped word and continues on that row; the
    // hand-rolled wrapper used to open a third row for `tail`.
    name: "a long token followed by words inside a code fence",
    text: `\`\`\`\n${"c".repeat(45)} tail\n\`\`\``,
  },
  {
    name: "a run of blank lines that the renderer collapses",
    text: "first\n\n\n\n\nsecond",
  },
  {
    // A list's content box loses the marker width; its bold markers do not.
    name: "a list item whose bold body only overflows through its markers",
    text: `- **${"d".repeat(35)}**`,
  },
];

describe("the row model weighs the markdown it draws", () => {
  for (const { name, text } of cases) {
    test(name, async () => {
      pinTerminal();
      const item = {
        kind: "assistant",
        id: `assistant-${name}`,
        text,
        phase: "finished",
      } satisfies StaticItem;
      const model = measuredRows(item, INDEX);
      const drawn = await drawnRows(item, INDEX);
      expect(
        drawn,
        `the band draws ${model} rows for: ${JSON.stringify(text)}`,
      ).toBe(model);
    });
  }
});
