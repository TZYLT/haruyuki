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
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
  parsePatchToAdvancedDiff,
} from "@/cli/helpers/diff";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ApprovalSubstitutions } from "./approval-rows";
import { measureTranscriptItemRows } from "./row-model";
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
  });
  const actual = await measureHeight(testCase.node);
  const delta = actual - predicted;
  expect(
    delta >= -1 && delta <= 1,
    `predicted ${predicted} rows but Ink laid out ${actual}`,
  ).toBe(true);
}

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
