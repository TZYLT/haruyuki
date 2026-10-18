import { Box } from "ink";
import { memo, useMemo } from "react";
import {
  DEFAULT_APPROVE_ALWAYS_LABEL,
  formatApprovalArgs,
  genericApprovalPreviewRows,
} from "@/cli/helpers/approval-layout";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { ApprovalOptions } from "./ApprovalOptions";
import { colors } from "./colors";
import { Text } from "./Text";

type Props = {
  toolName: string;
  toolArgs: string;
  onApprove: () => void;
  onApproveAlways: (scope: "project" | "session") => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
  showPreview?: boolean;
  defaultScope?: "project" | "session";
};

// Horizontal line character for Claude Code style
const SOLID_LINE = "─";

/**
 * InlineGenericApproval - Renders generic tool approval UI inline
 *
 * Used as fallback for any tool not handled by specialized inline components.
 */
export const InlineGenericApproval = memo(
  ({
    toolName,
    toolArgs,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
    showPreview = true,
    defaultScope = "project",
  }: Props) => {
    const columns = useTerminalWidth();
    const terminalRows = useTerminalRows();
    useProgressIndicator();

    // Generate horizontal line
    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    // The preview box is indented by 2 columns. The budget is shared with the
    // transcript row model (`@/cli/helpers/approval-layout`).
    const formattedArgs = formatApprovalArgs(
      toolArgs,
      genericApprovalPreviewRows(terminalRows),
      columns - 2,
    );

    // Memoize the static tool content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field
    const memoizedToolContent = useMemo(
      () => (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            Run {toolName}?
          </Text>

          <Box height={1} />

          {/* Arguments preview */}
          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor>{formattedArgs}</Text>
          </Box>
        </>
      ),
      [toolName, formattedArgs, solidLine],
    );

    const optionsMarginTop = showPreview ? 1 : 0;

    return (
      <Box flexDirection="column">
        {/* Static tool content - memoized to prevent re-render on keystroke */}
        {showPreview && memoizedToolContent}

        <ApprovalOptions
          allowPersistence={allowPersistence}
          alwaysLabel={approveAlwaysText || DEFAULT_APPROVE_ALWAYS_LABEL}
          isFocused={isFocused}
          marginTop={optionsMarginTop}
          onApprove={onApprove}
          onApproveAlways={() => onApproveAlways(defaultScope)}
          onCancel={onCancel}
          onDeny={onDeny}
        />
      </Box>
    );
  },
);

InlineGenericApproval.displayName = "InlineGenericApproval";
