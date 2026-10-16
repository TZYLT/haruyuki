import { Box, Text } from "ink";
import { memo } from "react";
import {
  useInputScopeClaim,
  useKeyBindings,
} from "@/cli/hooks/use-input-router";
import { brandColors } from "./colors.js";

export type BtwState = {
  status: "idle" | "forking" | "streaming" | "complete" | "error";
  question?: string;
  responseText?: string;
  forkedConversationId?: string;
  error?: string;
};

type BtwPaneProps = {
  state: BtwState;
  onJumpToConversation?: (conversationId: string) => void;
  onDismiss?: () => void;
};

/**
 * Ephemeral pane for /btw responses.
 *
 * Renders alongside the main transcript, showing the forked conversation's
 * response. The main input keeps working while it is up: this pane reports a
 * finished side answer, it does not own the user's next message, and the
 * composer unmounting behind it left a blank input area that typed nothing.
 *
 * Its own keys are therefore only the ones that cannot be someone typing:
 * `Esc` closes the pane, and switching to the fork sits behind the leader
 * prefix (`Ctrl+X` then `j`), which is what the prefix exists for — one more
 * usable key per entry without taking a letter away from the draft. The pane
 * claims the `modal` scope while it is showing so its `Esc` wins over the
 * composer's, and so the which-key hint lists its entry.
 */
export const BtwPane = memo(
  ({ state, onJumpToConversation, onDismiss }: BtwPaneProps) => {
    const complete = state.status === "complete";
    useInputScopeClaim("modal", complete);
    useKeyBindings("btw-pane", [
      {
        scope: "modal",
        bindings: [
          {
            id: "btw.dismiss",
            chords: [{ key: "escape" }],
            run: () => {
              if (!complete) return false;
              onDismiss?.();
              return true;
            },
          },
          {
            id: "btw.jumpToFork",
            leader: true,
            chords: [{ key: "j" }],
            label: "切到分叉会话",
            run: () => {
              if (!complete || !state.forkedConversationId) return false;
              onJumpToConversation?.(state.forkedConversationId);
              return true;
            },
          },
        ],
      },
    ]);

    if (state.status === "idle") {
      return null;
    }

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={brandColors.primaryAccent}
        paddingX={1}
        marginY={1}
      >
        {/* Header */}
        <Box>
          <Text bold color={brandColors.primaryAccent}>
            btw
          </Text>
          {state.question && (
            <Text dimColor>
              {" "}
              —{" "}
              {state.question.length > 60
                ? `${state.question.slice(0, 60)}...`
                : state.question}
            </Text>
          )}
        </Box>

        {/* Status line */}
        {state.status === "forking" && (
          <Text dimColor> Forking conversation...</Text>
        )}

        {state.status === "streaming" && (
          <Text dimColor> Side questing...</Text>
        )}

        {/* Response content */}
        {state.responseText && (
          <Box flexDirection="column">
            <Text dimColor> ──</Text>
            <Text>
              {"  "}
              {state.responseText}
            </Text>
          </Box>
        )}

        {/* Error */}
        {state.status === "error" && state.error && (
          <Text color="red"> Error: {state.error}</Text>
        )}

        {/* Fork ID and jump option when complete */}
        {state.status === "complete" && state.forkedConversationId && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              {"  "}Fork: {state.forkedConversationId}
            </Text>
            {onJumpToConversation && (
              <Text dimColor>
                {"  "}[esc] 关闭 · ctrl+x j 切到分叉（输入框仍可用）
              </Text>
            )}
          </Box>
        )}
      </Box>
    );
  },
);

BtwPane.displayName = "BtwPane";
