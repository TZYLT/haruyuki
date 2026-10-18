import { existsSync } from "node:fs";
import { Box } from "ink";
import { memo, useMemo } from "react";
import { fileEditApprovalHeaderText } from "@/cli/helpers/approval-info";
import { DEFAULT_APPROVE_ALWAYS_LABEL } from "@/cli/helpers/approval-layout";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { parsePatchToAdvancedDiff } from "@/cli/helpers/diff";
import { simpleDiffDisplayPath } from "@/cli/helpers/diff-rows";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { ApprovalOptions } from "./ApprovalOptions";
import { colors } from "./colors";
import { Text } from "./Text";

type FileEditInfo = {
  toolName: string;
  filePath: string;
  // For write tools
  content?: string;
  // For edit tools
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  // For patch tools
  patchInput?: string;
  toolCallId?: string;
};

type Props = {
  fileEdit: FileEditInfo;
  precomputedDiff?: AdvancedDiffSuccess;
  allDiffs?: Map<string, AdvancedDiffSuccess>; // For patch tools with multiple files
  onApprove: (diffs?: Map<string, AdvancedDiffSuccess>) => void;
  onApproveAlways: (
    scope: "project" | "session",
    diffs?: Map<string, AdvancedDiffSuccess>,
  ) => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
  showPreview?: boolean;
  defaultScope?: "project" | "session";
  /** Override the auto-generated header text (e.g. "Edit memory system/persona/soul?") */
  headerOverride?: string;
};

// Horizontal line characters for Claude Code style
const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

/**
 * Determine diff kind based on tool name
 */
function getDiffKind(toolName: string): "write" | "edit" {
  return toolName.toLowerCase() === "write" ? "write" : "edit";
}

/**
 * InlineFileEditApproval - Renders file edit approval UI inline (Claude Code style)
 *
 * Uses horizontal lines instead of boxes for visual styling:
 * - ──── solid line at top
 * - ╌╌╌╌ dotted line around diff content
 * - Approval options below
 */
export const InlineFileEditApproval = memo(
  ({
    fileEdit,
    precomputedDiff,
    allDiffs,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
    showPreview = true,
    defaultScope = "project",
    headerOverride,
  }: Props) => {
    const columns = useTerminalWidth();
    useProgressIndicator();

    // Build diffs map to pass to approval handler (needed for line numbers in result)
    const diffsToPass = useMemo((): Map<string, AdvancedDiffSuccess> => {
      const diffs = new Map<string, AdvancedDiffSuccess>();
      const toolCallId = fileEdit.toolCallId;

      // For Edit/Write - single file diff
      if (precomputedDiff && toolCallId) {
        diffs.set(toolCallId, precomputedDiff);
        return diffs;
      }

      // For Patch tools - use allDiffs or parse patch input
      if (fileEdit.patchInput && toolCallId) {
        // First try to use allDiffs if available
        if (allDiffs) {
          const operations = parsePatchOperations(fileEdit.patchInput);
          for (const op of operations) {
            const key = `${toolCallId}:${op.path}`;
            const diff = allDiffs.get(key);
            if (diff) {
              diffs.set(key, diff);
            }
          }
        }

        // If no diffs found from allDiffs, parse patch hunks directly
        if (diffs.size === 0) {
          const operations = parsePatchOperations(fileEdit.patchInput);
          for (const op of operations) {
            const key = `${toolCallId}:${op.path}`;
            if (op.kind === "add" || op.kind === "update") {
              const result = parsePatchToAdvancedDiff(op.patchLines, op.path);
              if (result) {
                diffs.set(key, result);
              }
            }
          }
        }
      }

      return diffs;
    }, [fileEdit, precomputedDiff, allDiffs]);

    const diffsPayload = diffsToPass.size > 0 ? diffsToPass : undefined;

    // Generate horizontal lines
    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    const dottedLine = DOTTED_LINE.repeat(Math.max(columns, 10));
    // Shared with the committed preview and the transcript row model
    // (`@/cli/helpers/approval-info`).
    const headerText =
      headerOverride || fileEditApprovalHeaderText(fileEdit, existsSync);
    const diffKind = getDiffKind(fileEdit.toolName);

    // Memoize the static diff content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field
    const memoizedDiffContent = useMemo(
      () => (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            {headerText}
          </Text>

          {/* Dotted separator before diff content */}
          <Text dimColor>{dottedLine}</Text>

          {/* Diff preview */}
          <Box paddingLeft={0}>
            {fileEdit.patchInput ? (
              // Render patch operations (can be multiple files)
              <Box flexDirection="column">
                {parsePatchOperations(fileEdit.patchInput).map((op, idx) => {
                  // The display form of a patch target, shared with the
                  // transcript row model and the committed preview.
                  const displayPath = simpleDiffDisplayPath(op.path);

                  // Look up precomputed diff using toolCallId:path key
                  const diffKey = fileEdit.toolCallId
                    ? `${fileEdit.toolCallId}:${op.path}`
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
                  } else if (op.kind === "update") {
                    return (
                      <Box
                        key={`patch-update-${op.path}`}
                        flexDirection="column"
                      >
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
                  } else if (op.kind === "delete") {
                    return (
                      <Box
                        key={`patch-delete-${op.path}`}
                        flexDirection="column"
                      >
                        {idx > 0 && <Box height={1} />}
                        <Text dimColor>{displayPath}</Text>
                        <Text color="red">File will be deleted</Text>
                      </Box>
                    );
                  }
                  return null;
                })}
              </Box>
            ) : diffKind === "write" ? (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="write"
                filePath={fileEdit.filePath}
                content={fileEdit.content || ""}
                showHeader={false}
              />
            ) : (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="edit"
                filePath={fileEdit.filePath}
                oldString={fileEdit.oldString || ""}
                newString={fileEdit.newString || ""}
                replaceAll={fileEdit.replaceAll}
                showHeader={false}
              />
            )}
          </Box>

          {/* Dotted separator after diff content */}
          <Text dimColor>{dottedLine}</Text>
        </>
      ),
      // Use primitive values to avoid memo invalidation when parent re-renders.
      [
        fileEdit.filePath,
        fileEdit.content,
        fileEdit.oldString,
        fileEdit.newString,
        fileEdit.replaceAll,
        fileEdit.patchInput,
        fileEdit.toolCallId,
        precomputedDiff,
        allDiffs,
        solidLine,
        dottedLine,
        headerText,
        diffKind,
      ],
    );

    const optionsMarginTop = showPreview ? 1 : 0;

    return (
      <Box flexDirection="column">
        {/* Static diff content - memoized to prevent re-render on keystroke */}
        {showPreview && memoizedDiffContent}

        <ApprovalOptions
          allowPersistence={allowPersistence}
          alwaysLabel={approveAlwaysText || DEFAULT_APPROVE_ALWAYS_LABEL}
          isFocused={isFocused}
          marginTop={optionsMarginTop}
          onApprove={() => onApprove(diffsPayload)}
          onApproveAlways={() => onApproveAlways(defaultScope, diffsPayload)}
          onCancel={onCancel}
          onDeny={onDeny}
        />
      </Box>
    );
  },
);

InlineFileEditApproval.displayName = "InlineFileEditApproval";
