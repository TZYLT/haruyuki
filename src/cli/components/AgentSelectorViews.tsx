import { Box } from "ink";
import type { ReactElement } from "react";
import { TypedConfirmPrompt } from "@/cli/overlay/confirm";
import { OverlayFrame } from "@/cli/overlay/frame";
import { Text } from "./Text";

interface AgentDeleteConfirmOverlayProps {
  command: string;
  displayName: string;
  input: string;
  loading: boolean;
}

/**
 * The typed-name confirmation for deleting an agent.
 *
 * The keys, the draft and the "the name has to match" rule live in
 * `AgentSelector`; this is its view. `OverlayShell` and `OverlayFrame` render the
 * same chrome — the frame is where that markup became one component, and this view
 * was one of the shell's remaining consumers.
 */
export function AgentDeleteConfirmOverlay({
  command,
  displayName,
  input,
  loading,
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

      <TypedConfirmPrompt value={input} placeholder="(type the agent's name)" />
    </OverlayFrame>
  );
}
