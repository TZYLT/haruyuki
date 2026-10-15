import { existsSync } from "node:fs";
import { Box } from "ink";
import { memo } from "react";
import { fileEditApprovalHeaderText } from "@/cli/helpers/approval-info";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import {
  isFileEditPreviewTool,
  isShellTool,
} from "@/cli/helpers/tool-name-mapping";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { colors } from "./colors";
import { BashPreview } from "./previews/BashPreview";
import { Text } from "./Text";

const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

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
 */
export const ApprovalPreview = memo(
  ({ toolName, toolArgs, precomputedDiff, allDiffs, toolCallId }: Props) => {
    const columns = useTerminalWidth();
    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    const dottedLine = DOTTED_LINE.repeat(Math.max(columns, 10));

    // Bash/Shell: Use BashPreview component
    if (isShellTool(toolName)) {
      try {
        const args = JSON.parse(toolArgs);
        let command = "";
        let description = "";
        if (toolName === "exec_command") {
          command = typeof args.cmd === "string" ? args.cmd : "";
          description =
            typeof args.description === "string" ? args.description : "";
        } else if (toolName === "write_stdin") {
          const sessionId =
            typeof args.session_id === "string" ||
            typeof args.session_id === "number"
              ? String(args.session_id)
              : "unknown";
          command = `write_stdin ${sessionId}`;
          description =
            typeof args.chars === "string" && args.chars.length > 0
              ? "Write input to running shell session"
              : "Poll running shell session";
        } else {
          command = typeof args.command === "string" ? args.command : "";
          description =
            typeof args.description === "string" ? args.description : "";
        }

        return (
          <Box flexDirection="column">
            <BashPreview command={command} description={description} />
          </Box>
        );
      } catch {
        // Fall through to generic
      }
    }

    // File Edit tools: Render diff preview
    if (isFileEditPreviewTool(toolName)) {
      try {
        const args = JSON.parse(toolArgs);
        // Shared with the inline approval and the transcript row model.
        const headerText = fileEditApprovalHeaderText(
          {
            toolName,
            filePath: args.file_path || "",
            patchInput: toolName === "ApplyPatch" ? args.input : undefined,
          },
          existsSync,
        );

        // Handle ApplyPatch (can have multiple files)
        if (args.input && toolName === "ApplyPatch") {
          const operations = parsePatchOperations(args.input);

          return (
            <Box flexDirection="column">
              <Text dimColor>{solidLine}</Text>
              <Text bold color={colors.approval.header}>
                {headerText}
              </Text>
              <Text dimColor>{dottedLine}</Text>

              <Box flexDirection="column">
                {operations.map((op, idx) => {
                  const { relative } = require("node:path");
                  const cwd = process.cwd();
                  const relPath = relative(cwd, op.path);
                  const displayPath = relPath.startsWith("..")
                    ? op.path
                    : relPath;

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

              <Text dimColor>{dottedLine}</Text>
            </Box>
          );
        }

        // Single file edit/write
        const filePath = args.file_path || "";

        return (
          <Box flexDirection="column">
            <Text dimColor>{solidLine}</Text>
            <Text bold color={colors.approval.header}>
              {headerText}
            </Text>
            <Text dimColor>{dottedLine}</Text>

            {/* Write */}
            {args.content !== undefined && (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="write"
                filePath={filePath}
                content={args.content}
              />
            )}

            {/* Single edit */}
            {args.old_string !== undefined && (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="edit"
                filePath={filePath}
                oldString={args.old_string || ""}
                newString={args.new_string || ""}
                replaceAll={args.replace_all}
              />
            )}

            <Text dimColor>{dottedLine}</Text>
          </Box>
        );
      } catch {
        // Fall through to generic
      }
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
