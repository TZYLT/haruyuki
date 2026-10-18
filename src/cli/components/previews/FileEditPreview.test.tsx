import { afterEach, describe, expect, test } from "bun:test";
import type { FileEditApprovalInfo } from "@/cli/helpers/approval-info";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { FileEditPreview } from "./FileEditPreview";

/**
 * The one file-edit approval body, judged on the frame.
 *
 * Both surfaces paint this component -- `ApprovalPreview` in the transcript once
 * the preview is committed to `<Static>`, `InlineFileEditApproval` in the live
 * area while it is being answered -- so these cases are the parity contract they
 * used to hold by hand. The frames were the two components' own before the merge
 * and are unchanged by it apart from the patch delete block, which the committed
 * side drew one row short and with the other side's text.
 */

const COLUMNS = 60;
const RULE = "─".repeat(COLUMNS);
const DOTTED = "╌".repeat(COLUMNS);

const PATCH = [
  "*** Begin Patch",
  "*** Update File: changed.ts",
  "@@",
  "-old",
  "+new",
  "*** Delete File: gone.ts",
  "*** End Patch",
].join("\n");

const WRITE: FileEditApprovalInfo = {
  toolName: "Write",
  filePath: "a.ts",
  content: "one\ntwo",
};

async function frame(
  info: FileEditApprovalInfo,
  options: { headerText?: string; showDiffHeader: boolean },
): Promise<string[]> {
  const shell = mountInkTty(
    <FileEditPreview
      info={info}
      headerText={options.headerText ?? "Write to a.ts?"}
      showDiffHeader={options.showDiffHeader}
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

describe("FileEditPreview", () => {
  test("the committed form shows the advanced diff header", async () => {
    expect(await frame(WRITE, { showDiffHeader: true })).toEqual([
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

  test("the inline form suppresses it and keeps the body", async () => {
    // The rows lose the header's four-column gutter with it: this is the frame the
    // live approval has always drawn.
    expect(await frame(WRITE, { showDiffHeader: false })).toEqual([
      RULE,
      "Write to a.ts?",
      DOTTED,
      "1 + one",
      "2 + two",
      DOTTED,
    ]);
  });

  test("the switch reaches the advanced renderer only", async () => {
    // An edit whose file is not there falls back to `EditRenderer`, which prints
    // its own summary row whatever the switch says: the committed preview and the
    // inline approval draw the same thing here, and always did.
    const edit: FileEditApprovalInfo = {
      toolName: "Edit",
      filePath: "a.ts",
      oldString: "old",
      newString: "new",
    };
    const expected = [
      RULE,
      "Update a.ts?",
      DOTTED,
      "  └ Updated a.ts with 1 addition and 1 removal",
      "    1 -  old",
      "    1 +  new",
      DOTTED,
    ];
    expect(
      await frame(edit, { headerText: "Update a.ts?", showDiffHeader: true }),
    ).toEqual(expected);
    expect(
      await frame(edit, { headerText: "Update a.ts?", showDiffHeader: false }),
    ).toEqual(expected);
  });

  test("the tool name picks the body, not the argument that is present", async () => {
    // A legacy `str_replace_editor` carrying neither string used to draw an empty
    // body on the committed side while the row model measured an edit renderer.
    const edit = await frame(
      { toolName: "str_replace_editor", filePath: "a.ts" },
      { headerText: "Edit a.ts?", showDiffHeader: false },
    );
    expect(edit.slice(0, 3)).toEqual([RULE, "Edit a.ts?", DOTTED]);
    expect(edit.at(-1)).toBe(DOTTED);
    expect(edit.length).toBeGreaterThan(4);
  });

  test("a patch keeps its blank separators, the delete block included", async () => {
    const patch: FileEditApprovalInfo = {
      toolName: "ApplyPatch",
      filePath: "",
      patchInput: PATCH,
      toolCallId: "call-1",
    };
    const expected = [
      RULE,
      "Apply patch to 2 files?",
      DOTTED,
      "changed.ts",
      "  └ Updated changed.ts with 1 addition and 1 removal",
      "    1 -  old",
      "    1 +  new",
      "",
      "gone.ts",
      "File will be deleted",
      DOTTED,
    ];
    expect(
      await frame(patch, {
        headerText: "Apply patch to 2 files?",
        showDiffHeader: true,
      }),
    ).toEqual(expected);
    // Patch operations label their own path, so the one difference between the
    // two surfaces does not reach them.
    expect(
      await frame(patch, {
        headerText: "Apply patch to 2 files?",
        showDiffHeader: false,
      }),
    ).toEqual(expected);
  });
});
