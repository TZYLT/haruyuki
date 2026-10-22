import { Box, useInput } from "ink";
import { memo, useState } from "react";
import {
  APPROVAL_OPTION_GUTTER_WIDTH,
  approvalHintText,
  CUSTOM_DENIAL_LABEL,
} from "@/cli/helpers/approval-layout";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { useTextInputCursor } from "@/cli/hooks/use-text-input-cursor";
import { colors } from "./colors";
import { Text } from "./Text";

/**
 * The option list every inline approval ends with: "Yes", an optional "always",
 * and a custom-denial row that is an inline text input.
 *
 * The four inline approvals were four copies of this -- the same state, the same
 * `useInput` body keyboard-key for keyboard-key, the same eighty lines of JSX,
 * the same hint rules. Only three things ever differed, and they are the props:
 * whether the "always" option is offered, what it says, and what each choice
 * calls.
 *
 * It does *not* move onto `overlay/list-bindings.ts` with the rest of the
 * toolkit's keys, on purpose. The custom-denial row is a live text editor: while
 * the cursor is on it every printable key belongs to the editor, and the editor
 * is Ink's raw input path (`useTextInputCursor`, shared with the composer's
 * handlers). Expressing "consume everything that is not this row's navigation"
 * as a key table would mean a chord-less catch-all binding whose declines fall
 * through to the composer behind the approval, which is the double-consumption
 * bug the router exists to prevent. The keys here are therefore unchanged from
 * the four copies, and the row model's own key-face table (docs/37 §9H) is
 * checked against them.
 */
export const ApprovalOptions = memo(
  ({
    allowPersistence,
    alwaysLabel,
    isFocused = true,
    marginTop,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    onOpenDiffFace,
  }: {
    /** Whether the "always" option is offered at all. */
    allowPersistence: boolean;
    /** What the "always" option says; the caller resolves its default. */
    alwaysLabel: string;
    isFocused?: boolean;
    /** Rows between the preview above and this list. */
    marginTop: number;
    onApprove: () => void;
    onApproveAlways: () => void;
    onDeny: (reason: string) => void;
    onCancel?: () => void;
    /**
     * `O`: open the diff in the full-screen face (`docs/38` §16.2's third entry).
     *
     * Handled here rather than as a router binding because this list's custom-denial
     * row is a live text editor: `o` is a letter in a denial reason, and a modal
     * binding would open a full-screen face while the user was typing "no". The key
     * is therefore offered only where this component can see that the editor is not
     * the current row.
     */
    onOpenDiffFace?: () => void;
  }) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const {
      text: customReason,
      cursorPos,
      handleKey,
      clear,
    } = useTextInputCursor();
    const columns = useTerminalWidth();

    // Custom option index depends on whether "always" option is shown
    const customOptionIndex = allowPersistence ? 2 : 1;
    const maxOptionIndex = customOptionIndex;
    const isOnCustomOption = selectedOption === customOptionIndex;

    useInput(
      (input, key) => {
        if (!isFocused) return;

        // CTRL-C: cancel (queue denial, return to input)
        if (key.ctrl && input === "c") {
          onCancel?.();
          return;
        }

        // Arrow navigation always works
        if (key.upArrow) {
          setSelectedOption((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedOption((prev) => Math.min(maxOptionIndex, prev + 1));
          return;
        }

        // When on custom input option
        if (isOnCustomOption) {
          if (key.return) {
            if (customReason.trim()) {
              onDeny(customReason.trim());
            }
            return;
          }
          if (key.escape) {
            if (customReason) {
              clear();
            } else {
              onCancel?.();
            }
            return;
          }
          // Handle text input (arrows, backspace, typing)
          if (handleKey(input, key)) return;
        }

        // When on regular options
        if (key.return) {
          if (selectedOption === 0) {
            onApprove();
          } else if (selectedOption === 1 && allowPersistence) {
            onApproveAlways();
          }
          return;
        }
        if (key.escape) {
          onCancel?.();
          return;
        }

        // Number keys for quick selection (only for fixed options, not custom text input)
        if (input === "1") {
          onApprove();
          return;
        }
        if (input === "2" && allowPersistence) {
          onApproveAlways();
          return;
        }

        // `O` opens the diff in the full-screen face. Only from the fixed options:
        // on the custom row every printable key belongs to the editor.
        if (
          onOpenDiffFace &&
          (input === "o" || input === "O") &&
          !isOnCustomOption
        ) {
          onOpenDiffFace();
          return;
        }
      },
      { isActive: isFocused },
    );

    const hintText = approvalHintText(
      isOnCustomOption,
      customReason.length > 0,
    );

    return (
      <>
        {/* Options */}
        <Box marginTop={marginTop} flexDirection="column">
          {/* Option 1: Yes */}
          <Box flexDirection="row">
            <Box width={APPROVAL_OPTION_GUTTER_WIDTH} flexShrink={0}>
              <Text
                color={
                  selectedOption === 0 ? colors.approval.header : undefined
                }
              >
                {selectedOption === 0 ? "❯" : " "} 1.
              </Text>
            </Box>
            <Box
              flexGrow={1}
              width={Math.max(0, columns - APPROVAL_OPTION_GUTTER_WIDTH)}
            >
              <Text
                wrap="wrap"
                color={
                  selectedOption === 0 ? colors.approval.header : undefined
                }
              >
                Yes
              </Text>
            </Box>
          </Box>

          {/* Option 2: Yes, always (only if persistence allowed) */}
          {allowPersistence && (
            <Box flexDirection="row">
              <Box width={APPROVAL_OPTION_GUTTER_WIDTH} flexShrink={0}>
                <Text
                  color={
                    selectedOption === 1 ? colors.approval.header : undefined
                  }
                >
                  {selectedOption === 1 ? "❯" : " "} 2.
                </Text>
              </Box>
              <Box
                flexGrow={1}
                width={Math.max(0, columns - APPROVAL_OPTION_GUTTER_WIDTH)}
              >
                <Text
                  wrap="wrap"
                  color={
                    selectedOption === 1 ? colors.approval.header : undefined
                  }
                >
                  {alwaysLabel}
                </Text>
              </Box>
            </Box>
          )}

          {/* Custom input option (3 if persistence, 2 if not) */}
          <Box flexDirection="row">
            <Box width={APPROVAL_OPTION_GUTTER_WIDTH} flexShrink={0}>
              <Text
                color={isOnCustomOption ? colors.approval.header : undefined}
              >
                {isOnCustomOption ? "❯" : " "} {customOptionIndex + 1}.
              </Text>
            </Box>
            <Box
              flexGrow={1}
              width={Math.max(0, columns - APPROVAL_OPTION_GUTTER_WIDTH)}
            >
              {customReason ? (
                <Text wrap="wrap">
                  {customReason.slice(0, cursorPos)}
                  {isOnCustomOption && "█"}
                  {customReason.slice(cursorPos)}
                </Text>
              ) : (
                <Text wrap="wrap" dimColor>
                  {CUSTOM_DENIAL_LABEL}
                  {isOnCustomOption && "█"}
                </Text>
              )}
            </Box>
          </Box>
        </Box>

        {/* Hint */}
        <Box marginTop={1}>
          <Text dimColor>{hintText}</Text>
        </Box>
      </>
    );
  },
);

ApprovalOptions.displayName = "ApprovalOptions";
