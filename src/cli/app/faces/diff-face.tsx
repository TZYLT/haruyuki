import { Box, type DOMElement, measureElement, useStdout } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import {
  CHROME_RESERVE_ROWS,
  useChromeHeight,
  useMeasuredChromeHeight,
} from "@/cli/app/chrome-height";
import { TAB_STRIP_ROWS } from "@/cli/app/shell/tab-strip-layout";
import { ViewportPanel } from "@/cli/app/ViewportPanel";
import { AdvancedDiffLine } from "@/cli/components/AdvancedDiffRenderer";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { useRowHovered } from "@/cli/helpers/hover-store";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import { solidRule } from "@/cli/helpers/rule-lines";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useMouseRows } from "@/cli/helpers/use-mouse-rows";
import {
  useInputScopeClaim,
  useKeyBindings,
} from "@/cli/hooks/use-input-router";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import { pushToast } from "@/cli/notifications/toast-store";
import {
  type DiffFaceRow,
  diffFaceFoldTarget,
  diffFaceHunkFolds,
  diffFaceHunkStarts,
  diffFaceLineLayout,
  diffFaceMaxOffset,
  diffFaceRows,
  diffFaceTotals,
  diffFaceWindow,
} from "./diff-face-model";
import { getDiffFaceSource, subscribeToDiffFace } from "./diff-face-store";

/**
 * The full-screen diff face (M6-P8).
 *
 * It takes the band: the shell renders it as the transcript region while
 * `activeOverlay === "diff"`, which is what makes it a *face* in 《38》§13.2's
 * sense — raised for a moment, keyboard-owning, leaving nothing behind — without
 * adding a tab. The overlay route is also what answers the two safety questions a
 * bare "modal" claim could not: the composer is disabled, and a pending approval
 * is dropped from the focused slot (so no key here can approve the tool the face
 * was opened to read).
 *
 * **Two columns above 90, one below** (《38》§16.2): the file rail on the left with
 * each file's `+N −M`, the content on the right under a `[3/12] path` breadcrumb.
 * Narrow terminals keep the breadcrumb and switch files with `[` / `]`.
 *
 * **Context is folded, not hidden**: a run of three or more unchanged lines is one
 * `… N lines` row; `Space` opens the first fold at or below the top of the screen
 * (or every run of the hunk the screen starts in), a click does the same to the row
 * it landed on, and `{` / `}` jump between hunks. Nothing here writes: the face is a
 * reader, and `O` hands the same worktree to the browser viewer for the cases a
 * terminal cannot serve well.
 */

/** Below this many columns the rail folds away and the breadcrumb carries the file. */
export const DIFF_FACE_TWO_COLUMN_MIN = 90;

/** Rail width: wide enough for a file name and its counts. */
const RAIL_WIDTH = 34;
const RAIL_WIDTH_NARROW = 28;

/** How many rows one wheel notch moves the face. */
const DIFF_FACE_WHEEL_ROWS = 3;

/** The two row blocks the pointer can aim at. */
const FILES_AREA = "diff-files";
const ROWS_AREA = "diff-rows";

export function DiffFaceHost(props: AppViewProps) {
  const { closeOverlay } = props;
  const source = useDiffFaceSource();
  const files = source?.files ?? [];

  // Geometry, exactly the band's rule (`ViewportTranscript`): terminal rows minus
  // the chrome and the panel measured on the previous frame, minus the shell's own
  // top rows — then clipped to the height Yoga actually gave the band.
  const terminalRows = useTerminalRows();
  const chromeRows = useChromeHeight();
  const { ref: panelRef, rows: panelRows } = useMeasuredChromeHeight();
  const { ref: bandRef, rows: measuredBandRows } = useMeasuredChromeHeight();
  const height = Math.max(
    1,
    terminalRows -
      (chromeRows ?? CHROME_RESERVE_ROWS) -
      (panelRows ?? 0) -
      TAB_STRIP_ROWS,
  );
  const bandHeight = Math.min(height, measuredBandRows ?? height);

  const { stdout } = useStdout();
  const inkColumns =
    typeof stdout?.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : undefined;
  const columns =
    inkColumns === undefined
      ? props.columns
      : Math.min(props.columns, inkColumns);
  const twoColumn = columns >= DIFF_FACE_TWO_COLUMN_MIN;
  const railWidth = columns < 110 ? RAIL_WIDTH_NARROW : RAIL_WIDTH;
  const contentColumns = twoColumn
    ? Math.max(1, columns - railWidth)
    : Math.max(1, columns);

  const [fileIndex, setFileIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // A new payload is a new file list: the cursor, the scroll position and the
  // folds all belong to the diff that was open, not to the one that replaced it.
  useEffect(() => {
    // `source` is the trigger, not data: the files were read from it above.
    void source;
    setFileIndex(0);
    setOffset(0);
    setExpanded(new Set<string>());
  }, [source]);

  const current = files[Math.min(fileIndex, Math.max(0, files.length - 1))];
  const rows = useMemo(
    () => (current ? diffFaceRows(current, expanded, fileIndex) : []),
    [current, expanded, fileIndex],
  );
  const layout = useMemo(() => diffFaceLineLayout(rows), [rows]);
  const hunkFolds = useMemo(
    () => (current ? diffFaceHunkFolds(current, fileIndex) : []),
    [current, fileIndex],
  );
  const foldsOf = useCallback(
    (hunkIndex: number): string[] =>
      hunkFolds.find((hunk) => hunk.hunkIndex === hunkIndex)?.keys ?? [],
    [hunkFolds],
  );

  // Title, rule, footer: the rest is the two-column region.
  const regionHeight = Math.max(1, bandHeight - 3);
  const bodyHeight = Math.max(1, regionHeight - 1);

  const window = diffFaceWindow({ rows, height: bodyHeight, offset });
  const visible = rows.slice(window.start, window.end);

  const scroll = useCallback(
    (delta: number): void => {
      setOffset((current) => {
        const max = diffFaceMaxOffset({ rows, height: bodyHeight });
        return Math.max(0, Math.min(max, current + delta));
      });
    },
    [rows, bodyHeight],
  );

  const toggleFold = useCallback((key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleHunk = useCallback(
    (hunkIndex: number): void => {
      const keys = foldsOf(hunkIndex);
      if (keys.length === 0) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        const allOpen = keys.every((key) => next.has(key));
        for (const key of keys) {
          if (allOpen) next.delete(key);
          else next.add(key);
        }
        return next;
      });
    },
    [foldsOf],
  );

  /** `Space`: the first foldable thing at or below the top of the screen. */
  const toggleTarget = useCallback((): void => {
    const target = diffFaceFoldTarget(rows, window.start);
    if (!target) return;
    if (target.kind === "fold") toggleFold(target.key);
    else toggleHunk(target.hunkIndex);
  }, [rows, window.start, toggleFold, toggleHunk]);

  const selectFile = useCallback((index: number): void => {
    setFileIndex(index);
    setOffset(0);
  }, []);

  const stepFile = useCallback(
    (direction: 1 | -1): void => {
      if (files.length === 0) return;
      const next = Math.max(
        0,
        Math.min(files.length - 1, fileIndex + direction),
      );
      if (next !== fileIndex) selectFile(next);
    },
    [files.length, fileIndex, selectFile],
  );

  const stepHunk = useCallback(
    (direction: 1 | -1): void => {
      const starts = diffFaceHunkStarts(rows);
      if (starts.length === 0) return;
      const target =
        direction === 1
          ? starts.find((index) => index > window.start)
          : [...starts].reverse().find((index) => index < window.start);
      if (target === undefined) return;
      setOffset(
        Math.max(
          0,
          Math.min(diffFaceMaxOffset({ rows, height: bodyHeight }), target),
        ),
      );
    },
    [rows, window.start, bodyHeight],
  );

  // `O` hands the worktree to the HTML viewer, which is still the better surface
  // for a very large diff. The answer is a toast: the face owns the band, and a
  // command row would be a transcript line behind it.
  const openInBrowser = useCallback((): void => {
    const path = source?.path;
    if (!path) return;
    void import("@/web/generate-diff-viewer")
      .then(({ generateAndOpenDiffViewer }) => generateAndOpenDiffViewer(path))
      .then((result) => {
        pushToast(
          result.opened
            ? "Opened the worktree diff in your browser"
            : `Run: open ${result.filePath}`,
        );
      })
      .catch(() => {
        pushToast("Could not open the browser");
      });
  }, [source]);

  useInputScopeClaim("overlay", true);
  useKeyBindings("diff-face", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "diff-face.close",
          chords: [{ key: "escape" }],
          run: () => {
            closeOverlay();
            return "consumed";
          },
        },
        {
          id: "diff-face.up",
          chords: [{ key: "upArrow" }, { key: "k" }],
          run: () => {
            scroll(-1);
            return "consumed";
          },
        },
        {
          id: "diff-face.down",
          chords: [{ key: "downArrow" }, { key: "j" }],
          run: () => {
            scroll(1);
            return "consumed";
          },
        },
        {
          id: "diff-face.page-up",
          chords: [{ key: "pageUp" }],
          run: () => {
            scroll(-(bodyHeight - 1));
            return "consumed";
          },
        },
        {
          id: "diff-face.page-down",
          chords: [{ key: "pageDown" }],
          run: () => {
            scroll(bodyHeight - 1);
            return "consumed";
          },
        },
        {
          id: "diff-face.first",
          chords: [{ key: "home" }],
          run: () => {
            setOffset(0);
            return "consumed";
          },
        },
        {
          id: "diff-face.last",
          chords: [{ key: "end" }],
          run: () => {
            setOffset(diffFaceMaxOffset({ rows, height: bodyHeight }));
            return "consumed";
          },
        },
        {
          id: "diff-face.previous-file",
          chords: [{ key: "[" }],
          run: () => {
            stepFile(-1);
            return "consumed";
          },
        },
        {
          id: "diff-face.next-file",
          chords: [{ key: "]" }],
          run: () => {
            stepFile(1);
            return "consumed";
          },
        },
        {
          id: "diff-face.previous-hunk",
          chords: [{ key: "{" }],
          run: () => {
            stepHunk(-1);
            return "consumed";
          },
        },
        {
          id: "diff-face.next-hunk",
          chords: [{ key: "}" }],
          run: () => {
            stepHunk(1);
            return "consumed";
          },
        },
        {
          id: "diff-face.fold",
          chords: [{ key: "space" }],
          run: () => {
            toggleTarget();
            return "consumed";
          },
        },
        {
          id: "diff-face.browser",
          chords: [{ key: "o" }],
          run: () => {
            if (!source?.path) return "declined";
            openInBrowser();
            return "consumed";
          },
        },
      ],
    },
  ]);

  // The wheel belongs to the face while it is up: the transcript behind it is not
  // mounted, so a notch that fell through would do nothing at all. Registered on
  // the content layer and claiming only the band's rectangle.
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
  useEffect(() => {
    return registerMouseHandler(
      (report) => {
        if (!report.wheel) return false;
        const node = bandRef.current;
        if (!node) return false;
        const box = measureElement(node);
        if (box.height <= 0) return false;
        const top = box.y + 1;
        if (report.row < top || report.row > box.y + box.height) return false;
        scrollRef.current(
          report.wheel === "up" ? -DIFF_FACE_WHEEL_ROWS : DIFF_FACE_WHEEL_ROWS,
        );
        return true;
      },
      { layer: "content", name: "diff-face-wheel" },
    );
  }, [bandRef]);

  // The pointer's two blocks: the file rows (a click is `[` / `]`) and the body
  // rows (a click is `Space` on the fold it landed on). A plain diff line is not
  // interactive, exactly as it has no key of its own.
  const filesRef = useRef<DOMElement | null>(null);
  const firstFile = Math.max(
    0,
    Math.min(
      fileIndex - Math.floor((bodyHeight - 1) / 2),
      Math.max(0, files.length - (bodyHeight - 1)),
    ),
  );
  const visibleFiles = files.slice(firstFile, firstFile + bodyHeight - 1);
  useMouseRows({
    area: FILES_AREA,
    ref: filesRef,
    rowCount: visibleFiles.length,
    activate: (index) => selectFile(firstFile + index),
    layer: "content",
  });

  const rowsRef = useRef<DOMElement | null>(null);
  useMouseRows({
    area: ROWS_AREA,
    ref: rowsRef,
    rowCount: visible.length,
    isInteractive: (index) => {
      const row = visible[index];
      if (!row) return false;
      if (row.kind === "fold") return true;
      return row.kind === "hunk" && foldsOf(row.hunkIndex).length > 0;
    },
    activate: (index) => {
      const row = visible[index];
      if (!row) return;
      if (row.kind === "fold") toggleFold(row.key);
      else if (row.kind === "hunk") toggleHunk(row.hunkIndex);
    },
    layer: "content",
    hoverable: visible.some(
      (row) => row.kind === "fold" || row.kind === "hunk",
    ),
  });

  const totals = diffFaceTotals(files);
  const title = source?.label ?? "Diff";
  const breadcrumb = current
    ? `[${fileIndex + 1}/${files.length}] ${current.path}`
    : "Nothing loaded";

  return (
    <>
      <Box
        ref={bandRef}
        height={bandHeight}
        flexDirection="column"
        flexShrink={1}
        overflow="hidden"
      >
        <Box flexDirection="row">
          <Text
            bold
            color={colors.selector.title}
          >{`Diff · ${truncateText(title, Math.max(8, columns - 34))}`}</Text>
          <Box flexGrow={1} />
          <Text
            dimColor
          >{`${files.length} file${files.length === 1 ? "" : "s"}`}</Text>
          <Text color={colors.diff.symbolAdd}>{` +${totals.additions}`}</Text>
          <Text
            color={colors.diff.symbolRemove}
          >{` −${totals.deletions}`}</Text>
        </Box>
        <Text dimColor>{solidRule(columns)}</Text>

        {files.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>{source?.note ?? "Reading the worktree diff…"}</Text>
          </Box>
        ) : twoColumn ? (
          <Box flexDirection="row" height={regionHeight} overflow="hidden">
            <Box
              width={railWidth - 1}
              flexDirection="column"
              flexShrink={0}
              overflow="hidden"
            >
              <Text dimColor>Files</Text>
              <Box ref={filesRef} flexDirection="column" flexShrink={0}>
                {visibleFiles.map((file, index) => (
                  <FileRow
                    key={file.path}
                    index={index}
                    path={file.path}
                    additions={file.additions}
                    deletions={file.deletions}
                    selected={firstFile + index === fileIndex}
                    width={railWidth - 1}
                  />
                ))}
                {firstFile + visibleFiles.length < files.length && (
                  <Text
                    dimColor
                  >{`… ${files.length - firstFile - visibleFiles.length} more`}</Text>
                )}
              </Box>
            </Box>
            {/* One `│` per row of the region: a single `<Text>│</Text>` is one row
                tall, which left every body row without a divider. */}
            <Text dimColor>
              {Array.from({ length: regionHeight }, () => "│").join("\n")}
            </Text>
            <Box
              width={contentColumns}
              flexDirection="column"
              flexShrink={0}
              overflow="hidden"
            >
              <Text dimColor>{truncateText(breadcrumb, contentColumns)}</Text>
              <Box ref={rowsRef} flexDirection="column" flexShrink={0}>
                {visible.map((row, index) => (
                  <BodyRow
                    key={row.key}
                    row={row}
                    index={index}
                    layout={layout}
                    columns={contentColumns}
                    interactive={row.kind === "fold" || row.kind === "hunk"}
                  />
                ))}
              </Box>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" height={regionHeight} overflow="hidden">
            <Text dimColor>{truncateText(breadcrumb, columns)}</Text>
            <Box ref={rowsRef} flexDirection="column" flexShrink={0}>
              {visible.map((row, index) => (
                <BodyRow
                  key={row.key}
                  row={row}
                  index={index}
                  layout={layout}
                  columns={columns}
                  interactive={row.kind === "fold" || row.kind === "hunk"}
                />
              ))}
            </Box>
          </Box>
        )}

        <Text dimColor>
          {window.above > 0 || window.below > 0
            ? `↑${window.above} ↓${window.below} · [ ] file · { } hunk · Space fold · O browser · Esc close`
            : "[ ] file · { } hunk · Space fold · O browser · Esc close"}
        </Text>
      </Box>
      <ViewportPanel
        panelRef={panelRef}
        approvalIsDrawn={false}
        approval={props}
      />
    </>
  );
}

/** The face's payload, from the module store the three doors write. */
function useDiffFaceSource() {
  return useSyncExternalStore(
    subscribeToDiffFace,
    getDiffFaceSource,
    getDiffFaceSource,
  );
}

/** One row of the file rail: `> name  +N −M`, or a dim row for a clean file. */
function FileRow({
  index,
  path,
  additions,
  deletions,
  selected,
  width,
}: {
  index: number;
  path: string;
  additions: number;
  deletions: number;
  selected: boolean;
  width: number;
}) {
  const hovered = useRowHovered(FILES_AREA, index);
  const counts = `+${additions} −${deletions}`;
  const name = truncateText(path, Math.max(4, width - counts.length - 4));
  // Both sides are measured with the terminal's own width table: `−` is an
  // ambiguous-width character, and a row laid out with `String.length` overflows the
  // rail by a column on a terminal that draws it double — which paints over the
  // divider and the first columns of the pane beside it.
  const padding = Math.max(
    0,
    width - 1 - 2 - terminalTextWidth(name) - terminalTextWidth(counts),
  );
  return (
    <Box
      flexDirection="row"
      backgroundColor={
        hovered && !selected ? colors.surface.hoverBg : undefined
      }
    >
      <Text
        color={selected ? colors.selector.itemHighlighted : undefined}
      >{`${selected ? "> " : "  "}`}</Text>
      <Text
        bold={selected}
        color={selected ? colors.selector.itemHighlighted : undefined}
      >
        {name}
      </Text>
      <Text>{" ".repeat(padding)}</Text>
      <Text color={colors.diff.symbolAdd}>{`+${additions}`}</Text>
      <Text color={colors.diff.symbolRemove}>{` −${deletions}`}</Text>
    </Box>
  );
}

/** One body row: a hunk header, a diff line, a fold stand-in, or a note. */
function BodyRow({
  row,
  index,
  layout,
  columns,
  interactive,
}: {
  row: DiffFaceRow;
  index: number;
  layout: ReturnType<typeof diffFaceLineLayout>;
  columns: number;
  interactive: boolean;
}) {
  const hovered = useRowHovered(ROWS_AREA, index);
  const background =
    hovered && interactive ? colors.surface.hoverBg : undefined;

  if (row.kind === "line") {
    return (
      <AdvancedDiffLine
        kind={row.line.kind}
        displayNo={row.line.displayNo}
        text={truncateText(
          row.line.text,
          Math.max(1, columns - layout.gutterWidth - 3),
        )}
        gutterWidth={layout.gutterWidth}
        columns={columns}
        indent=""
      />
    );
  }

  const text =
    row.kind === "fold"
      ? `… ${row.count} line${row.count === 1 ? "" : "s"}`
      : row.text;
  return (
    <Box flexDirection="row" backgroundColor={background}>
      <Text
        dimColor={row.kind !== "fold"}
        color={row.kind === "fold" ? colors.command.selected : undefined}
      >
        {truncateText(text, columns)}
      </Text>
    </Box>
  );
}
