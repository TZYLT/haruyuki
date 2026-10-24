import { describe, expect, test } from "bun:test";
import {
  LAYOUT_FIELDS,
  measureLineRows,
  type RowLayoutOptions,
  rowLayoutKey,
} from "@/cli/app/row-model";
import {
  layoutMarkdownTable,
  parseMarkdownTable,
} from "@/cli/components/MarkdownTable";
import type { Line } from "@/cli/helpers/accumulator";
import { markdownRowCount } from "@/cli/helpers/markdown-rows";
import {
  countTextRows,
  inkStringWidth,
  paddedRows,
} from "@/cli/helpers/text-metrics";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import {
  formatRecallBlockForDisplay,
  RECALL_DISPLAY_DEFAULT,
} from "@/reminders/recall-display";
import { RECALL_MARKER_TAG } from "@/reminders/recall-reminder";

const OPTIONS = { columns: 40 };

/** A `<system-reminder>` block with `body` in it. */
function reminderBlock(body: string): string {
  return `${SYSTEM_REMINDER_OPEN}\n${body}\n${SYSTEM_REMINDER_CLOSE}`;
}

/** A recall injection: the marker is what makes the block render as a summary. */
function recallBlock(body = "recalled passage"): string {
  return `${SYSTEM_REMINDER_OPEN}\n<${RECALL_MARKER_TAG} items="3" transcript="2" memory="1" />\n${body}\n${SYSTEM_REMINDER_CLOSE}`;
}

describe("markdownRowCount", () => {
  test("counts a paragraph that fits as one row", () => {
    expect(markdownRowCount("hello world", 40)).toBe(1);
  });

  test("wraps a paragraph at the width", () => {
    expect(markdownRowCount("hello world", 6)).toBe(2);
  });

  test("counts a fenced code block by its body lines", () => {
    expect(markdownRowCount("```\nconst a = 1;\n```", 40)).toBe(1);
    expect(markdownRowCount("```\na\nb\nc\n```", 40)).toBe(3);
  });

  test("counts a list item and a header as single rows", () => {
    expect(markdownRowCount("- item", 40)).toBe(1);
    expect(markdownRowCount("# Title", 40)).toBe(1);
  });

  test("counts blank lines and table rows", () => {
    expect(markdownRowCount("a\n\nb", 40)).toBe(3);
    expect(markdownRowCount("| a | b |\n| --- | --- |\n| 1 | 2 |", 40)).toBe(3);
  });

  test("returns zero rows for empty text", () => {
    expect(markdownRowCount("", 40)).toBe(0);
  });

  describe("tables (A3)", () => {
    // Two records over two columns: one header row, the `━` rule, and each
    // record with a `─` rule between them — `2n + 1` rows for `n` records.
    const grid = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";

    test("a grid table is 2n + 1 rows, not its markdown line count", () => {
      expect(markdownRowCount(grid, 40, { contentWidth: 40 })).toBe(5);
      // The markdown it replaced counted four lines for the same table.
      expect(markdownRowCount(grid, 40)).toBe(5);
    });

    test("grid rows grow with the number of cell lines", () => {
      const wrapping = `| a | b |\n| --- | --- |\n| ${"x".repeat(60)} | 2 |`;
      // The first cell wraps at its column, so the record is more than one line
      // tall: header + rule + its wrapped lines. The table lays itself out two
      // columns narrower than the width it is given (`ROW_SAFETY_COLUMNS`, so a
      // row cannot end past the terminal's edge), so the cell wraps one line
      // earlier than it did before that margin existed.
      expect(markdownRowCount(wrapping, 40, { contentWidth: 40 })).toBe(5);
    });

    test("a table too narrow for its columns falls back to stacked records", () => {
      const table = parseMarkdownTable(
        "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |".split(
          "\n",
        ),
      );
      if (!table) throw new Error("expected the table to parse");
      // The layout decision comes from `MarkdownTable` itself; assert it first so
      // this test fails loudly if the layout rule changes.
      expect(layoutMarkdownTable(table, 12).mode).toBe("stacked-records");
      // Two records of three fields, each a label row above a value row, plus the
      // one separator between the records.
      expect(
        markdownRowCount(
          "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |",
          12,
          { contentWidth: 12 },
        ),
      ).toBe(13);
    });

    test("a table with no records and no room renders nothing", () => {
      expect(
        markdownRowCount("| a | b | c |\n| --- | --- | --- |", 12, {
          contentWidth: 12,
        }),
      ).toBe(0);
    });
  });
});

describe("measureLineRows", () => {
  test("a separator is one row", () => {
    expect(measureLineRows({ kind: "separator", id: "sep" }, OPTIONS)).toBe(1);
  });

  test("a status row wraps each of its lines in the gutter box (A6)", () => {
    expect(
      measureLineRows({ kind: "status", id: "st", lines: ["a", "b"] }, OPTIONS),
    ).toBe(2);

    // Each line gets a `columns - 2` box, not the full terminal width: 40
    // columns of text is two rows in a 38-column box.
    expect(
      measureLineRows(
        { kind: "status", id: "st", lines: ["x".repeat(40)] },
        OPTIONS,
      ),
    ).toBe(2);
    // Exactly the box width is still one row.
    expect(
      measureLineRows(
        { kind: "status", id: "st", lines: ["x".repeat(38)] },
        OPTIONS,
      ),
    ).toBe(1);
  });

  test("a user row is its blocks plus the highlight's blank rows (A1)", () => {
    expect(
      measureLineRows({ kind: "user", id: "u", text: "hello world" }, OPTIONS),
    ).toBe(3);

    const long: Line = { kind: "user", id: "u", text: "x".repeat(100) };
    // 100 columns in a 38-column box: three rows, plus the blank row the
    // highlight draws above and below.
    expect(measureLineRows(long, OPTIONS)).toBe(3 + 2);
  });

  test("a hidden reminder block adds no user rows (A1)", () => {
    const text = `hello\n${reminderBlock("note line")}`;
    expect(measureLineRows({ kind: "user", id: "u", text }, OPTIONS)).toBe(3);
    // Visible but collapsed: one summary line, wrapped at the prompt width.
    expect(
      measureLineRows(
        { kind: "user", id: "u", text },
        { columns: 40, systemRemindersVisible: true },
      ),
    ).toBe(3 + 2);
    // Expanded: the header line and then the block's own four lines.
    expect(
      measureLineRows(
        { kind: "user", id: "u", text },
        {
          columns: 40,
          systemRemindersVisible: true,
          systemRemindersExpanded: true,
        },
      ),
    ).toBe(3 + 4);
  });

  test("user content on both sides of a reminder keeps both blocks (A1)", () => {
    const text = `before\n${reminderBlock("note line")}\nafter`;
    // Two highlighted blocks, no row for the separator between them (the
    // renderer's separator is an empty `<Text>`, which Ink measures as zero).
    expect(measureLineRows({ kind: "user", id: "u", text }, OPTIONS)).toBe(6);
  });

  test("a recall block follows its display tier (A1, A2)", () => {
    const text = recallBlock();
    const silent = measureLineRows(
      { kind: "user", id: "u", text },
      { columns: 40, recallDisplay: "silent" },
    );
    expect(silent).toBe(0);

    const shown = formatRecallBlockForDisplay({
      text,
      display: RECALL_DISPLAY_DEFAULT,
      expanded: false,
    });
    if (shown === null) throw new Error("expected the recall block to render");
    expect(measureLineRows({ kind: "user", id: "u", text }, OPTIONS)).toBe(
      countTextRows(shown, 38),
    );

    const full = measureLineRows(
      { kind: "user", id: "u", text },
      { columns: 40, recallDisplay: "full" },
    );
    expect(full).toBeGreaterThan(silent);
  });

  test("a recall transcript row renders its tier at the terminal width (A2)", () => {
    const line: Line = { kind: "recall", id: "r", text: recallBlock() };
    expect(
      measureLineRows(line, { columns: 40, recallDisplay: "silent" }),
    ).toBe(0);
    const shown = formatRecallBlockForDisplay({
      text: line.text,
      display: RECALL_DISPLAY_DEFAULT,
      expanded: false,
    });
    if (shown === null) throw new Error("expected the recall block to render");
    expect(measureLineRows(line, OPTIONS)).toBe(countTextRows(shown, 40));
  });

  test("an assistant row measures its markdown body", () => {
    const fits: Line = {
      kind: "assistant",
      id: "a",
      text: "hello",
      phase: "finished",
    };
    expect(measureLineRows(fits, OPTIONS)).toBe(1);

    const wraps: Line = {
      kind: "assistant",
      id: "a",
      text: "x".repeat(100),
      phase: "finished",
    };
    // 40 columns minus the 2-column bullet gutter.
    expect(measureLineRows(wraps, OPTIONS)).toBe(3);
  });

  test("an assistant table is measured as the table lays out (A3)", () => {
    const table: Line = {
      kind: "assistant",
      id: "a",
      phase: "finished",
      text: "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
    };
    // `AssistantMessageRich` hands `MarkdownDisplay` its 38-column content box,
    // so the table lays out against that width: header + rule + two records with
    // a rule between them.
    expect(measureLineRows(table, OPTIONS)).toBe(5);
  });

  test("collapsed reasoning is a single header row", () => {
    const header: Line = {
      kind: "reasoning",
      id: "r",
      text: "body",
      phase: "finished",
    };
    expect(measureLineRows(header, OPTIONS)).toBe(1);
  });

  test("a collapsed reasoning continuation is hidden", () => {
    const continuation: Line = {
      kind: "reasoning",
      id: "r",
      text: "body",
      phase: "finished",
      isContinuation: true,
    };
    expect(measureLineRows(continuation, OPTIONS)).toBe(0);
  });

  test("expanded reasoning adds the header, spacer and body (A2)", () => {
    const expanded: Line = {
      kind: "reasoning",
      id: "r",
      text: "body",
      phase: "finished",
    };
    expect(
      measureLineRows(expanded, { columns: 40, reasoningExpanded: true }),
    ).toBe(3);

    // An expanded continuation line has no header and no spacer, just its body.
    const continuation: Line = {
      kind: "reasoning",
      id: "r",
      text: "body",
      phase: "finished",
      isContinuation: true,
    };
    expect(
      measureLineRows(continuation, { columns: 40, reasoningExpanded: true }),
    ).toBe(1);

    // The body is the markdown walk at the `columns - 2` box width.
    const long: Line = {
      kind: "reasoning",
      id: "r",
      text: "x".repeat(100),
      phase: "finished",
    };
    expect(
      measureLineRows(long, { columns: 40, reasoningExpanded: true }),
    ).toBe(2 + 3);
  });

  test("a bare tool call is one header row", () => {
    const bare: Line = { kind: "tool_call", id: "t", phase: "finished" };
    expect(measureLineRows(bare, OPTIONS)).toBe(1);
  });

  test("a tool call measures its header and its markdown result body", () => {
    const withBody: Line = {
      kind: "tool_call",
      id: "t",
      phase: "finished",
      // Not JSON: the header shows the placeholder, on one row.
      argsText: "line1\nline2",
      resultText: "ok",
    };
    expect(measureLineRows(withBody, OPTIONS)).toBe(1 + 1);
  });

  test("an arg body that does not parse stays a single header row", () => {
    const huge: Line = {
      kind: "tool_call",
      id: "t",
      phase: "finished",
      argsText: Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"),
    };
    expect(measureLineRows(huge, OPTIONS)).toBe(1);
  });

  test("a read result is a one-line summary, not the returned text", () => {
    const read: Line = {
      kind: "tool_call",
      id: "t",
      phase: "finished",
      name: "read",
      argsText: JSON.stringify({ file_path: "src/a.ts" }),
      resultText: "a\nb\nc",
      resultOk: true,
    };
    expect(measureLineRows(read, OPTIONS)).toBe(1 + 1);
  });

  test("a finished shell call measures its collapsed output block", () => {
    const bash: Line = {
      kind: "tool_call",
      id: "t",
      phase: "finished",
      name: "Bash",
      argsText: JSON.stringify({ command: "echo hi" }),
      resultText: "a\nb\nc\nd",
      resultOk: true,
    };
    // One header row, three visible output lines, and the hidden-count row.
    expect(measureLineRows(bash, OPTIONS)).toBe(1 + 3 + 1);
  });

  test("a shell command's continuation line wraps in its columns - 5 box (A8)", () => {
    const continuation = "字".repeat(35);
    const line: Line = {
      kind: "tool_call",
      id: "t",
      phase: "running",
      name: "Bash",
      argsText: JSON.stringify({ command: `echo hi\n${continuation}` }),
      resultOk: true,
    };
    // 35 wide characters are 70 display columns inside a 35-column box: 17 + 17 +
    // 1 characters, so three rows. The model used to record exactly one row per
    // continuation line, whatever its width.
    expect(measureLineRows(line, OPTIONS)).toBe(1 + 3);
  });

  test("a command row wraps its input at the gutter and its output at the result gutter (A5)", () => {
    const command: Line = {
      kind: "command",
      id: "c",
      input: "ls",
      output: "a\nb",
    };
    // One input row, then the output markdown block in its `columns - 5` box.
    expect(measureLineRows(command, OPTIONS)).toBe(1 + 2);

    const wide: Line = {
      kind: "command",
      id: "c",
      input: "x".repeat(40),
      output: "y".repeat(40),
    };
    // 40 columns of input in a 38-column box: two rows. 40 columns of markdown
    // in a 35-column box: two rows.
    expect(measureLineRows(wide, OPTIONS)).toBe(2 + 2);
  });

  test("a waiting command renders nothing (A5)", () => {
    const waiting: Line = {
      kind: "command",
      id: "c",
      input: "ls",
      output: "",
      phase: "waiting",
    };
    expect(measureLineRows(waiting, OPTIONS)).toBe(0);
  });

  test("a preformatted command output is counted as plain text (A5)", () => {
    const line: Line = {
      kind: "command",
      id: "c",
      input: "ls",
      output: "a\n\nb",
      preformatted: true,
    };
    expect(measureLineRows(line, OPTIONS)).toBe(1 + 3);
  });

  test("a running bash command counts its streaming window (A5)", () => {
    const streaming: Line = {
      kind: "bash_command",
      id: "b",
      input: "npm test",
      output: "",
      phase: "running",
      streaming: {
        tailLines: [
          { text: "line one", isStderr: false },
          { text: "line two", isStderr: false },
        ],
        partialLine: "",
        partialIsStderr: false,
        totalLineCount: 5,
        startTime: Date.now(),
      },
    };
    // Input row, the first tail line, the second, and the hidden-count row —
    // which is 39 columns wide and so wraps to two rows in the 35-column box.
    // The model used to ignore `line.streaming` completely here.
    expect(measureLineRows(streaming, OPTIONS)).toBe(1 + 1 + 1 + 2);
  });

  test("a finished bash command counts every output line as its own block (A5)", () => {
    const line: Line = {
      kind: "bash_command",
      id: "b",
      input: "cat f",
      output: "a\nb\nc",
      phase: "finished",
    };
    expect(measureLineRows(line, OPTIONS)).toBe(1 + 3);
  });

  test("a bash command with no phase renders its markdown output (A5)", () => {
    const line: Line = {
      kind: "bash_command",
      id: "b",
      input: "cat f",
      output: "y".repeat(40),
    };
    // 40 columns of markdown in a 35-column box: two rows.
    expect(measureLineRows(line, OPTIONS)).toBe(1 + 2);
  });

  test("a task notification counts its own summary, not a compaction body", () => {
    // `EventMessage` returns after one bold summary row for a task notification;
    // the compaction branch's header + blank + body is never painted. With
    // `HARUYUKI_DEBUG=1` the old branch measured this 30-character summary as the
    // whole compaction body (2026-10-24).
    const summary = "Background command completed";
    const line: Line = {
      kind: "event",
      id: "ev",
      eventType: "task_notification",
      eventData: {},
      phase: "finished",
      summary,
    };
    expect(
      measureLineRows(line, {
        columns: 40,
        showCompactionsEnabled: true,
        compactionSummaryVisible: true,
      }),
    ).toBe(countTextRows(summary, 38));
  });

  test("a task notification with no summary still paints one row", () => {
    const line: Line = {
      kind: "event",
      id: "ev",
      eventType: "task_notification",
      eventData: {},
      phase: "finished",
    };
    expect(
      measureLineRows(line, {
        columns: 40,
        showCompactionsEnabled: true,
        compactionSummaryVisible: true,
      }),
    ).toBe(1);
  });
});

/**
 * The one invariant that keeps `diffLineRowCount` honest: Ink never has to wrap
 * a row this function produced. `paddedRows` is shared by the diff renderers and
 * the row model, so a row wider than `cols` is counted once and rendered twice.
 */
describe("paddedRows row width (A7)", () => {
  const rowWidth = (row: Array<{ text: string }>): number =>
    inkStringWidth(row.map((chunk) => chunk.text).join(""));

  test("a double-width character beside a one-column gap starts a new row", () => {
    // 79 columns of text, then a wide character in the next chunk: the single
    // remaining column cannot hold it. Appending it produced an 81-column row,
    // which Ink wrapped again.
    const rows = paddedRows([{ text: "x".repeat(79) }, { text: "你" }], 80, 0);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(rowWidth(row)).toBeLessThanOrEqual(80);
    }
    expect(rows[1]?.map((chunk) => chunk.text).join("")).toBe(
      `你${" ".repeat(78)}`,
    );
  });

  test("a wide character that still fits is not moved", () => {
    const rows = paddedRows([{ text: "x".repeat(78) }, { text: "你" }], 80, 0);
    expect(rows).toHaveLength(1);
    expect(rowWidth(rows[0] ?? [])).toBe(80);
  });
});

/**
 * The ledger key a measured page height is recorded under.
 *
 * The viewport *skips* a page it has a height for, so a layout field missing from this
 * key is a page whose recorded number silently describes the layout the reader has
 * left. `LAYOUT_FIELDS` is exhaustive by type (`Record<keyof RowLayoutOptions, true>`),
 * and this walks it: every field has to move the key on its own.
 */
describe("rowLayoutKey", () => {
  const BASE: RowLayoutOptions = {
    columns: 80,
    terminalRows: 24,
    userPromptPrefix: "> ",
    reasoningExpanded: false,
    systemRemindersVisible: true,
    systemRemindersExpanded: false,
    recallDisplay: "summary",
    expandedToolCallId: null,
    lastShellToolCallId: null,
    diffCount: 0,
    substitutionsSignature: "",
    compactionSummaryVisible: false,
    showCompactionsEnabled: false,
  };

  /** A value different from `value`, of the same kind where that matters. */
  function otherValue(value: unknown): unknown {
    if (typeof value === "number") return value + 1;
    if (typeof value === "boolean") return !value;
    if (typeof value === "string") return `${value}x`;
    return "set";
  }

  test("moves for every field that can change an item's height", () => {
    const base = rowLayoutKey(BASE);
    const unmoved: string[] = [];
    for (const field of Object.keys(
      LAYOUT_FIELDS,
    ) as (keyof RowLayoutOptions)[]) {
      const changed = { ...BASE, [field]: otherValue(BASE[field]) };
      if (rowLayoutKey(changed) === base) unmoved.push(field);
    }
    expect(unmoved).toEqual([]);
  });

  test("is stable for the same layout, and treats absent as empty", () => {
    expect(rowLayoutKey(BASE)).toBe(rowLayoutKey({ ...BASE }));
    // A field that is absent and one that is empty are the same layout: the key is a
    // comparison token, not a serialization.
    expect(rowLayoutKey({ ...BASE, userPromptPrefix: undefined })).toBe(
      rowLayoutKey({ ...BASE, userPromptPrefix: "" }),
    );
  });
});
