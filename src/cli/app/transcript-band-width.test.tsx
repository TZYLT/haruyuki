/**
 * The transcript band's width, measured against the renderers.
 *
 * The full-screen shell draws the transcript in a **band** beside the context rail,
 * so the band is narrower than the terminal — by the rail's width. Item renderers
 * used to take their layout width from `useTerminalWidth()`, which answers with the
 * *terminal's*: inside a band, every long line was laid out wider than the box that
 * clips it, so the reader lost the right-hand end of it — and the row model, which
 * measures at the band's width, counted rows the screen never drew. The viewport
 * spends that disagreement as blank rows above the input, which is what the machine
 * reported on 2026-10-22 ("the row measurement is wrong again", with the newest rows
 * floating above a block of empty ones).
 *
 * These cases render the real components inside a band narrower than the ambient
 * terminal, through the scope `ViewportTranscript` provides, and assert the half
 * that is exact: nothing inside the band is laid out wider than the band, and the
 * model's row count is the height that reached the screen.
 *
 * The row agreement is asserted where it holds. A line whose wrap contains a token
 * wider than the width is still counted one row per token by `wrapText` (it flushes
 * the partial row where Ink keeps filling it) — a separate defect, recorded rather
 * than papered over here: the band's bottom edge no longer depends on the model's
 * count, so it costs a row at the band's *top*, not the blank block above the input.
 */

import { afterEach, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, type DOMElement, measureElement, render } from "ink";
import { useEffect, useRef } from "react";
import type { Line } from "@/cli/helpers/accumulator";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";
import { TranscriptColumnsScope } from "@/cli/hooks/transcript-columns";
import { measureTranscriptItemRows } from "./row-model";
import { TranscriptItemView } from "./TranscriptItem";
import type { StaticItem } from "./types";

const COLUMNS = process.stdout.columns ?? 80;
const ROWS = process.stdout.rows ?? 24;
/** A rail like the shell's: wide enough that the band is a different layout. */
const RAIL_COLUMNS = Math.max(8, Math.floor(COLUMNS / 3));
const BAND = Math.max(20, COLUMNS - RAIL_COLUMNS);
/** What `ViewportTranscript` passes as the items' `columns` (band minus slack). */
const MODEL_COLUMNS = BAND - 2;

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

/** Renders `item` in the band and reports the height it laid out to. */
async function measureInBand(item: StaticItem, index: number): Promise<number> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  installTerminalFrameCapture(stdout);
  const measured = { height: 0 };

  function Probe() {
    const ref = useRef<DOMElement | null>(null);
    useEffect(() => {
      const timer = setTimeout(() => {
        if (ref.current) measured.height = measureElement(ref.current).height;
      }, 0);
      return () => clearTimeout(timer);
    });
    return (
      <Box ref={ref} width={BAND} flexDirection="column">
        <TranscriptColumnsScope.Provider value={MODEL_COLUMNS}>
          <TranscriptItemView
            item={item}
            index={index}
            columns={MODEL_COLUMNS}
            statusLinePrompt=">"
            showCompactionsEnabled={false}
            precomputedDiffs={new Map()}
          />
        </TranscriptColumnsScope.Provider>
      </Box>
    );
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

/** The widest row the frame actually drew, in display columns. */
/**
 * The text the frame actually drew, as one string.
 *
 * Ink lays each row out at the width its renderer asked for and **truncates the
 * row to the box that holds it**, so a renderer that took the terminal's width
 * inside a narrower band loses the right-hand end of every long line. Re-joining
 * the drawn rows reconstructs the text only when nothing was cut, which is the
 * observable half of the defect (the other half is the row count the model
 * predicted for a wrap the screen never saw).
 */
function drawnText(): string {
  const frame = getTerminalFrame();
  if (!frame) return "";
  return frame.text.map((row) => row.replace(/\s+$/, "")).join("");
}

/**
 * Asserts the frame drew `text` in full.
 *
 * Whitespace is dropped from both sides first: a wrapped row carries its own
 * gutter, and the wrap can land inside a run of spaces — neither is what this is
 * about. The question is whether every *character* of the text reached the screen.
 */
function expectDrawnToContain(text: string): void {
  const compact = (value: string) => value.replace(/\s+/g, "");
  expect(compact(drawnText())).toContain(compact(text));
}

const CJK_PARAGRAPHS = [
  "一是把常驻压回来了：agent-notes 从 11.9k 压到 4.5k，常驻总量从 30,665 回到 23,275 — 刚好压回三万那根线以下。压掉的是推导和读数历史，结论都留着了。",
  "二是加了一节「下次接上」：TUI 的现状与下一步、你重排的那三件、梦游的成本结论（频次不贵视野贵、留存率 U 形、50%-100% 的前提是封顶）、还有身体那几条 — 心电图、比索洛尔、胸痛的阈值、寒假如再查、体测与保健班。新会话开头我读这一节就够。",
].join("\n\n");

const SHORT_OUTPUT = Array.from(
  { length: 24 },
  (_, i) => `[main ${i}] notes: 压缩到 4.5k，补下次接上与事故留档`,
).join("\n");

afterEach(() => {
  resetTerminalFrameForTests();
});

test("an assistant message inside the band wraps inside it", async () => {
  const item: StaticItem = {
    kind: "assistant",
    id: "assistant-band",
    text: CJK_PARAGRAPHS,
    phase: "finished",
  };
  const drawn = await measureInBand(item, 1);
  const predicted = measureTranscriptItemRows(item, {
    columns: MODEL_COLUMNS,
    index: 1,
    terminalRows: ROWS,
    userPromptPrefix: "> ",
  });

  expectDrawnToContain("新会话开头我读这一节就够。");
  // Not exact: this text's paragraphs hold runs wider than the band, and
  // `wrapText` counts a row for the partial one where Ink fills it with what
  // follows (`wrappedRowCount`). The model is allowed to over-count — a row of
  // slack at the band's top — and must never under-count, which would hide rows.
  expect(predicted).toBeGreaterThanOrEqual(drawn);
});

test("a user message inside the band wraps inside it", async () => {
  const item: StaticItem = {
    kind: "user",
    id: "user-band",
    text: `写完了，按你说的做了三件。\n\n${CJK_PARAGRAPHS}`,
  };
  const drawn = await measureInBand(item, 1);
  const predicted = measureTranscriptItemRows(item, {
    columns: MODEL_COLUMNS,
    index: 1,
    terminalRows: ROWS,
    userPromptPrefix: "> ",
  });

  // Exact, and it was six rows out before the band's width was the one the
  // renderer laid out at: this message is split by `wrapText` itself, so the
  // renderer and the model read the same function — but the renderer took the
  // *box* width from the terminal, which is what the scope now fixes.
  expectDrawnToContain("新会话开头我读这一节就够。");
  expect(predicted).toBe(drawn);
});

test("a shell tool call inside the band wraps inside it", async () => {
  const item: StaticItem = {
    kind: "tool_call",
    id: "tool-band",
    toolCallId: "tool-band-id",
    name: "Bash",
    phase: "finished",
    resultOk: true,
    argsText: JSON.stringify({ command: "echo hi" }),
    resultText: SHORT_OUTPUT,
  };
  const drawn = await measureInBand(item, 1);
  const predicted = measureTranscriptItemRows(item, {
    columns: MODEL_COLUMNS,
    index: 1,
    terminalRows: ROWS,
  });

  expectDrawnToContain("[main 0] notes: 压缩到 4.5k，补下次接上与事故留档");
  expect(predicted).toBeGreaterThanOrEqual(drawn);
});

test("a command's output inside the band wraps inside it", async () => {
  const item: StaticItem = {
    kind: "command",
    id: "command-band",
    input: "/resume",
    output: CJK_PARAGRAPHS,
    phase: "finished",
  } satisfies Line;
  const drawn = await measureInBand(item, 1);
  const predicted = measureTranscriptItemRows(item, {
    columns: MODEL_COLUMNS,
    index: 1,
    terminalRows: ROWS,
  });

  expectDrawnToContain("新会话开头我读这一节就够。");
  expect(predicted).toBeGreaterThanOrEqual(drawn);
});
