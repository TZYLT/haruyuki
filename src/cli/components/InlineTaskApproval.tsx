import { Box } from "ink";
import { memo, useMemo } from "react";
import {
  TASK_APPROVE_ALWAYS_LABEL,
  taskApprovalPromptRows,
} from "@/cli/helpers/approval-layout";
import {
  countPreviewRows,
  fitPreviewLines,
} from "@/cli/helpers/approval-preview";
import { solidRule } from "@/cli/helpers/rule-lines";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { ApprovalOptions } from "./ApprovalOptions";
import { colors } from "./colors";
import { Text } from "./Text";

type Props = {
  taskInfo: {
    subagentType: string;
    description: string;
    prompt: string;
    model?: string;
    isBackground?: boolean;
  };
  onApprove: () => void;
  onApproveAlways: (scope: "project" | "session") => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
};

/**
 * InlineTaskApproval - Renders Task tool approval UI inline with pretty formatting
 *
 * Shows subagent type, description, and prompt in a readable format.
 */
export const InlineTaskApproval = memo(
  ({
    taskInfo,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
  }: Props) => {
    const columns = useTerminalWidth();
    const terminalRows = useTerminalRows();
    useProgressIndicator();

    // Generate horizontal line
    const solidLine = solidRule(columns);
    const contentWidth = Math.max(0, columns - 4); // 2 padding on each side

    // Memoize the static task content so it doesn't re-render on keystroke
    const memoizedTaskContent = useMemo(() => {
      const { subagentType, description, prompt, model, isBackground } =
        taskInfo;

      // Show as much of the prompt as fits, from the start: a live area
      // taller than the terminal is clipped to its bottom rows, which would
      // hide the header and the task being approved. The budget is shared with
      // the transcript row model (`@/cli/helpers/approval-layout`).
      const summary = `${subagentType}${isBackground ? " [background]" : ""} — ${description}${model ? ` (${model})` : ""}`;
      const truncatedPrompt = fitPreviewLines(
        prompt.split("\n"),
        taskApprovalPromptRows(
          terminalRows,
          countPreviewRows(summary.split("\n"), contentWidth),
        ),
        contentWidth,
      ).join("\n");

      return (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            Dispatch subagent?
          </Text>

          {/* Task details */}
          <Box paddingLeft={2} flexDirection="column" marginTop={1}>
            {/* Type — Description (with optional model) */}
            <Box flexDirection="row">
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  <Text bold color={colors.subagent.header}>
                    {subagentType}
                  </Text>
                  {isBackground && <Text dimColor>{" [background]"}</Text>}
                  <Text dimColor>
                    {" — "}
                    {description}
                    {model ? ` (${model})` : ""}
                  </Text>
                </Text>
              </Box>
            </Box>

            {/* Prompt */}
            <Box marginTop={1}>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap" dimColor>
                  {truncatedPrompt}
                </Text>
              </Box>
            </Box>
          </Box>
        </>
      );
    }, [taskInfo, solidLine, contentWidth, terminalRows]);

    // Generate "always" text for Task tool
    const alwaysText = approveAlwaysText || TASK_APPROVE_ALWAYS_LABEL;

    return (
      <Box flexDirection="column">
        {/* Static task content - memoized to prevent re-render on keystroke */}
        {memoizedTaskContent}

        <ApprovalOptions
          allowPersistence={allowPersistence}
          alwaysLabel={alwaysText}
          isFocused={isFocused}
          // The task approval always shows its preview, so its options always
          // carry the separating row.
          marginTop={1}
          onApprove={onApprove}
          onApproveAlways={() => onApproveAlways("session")}
          onCancel={onCancel}
          onDeny={onDeny}
        />
      </Box>
    );
  },
);

InlineTaskApproval.displayName = "InlineTaskApproval";
