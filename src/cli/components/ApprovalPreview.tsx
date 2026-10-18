import { existsSync } from "node:fs";
import { Box } from "ink";
import { memo } from "react";
import { fileEditApprovalHeaderText } from "@/cli/helpers/approval-info";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { dottedRule, solidRule } from "@/cli/helpers/rule-lines";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { resolveApprovalPreviewBody } from "@/cli/overlay/preview";
import { colors } from "./colors";
import { BashPreview } from "./previews/BashPreview";
import { FileEditPreview } from "./previews/FileEditPreview";
import { Text } from "./Text";

type Props = {
  toolName: string;
  toolArgs: string;
  precomputedDiff?: AdvancedDiffSuccess;
  allDiffs?: Map<string, AdvancedDiffSuccess>;
  toolCallId?: string;
};

/**
 * ApprovalPreview - Renders the preview content for an eagerly-committed approval
 *
 * This component renders the "preview" part of an approval that was committed
 * early to enable flicker-free approval UI. It ensures visual parity with
 * what the inline approval components show.
 *
 * The classification is not made here: `@/cli/overlay/preview` decides which
 * body this is, and the transcript row model measures that same decision. The
 * two used to parse the args separately -- this file with its own `JSON.parse`
 * and its own tool-name list -- which is how a committed preview and the rows
 * it occupied could disagree about what was on screen.
 */
export const ApprovalPreview = memo(
  ({ toolName, toolArgs, precomputedDiff, allDiffs, toolCallId }: Props) => {
    const columns = useTerminalWidth();
    const solidLine = solidRule(columns);
    const dottedLine = dottedRule(columns);
    const body = resolveApprovalPreviewBody({ toolName, toolArgs, toolCallId });

    // Bash/Shell: Use BashPreview component
    if (body.kind === "command") {
      return (
        <Box flexDirection="column">
          <BashPreview
            command={body.info.command}
            description={body.info.description ?? ""}
          />
        </Box>
      );
    }

    // File Edit tools: Render diff preview
    if (body.kind === "diff") {
      const { info } = body;
      // The filesystem probe stays here: the row model measures both answers of
      // this header rather than touching the filesystem.
      const headerText = fileEditApprovalHeaderText(
        {
          toolName: info.toolName,
          filePath: info.filePath,
          patchInput: info.patchInput,
        },
        existsSync,
      );

      return (
        <FileEditPreview
          info={info}
          headerText={headerText}
          precomputedDiff={precomputedDiff}
          allDiffs={allDiffs}
          showDiffHeader
        />
      );
    }

    // Generic fallback
    return (
      <Box flexDirection="column">
        <Text dimColor>{solidLine}</Text>
        <Text bold color={colors.approval.header}>
          {toolName} requires approval
        </Text>
        <Text dimColor>{dottedLine}</Text>
      </Box>
    );
  },
);

ApprovalPreview.displayName = "ApprovalPreview";
