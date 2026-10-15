/**
 * Tool-result rendering decisions, shared by the transcript renderer and the row
 * model.
 *
 * A tool result is not printed as raw text: the JSON envelope is unwrapped, the
 * text is clipped for display, a trailing blank run is dropped, a Workflow launch
 * collapses to a one-line summary, and shell tools hide the generic result body
 * once they have their own output block. The full-screen shell has to predict how
 * tall that ends up without rendering, so these decisions live here and both
 * consumers read them — a second copy would let the viewport window disagree with
 * what is actually printed.
 */

import { isWorkflowTool } from "@/cli/helpers/tool-name-mapping.js";
import { formatWorkflowLaunchLine } from "@/cli/helpers/workflow-display";
import { clipToolReturn } from "@/tools/manager.js";

/**
 * Unwrap the JSON envelope some tools return (`{"message": "..."}`). Anything
 * that is not such an object is returned unchanged.
 */
export function extractToolResultMessage(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    // Not JSON or parsing failed, use as-is
  }
  return text;
}

/**
 * The text a tool result renders as. Workflow launches show a one-line summary
 * instead of the model-facing task notes; everything else is clipped for display
 * with its trailing blank lines removed.
 */
export function resolveToolResultDisplayText(
  extractedText: string,
  rawName: string,
): string {
  return (
    (isWorkflowTool(rawName) && formatWorkflowLaunchLine(extractedText)) ||
    clipToolReturn(extractedText).replace(/\n+$/, "")
  );
}

export interface ToolResultText {
  /** Result text with the JSON `message` envelope unwrapped. */
  extractedText: string;
  /** What the result body renders (clipped, trailing blanks removed). */
  displayResultText: string;
}

/** Both result-text forms the renderer and the row model need, resolved once. */
export function resolveToolResultText(
  resultText: string,
  rawName: string,
): ToolResultText {
  const extractedText = extractToolResultMessage(resultText);
  return {
    extractedText,
    displayResultText: resolveToolResultDisplayText(extractedText, rawName),
  };
}
