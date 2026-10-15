/**
 * Tool-call display resolution, shared by the transcript renderer and the row
 * model.
 *
 * The tool call header decides *what* it shows (display name, the args summary,
 * or the syntax-highlighted shell command) through a chain of remappings: patch
 * kind, question state, shell semantics, then truncation to the available width.
 * The full-screen shell has to know how wide that header ends up without
 * rendering it, so the decision chain lives here and both consumers read it.
 *
 * This module stays free of syntax highlighting (that is the renderer's job) and
 * performs no I/O: `formatArgsDisplay` only parses JSON and formats paths.
 */

import { parseAskUserQuestionReceipt } from "@/ask-user-question";
import {
  formatArgsDisplay,
  parsePatchInput,
} from "@/cli/helpers/format-args-display";
import type { ShellSemanticDisplay } from "@/cli/helpers/shell-semantic-display";
import {
  getDisplayToolName,
  isPatchTool,
  isShellTool,
} from "@/cli/helpers/tool-name-mapping";

export type ToolCallPhase = "streaming" | "ready" | "running" | "finished";

export interface ToolCallDisplayInput {
  name?: string;
  argsText?: string;
  unifiedExecCommandDisplay?: string;
  resultText?: string;
  phase: ToolCallPhase;
  resultOk?: boolean;
  isStreaming?: boolean;
  columns: number;
}

export interface ToolCallDisplay {
  /** Raw tool name (`?` when the stream has not delivered one yet). */
  rawName: string;
  /** Name shown in the header, after every remapping. */
  displayName: string;
  /** `AskUserQuestion` hides its args in the header. */
  hidesArgs: boolean;
  /**
   * Args text the header renders (already truncated), `"…"`/`"(…)"` placeholders
   * included. `null` when the header shows no args at all.
   */
  argsDisplayText: string | null;
  /** Width the args box is given when the name fits on the first row. */
  headerArgsWidth: number;
  /**
   * True when the header renders name and args inline because the name alone
   * already fills the row.
   */
  headerInline: boolean;
  /** Raw shell command shown highlighted, when the tool is a shell call. */
  shellCommand: string | null;
  /** Columns the highlighted first line of `shellCommand` is clipped to. */
  shellCommandMaxColumns: number;
}

/** Renderer gate: a question tool hides its args behind the result. */
export function isQuestionToolName(name: string): boolean {
  return name === "AskUserQuestion";
}

/** Patch tools rename themselves from the patch content (Add → Write, …). */
function displayNameForPatch(
  rawName: string,
  argsJson: string,
  fallback: string,
): string {
  if (!isPatchTool(rawName)) return fallback;
  try {
    const parsedArgs = JSON.parse(argsJson);
    if (!parsedArgs.input) return fallback;
    const patchInfo = parsePatchInput(parsedArgs.input);
    if (!patchInfo) return fallback;
    if (patchInfo.kind === "add") return "Write";
    if (patchInfo.kind === "update") return "Update";
    return "Delete";
  } catch {
    // Keep the default display name when the args are not parseable JSON.
    return fallback;
  }
}

export function resolveToolCallDisplay(
  input: ToolCallDisplayInput,
): ToolCallDisplay {
  const rawName = input.name ?? "?";
  const argsJson =
    typeof input.argsText === "string"
      ? input.argsText
      : input.argsText == null
        ? ""
        : JSON.stringify(input.argsText);

  const rightWidth = Math.max(0, input.columns - 2);
  let displayName = getDisplayToolName(rawName);
  displayName = displayNameForPatch(rawName, argsJson, displayName);

  const hidesArgs = isQuestionToolName(rawName);
  if (hidesArgs) {
    // Show a friendly header only after completion.
    if (input.phase === "finished" && input.resultOk !== false) {
      displayName = parseAskUserQuestionReceipt(input.resultText)
        ? "Questions posted"
        : "User answered Haruyuki's questions:";
    } else {
      displayName = "Asking user questions...";
    }
  }

  let argsDisplayText: string | null = null;
  let shellCommand: string | null = null;
  let shellSemanticKind: ShellSemanticDisplay["kind"] | null = null;
  let hasShellDescription = false;

  if (!hidesArgs) {
    const readFormatted = (): {
      formatted: ReturnType<typeof formatArgsDisplay> | null;
      parseable: boolean;
    } => {
      if (!argsJson.trim()) return { formatted: null, parseable: true };
      try {
        return {
          formatted: formatArgsDisplay(argsJson, rawName, {
            unifiedExecCommandDisplay: input.unifiedExecCommandDisplay,
            suppressUnifiedExecInteractionLabel:
              rawName === "write_stdin" &&
              input.phase === "finished" &&
              input.resultOk === false,
          }),
          parseable: true,
        };
      } catch {
        return { formatted: null, parseable: false };
      }
    };

    // Args are complete once running/finished, stream done, or JSON is parseable.
    const { formatted, parseable } = readFormatted();
    const argsComplete =
      parseable ||
      input.phase === "running" ||
      input.phase === "finished" ||
      !input.isStreaming;

    if (!argsComplete) {
      argsDisplayText = "(…)";
    } else {
      const formattedArgs =
        formatted ??
        formatArgsDisplay(argsJson, rawName, {
          unifiedExecCommandDisplay: input.unifiedExecCommandDisplay,
          suppressUnifiedExecInteractionLabel:
            rawName === "write_stdin" &&
            input.phase === "finished" &&
            input.resultOk === false,
        });

      if (formattedArgs.shellSemantic) {
        shellSemanticKind = formattedArgs.shellSemantic.kind;
        displayName = formattedArgs.shellSemantic.label;
        hasShellDescription =
          typeof formattedArgs.parsed.description === "string" &&
          formattedArgs.parsed.description.trim().length > 0;
        if (shellSemanticKind === "run" && !hasShellDescription) {
          shellCommand = formattedArgs.shellSemantic.rawCommand;
        }
      } else if (formattedArgs.displayName) {
        displayName = formattedArgs.displayName;
      }

      // Normalize newlines to spaces to prevent forced line breaks.
      const normalizedDisplay = formattedArgs.display.replace(/\n/g, " ");
      // For max 2 lines: boxWidth * 2, minus parens (2) and margin (2).
      const argsBoxWidth = rightWidth - displayName.length;
      const maxArgsChars = Math.max(0, argsBoxWidth * 2 - 4);
      argsDisplayText =
        normalizedDisplay.length > maxArgsChars
          ? `${normalizedDisplay.slice(0, maxArgsChars - 1)}…`
          : normalizedDisplay;
    }
  }

  if (
    !shellCommand &&
    isShellTool(rawName) &&
    argsJson.trim() &&
    !hasShellDescription &&
    (shellSemanticKind === null || shellSemanticKind === "run")
  ) {
    try {
      const parsedArgs = JSON.parse(argsJson);
      if (typeof parsedArgs.cmd === "string") {
        shellCommand = parsedArgs.cmd;
      } else if (typeof parsedArgs.command === "string") {
        shellCommand = parsedArgs.command;
      } else if (Array.isArray(parsedArgs.command)) {
        shellCommand = parsedArgs.command.join(" ");
      }
    } catch {
      // Keep shellCommand null and fall back to plain args rendering.
    }
  }

  // +1 for the space between the name and the args box.
  const nameWidth = displayName.length + 1;
  return {
    rawName,
    displayName,
    hidesArgs,
    argsDisplayText,
    headerArgsWidth: Math.max(0, rightWidth - nameWidth),
    headerInline: displayName.length >= rightWidth,
    shellCommand,
    shellCommandMaxColumns: Math.max(10, rightWidth - nameWidth),
  };
}
