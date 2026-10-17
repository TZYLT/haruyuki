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
 * response. The composer stays **mounted** while it is up — unmounting it left a
 * blank input area that typed nothing — and typing plus the leaf editor's own keys
 * (arrows, Backspace, Home/End, `Ctrl+A/E/K/U/Y`, Enter) keep working, because those
 * reach Ink's `useInput` rather than a table. What does **not** work is every
 * app-scope chord: the pane claims the `modal` scope so its `Esc` wins, and
 * `consultedInputScopes()` then returns `[modal, system]`, so the composer's own
 * table (`Ctrl+W`, Option+Arrow, …) and the app table (`Ctrl+O/R/T` …) are not
 * consulted at all. That is the accepted trade (《36》§I), which is why the footer
 * must not advertise the leader prefix: `Ctrl+X` is app-scoped, so it cannot arm
 * while the pane is up.
 *
 * Its own keys are therefore only the ones that cannot be someone typing:
 * `Esc` closes the pane, and switching to the fork sits behind the leader prefix
 * (`Ctrl+X` then `j`) — reachable when the prefix was already armed before the pane
 * appeared, and listed in the which-key hint for that reason.
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
                {"  "}[esc] 关闭 ·
                面板期间应用级快捷键暂停（打字与基础编辑仍可用）
              </Text>
            )}
          </Box>
        )}
      </Box>
    );
  },
);

BtwPane.displayName = "BtwPane";
