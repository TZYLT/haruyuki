import { describe, expect, test } from "bun:test";
import { diffHunkHeader, parseUnifiedDiff } from "./diff-patch";

/**
 * The patch reader, on the shapes a real `git diff` prints.
 *
 * Every case here is one this repository produces on an ordinary day: a modified
 * file with two hunks, a new file, a deletion, a rename, a binary notice and an
 * untracked-file patch (which git writes as `--no-index` against `/dev/null`, with
 * a header that looks like a creation but carries no `new file mode` line).
 */

const TWO_HUNKS = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " const one = 1;",
  "-const two = 2;",
  "+const two = 22;",
  "+const extra = 3;",
  " const three = 3;",
  " const four = 4;",
  "@@ -20,3 +21,2 @@",
  " context;",
  "-gone;",
  " tail;",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+line one",
  "+line two",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-bye",
  "diff --git a/old-name.ts b/new-name.ts",
  "similarity index 100%",
  "rename from old-name.ts",
  "rename to new-name.ts",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 4444444..5555555 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
].join("\n");

describe("parseUnifiedDiff", () => {
  test("splits a patch into files, in order, with counts", () => {
    const files = parseUnifiedDiff(TWO_HUNKS);
    expect(files.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/new.ts",
      "src/gone.ts",
      "new-name.ts",
      "assets/logo.png",
    ]);
    const [first, created, deleted] = files;
    expect(first?.additions).toBe(2);
    expect(first?.deletions).toBe(2);
    expect(first?.hunks).toHaveLength(2);
    expect(created?.created).toBe(true);
    expect(created?.additions).toBe(2);
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.deletions).toBe(1);
  });

  test("keeps each hunk's start lines and every marker", () => {
    const [first] = parseUnifiedDiff(TWO_HUNKS);
    expect(first?.hunks[0]?.oldStart).toBe(1);
    expect(first?.hunks[0]?.newStart).toBe(1);
    expect(first?.hunks[1]?.oldStart).toBe(20);
    expect(first?.hunks[1]?.newStart).toBe(21);
    expect(first?.hunks[0]?.lines.map((line) => line.raw.charAt(0))).toEqual([
      " ",
      "-",
      "+",
      "+",
      " ",
      " ",
    ]);
  });

  test("records a rename's previous path", () => {
    const renamed = parseUnifiedDiff(TWO_HUNKS).find(
      (file) => file.path === "new-name.ts",
    );
    expect(renamed?.previousPath).toBe("old-name.ts");
    expect(renamed?.hunks).toEqual([]);
  });

  test("marks a binary file instead of inventing hunks for it", () => {
    const binary = parseUnifiedDiff(TWO_HUNKS).find((file) =>
      file.path.endsWith("logo.png"),
    );
    expect(binary?.binary).toBe(true);
    expect(binary?.hunks).toEqual([]);
  });

  test("reads an untracked file's --no-index patch as a creation", () => {
    const patch = [
      "diff --git a/scratch.md b/scratch.md",
      "new file mode 100644",
      "index 0000000..6666666",
      "--- /dev/null",
      "+++ b/scratch.md",
      "@@ -0,0 +1,1 @@",
      "+hello",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch);
    expect(file?.path).toBe("scratch.md");
    expect(file?.created).toBe(true);
    expect(file?.additions).toBe(1);
  });

  test("keeps a no-newline marker out of the rows", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch);
    expect(file?.hunks[0]?.lines.map((line) => line.raw)).toEqual([
      "-old",
      "+new",
    ]);
  });

  test("an empty patch has no files", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("diffHunkHeader", () => {
  test("counts both sides the way git prints them", () => {
    const [first] = parseUnifiedDiff(TWO_HUNKS);
    expect(first?.hunks[0]).toBeDefined();
    if (!first?.hunks[0]) return;
    expect(diffHunkHeader(first.hunks[0])).toBe("@@ -1,4 +1,5 @@");
    if (!first.hunks[1]) return;
    expect(diffHunkHeader(first.hunks[1])).toBe("@@ -20,3 +21,2 @@");
  });
});
