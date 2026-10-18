/**
 * Approval request parsing, shared by `ApprovalSwitch` and the transcript row
 * model.
 *
 * `ApprovalSwitch` picks one of four inline approval UIs from the tool name and
 * parses the tool args for the chosen one. The full-screen shell renders exactly
 * the same approval for the current request (and compact stubs for the rest), so
 * it needs the same decision *and* the same parsed fields to predict the row
 * count. Both read this module; a second copy of the dispatch would let the
 * viewport window disagree with the approval that is actually on screen.
 */

import { simpleDiffDisplayPath } from "@/cli/helpers/diff-rows";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping.js";

export interface BashApprovalInfo {
  toolName: string;
  command: string;
  description?: string;
}

export interface FileEditApprovalInfo {
  toolName: string;
  filePath: string;
  content?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  patchInput?: string;
  toolCallId?: string;
}

export interface TaskApprovalInfo {
  subagentType: string;
  description: string;
  prompt: string;
  model?: string;
  isBackground?: boolean;
}

/** Which inline approval UI a request maps to. */
export type ApprovalKind = "fileEdit" | "shell" | "task" | "generic";

/** Tool name, file path and (for patch tools) the patch body of an edit. */
export interface FileEditApprovalHeaderInput {
  toolName: string;
  filePath: string;
  patchInput?: string;
}

/**
 * Human-readable header for a file edit/write/patch approval ("Overwrite x?",
 * "Apply patch to 3 files?", …).
 *
 * Existence is injected rather than probed here: the write case distinguishes
 * "Overwrite" from "Write to" with a filesystem check, and the transcript row
 * model measures this header without touching the filesystem. The renderers pass
 * their own `existsSync`; the row model passes both answers and keeps the taller
 * header, so the measured height never lands under the rendered one.
 */
export function fileEditApprovalHeaderText(
  input: FileEditApprovalHeaderInput,
  fileExists: (filePath: string) => boolean,
): string {
  const toolName = input.toolName.toLowerCase();

  if (toolName === "applypatch") {
    if (input.patchInput) {
      const operations = parsePatchOperations(input.patchInput);
      if (operations.length > 1) {
        return `Apply patch to ${operations.length} files?`;
      }
      const operation = operations[0];
      if (operation) {
        const displayPath = simpleDiffDisplayPath(operation.path);
        if (operation.kind === "add") return `Write to ${displayPath}?`;
        if (operation.kind === "update") return `Update ${displayPath}?`;
        return `Delete ${displayPath}?`;
      }
    }
    return "Apply patch?";
  }

  const displayPath = simpleDiffDisplayPath(input.filePath);
  if (toolName === "write") {
    return fileExists(input.filePath)
      ? `Overwrite ${displayPath}?`
      : `Write to ${displayPath}?`;
  }
  if (
    toolName === "edit" ||
    toolName === "str_replace_editor" ||
    toolName === "str_replace_based_edit_tool"
  ) {
    return `Update ${displayPath}?`;
  }
  return `Edit ${displayPath}?`;
}

export function isCommandMonitorApproval(approval: ApprovalRequest): boolean {
  if (approval.toolName !== "Monitor") return false;
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    return typeof args.command === "string";
  } catch {
    return false;
  }
}

/**
 * The UI family for a request **and** the parsed fields for it.
 *
 * This is the single dispatch: `ApprovalSwitch` renders by it and the transcript
 * row model measures by it. A second copy of the order (or of the per-family
 * predicates) would let the viewport window disagree with the approval that is
 * actually on screen, which is invisible until the two drift and a row is clipped.
 */
export type ResolvedApproval =
  | { kind: "fileEdit"; fileEdit: FileEditApprovalInfo }
  | { kind: "shell"; bash: BashApprovalInfo }
  | { kind: "task"; task: TaskApprovalInfo }
  | { kind: "generic" };

export function resolveApproval(approval: ApprovalRequest): ResolvedApproval {
  const toolName = approval.toolName;
  if (
    isFileEditTool(toolName) ||
    isFileWriteTool(toolName) ||
    isPatchTool(toolName)
  ) {
    const fileEdit = getFileEditApprovalInfo(approval);
    if (fileEdit) return { kind: "fileEdit", fileEdit };
  }
  if (isShellTool(toolName) || isCommandMonitorApproval(approval)) {
    const bash = getBashApprovalInfo(approval);
    if (bash) return { kind: "shell", bash };
  }
  if (isTaskTool(toolName)) {
    const task = getTaskApprovalInfo(approval);
    if (task) return { kind: "task", task };
  }
  return { kind: "generic" };
}

/** Just the family, for callers that measure options and hints by kind. */
export function resolveApprovalKind(approval: ApprovalRequest): ApprovalKind {
  return resolveApproval(approval).kind;
}

/**
 * Parse bash info from the raw tool name and args.
 *
 * Split out for `ApprovalPreview`, which has the tool name and args but no
 * `ApprovalRequest`. The two used to parse separately and disagreed on the
 * missing-command placeholder — the preview rendered an empty command where the
 * inline approval renders `(no command)` — so the preview and the approval it
 * stands in for could differ in the very case the row model measures.
 */
export function parseBashApprovalArgs(
  toolName: string,
  toolArgs: string,
): BashApprovalInfo | null {
  try {
    const args = JSON.parse(toolArgs || "{}");
    const t = toolName.toLowerCase();

    let command = "";
    let description = "";

    if (t === "exec_command") {
      command = typeof args.cmd === "string" ? args.cmd : "(no command)";
      description =
        typeof args.description === "string" ? args.description : "";
    } else if (t === "write_stdin") {
      const sessionId =
        typeof args.session_id === "string" ||
        typeof args.session_id === "number"
          ? String(args.session_id)
          : "unknown";
      command = `write_stdin ${sessionId}`;
      description =
        typeof args.chars === "string" && args.chars.length > 0
          ? "Write input to running shell session"
          : "Poll running shell session";
    } else {
      // Bash uses command string and description
      command =
        typeof args.command === "string" ? args.command : "(no command)";
      description =
        typeof args.description === "string" ? args.description : "";
    }

    return { toolName, command, description };
  } catch {
    return null;
  }
}

/** Parse bash info from an approval request. */
export function getBashApprovalInfo(approval: {
  toolName: string;
  toolArgs: string;
}): BashApprovalInfo | null {
  return parseBashApprovalArgs(approval.toolName, approval.toolArgs);
}

/**
 * Parse file edit info from approval args.
 *
 * Takes the three fields it reads rather than an `ApprovalRequest`: the
 * committed-preview classification (`@/cli/overlay/preview`) has a tool name,
 * args and a *possibly absent* tool call id (a static item may carry none), and
 * narrowing here is what lets it call this instead of parsing the args a second
 * time.
 */
export function getFileEditApprovalInfo(approval: {
  toolName: string;
  toolArgs: string;
  toolCallId?: string;
}): FileEditApprovalInfo | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");

    // For patch tools, use the input field
    if (isPatchTool(approval.toolName)) {
      return {
        toolName: approval.toolName,
        filePath: "", // Patch can have multiple files
        patchInput: args.input as string | undefined,
        toolCallId: approval.toolCallId,
      };
    }

    // For regular file edit/write tools
    return {
      toolName: approval.toolName,
      filePath: String(args.file_path || ""),
      content: args.content as string | undefined,
      oldString: args.old_string as string | undefined,
      newString: args.new_string as string | undefined,
      replaceAll: args.replace_all as boolean | undefined,
      toolCallId: approval.toolCallId,
    };
  } catch {
    return null;
  }
}

/** Parse task info from approval args. */
export function getTaskApprovalInfo(
  approval: ApprovalRequest,
): TaskApprovalInfo | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    return {
      subagentType:
        typeof args.subagent_type === "string" ? args.subagent_type : "unknown",
      description:
        typeof args.description === "string"
          ? args.description
          : "(no description)",
      prompt: typeof args.prompt === "string" ? args.prompt : "(no prompt)",
      model: typeof args.model === "string" ? args.model : undefined,
      isBackground: true,
    };
  } catch {
    return {
      subagentType: "unknown",
      description: "(parse error)",
      prompt: "(parse error)",
    };
  }
}
