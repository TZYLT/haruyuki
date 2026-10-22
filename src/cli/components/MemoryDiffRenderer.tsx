import * as Diff from "diff";
import { Box } from "ink";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  memoryContentWidth,
  memoryContextWidth,
  selectMemoryDiffRows,
} from "@/cli/helpers/memory-diff-rows";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { colors } from "./colors";
import { Text } from "./Text";

interface MemoryDiffRendererProps {
  argsText: string;
  toolName: string;
}

function stringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function memoryBlockName(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Renders a diff view for memory tool operations.
 * Handles both `memory` (command-based) and `memory_apply_patch` (unified diff) tools.
 */
export function MemoryDiffRenderer({
  argsText,
  toolName,
}: MemoryDiffRendererProps) {
  const columns = useTerminalWidth();

  try {
    const args = JSON.parse(argsText) as Record<string, unknown>;

    // Handle memory_apply_patch tool (codex-style apply_patch input)
    if (toolName === "memory_apply_patch") {
      const patch = typeof args.input === "string" ? args.input : "";
      return (
        <PatchDiffRenderer label="memory" patch={patch} columns={columns} />
      );
    }

    // Handle memory tool (command-based)
    const command = args.command as string;
    const path = stringArg(args, "file_path", "path", "old_path") ?? "unknown";

    // Extract just the block name from the path (e.g., "/memories/project" -> "project")
    const blockName = memoryBlockName(path);

    switch (command) {
      case "str_replace": {
        const oldStr = stringArg(args, "old_string", "old_str") ?? "";
        const newStr = stringArg(args, "new_string", "new_str") ?? "";
        return (
          <MemoryStrReplaceDiff
            blockName={blockName}
            oldStr={oldStr}
            newStr={newStr}
            columns={columns}
          />
        );
      }

      case "insert": {
        const insertText = stringArg(args, "insert_text") ?? "";
        const insertLine = args.insert_line;
        const prefixWidth = 4; // "    " indent
        const contentWidth = memoryContentWidth(columns);
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>{CLI_GLYPHS.result}</Text>
                </Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  Inserted into memory block{" "}
                  <Text bold color={colors.tool.memoryName}>
                    {blockName}
                  </Text>
                  {insertLine !== undefined && ` at line ${insertLine}`}
                </Text>
              </Box>
            </Box>
            {insertText.split("\n").map((line: string, i: number) => (
              <Box
                key={`insert-${i}-${line.substring(0, 20)}`}
                flexDirection="row"
              >
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{"    "}</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text
                    backgroundColor={colors.diff.addedLineBg}
                    color={colors.diff.textOnTint}
                    wrap="wrap"
                  >
                    {`+ ${line}`}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        );
      }

      case "create": {
        const description = stringArg(args, "description") ?? "";
        const fileText = stringArg(args, "file_text") ?? "";
        const prefixWidth = 4; // "    " indent
        const contentWidth = memoryContentWidth(columns);
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>{CLI_GLYPHS.result}</Text>
                </Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  Created memory block{" "}
                  <Text bold color={colors.tool.memoryName}>
                    {blockName}
                  </Text>
                  {description && (
                    <Text dimColor> - {truncate(description, 40)}</Text>
                  )}
                </Text>
              </Box>
            </Box>
            {fileText
              ?.split("\n")
              .slice(0, 3)
              .map((line: string, i: number) => (
                <Box
                  key={`create-${i}-${line.substring(0, 20)}`}
                  flexDirection="row"
                >
                  <Box width={prefixWidth} flexShrink={0}>
                    <Text>{"    "}</Text>
                  </Box>
                  <Box flexGrow={1} width={contentWidth}>
                    <Text
                      backgroundColor={colors.diff.addedLineBg}
                      color={colors.diff.textOnTint}
                      wrap="wrap"
                    >
                      {`+ ${truncate(line, 60)}`}
                    </Text>
                  </Box>
                </Box>
              ))}
            {fileText && fileText.split("\n").length > 3 && (
              <Text dimColor>
                {"    "}... and {fileText.split("\n").length - 3} more lines
              </Text>
            )}
          </Box>
        );
      }

      case "delete": {
        const prefixWidth = 4;
        const contentWidth = memoryContentWidth(columns);
        return (
          <Box flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>{CLI_GLYPHS.result}</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text wrap="wrap">
                Deleted memory block{" "}
                <Text bold color={colors.tool.memoryName}>
                  {blockName}
                </Text>
              </Text>
            </Box>
          </Box>
        );
      }

      case "rename": {
        const newPath = stringArg(args, "new_path") ?? "";
        const newBlockName = memoryBlockName(newPath);
        const description = args.description;
        const prefixWidth = 4;
        const contentWidth = memoryContentWidth(columns);
        if (description) {
          return (
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>{CLI_GLYPHS.result}</Text>
                </Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  Updated description of{" "}
                  <Text bold color={colors.tool.memoryName}>
                    {blockName}
                  </Text>
                </Text>
              </Box>
            </Box>
          );
        }
        return (
          <Box flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>{CLI_GLYPHS.result}</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text wrap="wrap">
                Renamed{" "}
                <Text bold color={colors.tool.memoryName}>
                  {blockName}
                </Text>{" "}
                to{" "}
                <Text bold color={colors.tool.memoryName}>
                  {newBlockName}
                </Text>
              </Text>
            </Box>
          </Box>
        );
      }

      default: {
        const defaultPrefixWidth = 4;
        const defaultContentWidth = memoryContentWidth(columns);
        return (
          <Box flexDirection="row">
            <Box width={defaultPrefixWidth} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>{CLI_GLYPHS.result}</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={defaultContentWidth}>
              <Text wrap="wrap">
                Memory operation: {command} on{" "}
                <Text bold color={colors.tool.memoryName}>
                  {blockName}
                </Text>
              </Text>
            </Box>
          </Box>
        );
      }
    }
  } catch {
    // If parsing fails, return null to fall through to regular handling
    return null;
  }
}

/**
 * Renders a str_replace diff with line-level diffing and word-level highlighting.
 * Uses Diff.diffLines() to only show lines that actually changed,
 * instead of showing all old lines then all new lines.
 */
function MemoryStrReplaceDiff({
  blockName,
  oldStr,
  newStr,
  columns,
}: {
  blockName: string;
  oldStr: string;
  newStr: string;
  columns: number;
}) {
  // Which changed lines are drawn is shared with the transcript row model
  // (`helpers/memory-diff-rows.ts`): the model predicts this block's height, and
  // two copies of "which rows show" is how the viewport drifts from the screen.
  const { rows: displayRows, hiddenCount } = selectMemoryDiffRows(
    oldStr,
    newStr,
  );

  const prefixWidth = 4;
  const contentWidth = memoryContentWidth(columns);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={prefixWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>{CLI_GLYPHS.result}</Text>
          </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            Updated memory block{" "}
            <Text bold color={colors.tool.memoryName}>
              {blockName}
            </Text>
          </Text>
        </Box>
      </Box>

      {displayRows.map((row, i) => (
        <DiffLine
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional output
          key={`diff-${i}-${row.type}-${row.content.substring(0, 20)}`}
          type={row.type}
          content={row.content}
          compareContent={row.pairContent}
          columns={columns}
        />
      ))}

      {hiddenCount > 0 && (
        <Text dimColor>
          {"    "}... {hiddenCount} more lines
        </Text>
      )}
    </Box>
  );
}

/**
 * Single diff line with word-level highlighting
 */
function DiffLine({
  type,
  content,
  compareContent,
  columns,
}: {
  type: "add" | "remove";
  content: string;
  compareContent?: string;
  columns: number;
}) {
  const prefix = type === "add" ? "+" : "-";
  const lineBg =
    type === "add" ? colors.diff.addedLineBg : colors.diff.removedLineBg;
  const wordBg =
    type === "add" ? colors.diff.addedWordBg : colors.diff.removedWordBg;

  const prefixWidth = 4; // "    " indent
  const contentWidth = memoryContentWidth(columns);

  // Word-level diff if we have something to compare
  if (compareContent !== undefined && content.trim() && compareContent.trim()) {
    const wordDiffs =
      type === "add"
        ? Diff.diffWords(compareContent, content)
        : Diff.diffWords(content, compareContent);

    return (
      <Box flexDirection="row">
        <Box width={prefixWidth} flexShrink={0}>
          <Text>{"    "}</Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            <Text backgroundColor={lineBg} color={colors.diff.textOnTint}>
              {`${prefix} `}
            </Text>
            {wordDiffs.map((part, i) => {
              if (part.added && type === "add") {
                return (
                  <Text
                    key={`w-${i}-${part.value.substring(0, 10)}`}
                    backgroundColor={wordBg}
                    color={colors.diff.textOnTint}
                  >
                    {part.value}
                  </Text>
                );
              } else if (part.removed && type === "remove") {
                return (
                  <Text
                    key={`w-${i}-${part.value.substring(0, 10)}`}
                    backgroundColor={wordBg}
                    color={colors.diff.textOnTint}
                  >
                    {part.value}
                  </Text>
                );
              } else if (!part.added && !part.removed) {
                return (
                  <Text
                    key={`w-${i}-${part.value.substring(0, 10)}`}
                    backgroundColor={lineBg}
                    color={colors.diff.textOnTint}
                  >
                    {part.value}
                  </Text>
                );
              }
              return null;
            })}
          </Text>
        </Box>
      </Box>
    );
  }

  // Simple line without word diff
  return (
    <Box flexDirection="row">
      <Box width={prefixWidth} flexShrink={0}>
        <Text>{"    "}</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        <Text
          backgroundColor={lineBg}
          color={colors.diff.textOnTint}
          wrap="wrap"
        >
          {`${prefix} ${content}`}
        </Text>
      </Box>
    </Box>
  );
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * Renders a unified-diff patch from memory_apply_patch tool
 */
function PatchDiffRenderer({
  label,
  patch,
  columns,
}: {
  label: string;
  patch: string;
  columns: number;
}) {
  const lines = patch.split("\n");
  const maxLines = 8;
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;

  const prefixWidth = 4; // "    " indent
  const contentWidth = memoryContentWidth(columns);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={prefixWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>{CLI_GLYPHS.result}</Text>
          </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            Patched memory block{" "}
            <Text bold color={colors.tool.memoryName}>
              {label}
            </Text>
          </Text>
        </Box>
      </Box>
      {displayLines.map((line, i) => {
        // Skip @@ hunk headers
        if (line.startsWith("@@")) {
          return null;
        }

        const firstChar = line[0];
        const content = line.slice(1); // Remove the prefix character

        if (firstChar === "+") {
          return (
            <Box
              key={`patch-${i}-${line.substring(0, 20)}`}
              flexDirection="row"
            >
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{"    "}</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text
                  backgroundColor={colors.diff.addedLineBg}
                  color={colors.diff.textOnTint}
                  wrap="wrap"
                >
                  {`+ ${content}`}
                </Text>
              </Box>
            </Box>
          );
        } else if (firstChar === "-") {
          return (
            <Box
              key={`patch-${i}-${line.substring(0, 20)}`}
              flexDirection="row"
            >
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{"    "}</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text
                  backgroundColor={colors.diff.removedLineBg}
                  color={colors.diff.textOnTint}
                  wrap="wrap"
                >
                  {`- ${content}`}
                </Text>
              </Box>
            </Box>
          );
        } else if (firstChar === " ") {
          // Context line - show dimmed
          return (
            <Box
              key={`patch-${i}-${line.substring(0, 20)}`}
              flexDirection="row"
            >
              <Box width={prefixWidth + 2} flexShrink={0}>
                <Text dimColor>{"      "}</Text>
              </Box>
              <Box flexGrow={1} width={memoryContextWidth(columns)}>
                <Text dimColor wrap="wrap">
                  {content}
                </Text>
              </Box>
            </Box>
          );
        }
        // Unknown format, show as-is
        return (
          <Box key={`patch-${i}-${line.substring(0, 20)}`} flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text dimColor>{"    "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text dimColor wrap="wrap">
                {line}
              </Text>
            </Box>
          </Box>
        );
      })}
      {hasMore && (
        <Text dimColor>
          {"    "}... {lines.length - maxLines} more lines
        </Text>
      )}
    </Box>
  );
}
