/**
 * Differential test: the transcript row model against the real renderers.
 *
 * Every other test of the row model checks the model against itself. This one
 * renders the actual components the viewport uses — `TranscriptItemView` (tool
 * calls, approval previews) and `ApprovalSwitch` / `PendingApprovalStub` (the
 * substituted approval nodes) — with Ink, measures the laid-out element, and
 * compares it with what the model predicted for the same item. The model is
 * allowed to be off by one row (a documented approximation may leave a blank row);
 * anything larger means the viewport would hide content or drift.
 *
 * Width comes from the ambient terminal because the renderers read it through
 * `useTerminalWidth()` (`process.stdout.columns`), and the render stream is given
 * the same size so the two agree.
 */

import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, type DOMElement, measureElement, render } from "ink";
import { type ReactNode, useEffect, useRef } from "react";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { PendingApprovalStub } from "@/cli/components/PendingApprovalStub";
import {
  setRecallDisplay,
  setSystemRemindersVisible,
  setThinkingExpanded,
  toggleSystemReminderDisplay,
} from "@/cli/components/transcript-display-state";
import {
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
  parsePatchToAdvancedDiff,
} from "@/cli/helpers/diff";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { RECALL_MARKER_TAG } from "@/reminders/recall-reminder";
import type { ApprovalSubstitutions } from "./approval-rows";
import { measureTranscriptItemRows, type RowMeasureOptions } from "./row-model";
import { TranscriptItemView } from "./TranscriptItem";
import type { StaticItem } from "./types";

/** The renderers read the ambient terminal, so the test renders at the same size. */
const COLUMNS = process.stdout.columns ?? 80;
const ROWS = process.stdout.rows ?? 24;

const FILE_PATH = "/tmp/row-model-fidelity/example.unknown";

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

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

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
  await wait();
  instance.unmount();
  instance.cleanup();
  return measured.height;
}

interface Case {
  item: StaticItem;
  node: ReactNode;
  index?: number;
  diffs?: Map<string, AdvancedDiffSuccess>;
  expandedToolCallId?: string | null;
  lastShellToolCallId?: string | null;
  substitutions?: ApprovalSubstitutions;
  /** Display state the model must be handed to match the rendered node. */
  measure?: Partial<RowMeasureOptions>;
  /**
   * Exact row count the model must predict. The ±1 render tolerance alone hides
   * a one-row under-count, so the cases that pin a defect assert this too.
   * `undefined` where the expectation would depend on the ambient terminal width.
   */
  expectedRows?: number;
}

/** Asserts the rendered height is within one row of the model's prediction. */
async function expectPredictedHeight(testCase: Case): Promise<void> {
  const index = testCase.index ?? 1;
  const predicted = measureTranscriptItemRows(testCase.item, {
    columns: COLUMNS,
    index,
    terminalRows: ROWS,
    diffs: testCase.diffs,
    expandedToolCallId: testCase.expandedToolCallId,
    lastShellToolCallId: testCase.lastShellToolCallId,
    substitutions: testCase.substitutions,
    ...testCase.measure,
  });
  if (testCase.expectedRows !== undefined) {
    expect(
      predicted,
      `expected the model to predict ${testCase.expectedRows} rows, got ${predicted}`,
    ).toBe(testCase.expectedRows);
  }
  const actual = await measureHeight(testCase.node);
  const delta = actual - predicted;
  expect(
    delta >= -1 && delta <= 1,
    `predicted ${predicted} rows but Ink laid out ${actual}`,
  ).toBe(true);
}

/**
 * Whether the ambient terminal is wide enough for the width-sensitive
 * expectations below: the reminder and recall summary lines are ~45 and ~90
 * columns wide, and every other case's blocks are shorter.
 */
const WIDE = COLUMNS >= 60;

/** The production prompt prefix; the model's default matches it. */
const PROMPT = CLI_GLYPHS.prompt;

/** The node `ViewportTranscript` renders for a plain transcript line. */
function lineCase(
  item: StaticItem,
  measure: Partial<RowMeasureOptions> = {},
): Case {
  const index = 1;
  return {
    item,
    index,
    measure: { userPromptPrefix: `${PROMPT} `, ...measure },
    node: (
      <TranscriptItemView
        item={item}
        index={index}
        columns={COLUMNS}
        statusLinePrompt={PROMPT}
        showCompactionsEnabled={false}
        precomputedDiffs={new Map()}
      />
    ),
  };
}

/** A `<system-reminder>` block carrying `body`. */
const reminderBlock = (body: string): string =>
  `${SYSTEM_REMINDER_OPEN}\n${body}\n${SYSTEM_REMINDER_CLOSE}`;

/** A recall injection, which renders through its own display tier. */
const recallBlock = (body = "recalled passage"): string =>
  `${SYSTEM_REMINDER_OPEN}\n<${RECALL_MARKER_TAG} items="3" transcript="2" memory="1" />\n${body}\n${SYSTEM_REMINDER_CLOSE}`;

let nextId = 0;
function toolCall(
  fields: Partial<Extract<StaticItem, { kind: "tool_call" }>> & {
    name: string;
    toolCallId: string;
  },
): Extract<StaticItem, { kind: "tool_call" }> {
  nextId += 1;
  return {
    kind: "tool_call",
    id: `tc-${nextId}`,
    phase: "finished",
    resultOk: true,
    ...fields,
  };
}

/** The node `ViewportTranscript` renders for an ordinary tool call item. */
function toolCallNode(
  item: Extract<StaticItem, { kind: "tool_call" }>,
  index: number,
  diffs: Map<string, AdvancedDiffSuccess>,
  expandedToolCallId?: string | null,
  lastShellToolCallId?: string | null,
): ReactNode {
  return (
    <TranscriptItemView
      item={item}
      index={index}
      columns={COLUMNS}
      statusLinePrompt=">"
      showCompactionsEnabled={false}
      precomputedDiffs={diffs}
      hiddenToolCallId={expandedToolCallId ?? undefined}
      lastShellToolCallId={lastShellToolCallId ?? undefined}
    />
  );
}

/** A tool call measured and rendered as an ordinary tool call. */
function toolCallCase(
  item: Extract<StaticItem, { kind: "tool_call" }>,
  diffs: Map<string, AdvancedDiffSuccess> = new Map(),
  options: {
    expandedToolCallId?: string | null;
    lastShellToolCallId?: string | null;
  } = {},
): Case {
  const index = 1;
  return {
    item,
    index,
    diffs,
    ...options,
    node: toolCallNode(
      item,
      index,
      diffs,
      options.expandedToolCallId,
      options.lastShellToolCallId,
    ),
  };
}

/** The node `ViewportTranscript` renders for the current approval. */
function approvalCase(
  approval: ApprovalRequest,
  diffs: Map<string, AdvancedDiffSuccess>,
  options: {
    showPreview?: boolean;
    approveAlwaysText?: string;
    allowPersistence?: boolean;
  } = {},
): Case {
  const index = 1;
  const item = toolCall({
    name: approval.toolName,
    toolCallId: approval.toolCallId,
    argsText: approval.toolArgs,
    resultText: "…",
  });
  const substitutions: ApprovalSubstitutions = {
    currentApproval: approval,
    currentApprovalContext: options.approveAlwaysText
      ? {
          recommendedRule: "test",
          ruleDescription: "test",
          approveAlwaysText: options.approveAlwaysText,
          defaultScope: "project",
          allowPersistence: options.allowPersistence ?? true,
          safetyLevel: "moderate",
        }
      : undefined,
    showPreview: options.showPreview ?? true,
  };
  return {
    item,
    index,
    diffs,
    substitutions,
    node: (
      <Box flexDirection="column" marginTop={1}>
        <ApprovalSwitch
          approval={approval}
          onApprove={() => {}}
          onApproveAlways={() => {}}
          onDeny={() => {}}
          precomputedDiff={diffs.get(approval.toolCallId)}
          allDiffs={diffs}
          isFocused={true}
          approveAlwaysText={options.approveAlwaysText}
          allowPersistence={options.allowPersistence ?? true}
          defaultScope="project"
          showPreview={options.showPreview ?? true}
        />
      </Box>
    ),
  };
}

/** The node `ViewportTranscript` renders for a pending or queued approval. */
function stubCase(
  item: Extract<StaticItem, { kind: "tool_call" }>,
  substitutions: ApprovalSubstitutions,
): Case {
  const index = 1;
  const toolCallId = item.toolCallId ?? "";
  return {
    item,
    index,
    substitutions,
    node: (
      <Box flexDirection="column" marginTop={1}>
        <PendingApprovalStub
          toolName={
            substitutions.approvalMap?.get(toolCallId)?.toolName ??
            item.name ??
            "Unknown"
          }
          description={substitutions.stubDescriptions?.get(toolCallId)}
          decision={
            substitutions.queuedIds?.has(toolCallId)
              ? substitutions.queuedDecisions?.get(toolCallId)
              : undefined
          }
        />
      </Box>
    ),
  };
}

/** A write diff over `content`, built without touching the filesystem. */
function writeDiff(content: string, filePath: string): AdvancedDiffSuccess {
  const result = computeAdvancedDiff(
    { kind: "write", filePath, content },
    { oldStrOverride: "" },
  );
  if (result.mode !== "advanced") {
    throw new Error(`expected a previewable diff, got ${result.mode}`);
  }
  return result;
}

const EDIT_CONTENT = Array.from(
  { length: 14 },
  (_, i) => `export const value${i} = ${i};`,
).join("\n");

test("edit tool call with a precomputed diff", async () => {
  const item = toolCall({
    name: "Edit",
    toolCallId: "tc-edit",
    argsText: JSON.stringify({
      file_path: FILE_PATH,
      old_string: "old",
      new_string: "new",
    }),
    resultText: "The file has been updated.",
  });
  const diffs = new Map([
    [item.toolCallId as string, writeDiff(EDIT_CONTENT, FILE_PATH)],
  ]);
  await expectPredictedHeight(toolCallCase(item, diffs));
});

test("edit tool call on a syntax-highlighted path", async () => {
  const filePath = "/tmp/row-model-fidelity/example.ts";
  const item = toolCall({
    name: "Edit",
    toolCallId: "tc-edit-ts",
    argsText: JSON.stringify({
      file_path: filePath,
      old_string: "old",
      new_string: "new",
    }),
    resultText: "The file has been updated.",
  });
  const diffs = new Map([
    [item.toolCallId as string, writeDiff(EDIT_CONTENT, filePath)],
  ]);
  await expectPredictedHeight(toolCallCase(item, diffs));
});

test("write tool call with a precomputed diff", async () => {
  const item = toolCall({
    name: "write",
    toolCallId: "tc-write",
    argsText: JSON.stringify({ file_path: FILE_PATH, content: EDIT_CONTENT }),
    resultText: "File written.",
  });
  const diffs = new Map([
    [item.toolCallId as string, writeDiff(EDIT_CONTENT, FILE_PATH)],
  ]);
  await expectPredictedHeight(toolCallCase(item, diffs));
});

const PATCH_INPUT = [
  "*** Begin Patch",
  `*** Update File: ${FILE_PATH}`,
  "@@",
  " context line",
  "-removed line",
  "+added line",
  "*** Add File: /tmp/row-model-fidelity/added.unknown",
  "+a brand new file",
  "+with two lines",
  "*** Delete File: /tmp/row-model-fidelity/deleted.unknown",
  "*** End Patch",
].join("\n");

test("patch tool call without per-operation diffs", async () => {
  const item = toolCall({
    name: "ApplyPatch",
    toolCallId: "tc-patch",
    argsText: JSON.stringify({ input: PATCH_INPUT }),
    resultText: "Patch applied.",
  });
  await expectPredictedHeight(toolCallCase(item));
});

test("patch tool call with per-operation diffs", async () => {
  const toolCallId = "tc-patch-diffs";
  const item = toolCall({
    name: "ApplyPatch",
    toolCallId,
    argsText: JSON.stringify({ input: PATCH_INPUT }),
    resultText: "Patch applied.",
  });
  const diffs = new Map<string, AdvancedDiffSuccess>();
  for (const operation of parsePatchOperations(PATCH_INPUT)) {
    if (operation.kind === "delete") continue;
    const diff = parsePatchToAdvancedDiff(operation.patchLines, operation.path);
    if (diff) diffs.set(`${toolCallId}:${operation.path}`, diff);
  }
  expect(diffs.size).toBe(2);
  await expectPredictedHeight(toolCallCase(item, diffs));
});

test("bash tool call shows its collapsed output", async () => {
  const item = toolCall({
    name: "Bash",
    toolCallId: "tc-bash",
    argsText: JSON.stringify({ command: "printf 'a\\nb\\nc\\nd\\ne\\n'" }),
    resultText: "a\nb\nc\nd\ne",
  });
  await expectPredictedHeight(toolCallCase(item));
});

test("exec_command tool call shows its collapsed output", async () => {
  const item = toolCall({
    name: "exec_command",
    toolCallId: "tc-exec",
    argsText: JSON.stringify({
      cmd: "seq 1 8",
      description: "Count to eight",
    }),
    resultText: "1\n2\n3\n4\n5\n6\n7\n8",
  });
  await expectPredictedHeight(toolCallCase(item));
});

test("expanded bash output keeps the ctrl+o hints", async () => {
  const result = Array.from({ length: 12 }, (_, i) => `output line ${i}`).join(
    "\n",
  );
  const item = toolCall({
    name: "Bash",
    toolCallId: "tc-bash-expanded",
    argsText: JSON.stringify({ command: "cat big.txt" }),
    resultText: result,
  });
  await expectPredictedHeight(
    toolCallCase(item, new Map(), {
      expandedToolCallId: item.id,
      lastShellToolCallId: item.id,
    }),
  );
});

test("read tool call is a one-line summary", async () => {
  const item = toolCall({
    name: "read",
    toolCallId: "tc-read",
    argsText: JSON.stringify({ file_path: FILE_PATH, offset: 1, limit: 40 }),
    resultText: "one\ntwo\nthree",
  });
  await expectPredictedHeight(toolCallCase(item));
});

test("grep tool call is a one-line summary", async () => {
  const item = toolCall({
    name: "grep",
    toolCallId: "tc-grep",
    argsText: JSON.stringify({ pattern: "TODO", path: "src" }),
    resultText: "Found 3 files",
  });
  await expectPredictedHeight(toolCallCase(item));
});

test("todo_write result is measured as its checkbox list", async () => {
  const item = toolCall({
    name: "todo_write",
    toolCallId: "tc-todo",
    argsText: JSON.stringify({
      todos: [
        { id: "1", content: "first task", status: "completed" },
        { id: "2", content: "second task", status: "in_progress" },
        { id: "3", content: "third task", status: "pending" },
      ],
    }),
    resultText: "Todos updated",
  });
  await expectPredictedHeight(toolCallCase(item));
});

test("an approval_preview item is measured against ApprovalPreview", async () => {
  const item: StaticItem = {
    kind: "approval_preview",
    id: "preview-1",
    toolCallId: "tc-preview",
    toolName: "Edit",
    toolArgs: JSON.stringify({
      file_path: FILE_PATH,
      old_string: "old",
      new_string: "new",
    }),
    precomputedDiff: writeDiff(EDIT_CONTENT, FILE_PATH),
  };
  const index = 1;
  await expectPredictedHeight({
    item,
    index,
    node: (
      <TranscriptItemView
        item={item}
        index={index}
        columns={COLUMNS}
        statusLinePrompt=">"
        showCompactionsEnabled={false}
        precomputedDiffs={new Map()}
      />
    ),
  });
});

test("a generic approval matches its measured height", async () => {
  const approval: ApprovalRequest = {
    toolCallId: "ap-generic",
    toolName: "SomeTool",
    toolArgs: JSON.stringify({ key: "value", count: 3 }),
  };
  await expectPredictedHeight(approvalCase(approval, new Map()));
});

test("a file edit approval matches its measured height", async () => {
  const approval: ApprovalRequest = {
    toolCallId: "ap-edit",
    toolName: "Edit",
    toolArgs: JSON.stringify({
      file_path: FILE_PATH,
      old_string: "old",
      new_string: "new",
    }),
  };
  const diffs = new Map([
    [approval.toolCallId, writeDiff(EDIT_CONTENT, FILE_PATH)],
  ]);
  await expectPredictedHeight(approvalCase(approval, diffs));
});

test("a shell approval matches its measured height", async () => {
  const approval: ApprovalRequest = {
    toolCallId: "ap-bash",
    toolName: "Bash",
    toolArgs: JSON.stringify({
      command: "git status --short",
      description: "Show the working tree state",
    }),
  };
  await expectPredictedHeight(approvalCase(approval, new Map()));
});

test("a task approval matches its measured height", async () => {
  const approval: ApprovalRequest = {
    toolCallId: "ap-task",
    toolName: "Task",
    toolArgs: JSON.stringify({
      subagent_type: "general-purpose",
      description: "Audit the row model",
      prompt: "Read the row model and report how it measures a tool call.",
    }),
  };
  await expectPredictedHeight(
    approvalCase(approval, new Map(), { allowPersistence: false }),
  );
});

test("an approval with its preview committed measures the options only", async () => {
  const approval: ApprovalRequest = {
    toolCallId: "ap-committed",
    toolName: "Edit",
    toolArgs: JSON.stringify({
      file_path: FILE_PATH,
      old_string: "old",
      new_string: "new",
    }),
  };
  const diffs = new Map([
    [approval.toolCallId, writeDiff(EDIT_CONTENT, FILE_PATH)],
  ]);
  await expectPredictedHeight(
    approvalCase(approval, diffs, {
      showPreview: false,
      approveAlwaysText: "Yes, and don't ask again for this session",
    }),
  );
});

test("a running shell call measures its streaming window", async () => {
  const item = toolCall({
    name: "Bash",
    toolCallId: "tc-streaming",
    argsText: JSON.stringify({ command: "npm test" }),
    resultText: undefined,
    phase: "running",
    streaming: {
      tailLines: [
        { text: "line one", isStderr: false },
        { text: "line two", isStderr: false },
        { text: "line three", isStderr: true },
      ],
      partialLine: "",
      partialIsStderr: false,
      totalLineCount: 9,
      startTime: Date.now() - 5000,
    },
  });
  // Header, the first tail line, the other two, and the hidden-count row.
  await expectPredictedHeight(toolCallCase(item));
});

test("a running shell call with no output yet is one row", async () => {
  const item = toolCall({
    name: "Bash",
    toolCallId: "tc-streaming-empty",
    argsText: JSON.stringify({ command: "npm test" }),
    resultText: undefined,
    phase: "running",
    streaming: {
      tailLines: [],
      partialLine: "",
      partialIsStderr: false,
      totalLineCount: 0,
      startTime: Date.now(),
    },
  });
  await expectPredictedHeight(toolCallCase(item));
});

test("a pending approval stub matches its measured height", async () => {
  const toolCallId = "tc-pending";
  const item = toolCall({
    name: "Bash",
    toolCallId,
    argsText: JSON.stringify({ command: "ls" }),
    phase: "ready",
    resultText: undefined,
  });
  await expectPredictedHeight(
    stubCase(item, {
      approvalMap: new Map([
        [
          toolCallId,
          {
            toolCallId,
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "ls" }),
          },
        ],
      ]),
      pendingIds: new Set([toolCallId]),
      stubDescriptions: new Map([[toolCallId, "List the directory"]]),
    }),
  );
});

test("a queued approval stub matches its measured height", async () => {
  const toolCallId = "tc-queued";
  const item = toolCall({
    name: "write",
    toolCallId,
    argsText: JSON.stringify({ file_path: FILE_PATH, content: "x" }),
    phase: "ready",
    resultText: undefined,
  });
  await expectPredictedHeight(
    stubCase(item, {
      approvalMap: new Map([
        [
          toolCallId,
          {
            toolCallId,
            toolName: "write",
            toolArgs: JSON.stringify({ file_path: FILE_PATH, content: "x" }),
          },
        ],
      ]),
      queuedIds: new Set([toolCallId]),
      queuedDecisions: new Map([[toolCallId, { type: "deny" as const }]]),
    }),
  );
});

// ---------------------------------------------------------------------------
// Plain transcript lines. Every one of these renders `TranscriptItemView`, the
// same node the viewport draws, and is measured by the same `measureLineRows`
// branch the viewport uses.
// ---------------------------------------------------------------------------

test("a plain user message carries the highlight's blank rows (A1)", async () => {
  const item: StaticItem = {
    kind: "user",
    id: "user-plain",
    text: "hello world",
  };
  // Gap + blank row + text row + blank row.
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 3 });
});

test("a user message with a hidden reminder measures the same (A1)", async () => {
  const item: StaticItem = {
    kind: "user",
    id: "user-hidden",
    text: `hello\n${reminderBlock("note line")}`,
  };
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 3 });
});

test("user content on both sides of a reminder keeps both blocks (A1)", async () => {
  const item: StaticItem = {
    kind: "user",
    id: "user-split",
    text: `before\n${reminderBlock("note line")}\nafter`,
  };
  // Two highlighted blocks; the separator between them is an empty `<Text>`,
  // which Ink measures as zero rows.
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 3 + 3 });
});

test("a visible reminder block adds its summary row (A1, A2)", async () => {
  setSystemRemindersVisible(true);
  try {
    const item: StaticItem = {
      kind: "user",
      id: "user-reminder",
      text: `hello\n${reminderBlock("note line")}`,
    };
    // Gap + the highlighted block, then the one-line "▸ System reminder …" row
    // (45 columns, so one row on a normal terminal).
    await expectPredictedHeight({
      ...lineCase(item, { systemRemindersVisible: true }),
      expectedRows: WIDE ? 1 + 3 + 1 : undefined,
    });
  } finally {
    setSystemRemindersVisible(false);
  }
});

test("an expanded reminder block counts its own lines (A1, A2)", async () => {
  setSystemRemindersVisible(true);
  toggleSystemReminderDisplay();
  try {
    const item: StaticItem = {
      kind: "user",
      id: "user-reminder-expanded",
      text: `hello\n${reminderBlock("note line")}`,
    };
    // Collapsed header row plus the raw block's three lines.
    await expectPredictedHeight({
      ...lineCase(item, {
        systemRemindersVisible: true,
        systemRemindersExpanded: true,
      }),
      expectedRows: WIDE ? 1 + 3 + 1 + 3 : undefined,
    });
  } finally {
    // The setter clears the expansion with the visibility.
    setSystemRemindersVisible(false);
  }
});

test("a recall-only user row hidden by its tier renders nothing (A2)", async () => {
  setRecallDisplay("silent");
  try {
    const item: StaticItem = {
      kind: "user",
      id: "user-recall",
      text: recallBlock(),
    };
    // Only the item gap: the tier hides the block and there is no user text.
    await expectPredictedHeight({
      ...lineCase(item, { recallDisplay: "silent" }),
      expectedRows: 1,
    });
  } finally {
    setRecallDisplay("summary");
  }
});

test("a recall transcript row follows its display tier (A2)", async () => {
  const item: StaticItem = {
    kind: "recall",
    id: "recall-1",
    text: recallBlock(),
  };

  setRecallDisplay("silent");
  try {
    // Hidden by the tier: only the item gap is left.
    await expectPredictedHeight({
      ...lineCase(item, { recallDisplay: "silent" }),
      expectedRows: 1,
    });
  } finally {
    setRecallDisplay("summary");
  }

  setRecallDisplay("full");
  try {
    // The full tier renders the block itself: four lines, each one row.
    await expectPredictedHeight({
      ...lineCase(item, { recallDisplay: "full" }),
      expectedRows: 1 + 4,
    });
  } finally {
    setRecallDisplay("summary");
  }
});

test("a status message wraps each line in its gutter box (A6)", async () => {
  const item: StaticItem = {
    kind: "status",
    id: "status-long",
    lines: ["alpha", "x".repeat(COLUMNS)],
  };
  // Gap + the short line + two rows for the long one (`columns - 2` box).
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 1 + 2 });
});

test("an error exactly one column too wide wraps (A4)", async () => {
  const item: StaticItem = {
    kind: "error",
    id: "error-wide",
    text: "x".repeat(COLUMNS),
  };
  // Gap + two rows in the `columns - 2` content box. Measuring at the full
  // terminal width predicted one.
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 2 });
});

test("a command line measures its input and markdown output boxes (A5)", async () => {
  const item: StaticItem = {
    kind: "command",
    id: "command-1",
    input: "ls -la",
    output: "a\nb",
    phase: "finished",
  };
  // Gap + input row + the two-line markdown output row.
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 1 + 2 });
});

test("a finished bash command counts every output line (A5)", async () => {
  const item: StaticItem = {
    kind: "bash_command",
    id: "bash-1",
    input: "cat f",
    output: "a\nb\nc",
    phase: "finished",
  };
  // Gap + input row + three output lines (never collapsed in bash mode).
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 1 + 3 });
});

test("a running bash command measures its streaming window (A5)", async () => {
  const item: StaticItem = {
    kind: "bash_command",
    id: "bash-streaming",
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
      totalLineCount: 3,
      startTime: Date.now(),
    },
  };
  // Gap + input row + first tail line + second + the hidden-count row. The model
  // ignored `line.streaming` entirely before this fix, predicting one row for
  // the whole body.
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 1 + 3 });
});

test("a Ctrl+T expanded reasoning row measures its body (A2)", async () => {
  setThinkingExpanded(true);
  try {
    const body = Array.from(
      { length: 12 },
      (_, index) => `thought line ${index}`,
    ).join("\n");
    const item: StaticItem = {
      kind: "reasoning",
      id: "reason-expanded",
      phase: "finished",
      text: body,
    };
    // Gap + header + the one-row spacer + twelve body rows. Predicting the
    // collapsed header here is the defect Ctrl+T exposed.
    await expectPredictedHeight({
      ...lineCase(item, { reasoningExpanded: true }),
      expectedRows: 1 + 2 + 12,
    });
  } finally {
    setThinkingExpanded(false);
  }
});

test("an assistant markdown table is measured as a grid (A3)", async () => {
  const item: StaticItem = {
    kind: "assistant",
    id: "assistant-table",
    phase: "finished",
    text: "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
  };
  // Gap + header row + `━` rule + two records with a `─` rule between them.
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 5 });
});

test("a CJK diff row counts its wrapped display columns (A7)", async () => {
  // Wide characters cross the row boundary, and the highlighted (`.ts`) path
  // splits the same text into more chunks than the model sees: after the
  // `paddedRows` fix a chunk boundary cannot change the row count.
  const filePath = "/tmp/row-model-fidelity/cjk.ts";
  const content = Array.from(
    { length: 3 },
    (_, index) => `${"字".repeat(40)} line ${index}`,
  ).join("\n");
  const item = toolCall({
    name: "Edit",
    toolCallId: "tc-cjk",
    argsText: JSON.stringify({
      file_path: filePath,
      old_string: "old",
      new_string: "new",
    }),
    resultText: "The file has been updated.",
  });
  const diffs = new Map([
    [item.toolCallId as string, writeDiff(content, filePath)],
  ]);
  await expectPredictedHeight(toolCallCase(item, diffs));
});

test("a separator item carries its own margin (A9)", async () => {
  const item: StaticItem = { kind: "separator", id: "sep-1" };
  // Gap + the separator's own one-row box + the full-width rule.
  await expectPredictedHeight({ ...lineCase(item), expectedRows: 1 + 2 });
});

test("a shell command continuation line wraps inside its box (A8)", async () => {
  // A second command line of wide characters, clipped to `columns - 5` code
  // units and then wrapped inside a `columns - 5` box.
  const continuation = "字".repeat(2 * Math.max(1, COLUMNS - 5));
  const item = toolCall({
    name: "Bash",
    toolCallId: "tc-continuation",
    phase: "running",
    argsText: JSON.stringify({ command: `echo hi\n${continuation}` }),
  });
  await expectPredictedHeight(toolCallCase(item));
});
