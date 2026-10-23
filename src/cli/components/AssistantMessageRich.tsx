import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { normalizeMarkdownBody } from "@/cli/helpers/markdown-text";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { Text } from "./Text";

type AssistantLine = {
  kind: "assistant";
  id: string;
  text: string;
  phase: "streaming" | "finished";
  isContinuation?: boolean;
};

/**
 * AssistantMessageRich - Rich formatting version with two-column layout
 * This is a direct port from the old letta-code codebase to preserve the exact styling
 *
 * Features:
 * - Left column (2 chars wide) with bullet point marker (unless continuation)
 * - Right column with wrapped text content
 * - Proper text normalization
 * - Support for markdown rendering (when MarkdownDisplay is available)
 */
export const AssistantMessage = memo(({ line }: { line: AssistantLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  const normalizedText = normalizeMarkdownBody(line.text);
  if (!normalizedText.trim()) {
    return null;
  }

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{line.isContinuation ? " " : CLI_GLYPHS.bullet}</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        <MarkdownDisplay
          text={normalizedText}
          hangingIndent={0}
          contentWidth={contentWidth}
        />
      </Box>
    </Box>
  );
});

AssistantMessage.displayName = "AssistantMessage";
