import { Box } from "ink";
import { memo } from "react";
import { AdvancedDiffRenderer } from "@/cli/components/AdvancedDiffRenderer";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import type { FileEditApprovalInfo } from "@/cli/helpers/approval-info";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { simpleDiffDisplayPath } from "@/cli/helpers/diff-rows";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import { dottedRule, solidRule } from "@/cli/helpers/rule-lines";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";

type Props = {
  /** Parsed file-edit args: the tool name, the path, and one body's worth of them. */
  info: FileEditApprovalInfo;
  /** The header row. The caller owns the existence probe and any override. */
  headerText: string;
  /** Diff precomputed for a single edit or write, keyed by the tool call id. */
  precomputedDiff?: AdvancedDiffSuccess;
  /** Per-operation diffs for a patch, keyed `toolCallId:path`. */
  allDiffs?: ReadonlyMap<string, AdvancedDiffSuccess>;
  /**
   * Whether a single edit/write draws the advanced diff's own header.
   *
   * The committed preview shows it; the inline approval suppresses it because
   * the header row above already says what is changing. Patch operations
   * suppress it on both surfaces, each block labelling its own path.
   */
  showDiffHeader: boolean;
};

/**
 * FileEditPreview - the body of a file edit/write/patch approval preview.
 *
 * One body, two surfaces. `ApprovalPreview` paints it into the transcript when
 * an approval is committed early (to keep a tall preview out of the live area),
 * and `InlineFileEditApproval` paints it in the live area while the approval is
 * being answered. Each had its own copy, and the copies had drifted apart:
 *
 * - a patch's delete block was `Delete x` on the committed side and the red
 *   "File will be deleted" inline, and the committed one dropped the blank row
 *   between two operations entirely — because its separator sat in a row
 *   direction box, where a width-less spacer is zero rows. The transcript row
 *   model counts that row, so the eager-commit measurement and the painted item
 *   disagreed about a patch containing a delete;
 * - a single-file body was picked by which argument happened to be present on
 *   the committed side and by the tool name inline, so a legacy
 *   `str_replace_editor` carrying neither drew nothing where the row model
 *   measured a diff.
 *
 * What stays with the callers is their own policy: the header row (the write
 * case probes the filesystem, and the live surface may override the text) and
 * `showDiffHeader`.
 */
export const FileEditPreview = memo(
  ({ info, headerText, precomputedDiff, allDiffs, showDiffHeader }: Props) => {
    const columns = useTerminalWidth();
    const solidLine = solidRule(columns);
    const dottedLine = dottedRule(columns);

    if (info.patchInput) {
      const operations = parsePatchOperations(info.patchInput);
      return (
        <Box flexDirection="column">
          <Text dimColor>{solidLine}</Text>
          <Text bold color={colors.approval.header}>
            {headerText}
          </Text>
          <Text dimColor>{dottedLine}</Text>

          <Box flexDirection="column">
            {operations.map((op, index) => {
              // The display form of a patch target, shared with the transcript
              // row model and the patch result renderer.
              const displayPath = simpleDiffDisplayPath(op.path);
              // Look up the precomputed diff using the compound key.
              const operationDiff = info.toolCallId
                ? allDiffs?.get(`${info.toolCallId}:${op.path}`)
                : undefined;

              return (
                <Box key={`patch-${op.kind}-${op.path}`} flexDirection="column">
                  {index > 0 && <Box height={1} />}
                  <Text dimColor>{displayPath}</Text>
                  {op.kind === "delete" ? (
                    <Text color="red">File will be deleted</Text>
                  ) : op.kind === "add" ? (
                    <AdvancedDiffRenderer
                      precomputed={operationDiff}
                      kind="write"
                      filePath={op.path}
                      content={op.content}
                      showHeader={false}
                    />
                  ) : (
                    <AdvancedDiffRenderer
                      precomputed={operationDiff}
                      kind="edit"
                      filePath={op.path}
                      oldString={op.oldString}
                      newString={op.newString}
                      showHeader={false}
                    />
                  )}
                </Box>
              );
            })}
          </Box>

          <Text dimColor>{dottedLine}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{solidLine}</Text>
        <Text bold color={colors.approval.header}>
          {headerText}
        </Text>
        <Text dimColor>{dottedLine}</Text>

        {/* The tool name picks the body, not the argument that happens to be
         * present: this is the same rule the row model measures by. */}
        {info.toolName.toLowerCase() === "write" ? (
          <AdvancedDiffRenderer
            precomputed={precomputedDiff}
            kind="write"
            filePath={info.filePath}
            content={info.content ?? ""}
            showHeader={showDiffHeader}
          />
        ) : (
          <AdvancedDiffRenderer
            precomputed={precomputedDiff}
            kind="edit"
            filePath={info.filePath}
            oldString={info.oldString ?? ""}
            newString={info.newString ?? ""}
            replaceAll={info.replaceAll}
            showHeader={showDiffHeader}
          />
        )}

        <Text dimColor>{dottedLine}</Text>
      </Box>
    );
  },
);

FileEditPreview.displayName = "FileEditPreview";
