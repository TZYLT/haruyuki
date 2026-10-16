import { Box } from "ink";
import type { SessionStatsSnapshot } from "@/agent/stats";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { exitSummaryLines } from "./exit-summary";

/**
 * The exit summary in the Ink frame (the append shell's form). The text itself
 * comes from `exitSummaryLines`, the same list the full-screen shell prints after
 * teardown, so the two cannot drift.
 */
export function ExitStats({
  stats,
  agentName,
  agentId,
  conversationId,
}: {
  stats: SessionStatsSnapshot;
  agentName: string | null;
  agentId: string;
  conversationId: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {exitSummaryLines({ stats, agentName, agentId, conversationId }).map(
        (line) => {
          if (line.kind === "blank") {
            return <Box key={line.id} height={1} />;
          }

          if (line.kind === "stat") {
            return (
              <Box key={line.id}>
                {/* Art slot, intentionally blank: the glyphs that used to sit
                    here are upstream brand artwork, which the LICENSE "Brand
                    Assets Exclusion" excludes from the Apache-2.0 grant. The
                    column is reserved so the labels stay aligned when this fork
                    draws its own mark. */}
                <Text color={colors.footer.agentName}>{"        "}</Text>
                <Text dimColor>{line.text}</Text>
              </Box>
            );
          }

          return (
            <Text
              key={line.id}
              color={line.kind === "command" ? colors.link.url : undefined}
              dimColor={line.kind === "label"}
            >
              {line.text}
            </Text>
          );
        },
      )}
    </Box>
  );
}
