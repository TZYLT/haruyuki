/**
 * The `memory str_replace` preview, measured against the renderer that draws it.
 *
 * This is the item the machine's "big blocks of text vanish while scrolling"
 * turned out to be: the row model predicted **35 rows** for a preview that draws
 * about four, because it measured every old and new line at the *widest* row's
 * height and multiplied — "over-estimates rather than hiding a change". A viewport
 * that believes an empty band is full never asks for the next item, so the rows
 * stayed empty (2026-10-20, `blankTail=19` with `tool_call(memory):35` in the
 * window the log recorded).
 *
 * The two sides now share their selection (`helpers/memory-diff-rows.ts`); this
 * test holds them together with the real component.
 */

import { expect, test } from "bun:test";
import {
  ROW_SAFETY_COLUMNS,
  visibleWidth,
} from "@/cli/display/statusline/formatting";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { mountInkTty } from "@/test-utils/ink-tty";
import { measureTranscriptItemRows } from "./row-model";
import { TranscriptItemView } from "./TranscriptItem";
import type { StaticItem } from "./types";

const COLUMNS = 120;
const ROWS = 50;

const PARAGRAPH =
  "压缩线是窗口减去固定开销之后剩下的空间，而固定开销包括编译后的系统提示词与工具 schema，所以把窗口设成 64k 之后压缩会在每一轮都触发一次，直到消息掉到 8.4k 为止。";

function memoryReplace(oldStr: string, newStr: string): StaticItem {
  return {
    kind: "tool_call",
    id: "tc-memory",
    name: "memory",
    phase: "finished",
    resultOk: true,
    toolCallId: "tc-memory",
    argsText: JSON.stringify({
      command: "str_replace",
      file_path: "system/agent-notes.md",
      old_string: oldStr,
      new_string: newStr,
    }),
    resultText: "Updated memory block agent-notes.md",
  } as StaticItem;
}

async function compare(
  item: StaticItem,
): Promise<{ predicted: number; painted: number; widest: number }> {
  const predicted = measureTranscriptItemRows(item, {
    columns: COLUMNS,
    index: 1,
    terminalRows: ROWS,
    diffs: new Map(),
    userPromptPrefix: `${CLI_GLYPHS.prompt} `,
  });
  const shell = mountInkTty(
    <TranscriptItemView
      item={item}
      index={1}
      columns={COLUMNS}
      statusLinePrompt=">"
      showCompactionsEnabled={false}
      precomputedDiffs={new Map()}
    />,
    { columns: COLUMNS, rows: ROWS },
  );
  let painted = 0;
  let widest = 0;
  try {
    const rows = await shell.rows();
    painted = rows.length;
    for (const row of rows) widest = Math.max(widest, visibleWidth(row));
  } finally {
    shell.stop();
  }
  return { predicted, painted, widest };
}

test("a one-line replace is measured as the handful of rows it draws", async () => {
  const item = memoryReplace(PARAGRAPH, PARAGRAPH.replace("64k", "256k"));
  const { predicted, painted } = await compare(item);
  // The old estimate was 35 rows for this shape (ten candidates, widest row 3-4
  // rows each). What it draws is the header plus the changed pair.
  expect(predicted).toBeLessThan(15);
  expect(Math.abs(predicted - painted)).toBeLessThanOrEqual(1);
});

test("a multi-line replace counts its changed lines, not the widest one times ten", async () => {
  const before = [PARAGRAPH, PARAGRAPH, PARAGRAPH].join("\n");
  const after = [PARAGRAPH, `${PARAGRAPH}（已改）`, PARAGRAPH].join("\n");
  const item = memoryReplace(before, after);
  const { predicted, painted } = await compare(item);
  expect(Math.abs(predicted - painted)).toBeLessThanOrEqual(1);
});

test("no preview line reaches past the terminal, so nothing wraps", async () => {
  // The machine's report of a memory diff: "flickers, the selection lands on the
  // wrong rows, the tab row disappears", with a lone `e` on its own line. That is a
  // long preview line ending one column past the terminal: the terminal wraps it,
  // the frame grows a line, the alternate screen scrolls, and every row the
  // selection painter measured moves. The text below is deliberately full of the
  // characters `string-width` and a terminal disagree about.
  const long =
    "Evidence 2026-09-25: setting the window to 64k took effect within a minute — “an auto‑compaction fired — and its stats recorded `context_window: 64000`” … while `letta model get` still said 1,000,000/384,000.";
  const item = memoryReplace(long, `${long} 改`);
  const { predicted, painted, widest } = await compare(item);
  expect(Math.abs(predicted - painted)).toBeLessThanOrEqual(1);
  // Two columns of slack (`ROW_SAFETY_COLUMNS`): a row that ends inside the
  // terminal cannot wrap, whatever the terminal's own idea of a glyph's width is.
  expect(widest).toBeLessThanOrEqual(COLUMNS - ROW_SAFETY_COLUMNS);
});
