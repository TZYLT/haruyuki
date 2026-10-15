/**
 * The eager approval-preview decision.
 *
 * An approval preview is committed to static early when it is tall enough that
 * the live area cannot hold it; only the options stay live. That decision used to
 * carry its own estimate of the preview layout, which drifted from the renderer
 * (it split lines by UTF-16 length rather than display width). It now goes through
 * the same row model the viewport uses, and these tests pin the two things the
 * decision still owns: which approvals qualify at all, and which diff source each
 * of them is measured from.
 */

import { describe, expect, test } from "bun:test";
import {
  buildApprovalPreviewItem,
  eagerCommitPreviewRows,
} from "@/cli/app/approval-rows";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { computeAdvancedDiff } from "@/cli/helpers/diff";
import type { ApprovalRequest } from "@/cli/helpers/stream";

const COLUMNS = 100;
const TERMINAL_ROWS = 30;
const OPTIONS = {
  columns: COLUMNS,
  terminalRows: TERMINAL_ROWS,
  diffs: new Map<string, AdvancedDiffSuccess>(),
};

function approval(
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolCallId = "tc-1",
): ApprovalRequest {
  return { toolCallId, toolName, toolArgs: JSON.stringify(toolArgs) };
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

const FILE_CONTENT = Array.from(
  { length: 20 },
  (_, index) => `export const value${index} = ${index};`,
).join("\n");

describe("eagerCommitPreviewRows", () => {
  test("a tall shell command qualifies and grows with the command", () => {
    const short = eagerCommitPreviewRows(
      approval("Bash", { command: "ls -la" }),
      OPTIONS,
    );
    const tall = eagerCommitPreviewRows(
      approval("Bash", { command: `${"# comment\n".repeat(9)}ls -la` }),
      OPTIONS,
    );

    expect(short).toBeGreaterThan(0);
    expect(tall).toBeGreaterThanOrEqual(short);
  });

  test("a tool the preview never renders tall does not qualify", () => {
    // The generic preview is a fixed three rows, so committing it early would add
    // static churn without removing a flicker source.
    expect(
      eagerCommitPreviewRows(
        approval("WebSearch", { query: "x".repeat(400) }),
        {
          ...OPTIONS,
        },
      ),
    ).toBe(0);
  });

  test("an approval without an id does not qualify", () => {
    expect(
      eagerCommitPreviewRows(
        { toolCallId: "", toolName: "Bash", toolArgs: "{}" },
        OPTIONS,
      ),
    ).toBe(0);
  });

  test("an edit with a precomputed diff is measured from the item's diff", () => {
    const request = approval("Edit", {
      file_path: "/tmp/a.ts",
      old_string: "old",
      new_string: "new",
    });
    const diffs = new Map([
      [request.toolCallId, writeDiff(FILE_CONTENT, "/tmp/a.ts")],
    ]);

    const withDiff = eagerCommitPreviewRows(request, { ...OPTIONS, diffs });
    const withoutDiff = eagerCommitPreviewRows(request, {
      ...OPTIONS,
      diffs: new Map(),
    });

    // 20 replaced lines cannot be measured as the one-line `old`/`new` fallback:
    // the diff the renderer will draw has to drive the estimate, or a tall edit
    // would never be committed early.
    expect(withoutDiff).toBeLessThan(TERMINAL_ROWS);
    expect(withDiff).toBeGreaterThan(withoutDiff);
  });

  test("a patch is measured from the per-operation diff keys", () => {
    const request = approval("ApplyPatch", {
      input: `*** Begin Patch\n*** Update File: /tmp/a.ts\n@@\n-old\n+new\n*** End Patch\n`,
    });

    const plainKey = eagerCommitPreviewRows(request, {
      ...OPTIONS,
      diffs: new Map([
        [request.toolCallId, writeDiff(FILE_CONTENT, "/tmp/a.ts")],
      ]),
    });
    // A patch preview reads the compound `id:path` key, exactly like
    // `ApprovalPreview` does, so the whole-file diff under the plain id must not
    // reach it.
    const compoundKey = eagerCommitPreviewRows(request, {
      ...OPTIONS,
      diffs: new Map([
        [
          `${request.toolCallId}:/tmp/a.ts`,
          writeDiff(FILE_CONTENT, "/tmp/a.ts"),
        ],
      ]),
    });

    expect(plainKey).toBeGreaterThan(0);
    expect(compoundKey).toBeGreaterThan(plainKey);
  });
});

describe("buildApprovalPreviewItem", () => {
  test("attaches the precomputed diff for the single-file tools only", () => {
    const request = approval("Edit", { file_path: "/tmp/a.ts" });
    const diff = writeDiff(FILE_CONTENT, "/tmp/a.ts");
    const diffs = new Map([[request.toolCallId, diff]]);

    const edit = buildApprovalPreviewItem(request, diffs);
    expect(edit.precomputedDiff).toBe(diff);
    expect(edit.id).toBe(`approval-preview-${request.toolCallId}`);
    expect(edit.toolArgs).toBe(request.toolArgs);

    // A patch preview parses its own operations and reads `allDiffs` instead, so
    // attaching the whole-file diff would render the wrong body.
    const patch = buildApprovalPreviewItem(
      approval("ApplyPatch", { input: "*** Begin Patch\n*** End Patch\n" }),
      diffs,
    );
    expect(patch.precomputedDiff).toBeUndefined();
  });

  test("defaults empty tool args", () => {
    expect(
      buildApprovalPreviewItem(
        { toolCallId: "tc-2", toolName: "Bash", toolArgs: "" },
        new Map(),
      ).toolArgs,
    ).toBe("{}");
  });
});
