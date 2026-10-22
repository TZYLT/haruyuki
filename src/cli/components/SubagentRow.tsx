/**
 * One subagent's rows in the group, shared by the live and the frozen group.
 *
 * `SubagentGroupDisplay` (live area, store-subscribed, keyboard-owning) and
 * `SubagentGroupStatic` (a frozen snapshot inside Ink's `<Static>`) are two
 * components on purpose: they differ in **lifecycle**, not in pixels. A live
 * component may subscribe to a store and re-render; a static one must not, and
 * keyboard handlers must not stack up across frozen copies. What they must agree
 * on is the row: the tree characters, the gutter, the `· type · model` suffix,
 * the stats cell and the status/error line.
 *
 * So this module owns the row's markup and nothing else. Which cells apply is
 * the caller's policy, because it genuinely differs — a frozen `running` agent
 * (a background subagent committed while it works) says "Running in the
 * background", while a live one with no tool call yet says "Launching…", and the
 * live group drops the stats cell entirely while an agent is still starting.
 * Those rules stay where they are decided; the caller hands the row the facts.
 */

import { Box } from "ink";
import { memo, type ReactNode } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  formatStats,
  formatToolArgs,
  getSubagentModelDisplay,
  getTreeChars,
} from "@/cli/helpers/subagent-display.js";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width.js";
import { colors } from "./colors.js";
import { Text } from "./Text";

const ROW_INDENT = "  ";
const STATUS_INDENT = "   ";
const EXPANDED_TOOL_INDENT = "    ";

/**
 * What the row says under the description.
 *
 * A union rather than a string plus flags: the three cases paint different
 * things — the error case wraps its text in the gutter so a long message aligns
 * under the tree, `launching` inserts the result glyph the hand-written rows
 * used, and the plain case is a dim line under the status indent. The old
 * `hideBackgroundStatusLine` gate is `status: null`.
 */
export type SubagentRowStatus =
  | { kind: "error"; message?: string }
  | { kind: "launching" }
  | { kind: "text"; text: string };

export interface SubagentRowProps {
  /** Whether this is the last agent in the group (picks the tree characters). */
  isLast: boolean;
  description: string;
  type: string;
  model?: string;
  /**
   * Whether the `N tool uses · N tokens` cell applies. The two callers decide
   * this differently, and both are right: see the module comment.
   */
  showStats: boolean;
  /** Pre-formatted by {@link formatStats} — the row does not count tools. */
  stats: string;
  /** Dim the description (a foreground agent that is still running). */
  dimDescription: boolean;
  /** The `Subagent: <url>` line; omitted entirely when absent. */
  agentURL?: string | null;
  /** The status line, or `null` to paint none. */
  status: SubagentRowStatus | null;
  /** Rows between the URL line and the status line (expanded tool calls). */
  children?: ReactNode;
}

export const SubagentRow = memo(
  ({
    isLast,
    description,
    type,
    model,
    showStats,
    stats,
    dimDescription,
    agentURL,
    status,
    children,
  }: SubagentRowProps) => {
    const { treeChar, continueChar } = getTreeChars(isLast);
    const columns = useTerminalWidth();
    const gutterWidth =
      ROW_INDENT.length + continueChar.length + STATUS_INDENT.length;
    const contentWidth = Math.max(0, columns - gutterWidth);
    const modelDisplay = getSubagentModelDisplay(model);

    return (
      <Box flexDirection="column">
        {/* Main row: tree char + description + type + model + stats */}
        <Box flexDirection="row">
          <Text wrap="truncate-end">
            <Text color={colors.subagent.treeChar}>
              {ROW_INDENT}
              {treeChar}{" "}
            </Text>
            <Text bold={!dimDescription} dimColor={dimDescription}>
              {description}
            </Text>
            <Text dimColor>
              {" · "}
              {type.toLowerCase()}
            </Text>
            {modelDisplay && (
              <>
                <Text dimColor>{` · ${modelDisplay.label}`}</Text>
                {modelDisplay.isByokProvider && (
                  <Text
                    color={
                      modelDisplay.isOpenAICodexProvider
                        ? colors.provider.openaiCodex
                        : "yellow"
                    }
                  >
                    {" ▲"}
                  </Text>
                )}
              </>
            )}
            {showStats && (
              <Text dimColor>
                {" · "}
                {stats}
              </Text>
            )}
          </Text>
        </Box>

        {agentURL && (
          <Box flexDirection="row">
            <Text color={colors.subagent.treeChar}>
              {ROW_INDENT}
              {continueChar} {CLI_GLYPHS.result}{" "}
            </Text>
            <Text dimColor>{"Subagent: "}</Text>
            <Text dimColor>{agentURL}</Text>
          </Box>
        )}

        {children}

        {status !== null && (
          <Box flexDirection="row">
            {status.kind === "error" ? (
              <>
                <Box width={gutterWidth} flexShrink={0}>
                  <Text>
                    <Text color={colors.subagent.treeChar}>
                      {ROW_INDENT}
                      {continueChar}
                    </Text>
                    <Text dimColor>{STATUS_INDENT}</Text>
                  </Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text wrap="wrap" color={colors.subagent.error}>
                    {status.message}
                  </Text>
                </Box>
              </>
            ) : status.kind === "launching" ? (
              <>
                <Text color={colors.subagent.treeChar}>
                  {ROW_INDENT}
                  {continueChar} {CLI_GLYPHS.result}{" "}
                </Text>
                <Text dimColor>Launching...</Text>
              </>
            ) : (
              <>
                <Text color={colors.subagent.treeChar}>
                  {ROW_INDENT}
                  {continueChar}
                </Text>
                <Text dimColor>
                  {STATUS_INDENT}
                  {status.text}
                </Text>
              </>
            )}
          </Box>
        )}
      </Box>
    );
  },
);

SubagentRow.displayName = "SubagentRow";

export interface SubagentToolCallRowProps {
  isLast: boolean;
  name: string;
  args: string;
}

/** One expanded tool call under an agent's description row. */
export const SubagentToolCallRow = memo(
  ({ isLast, name, args }: SubagentToolCallRowProps) => {
    const { continueChar } = getTreeChars(isLast);
    return (
      <Box flexDirection="row">
        <Text color={colors.subagent.treeChar}>
          {ROW_INDENT}
          {continueChar}
        </Text>
        <Text dimColor>
          {EXPANDED_TOOL_INDENT}
          {name}({formatToolArgs(args)})
        </Text>
      </Box>
    );
  },
);

SubagentToolCallRow.displayName = "SubagentToolCallRow";
