import { describe, expect, test } from "bun:test";
import {
  isTallPreviewTool,
  resolveApprovalPreviewBody,
} from "@/cli/overlay/preview";

describe("resolveApprovalPreviewBody", () => {
  test("a shell tool classifies as a command body", () => {
    const body = resolveApprovalPreviewBody({
      toolName: "Bash",
      toolArgs: JSON.stringify({ command: "ls -la", description: "list" }),
      toolCallId: "call-1",
    });

    expect(body.kind).toBe("command");
    if (body.kind !== "command") throw new Error("expected command");
    expect(body.info.command).toBe("ls -la");
    expect(body.info.description).toBe("list");
  });

  test("a shell tool whose args do not parse falls through to the args body", () => {
    // Not a command body with an empty command: `parseBashApprovalArgs` returns
    // null on unparsable JSON, and the renderer draws the generic body.
    expect(
      resolveApprovalPreviewBody({ toolName: "Bash", toolArgs: "{" }).kind,
    ).toBe("args");
  });

  test("a write tool classifies as a diff body with no patch operations", () => {
    const body = resolveApprovalPreviewBody({
      toolName: "Write",
      toolArgs: JSON.stringify({ file_path: "a/b.ts", content: "hi" }),
      toolCallId: "call-2",
    });

    expect(body.kind).toBe("diff");
    if (body.kind !== "diff") throw new Error("expected diff");
    expect(body.info.filePath).toBe("a/b.ts");
    expect(body.info.content).toBe("hi");
    expect(body.operations).toEqual([]);
  });

  test("a patch tool classifies as a diff body carrying its operations", () => {
    const body = resolveApprovalPreviewBody({
      toolName: "ApplyPatch",
      toolArgs: JSON.stringify({
        input: [
          "*** Begin Patch",
          "*** Add File: new.ts",
          "+hello",
          "*** End Patch",
        ].join("\n"),
      }),
      toolCallId: "call-3",
    });

    expect(body.kind).toBe("diff");
    if (body.kind !== "diff") throw new Error("expected diff");
    expect(body.info.patchInput).toContain("*** Begin Patch");
    expect(body.operations.map((operation) => operation.path)).toEqual([
      "new.ts",
    ]);
  });

  test("the legacy file-edit names classify as diffs, not args", () => {
    // `isFileEditPreviewTool` is deliberately wider than `isFileEditTool` so a
    // saved transcript keeps its preview; this is the list that widens it.
    for (const toolName of [
      "Edit",
      "Write",
      "str_replace_editor",
      "str_replace_based_edit_tool",
      "ApplyPatch",
    ]) {
      expect(
        resolveApprovalPreviewBody({ toolName, toolArgs: "{}" }).kind,
      ).toBe("diff");
    }
  });

  test("the lowercase live-edit names are not committed-preview edits", () => {
    // The narrow list is what `ApprovalPreview` grew up with: an eager commit is
    // never attempted for these, so the classification must agree with the gate.
    for (const toolName of ["edit", "write", "multi_edit", "MultiEdit"]) {
      expect(
        resolveApprovalPreviewBody({ toolName, toolArgs: "{}" }).kind,
      ).toBe("args");
      expect(isTallPreviewTool(toolName)).toBe(false);
    }
  });

  test("an unknown tool falls back to the generic body, carrying nothing", () => {
    // The body says "nothing tool-specific here" and stops: both consumers then
    // draw the args from the props they already hold, so the tool name this used
    // to travel in was never read. Asserting the exact shape is what keeps a
    // payload from being reintroduced for nobody.
    const body = resolveApprovalPreviewBody({
      toolName: "Read",
      toolArgs: JSON.stringify({ file_path: "a.ts" }),
    });

    expect(body).toEqual({ kind: "args" });
  });

  test("the tool call id travels into the parsed info", () => {
    // The renderer and the row model look diffs up by `id:path`, so the parse
    // that feeds both has to keep the id.
    const body = resolveApprovalPreviewBody({
      toolName: "ApplyPatch",
      toolArgs: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
      toolCallId: "call-9",
    });

    expect(body.kind).toBe("diff");
    if (body.kind !== "diff") throw new Error("expected diff");
    expect(body.info.toolCallId).toBe("call-9");
  });
});

describe("isTallPreviewTool", () => {
  test("the tall families qualify and everything else does not", () => {
    for (const toolName of [
      "Bash",
      "bash",
      "exec_command",
      "write_stdin",
      "shell_command",
      "Shell",
      "Edit",
      "Write",
      "ApplyPatch",
      "str_replace_editor",
    ]) {
      expect(isTallPreviewTool(toolName)).toBe(true);
    }

    for (const toolName of [
      "Read",
      "Task",
      "Glob",
      "edit",
      "write",
      "AskUserQuestion",
    ]) {
      expect(isTallPreviewTool(toolName)).toBe(false);
    }
  });
});
