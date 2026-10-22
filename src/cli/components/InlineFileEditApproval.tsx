import { existsSync } from "node:fs";
import { Box } from "ink";
import { memo, useMemo } from "react";
import {
  type FileEditApprovalInfo,
  fileEditApprovalHeaderText,
} from "@/cli/helpers/approval-info";
import { DEFAULT_APPROVE_ALWAYS_LABEL } from "@/cli/helpers/approval-layout";
import {
  type AdvancedDiffSuccess,
  parsePatchToAdvancedDiff,
} from "@/cli/helpers/diff";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import { ApprovalOptions } from "./ApprovalOptions";
import { FileEditPreview } from "./previews/FileEditPreview";

type Props = {
  fileEdit: FileEditApprovalInfo;
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
  /** `O`: hand this approval's diff to the full-screen diff face. */
  onOpenDiffFace?: (diffs: Map<string, AdvancedDiffSuccess>) => void;
};

/**
 * InlineFileEditApproval - Renders file edit approval UI inline (Claude Code style)
 *
 * The preview body is `FileEditPreview`, shared with the committed preview the
 * transcript paints once an approval's preview has been flushed to `<Static>`;
 * what lives here is the live surface's own policy -- the options that answer
 * the approval, the diffs collected for the result, and the existence probe
 * behind the header.
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
    onOpenDiffFace,
  }: Props) => {
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

    // Shared with the committed preview and the transcript row model
    // (`@/cli/helpers/approval-info`).
    const headerText =
      headerOverride || fileEditApprovalHeaderText(fileEdit, existsSync);

    // Memoize the static diff content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field.
    //
    // The memo depends on the parsed fields rather than on `fileEdit`, which the
    // approval dispatch rebuilds on every render: a fresh object would invalidate
    // this on each keystroke and re-render the whole diff. The width is not a
    // dependency either -- `FileEditPreview` reads it with the same hook every
    // diff renderer already uses, and a resize re-renders it from there.
    const memoizedDiffContent = useMemo(
      () => (
        <FileEditPreview
          info={{
            toolName: fileEdit.toolName,
            filePath: fileEdit.filePath,
            content: fileEdit.content,
            oldString: fileEdit.oldString,
            newString: fileEdit.newString,
            replaceAll: fileEdit.replaceAll,
            patchInput: fileEdit.patchInput,
            toolCallId: fileEdit.toolCallId,
          }}
          headerText={headerText}
          precomputedDiff={precomputedDiff}
          allDiffs={allDiffs}
          showDiffHeader={false}
        />
      ),
      [
        fileEdit.toolName,
        fileEdit.filePath,
        fileEdit.content,
        fileEdit.oldString,
        fileEdit.newString,
        fileEdit.replaceAll,
        fileEdit.patchInput,
        fileEdit.toolCallId,
        headerText,
        precomputedDiff,
        allDiffs,
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
          onOpenDiffFace={
            onOpenDiffFace && diffsPayload
              ? () => onOpenDiffFace(diffsPayload)
              : undefined
          }
        />
      </Box>
    );
  },
);

InlineFileEditApproval.displayName = "InlineFileEditApproval";
