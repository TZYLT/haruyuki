import { existsSync } from "node:fs";
import { Box } from "ink";
import { memo } from "react";
import { fileEditApprovalHeaderText } from "@/cli/helpers/approval-info";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { simpleDiffDisplayPath } from "@/cli/helpers/diff-rows";
import { dottedRule, solidRule } from "@/cli/helpers/rule-lines";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { resolveApprovalPreviewBody } from "@/cli/overlay/preview";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { colors } from "./colors";
import { BashPreview } from "./previews/BashPreview";
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
      const { info, operations } = body;
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
        <Box flexDirection="column">
          <Text dimColor>{solidLine}</Text>
          <Text bold color={colors.approval.header}>
            {headerText}
          </Text>
          <Text dimColor>{dottedLine}</Text>

          {/* Handle ApplyPatch (can have multiple files) */}
          {info.patchInput ? (
            <Box flexDirection="column">
              {operations.map((op, idx) => {
                // The display form of a patch target, shared with the inline
                // approval and the transcript row model.
                const displayPath = simpleDiffDisplayPath(op.path);

                const diffKey = toolCallId
                  ? `${toolCallId}:${op.path}`
                  : undefined;
                const opDiff =
                  diffKey && allDiffs ? allDiffs.get(diffKey) : undefined;

                if (op.kind === "add") {
                  return (
                    <Box key={`patch-add-${op.path}`} flexDirection="column">
                      {idx > 0 && <Box height={1} />}
                      <Text dimColor>{displayPath}</Text>
                      <AdvancedDiffRenderer
                        precomputed={opDiff}
                        kind="write"
                        filePath={op.path}
                        content={op.content}
                        showHeader={false}
                      />
                    </Box>
                  );
                }
                if (op.kind === "update") {
                  return (
                    <Box key={`patch-update-${op.path}`} flexDirection="column">
                      {idx > 0 && <Box height={1} />}
                      <Text dimColor>{displayPath}</Text>
                      <AdvancedDiffRenderer
                        precomputed={opDiff}
                        kind="edit"
                        filePath={op.path}
                        oldString={op.oldString}
                        newString={op.newString}
                        showHeader={false}
                      />
                    </Box>
                  );
                }
                if (op.kind === "delete") {
                  return (
                    <Box key={`patch-delete-${op.path}`}>
                      {idx > 0 && <Box height={1} />}
                      <Text>
                        Delete <Text bold>{displayPath}</Text>
                      </Text>
                    </Box>
                  );
                }
                return null;
              })}
            </Box>
          ) : (
            <>
              {/* Write */}
              {info.content !== undefined && (
                <AdvancedDiffRenderer
                  precomputed={precomputedDiff}
                  kind="write"
                  filePath={info.filePath}
                  content={info.content}
                />
              )}

              {/* Single edit */}
              {info.oldString !== undefined && (
                <AdvancedDiffRenderer
                  precomputed={precomputedDiff}
                  kind="edit"
                  filePath={info.filePath}
                  oldString={info.oldString || ""}
                  newString={info.newString || ""}
                  replaceAll={info.replaceAll}
                />
              )}
            </>
          )}

          <Text dimColor>{dottedLine}</Text>
        </Box>
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
