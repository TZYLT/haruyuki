import { Box } from "ink";
import type {
  ByokProvider,
  ProviderResponse,
} from "@/providers/byok-providers";
import { colors } from "./colors";
import { Text } from "./Text";

/**
 * The `/config connect` manage step, as markup.
 *
 * Split out of the face for the reason the size ratchet exists: what a connected
 * provider shows (its records, their usage rows when it is a ChatGPT OAuth
 * provider, and the action rows under them) is a screenful of its own, and the
 * face is about which step is on screen and which keys answer to it. It is
 * pure — every value it paints comes in as a prop — so the face keeps the
 * cursor and the action dispatch, and this keeps the picture.
 */

/** How a ChatGPT provider's usage panel is doing. */
export type ChatGPTUsageStatus =
  | { status: "loading" }
  | { status: "ready"; rows: string[] }
  | { status: "error"; message: string };

/** The rows the usage panel shows. Never empty: a loading or failed read says so. */
function usageStatusRows(status: ChatGPTUsageStatus | undefined): string[] {
  if (!status || status.status === "loading") return ["Loading..."];
  if (status.status === "error") return [`Unavailable: ${status.message}`];
  return status.rows;
}

export interface ProviderOptionsViewProps {
  provider: ByokProvider;
  /** The action labels, in the order the cursor walks them. */
  options: readonly string[];
  /** The provider's live connections. */
  connectedRecords: readonly ProviderResponse[];
  /** Whether this provider has a usage panel at all. */
  showUsage: boolean;
  usageByProvider: Record<string, ChatGPTUsageStatus>;
  optionIndex: number;
}

export function ProviderOptionsView({
  provider,
  options,
  connectedRecords,
  showUsage,
  usageByProvider,
  optionIndex,
}: ProviderOptionsViewProps) {
  return (
    <>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Manage {provider.displayName}
        </Text>
        <Box height={1} />
        {connectedRecords.length > 0 ? (
          connectedRecords.map((record) => {
            const usageStatus = usageByProvider[record.name];
            return (
              <Box key={record.id} flexDirection="column">
                <Box flexDirection="row">
                  <Text>{"  "}</Text>
                  <Text color="green">[✓]</Text>
                  <Text> </Text>
                  <Text bold>{record.name}</Text>
                  <Text dimColor> · </Text>
                  <Text color="green">Connected</Text>
                </Box>
                {showUsage && (
                  <Box flexDirection="column">
                    {usageStatusRows(usageStatus).map((row) => (
                      <Box key={row} flexDirection="row">
                        <Text>{"      "}</Text>
                        <Text
                          color={
                            usageStatus?.status === "error"
                              ? "yellow"
                              : undefined
                          }
                          dimColor={usageStatus?.status !== "error"}
                        >
                          {row}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            );
          })
        ) : (
          <Text dimColor>{"  "}No connected providers.</Text>
        )}
      </Box>

      <Box flexDirection="column">
        {options.map((option, index) => {
          const isSelected = index === optionIndex;
          return (
            <Box key={option} flexDirection="row">
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "> " : "  "}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {option}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{"  "}Enter confirm · ↑↓ navigate · Esc back</Text>
      </Box>
    </>
  );
}
