/**
 * The full-screen diff face's row model (M6-P8).
 *
 * A file's hunks become a flat list of rows the face can scroll: hunk headers,
 * diff lines, and the folded `… N lines` stand-ins for the context runs the user
 * has not opened. Everything here is pure — no React, no Ink, no I/O — because
 * the same list has to answer three questions at once: what to paint, how tall it
 * is, and which row a key or a click is aimed at.
 *
 * **Why fold context at all**: `git diff` prints three context lines on each side
 * of a change, and a file with twenty changes is a wall of unchanged code with the
 * changes hidden inside it. Folding is what makes the face a review surface rather
 * than a dump (`docs/38` §16.2). Folds are keyed by file, hunk and run, so
 * switching files and coming back does not lose the ones that were opened.
 *
 * One row is one line: the face truncates long lines instead of wrapping them
 * (`docs/38` §16.2, "no horizontal scroll"), which is also what lets a click map
 * to a row without measuring anything at event time.
 */

import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { type DiffPatchFile, diffHunkHeader } from "@/cli/helpers/diff-patch";
import {
  type DiffLineLayout,
  type DiffRowKind,
  diffGutterWidth,
  walkAdvancedDiffHunk,
} from "@/cli/helpers/diff-rows";

/**
 * Shortest context run worth a fold row.
 *
 * A two-line gap costs more to fold than to read — the stand-in is itself a row,
 * and an arrow to press — so short runs stay open and only a real block of
 * unchanged code collapses.
 */
export const DIFF_FACE_FOLD_MIN = 3;

/** One row of the face's scrollable body. */
export type DiffFaceRow =
  | { kind: "hunk"; key: string; hunkIndex: number; text: string }
  | { kind: "line"; key: string; hunkIndex: number; line: DiffFaceWalkLine }
  | {
      kind: "fold";
      key: string;
      hunkIndex: number;
      /** Context lines hidden behind this row. */
      count: number;
    }
  | { kind: "note"; key: string; text: string };

/** A diff line, projected from the shared walker. */
export interface DiffFaceWalkLine {
  kind: DiffRowKind;
  displayNo: number;
  text: string;
}

/** Fold key: stable across renders, and unique per file, hunk and run. */
export function diffFaceFoldKey(
  fileIndex: number,
  hunkIndex: number,
  runIndex: number,
): string {
  return `${fileIndex}:${hunkIndex}:${runIndex}`;
}

/** The layout the face paints its lines in (no result gutter, plain indent). */
export function diffFaceLineLayout(
  rows: readonly DiffFaceRow[],
): DiffLineLayout {
  const numbers = rows.flatMap((row) =>
    row.kind === "line" ? [row.line.displayNo] : [],
  );
  return { indent: "", gutterWidth: diffGutterWidth(numbers) };
}

/**
 * A hunk's context runs, in order.
 *
 * `foldable` is false for a run too short to be worth folding — both the row
 * model and `Space` decide from this one walk, so the key that opens a run and
 * the row that showed it closed cannot disagree.
 */
function contextRuns(
  hunk: AdvancedDiffSuccess["hunks"][number],
): { runIndex: number; count: number; foldable: boolean }[] {
  const runs: { runIndex: number; count: number; foldable: boolean }[] = [];
  let count = 0;
  let runIndex = 0;
  for (const walked of walkAdvancedDiffHunk(hunk)) {
    if (walked.kind === "context") {
      count++;
      continue;
    }
    if (count > 0) {
      runs.push({
        runIndex,
        count,
        foldable: count >= DIFF_FACE_FOLD_MIN,
      });
      runIndex++;
      count = 0;
    }
  }
  if (count > 0) {
    runs.push({ runIndex, count, foldable: count >= DIFF_FACE_FOLD_MIN });
  }
  return runs;
}

/**
 * Every fold key one file's hunks own, per hunk.
 *
 * Computed without looking at `expanded` on purpose: "collapse this hunk" has to
 * know the runs that are open, and a list built from the currently collapsed rows
 * would be empty exactly then.
 */
export function diffFaceHunkFolds(
  file: DiffPatchFile,
  fileIndex = 0,
): { hunkIndex: number; keys: string[] }[] {
  return file.hunks.map((hunk, hunkIndex) => ({
    hunkIndex,
    keys: contextRuns(hunk)
      .filter((run) => run.foldable)
      .map((run) => diffFaceFoldKey(fileIndex, hunkIndex, run.runIndex)),
  }));
}

/**
 * The body rows of one file.
 *
 * `expanded` holds the fold keys that are open. A run is folded when it is at
 * least `DIFF_FACE_FOLD_MIN` long and its key is not in the set.
 */
export function diffFaceRows(
  file: DiffPatchFile,
  expanded: ReadonlySet<string>,
  fileIndex = 0,
): DiffFaceRow[] {
  if (file.binary) {
    return [
      {
        kind: "note",
        key: "binary",
        text: "Binary file — the patch carries no text to show.",
      },
    ];
  }
  if (file.hunks.length === 0) {
    return [
      {
        kind: "note",
        key: "empty",
        text: file.created
          ? "New empty file."
          : "No text changes (mode or metadata only).",
      },
    ];
  }

  const rows: DiffFaceRow[] = [];
  let rowCounter = 0;
  for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex++) {
    const hunk = file.hunks[hunkIndex];
    if (!hunk) continue;
    rows.push({
      kind: "hunk",
      key: `hunk:${fileIndex}:${hunkIndex}`,
      hunkIndex,
      text: diffHunkHeader(hunk),
    });

    // One walk into runs of context and single change lines: the fold decision is
    // made on a whole run, and a run's fold row replaces all of its lines.
    type Segment =
      | {
          kind: "context";
          key: string;
          count: number;
          lines: DiffFaceWalkLine[];
        }
      | { kind: "change"; line: DiffFaceWalkLine };
    const segments: Segment[] = [];
    let open: { key: string; lines: DiffFaceWalkLine[] } | null = null;
    let runIndex = 0;
    for (const walked of walkAdvancedDiffHunk(hunk)) {
      const line: DiffFaceWalkLine = {
        kind: walked.kind,
        displayNo: walked.displayNo,
        text: walked.text,
      };
      if (walked.kind === "context") {
        if (!open) {
          open = {
            key: diffFaceFoldKey(fileIndex, hunkIndex, runIndex),
            lines: [],
          };
          runIndex++;
        }
        open.lines.push(line);
      } else {
        if (open) {
          segments.push({
            kind: "context",
            key: open.key,
            count: open.lines.length,
            lines: open.lines,
          });
          open = null;
        }
        segments.push({ kind: "change", line });
      }
    }
    if (open) {
      segments.push({
        kind: "context",
        key: open.key,
        count: open.lines.length,
        lines: open.lines,
      });
    }

    for (const segment of segments) {
      if (segment.kind === "change") {
        rows.push({
          kind: "line",
          key: `line:${fileIndex}:${hunkIndex}:${rowCounter++}`,
          hunkIndex,
          line: segment.line,
        });
        continue;
      }
      if (segment.count >= DIFF_FACE_FOLD_MIN && !expanded.has(segment.key)) {
        rows.push({
          kind: "fold",
          key: segment.key,
          hunkIndex,
          count: segment.count,
        });
        continue;
      }
      for (const line of segment.lines) {
        rows.push({
          kind: "line",
          key: `line:${fileIndex}:${hunkIndex}:${rowCounter++}`,
          hunkIndex,
          line,
        });
      }
    }
  }
  return rows;
}

/**
 * Which row a bare `Space` acts on: the first fold at or below the window top, or
 * the hunk header the window starts in.
 *
 * A reader scrolls to what they want and presses the key; there is no cursor in
 * this face, so "what is on screen" is the only honest target. `null` means there
 * is nothing left to fold and the key declines.
 */
export function diffFaceFoldTarget(
  rows: readonly DiffFaceRow[],
  offset: number,
): { kind: "fold"; key: string } | { kind: "hunk"; hunkIndex: number } | null {
  for (let index = Math.max(0, offset); index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    if (row.kind === "fold") return { kind: "fold", key: row.key };
    if (row.kind === "hunk") return { kind: "hunk", hunkIndex: row.hunkIndex };
  }
  return null;
}

/** Row indices of the hunk headers, for `{` / `}` and the mouse. */
export function diffFaceHunkStarts(rows: readonly DiffFaceRow[]): number[] {
  return rows.flatMap((row, index) => (row.kind === "hunk" ? [index] : []));
}

/** The slice of rows that fits `height`. */
export function diffFaceWindow(input: {
  rows: readonly DiffFaceRow[];
  height: number;
  offset: number;
}): { start: number; end: number; above: number; below: number } {
  const { rows } = input;
  const limit = Math.max(1, input.height);
  const start = Math.max(
    0,
    Math.min(input.offset, Math.max(0, rows.length - 1)),
  );
  const end = Math.min(rows.length, start + limit);
  return { start, end, above: start, below: Math.max(0, rows.length - end) };
}

/** Largest valid scroll offset, so `End` lands on the last screen of rows. */
export function diffFaceMaxOffset(input: {
  rows: readonly DiffFaceRow[];
  height: number;
}): number {
  return Math.max(0, input.rows.length - Math.max(1, input.height));
}

/** `+N −M` totals across the files in the face. */
export function diffFaceTotals(files: readonly DiffPatchFile[]): {
  additions: number;
  deletions: number;
} {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

/**
 * The files a set of precomputed diffs describes, for the two entry points that
 * start from a tool result or an approval rather than from a patch.
 *
 * The map's keys carry the real path for patch tools (`toolCallId:path`), while
 * an `AdvancedDiffSuccess` only knows the file's basename — so the key is the
 * better label when it has one.
 */
export function diffFaceFilesFromDiffs(
  entries: readonly (readonly [string, AdvancedDiffSuccess])[],
): DiffPatchFile[] {
  return entries.map(([key, diff]) => {
    const path = key.includes(":") ? key.slice(key.indexOf(":") + 1) : "";
    let additions = 0;
    let deletions = 0;
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        const marker = (line.raw || "").charAt(0);
        if (marker === "+") additions++;
        else if (marker === "-") deletions++;
      }
    }
    return {
      path: path || diff.fileName,
      additions,
      deletions,
      hunks: diff.hunks,
    };
  });
}
