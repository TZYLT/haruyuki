import { Box } from "ink";
import { memo, useMemo } from "react";
import { DEFAULT_APPROVE_ALWAYS_LABEL } from "@/cli/helpers/approval-layout";
import { solidRule } from "@/cli/helpers/rule-lines";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { ApprovalOptions } from "./ApprovalOptions";
import { colors } from "./colors";
import { SyntaxHighlightedCommand } from "./SyntaxHighlightedCommand";
import { Text } from "./Text";

type BashInfo = {
  toolName: string;
  command: string;
  description?: string;
};

type Props = {
  bashInfo: BashInfo;
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

const BASH_PREVIEW_MAX_LINES = 3;

/**
 * InlineBashApproval - Renders bash/shell approval UI inline (Claude Code style)
 *
 * Option 3 is an inline text input - when selected, user can type directly
 * without switching to a separate screen.
 */
export const InlineBashApproval = memo(
  ({
    bashInfo,
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
    useProgressIndicator();

    const solidLine = solidRule(columns);

    // Memoize the static command content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field
    const memoizedCommandContent = useMemo(
      () => (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            Run this command?
          </Text>

          <Box height={1} />

          {/* Command preview */}
          <Box paddingLeft={2} flexDirection="column">
            <SyntaxHighlightedCommand
              command={bashInfo.command}
              maxLines={BASH_PREVIEW_MAX_LINES}
              maxColumns={Math.max(10, columns - 2)}
              showTruncationHint
            />
            {bashInfo.description && (
              <Box marginTop={1}>
                <Text dimColor>{bashInfo.description}</Text>
              </Box>
            )}
          </Box>
        </>
      ),
      [bashInfo.command, bashInfo.description, solidLine, columns],
    );

    const optionsMarginTop = showPreview ? 1 : 0;

    return (
      <Box flexDirection="column">
        {/* Static command content - memoized to prevent re-render on keystroke */}
        {showPreview && memoizedCommandContent}

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

InlineBashApproval.displayName = "InlineBashApproval";
