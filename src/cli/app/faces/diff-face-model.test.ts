import { describe, expect, test } from "bun:test";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { DiffPatchFile } from "@/cli/helpers/diff-patch";
import {
  DIFF_FACE_FOLD_MIN,
  diffFaceFilesFromDiffs,
  diffFaceFoldKey,
  diffFaceFoldTarget,
  diffFaceHunkFolds,
  diffFaceHunkStarts,
  diffFaceLineLayout,
  diffFaceMaxOffset,
  diffFaceRows,
  diffFaceTotals,
  diffFaceWindow,
} from "./diff-face-model";

/**
 * The face's row model: what folds, what a key is aimed at, and how much fits.
 *
 * These are the numbers the component paints and the numbers the keys move over, so
 * they are asserted here rather than inferred from a frame: a fold that is one row
 * off is invisible in a screenshot and obvious in a list of rows.
 */

function file(
  lines: string[],
  hunkStarts: { oldStart: number; newStart: number }[] = [
    { oldStart: 1, newStart: 1 },
  ],
): DiffPatchFile {
  return {
    path: "src/a.ts",
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length,
    hunks: hunkStarts.map((start, index) => ({
      oldStart: start.oldStart,
      newStart: start.newStart,
      lines: index === 0 ? lines.map((raw) => ({ raw })) : [],
    })),
  };
}

/** Three context lines around a single change: one foldable run, one fold row. */
const FOLDABLE = file([
  " one",
  " two",
  " three",
  "-four",
  "+four!",
  " five",
  " six",
  " seven",
]);

describe("diffFaceRows", () => {
  test("folds a context run of three or more into one stand-in row", () => {
    const rows = diffFaceRows(FOLDABLE, new Set());
    expect(rows.map((row) => row.kind)).toEqual([
      "hunk",
      "fold",
      "line",
      "line",
      "fold",
    ]);
    const folds = rows.filter((row) => row.kind === "fold");
    expect(folds.map((row) => (row.kind === "fold" ? row.count : 0))).toEqual([
      3, 3,
    ]);
  });

  test("keeps a run shorter than the fold minimum open", () => {
    const short = file([" one", " two", "-three", "+three!"]);
    const rows = diffFaceRows(short, new Set());
    expect(rows.some((row) => row.kind === "fold")).toBe(false);
    expect(rows.filter((row) => row.kind === "line")).toHaveLength(4);
    expect(DIFF_FACE_FOLD_MIN).toBe(3);
  });

  test("an expanded run paints its lines in place of the stand-in", () => {
    const key = diffFaceFoldKey(0, 0, 0);
    const rows = diffFaceRows(FOLDABLE, new Set([key]));
    expect(rows.map((row) => row.kind)).toEqual([
      "hunk",
      "line",
      "line",
      "line",
      "line",
      "line",
      "fold",
    ]);
    const texts = rows.flatMap((row) =>
      row.kind === "line" ? [row.line.text] : [],
    );
    expect(texts.slice(0, 3)).toEqual(["one", "two", "three"]);
  });

  test("numbers lines by their own side", () => {
    const rows = diffFaceRows(FOLDABLE, new Set([diffFaceFoldKey(0, 0, 0)]));
    const numbered = rows.flatMap((row) =>
      row.kind === "line" ? [[row.line.kind, row.line.displayNo] as const] : [],
    );
    expect(numbered).toEqual([
      ["context", 1],
      ["context", 2],
      ["context", 3],
      ["remove", 4],
      ["add", 4],
    ]);
  });

  test("gutter width follows the largest number in the file", () => {
    const long = file([" one", "-two", "+two!", " three", " four", " five"]);
    const rows = diffFaceRows(long, new Set());
    expect(diffFaceLineLayout(rows).gutterWidth).toBe(1);
    const big = file(
      [" one", "-two", "+two!", " three", " four", " five"],
      [{ oldStart: 998, newStart: 998 }],
    );
    expect(diffFaceLineLayout(diffFaceRows(big, new Set())).gutterWidth).toBe(
      3,
    );
  });

  test("a binary file says so instead of showing nothing", () => {
    const rows = diffFaceRows(
      { ...FOLDABLE, binary: true, hunks: [] },
      new Set(),
    );
    expect(rows).toEqual([
      {
        kind: "note",
        key: "binary",
        text: "Binary file — the patch carries no text to show.",
      },
    ]);
  });

  test("a hunk with no text changes explains itself", () => {
    const rows = diffFaceRows({ ...FOLDABLE, hunks: [] }, new Set());
    expect(rows[0]?.kind).toBe("note");
  });
});

describe("diffFaceHunkFolds", () => {
  test("lists a hunk's foldable runs without looking at what is open", () => {
    const open = new Set([diffFaceFoldKey(0, 0, 0)]);
    expect(diffFaceHunkFolds(FOLDABLE, 0)).toEqual([
      {
        hunkIndex: 0,
        keys: [diffFaceFoldKey(0, 0, 0), diffFaceFoldKey(0, 0, 1)],
      },
    ]);
    expect(diffFaceRows(FOLDABLE, open).length).toBeGreaterThan(0);
    // The list is the same whether the runs are open or closed: that is what makes
    // "collapse this hunk" possible at all.
    expect(diffFaceHunkFolds(FOLDABLE, 0)[0]?.keys).toHaveLength(2);
  });
});

describe("diffFaceFoldTarget", () => {
  test("aims at the first fold at or below the window top", () => {
    const rows = diffFaceRows(FOLDABLE, new Set());
    expect(diffFaceFoldTarget(rows, 0)).toEqual({
      kind: "hunk",
      hunkIndex: 0,
    });
    expect(diffFaceFoldTarget(rows, 1)).toEqual({
      kind: "fold",
      key: diffFaceFoldKey(0, 0, 0),
    });
  });

  test("aims at the hunk header when nothing is folded in it", () => {
    const key = diffFaceFoldKey(0, 0, 0);
    const rows = diffFaceRows(FOLDABLE, new Set([key]));
    expect(diffFaceFoldTarget(rows, 0)).toEqual({
      kind: "hunk",
      hunkIndex: 0,
    });
  });

  test("has nothing to aim at past the last fold", () => {
    const open = new Set([diffFaceFoldKey(0, 0, 0), diffFaceFoldKey(0, 0, 1)]);
    const rows = diffFaceRows(FOLDABLE, open);
    expect(diffFaceFoldTarget(rows, rows.length - 1)).toBeNull();
  });
});

describe("the window and the scroll range", () => {
  const rows = diffFaceRows(FOLDABLE, new Set());

  test("shows as many rows as fit and reports what is above and below", () => {
    expect(diffFaceWindow({ rows, height: 3, offset: 0 })).toEqual({
      start: 0,
      end: 3,
      above: 0,
      below: 2,
    });
    expect(diffFaceWindow({ rows, height: 3, offset: 2 })).toEqual({
      start: 2,
      end: 5,
      above: 2,
      below: 0,
    });
  });

  test("clamps an offset past the end", () => {
    expect(diffFaceWindow({ rows, height: 3, offset: 99 })).toEqual({
      start: 4,
      end: 5,
      above: 4,
      below: 0,
    });
  });

  test("End lands on the last screen of rows, not the last row", () => {
    expect(diffFaceMaxOffset({ rows, height: 3 })).toBe(2);
    expect(diffFaceMaxOffset({ rows, height: 99 })).toBe(0);
  });

  test("an empty body has one empty window", () => {
    expect(diffFaceWindow({ rows: [], height: 5, offset: 0 })).toEqual({
      start: 0,
      end: 0,
      above: 0,
      below: 0,
    });
  });
});

describe("diffFaceHunkStarts", () => {
  test("lists the header row of every hunk", () => {
    const twoHunks = file(
      [" one", " two", " three", "-four", "+four!", " five", " six", " seven"],
      [
        { oldStart: 1, newStart: 1 },
        { oldStart: 40, newStart: 40 },
      ],
    );
    const rows = diffFaceRows(twoHunks, new Set());
    const starts = diffFaceHunkStarts(rows);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeGreaterThan(starts[0] ?? 0);
  });
});

describe("diffFaceTotals", () => {
  test("adds the files' counts", () => {
    expect(
      diffFaceTotals([FOLDABLE, { ...FOLDABLE, additions: 4, deletions: 1 }]),
    ).toEqual({ additions: 5, deletions: 2 });
  });
});

describe("diffFaceFilesFromDiffs", () => {
  test("takes the real path from a patch tool's key", () => {
    const diff: AdvancedDiffSuccess = {
      mode: "advanced",
      fileName: "b.ts",
      oldStr: "",
      newStr: "",
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { raw: "-old" },
            { raw: "+new" },
            { raw: "+more" },
            { raw: " kept" },
          ],
        },
      ],
    };
    const files = diffFaceFilesFromDiffs([
      ["tc-1:src/deep/b.ts", diff],
      ["tc-2", { ...diff, fileName: "solo.ts" }],
    ]);
    expect(files.map((file) => file.path)).toEqual([
      "src/deep/b.ts",
      "solo.ts",
    ]);
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(1);
  });

  test("no diffs is no files", () => {
    expect(diffFaceFilesFromDiffs([])).toEqual([]);
  });
});
