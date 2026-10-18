import { Box } from "ink";
import type { ReactElement } from "react";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { colors } from "./colors";
import { Text } from "./Text";

interface AgentDeleteConfirmOverlayProps {
  command: string;
  displayName: string;
  input: string;
  loading: boolean;
  /** The draft is the caller's; this view only paints it and forwards typing. */
  onInputChange: (value: string) => void;
  /** Enter. The caller decides whether the typed name matches. */
  onInputSubmit: (value: string) => void;
}

/**
 * The typed-name confirmation for deleting an agent.
 *
 * The keys, the draft and "the name has to match" rule live in `AgentSelector`;
 * this is its view. The prompt row is the toolkit's text sub-view, so the draft
 * keeps a caret and receives pastes — the hand-rolled appender it replaced
 * dropped a paste silently, and the `TypedConfirmPrompt` display it replaced
 * could not have caught one either. While the delete is in flight the field is
 * unfocused, which is the old `if (deleteLoading) return` written as a prop.
 */
export function AgentDeleteConfirmOverlay({
  command,
  displayName,
  input,
  loading,
  onInputChange,
  onInputSubmit,
}: AgentDeleteConfirmOverlayProps): ReactElement {
  const inputMatches = input === displayName;
  let footerText = "Esc cancel";
  if (loading) {
    footerText = "Deleting... · Esc cancel";
  } else if (inputMatches) {
    footerText = "Enter to delete · Esc cancel";
  }

  return (
    <OverlayFrame
      command={command}
      title="Delete agent"
      footer={
        <Text dimColor>
          {"  "}
          {footerText}
        </Text>
      }
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          {"  "}Are you sure you want to delete <Text bold>{displayName}</Text>?
        </Text>
        <Text color="red">{"  "}This action can not be undone.</Text>
      </Box>

      <OverlayTextField
        value={input}
        onChange={onInputChange}
        onSubmit={onInputSubmit}
        placeholder="(type the agent's name)"
        focus={!loading}
        marker={<Text color={colors.selector.itemHighlighted}>{"> "}</Text>}
      />
    </OverlayFrame>
  );
}
