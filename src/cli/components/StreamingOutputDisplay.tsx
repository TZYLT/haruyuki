import { Box } from "ink";
import { memo, useEffect, useState } from "react";
import type { StreamingState } from "@/cli/helpers/accumulator";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  clipStreamingLine,
  STREAMING_MIN_CONTENT_WIDTH,
  streamingOutputLayout,
} from "@/cli/helpers/shell-output";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { Text } from "./Text";

interface StreamingOutputDisplayProps {
  streaming: StreamingState;
  /** Show "(esc to interrupt)" hint - used by bash mode (LET-7199) */
  showInterruptHint?: boolean;
}

/**
 * Display component for streaming bash output during execution.
 * Shows a rolling window of the last 5 lines with elapsed time.
 */
export const StreamingOutputDisplay = memo(
  ({ streaming, showInterruptHint }: StreamingOutputDisplayProps) => {
    const columns = useTerminalWidth();
    // Force re-render every second for elapsed timer
    const [, forceUpdate] = useState(0);
    useEffect(() => {
      const interval = setInterval(() => forceUpdate((n) => n + 1), 1000);
      return () => clearInterval(interval);
    }, []);

    const elapsed = Math.floor((Date.now() - streaming.startTime) / 1000);
    // Which lines are visible is shared with the transcript row model.
    const {
      first: firstLine,
      rest,
      hiddenCount,
    } = streamingOutputLayout(streaming);
    const contentWidth = Math.max(STREAMING_MIN_CONTENT_WIDTH, columns - 5);

    const interruptHint = showInterruptHint ? " (esc to interrupt)" : "";
    if (!firstLine) {
      return (
        <Box>
          <Text
            dimColor
          >{`  ${CLI_GLYPHS.result}  Running... (${elapsed}s)${interruptHint}`}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        {/* L-bracket on first line - matches ToolCallMessageRich result prefix */}
        <Box>
          <Text dimColor>{`  ${CLI_GLYPHS.result}  `}</Text>
          <Text
            dimColor={!firstLine.isStderr}
            color={firstLine.isStderr ? "red" : undefined}
          >
            {clipStreamingLine(firstLine.text, contentWidth)}
          </Text>
        </Box>
        {/* Remaining lines with indent (5 spaces to align with content after bracket) */}
        {rest.map((line, i) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: Lines are positional output, stable order within render
            key={i}
            dimColor={!line.isStderr}
            color={line.isStderr ? "red" : undefined}
          >
            {"     "}
            {clipStreamingLine(line.text, contentWidth)}
          </Text>
        ))}
        {/* Hidden count + elapsed time */}
        {hiddenCount > 0 && (
          <Text dimColor>
            {"     "}… +{hiddenCount} more lines ({elapsed}s){interruptHint}
          </Text>
        )}

        {/* Always show elapsed while running, even if output is short */}
        {hiddenCount === 0 && (
          <Text dimColor>
            {"     "}({elapsed}s){interruptHint}
          </Text>
        )}
      </Box>
    );
  },
);

StreamingOutputDisplay.displayName = "StreamingOutputDisplay";
