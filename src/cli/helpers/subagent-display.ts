/**
 * Shared utilities for subagent display components
 *
 * Used by both SubagentGroupDisplay (live) and SubagentGroupStatic (frozen).
 */
import { getModelShortName, resolveModel } from "@/agent/model";
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";
import { formatCompact } from "./format";

/**
 * Format tool count and token statistics for display
 *
 * @param toolCount - Number of tool calls
 * @param totalTokens - Total tokens used (0 or undefined means no data available)
 */
export function formatStats(toolCount: number, totalTokens: number): string {
  const toolStr = `${toolCount} tool use${toolCount !== 1 ? "s" : ""}`;

  if (totalTokens > 0) {
    return `${toolStr} · ${formatCompact(totalTokens)} tokens`;
  }

  return toolStr;
}

/**
 * Format a tool call's raw JSON arguments for the expanded-tool-call rows.
 *
 * Best effort by design: arguments reach this as a string from the stream, so an
 * unparsable one renders as `name()` rather than throwing inside a render pass.
 * At most two entries are shown, and a value longer than 50 characters is
 * truncated to 47 plus an ellipsis.
 */
export function formatToolArgs(argsStr: string): string {
  try {
    const args = JSON.parse(argsStr);
    const entries = Object.entries(args)
      .filter(([_, value]) => value !== undefined && value !== null)
      .slice(0, 2);

    if (entries.length === 0) return "";

    return entries
      .map(([key, value]) => {
        let displayValue = String(value);
        if (displayValue.length > 50) {
          displayValue = `${displayValue.slice(0, 47)}...`;
        }
        return `${key}: "${displayValue}"`;
      })
      .join(", ");
  } catch {
    return "";
  }
}

/**
 * Get tree-drawing characters for hierarchical display
 *
 * @param isLast - Whether this is the last item in the list
 * @returns Object with treeChar (branch connector) and continueChar (continuation line)
 */
export function getTreeChars(isLast: boolean): {
  treeChar: string;
  continueChar: string;
} {
  return {
    treeChar: isLast ? "└─" : "├─",
    continueChar: isLast ? "  " : "│ ",
  };
}

export interface SubagentModelDisplay {
  label: string;
  isByokProvider: boolean;
  isOpenAICodexProvider: boolean;
}

/**
 * Format a subagent model identifier using the same logic as the input footer:
 * short label (if known) + provider-based BYOK marker eligibility.
 */
export function getSubagentModelDisplay(
  model: string | undefined,
): SubagentModelDisplay | null {
  if (!model) return null;

  // Normalize model IDs (e.g. "haiku") to handles before formatting.
  const normalized = resolveModel(model) ?? model;
  const slashIndex = normalized.indexOf("/");
  const provider =
    slashIndex >= 0 ? normalized.slice(0, slashIndex) : normalized;
  const isOpenAICodexProvider = provider === OPENAI_CODEX_PROVIDER_NAME;
  const isByokProvider = provider.startsWith("lc-") || isOpenAICodexProvider;
  const label =
    getModelShortName(normalized) ?? normalized.split("/").pop() ?? normalized;

  return {
    label,
    isByokProvider,
    isOpenAICodexProvider,
  };
}
