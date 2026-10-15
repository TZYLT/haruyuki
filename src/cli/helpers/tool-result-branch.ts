/**
 * Whether a tool call renders the generic result body.
 *
 * Shell tools replace the generic result with their own streaming/collapsed
 * output block once they have one, so `ToolCallMessageRich` renders the default
 * result only for non-shell tools, for failed shell calls (the error text), and
 * while a shell call has not reached running/finished. The full-screen shell
 * measures the same body without rendering, so the decision lives here.
 */

import { isShellOutputTool } from "@/cli/helpers/tool-name-mapping.js";

export interface ToolResultBranchState {
  phase: "streaming" | "ready" | "running" | "finished";
  resultOk?: boolean;
}

/**
 * True when the tool call's generic result body is rendered: not a shell output
 * tool, or a shell call that failed, or a shell call that is neither running nor
 * finished.
 */
export function showsDefaultToolResult(
  line: ToolResultBranchState,
  rawName: string,
): boolean {
  return (
    !isShellOutputTool(rawName) ||
    (line.phase === "finished" && line.resultOk === false) ||
    (line.phase !== "running" && line.phase !== "finished")
  );
}
