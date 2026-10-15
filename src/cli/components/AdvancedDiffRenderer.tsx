import { Box } from "ink";
import { useMemo } from "react";
import {
  ADV_DIFF_CONTEXT_LINES,
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
} from "@/cli/helpers/diff";
import {
  advancedDiffHeaderPath,
  advancedDiffHeaderText,
  buildAdvancedDiffRows,
  buildDiffLineChunks,
  type DiffSyntaxSpan,
  diffGutterWidth,
} from "@/cli/helpers/diff-rows";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { paddedRows } from "@/cli/helpers/text-metrics";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { colors } from "./colors";
import { EditRenderer, WriteRenderer } from "./DiffRenderer";
import {
  highlightCode,
  languageFromPath,
  type StyledSpan,
} from "./SyntaxHighlightedCommand";
import { Text } from "./Text";

const HIGHLIGHT_MAX_BYTES = 512 * 1024;
const HIGHLIGHT_MAX_LINES = 10_000;

type Props =
  | {
      kind: "write";
      filePath: string;
      content: string;
      showHeader?: boolean;
      oldContentOverride?: string;
    }
  | {
      kind: "edit";
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
      showHeader?: boolean;
      oldContentOverride?: string;
    };

export function exceedsAdvancedDiffHighlightLimits(
  hunks: AdvancedDiffSuccess["hunks"],
): boolean {
  let totalBytes = 0;
  let totalLines = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const raw = line.raw || "";
      if (raw.charAt(0) === "\\") continue;
      totalBytes += Buffer.byteLength(raw.slice(1), "utf8");
      totalLines += 1;
      if (
        totalBytes > HIGHLIGHT_MAX_BYTES ||
        totalLines > HIGHLIGHT_MAX_LINES
      ) {
        return true;
      }
    }
  }

  return false;
}

// Render a single diff line split into full-width rows.
// Each visual row gets its own <Text> with backgroundColor so there are no gaps.
// See ~/dev/codex/codex-rs/tui/src/diff_render.rs lines 836-936.
function Line({
  kind,
  displayNo,
  text,
  syntaxSpans,
  gutterWidth,
  columns,
  indent,
}: {
  kind: "context" | "remove" | "add";
  displayNo: number;
  text: string;
  syntaxSpans?: DiffSyntaxSpan[];
  gutterWidth: number;
  columns: number;
  indent: string;
}) {
  const bgLine =
    kind === "add"
      ? colors.diff.addedLineBg
      : kind === "remove"
        ? colors.diff.removedLineBg
        : colors.diff.contextLineBg;

  // The row split is shared with the transcript row model (`diff-rows`), which
  // counts these rows without rendering; the role→colour mapping stays here.
  const { chunks, contIndent } = buildDiffLineChunks(
    {
      kind,
      displayNo,
      text,
      syntaxSpanTexts: syntaxSpans?.map((span) => span.text),
    },
    { indent, gutterWidth },
  );
  const symbolColor =
    kind === "add"
      ? colors.diff.symbolAdd
      : kind === "remove"
        ? colors.diff.symbolRemove
        : colors.diff.symbolContext;
  const rows = paddedRows(
    chunks.map((chunk) => ({
      text: chunk.text,
      color:
        chunk.role === "symbol"
          ? symbolColor
          : chunk.syntaxIndex === undefined
            ? undefined
            : syntaxSpans?.[chunk.syntaxIndex]?.color,
      dimColor: chunk.role === "gutter" && kind === "context",
    })),
    columns,
    contIndent,
  );

  return (
    <>
      {rows.map((row, ri) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static, never reorder
        <Text key={ri} backgroundColor={bgLine} dimColor={kind === "remove"}>
          {row.map((c, ci) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: chunks are static
            <Text key={ci} color={c.color} dimColor={c.dimColor}>
              {c.text}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

export function AdvancedDiffRenderer(
  props: Props & { precomputed?: AdvancedDiffSuccess },
) {
  // Must call hooks at top level before any early returns
  const columns = useTerminalWidth();

  const result = useMemo(() => {
    if (props.precomputed) return props.precomputed;
    if (props.kind === "write") {
      return computeAdvancedDiff(
        { kind: "write", filePath: props.filePath, content: props.content },
        { oldStrOverride: props.oldContentOverride },
      );
    }
    return computeAdvancedDiff(
      {
        kind: "edit",
        filePath: props.filePath,
        oldString: props.oldString,
        newString: props.newString,
        replaceAll: props.replaceAll,
      },
      { oldStrOverride: props.oldContentOverride },
    );
  }, [props]);

  const showHeader = props.showHeader !== false; // default to true

  if (result.mode === "fallback") {
    // Render simple arg-based fallback for readability
    const filePathForFallback = (props as { filePath: string }).filePath;
    if (props.kind === "write") {
      return (
        <WriteRenderer filePath={filePathForFallback} content={props.content} />
      );
    }
    return (
      <EditRenderer
        filePath={filePathForFallback}
        oldString={props.oldString}
        newString={props.newString}
      />
    );
  }

  if (result.mode === "unpreviewable") {
    const gutterWidth = 4;
    return (
      <Box flexDirection="row">
        <Box width={gutterWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>{CLI_GLYPHS.result}</Text>
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text wrap="wrap" dimColor>
            Cannot preview changes: {result.reason}
          </Text>
        </Box>
      </Box>
    );
  }

  const { hunks } = result;
  const filePath = (props as { filePath: string }).filePath;

  // Syntax-highlight all hunk content at once per hunk (preserves parser state
  // across consecutive lines, like Codex's hunk-level highlighting approach).
  const lang = languageFromPath(filePath);
  const shouldHighlight = lang && !exceedsAdvancedDiffHighlightLimits(hunks);
  const hunkSyntaxLines: (StyledSpan[] | undefined)[][] = [];
  for (const h of hunks) {
    // Concatenate all displayable lines in the hunk for a single highlight pass.
    const textLines: string[] = [];
    for (const line of h.lines) {
      if (!line) continue;
      const raw = line.raw || "";
      if (raw.charAt(0) === "\\") continue; // skip meta
      textLines.push(raw.slice(1));
    }
    const block = textLines.join("\n");
    const highlighted = shouldHighlight
      ? highlightCode(block, lang)
      : undefined;
    const syntaxLines =
      highlighted?.length === textLines.length ? highlighted : undefined;
    // Map highlighted per-line spans back; undefined when highlighting failed.
    hunkSyntaxLines.push(textLines.map((_, i) => syntaxLines?.[i]));
  }

  const rows = buildAdvancedDiffRows(hunks, hunkSyntaxLines);
  // Gutter width fits the largest display number we will render, so multi-digit
  // line numbers (e.g., 10) never wrap. Shared with the row model.
  const gutterWidth = diffGutterWidth(rows.map((row) => row.displayNo));

  const header = advancedDiffHeaderText(props.kind, filePath);

  // If no changes (empty diff), show a message with filepath
  if (rows.length === 0) {
    const noChangesGutter = 4;
    return (
      <Box flexDirection="column">
        {showHeader ? (
          <Box flexDirection="row">
            <Box width={noChangesGutter} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>{CLI_GLYPHS.result}</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - noChangesGutter)}>
              <Text wrap="wrap">{header}</Text>
            </Box>
          </Box>
        ) : null}
        <Box flexDirection="row">
          <Box width={noChangesGutter} flexShrink={0}>
            <Text>{"    "}</Text>
          </Box>
          <Box flexGrow={1} width={Math.max(0, columns - noChangesGutter)}>
            <Text dimColor>
              No changes to <Text bold>{advancedDiffHeaderPath(filePath)}</Text>{" "}
              (file content identical)
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Gutter width for `  └` prefix (4 chars: 2 spaces + └ + space)
  const toolResultGutter = 4;

  return (
    <Box flexDirection="column">
      {showHeader ? (
        <>
          <Box flexDirection="row">
            <Box width={toolResultGutter} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>{CLI_GLYPHS.result}</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - toolResultGutter)}>
              <Text wrap="wrap">{header}</Text>
            </Box>
          </Box>
          <Box flexDirection="row">
            <Box width={toolResultGutter} flexShrink={0}>
              <Text>{"    "}</Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - toolResultGutter)}>
              <Text
                dimColor
              >{`Showing ~${ADV_DIFF_CONTEXT_LINES} context line${ADV_DIFF_CONTEXT_LINES === 1 ? "" : "s"}`}</Text>
            </Box>
          </Box>
        </>
      ) : null}
      {rows.map((r, idx) => (
        <Line
          key={`row-${idx}-${r.kind}-${r.displayNo || idx}`}
          kind={r.kind}
          displayNo={r.displayNo}
          text={r.text}
          syntaxSpans={r.syntaxSpans}
          gutterWidth={gutterWidth}
          columns={columns}
          indent={showHeader ? " ".repeat(toolResultGutter) : ""}
        />
      ))}
    </Box>
  );
}
