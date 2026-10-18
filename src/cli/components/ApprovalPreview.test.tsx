import { afterEach, describe, expect, test } from "bun:test";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { ApprovalPreview } from "./ApprovalPreview";

/**
 * The committed approval preview, judged on the frame.
 *
 * The renderer and the transcript row model both draw and measure from
 * `@/cli/overlay/preview`'s classification now, so what these pin is that the
 * renderer still paints the body that classification names -- including the
 * three-row generic body, whose height the viewport walk depends on. The
 * rewrite was proved parity-first against the previous renderer over a wider
 * matrix (unparsable args, an empty patch input, the legacy `str_replace_*`
 * names, a lowercase `write`); these are the frames that stay.
 *
 * The file-edit bodies are the exception: they are no longer this file's, they
 * are `FileEditPreview`'s, shared with the live approval that answers the same
 * request. The frames below are the committed form of that one body (it draws
 * the advanced diff header; the inline surface suppresses it), and
 * `previews/FileEditPreview.test.tsx` holds the body's own cases.
 */

const COLUMNS = 60;
const RULE = "─".repeat(COLUMNS);
const DOTTED = "╌".repeat(COLUMNS);

const PATCH = [
  "*** Begin Patch",
  "*** Add File: added.ts",
  "+hello",
  "*** Update File: changed.ts",
  "@@",
  "-old",
  "+new",
  "*** Delete File: gone.ts",
  "*** End Patch",
].join("\n");

async function frame(toolName: string, toolArgs: string): Promise<string[]> {
  const shell = mountInkTty(
    <ApprovalPreview
      toolName={toolName}
      toolArgs={toolArgs}
      toolCallId="call-1"
    />,
    { columns: COLUMNS, rows: 40 },
  );
  try {
    return await shell.rows();
  } finally {
    shell.stop();
  }
}

afterEach(resetInkTtyState);

describe("ApprovalPreview", () => {
  test("a shell command delegates to the bash preview", async () => {
    expect(
      await frame(
        "Bash",
        JSON.stringify({ command: "ls -la", description: "list" }),
      ),
    ).toEqual([RULE, "Run this command?", "", "  $ ls -la", "  list"]);
  });

  test("a shell tool whose args do not parse draws the generic body", async () => {
    // Three rows, not a command block with an empty command: the classification
    // falls through exactly where the row model expects the fallback.
    expect(await frame("exec_command", "{")).toEqual([
      RULE,
      "exec_command requires approval",
      DOTTED,
    ]);
  });

  test("a write draws its diff under the header", async () => {
    expect(
      await frame(
        "Write",
        JSON.stringify({ file_path: "a.ts", content: "one\ntwo" }),
      ),
    ).toEqual([
      RULE,
      "Write to a.ts?",
      DOTTED,
      "  └ Wrote changes to ./a.ts",
      "    Showing ~1 context line",
      "    1 + one",
      "    2 + two",
      DOTTED,
    ]);
  });

  test("a patch draws one block per operation, deletes included", async () => {
    // Every block after the first opens with the blank row the row model counts,
    // the delete included: `Delete gone.ts` used to sit in a row-direction box,
    // where its separator collapsed to zero rows and the block was one row short
    // of what `approvalPreviewItemRows` measures.
    expect(await frame("ApplyPatch", JSON.stringify({ input: PATCH }))).toEqual(
      [
        RULE,
        "Apply patch to 3 files?",
        DOTTED,
        "added.ts",
        "1 + hello",
        "",
        "changed.ts",
        "  └ Updated changed.ts with 1 addition and 1 removal",
        "    1 -  old",
        "    1 +  new",
        "",
        "gone.ts",
        "File will be deleted",
        DOTTED,
      ],
    );
  });

  test("a lowercase write is not a preview edit", async () => {
    // `isFileEditPreviewTool` is deliberately narrow about case; the eager
    // commit gate reads the same list, so this tool is never committed early
    // and its committed body stays the generic one.
    expect(
      await frame(
        "write",
        JSON.stringify({ file_path: "a.ts", content: "hi" }),
      ),
    ).toEqual([RULE, "write requires approval", DOTTED]);
  });
});
