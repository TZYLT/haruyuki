import { afterEach, describe, expect, test } from "bun:test";
import type { FileEditApprovalInfo } from "@/cli/helpers/approval-info";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { InlineFileEditApproval } from "./InlineFileEditApproval";

/**
 * The live file-edit approval, judged on the frame.
 *
 * Its preview body is `FileEditPreview`, shared with the committed preview the
 * transcript paints, so what this pins is the live half of that contract: the
 * advanced diff header suppressed, the options under it, and the preview going
 * away (and taking its margin with it) once the preview has been committed.
 */

const COLUMNS = 60;
const RULE = "─".repeat(COLUMNS);
const DOTTED = "╌".repeat(COLUMNS);

const WRITE: FileEditApprovalInfo = {
  toolName: "Write",
  filePath: "a.ts",
  content: "one\ntwo",
};

async function frame(
  fileEdit: FileEditApprovalInfo,
  options: { showPreview?: boolean } = {},
): Promise<string[]> {
  const shell = mountInkTty(
    <InlineFileEditApproval
      fileEdit={fileEdit}
      onApprove={() => {}}
      onApproveAlways={() => {}}
      onDeny={() => {}}
      isFocused={false}
      showPreview={options.showPreview ?? true}
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

describe("InlineFileEditApproval", () => {
  test("paints the shared body above the options", async () => {
    expect(await frame(WRITE)).toEqual([
      RULE,
      "Write to a.ts?",
      DOTTED,
      "1 + one",
      "2 + two",
      DOTTED,
      "",
      "> 1. Yes",
      "  2. Yes, and don't ask again for this project",
      "  3. No, and tell Haruyuki what to do differently",
      "",
      "Enter to select · Esc to cancel",
    ]);
  });

  test("hides only the preview once it is committed elsewhere", async () => {
    expect(await frame(WRITE, { showPreview: false })).toEqual([
      "> 1. Yes",
      "  2. Yes, and don't ask again for this project",
      "  3. No, and tell Haruyuki what to do differently",
      "",
      "Enter to select · Esc to cancel",
    ]);
  });
});
