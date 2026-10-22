/**
 * Unified-patch reader: a git diff's text in, one entry per file out.
 *
 * The full-screen diff face (M6-P8) shows what a worktree changed, and the only
 * thing the shell has to hand is the patch `git diff` prints. This module turns
 * that text into the same `AdvancedHunk` shape every other diff surface already
 * renders (`helpers/diff.ts`), so the face reuses the existing row model instead
 * of teaching the app a second diff representation.
 *
 * Pure and React-free on purpose: no git call, no filesystem, no colour. The
 * caller decides what to run git against (`web/worktree-diff-list.ts`) and what
 * to do with the result.
 */

import type { AdvancedHunk } from "@/cli/helpers/diff";

/** One file's changes, in the shape the diff renderers already consume. */
export interface DiffPatchFile {
  /** Repo-relative path (`b/` stripped); the old path for a deletion. */
  path: string;
  /** The path before a rename, when the patch records one. */
  previousPath?: string;
  additions: number;
  deletions: number;
  hunks: AdvancedHunk[];
  /** A patch that says "Binary files differ" has no hunks to show. */
  binary?: boolean;
  /** A new file (`--- /dev/null`): the face notes it rather than diffing it. */
  created?: boolean;
  /** A deleted file (`+++ /dev/null`). */
  deleted?: boolean;
}

/**
 * Hunk header for one hunk, counted the way `git diff` prints it.
 *
 * The counts are derived from the lines rather than stored: `AdvancedHunk` keeps
 * only the starts, and a header that disagreed with the rows under it would be
 * the one line in the face nobody could trust.
 */
export function diffHunkHeader(hunk: AdvancedHunk): string {
  let oldCount = 0;
  let newCount = 0;
  for (const line of hunk.lines) {
    const marker = (line.raw || "").charAt(0);
    if (marker === "\\") continue;
    if (marker !== "+") oldCount++;
    if (marker !== "-") newCount++;
  }
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
}

/** Strip the `a/` or `b/` prefix git puts in front of a patch path. */
function stripPrefix(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return "";
  return trimmed.replace(/^[ab]\//, "");
}

/** `diff --git a/x b/y`: the fallback path when no `+++` line follows. */
function pathFromGitHeader(line: string): string | undefined {
  const match = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
  return match?.[2] ? stripPrefix(match[2]) : undefined;
}

/**
 * Parse a unified diff into per-file entries.
 *
 * Tolerant by design: a hunk line that is not a marker, an empty line, a rename
 * header, a mode change and a binary notice all have to survive a real
 * `git diff`, and a parser that threw on any of them would make the face fail on
 * the worktree a user happens to be on.
 */
export function parseUnifiedDiff(patch: string): DiffPatchFile[] {
  const files: DiffPatchFile[] = [];
  let current: DiffPatchFile | null = null;
  let hunk: AdvancedHunk | null = null;

  const finishHunk = (): void => {
    if (current && hunk && hunk.lines.length > 0) current.hunks.push(hunk);
    hunk = null;
  };
  const finishFile = (): void => {
    finishHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      current = {
        path: pathFromGitHeader(line) ?? "",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("--- ")) {
      // `/dev/null` on the old side means the file is new.
      const path = stripPrefix(line.slice(4));
      if (path) current.path = path;
      else current.created = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = stripPrefix(line.slice(4));
      if (path) current.path = path;
      else current.deleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.previousPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("new file mode ")) {
      current.created = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.deleted = true;
      continue;
    }
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      finishHunk();
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      hunk = {
        oldStart: match?.[1] ? Number.parseInt(match[1], 10) : 1,
        newStart: match?.[2] ? Number.parseInt(match[2], 10) : 1,
        lines: [],
      };
      continue;
    }
    if (!hunk) continue;

    const marker = line.charAt(0);
    if (marker === "+") {
      current.additions++;
      hunk.lines.push({ raw: line });
    } else if (marker === "-") {
      current.deletions++;
      hunk.lines.push({ raw: line });
    } else if (marker === " ") {
      hunk.lines.push({ raw: line });
    } else if (marker === "\\") {
    } else if (line === "") {
      // A blank context line some producers emit without its leading space.
      hunk.lines.push({ raw: " " });
    }
  }

  finishFile();
  return files;
}
