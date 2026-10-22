/**
 * What the diff face is showing, and nothing about how it looks.
 *
 * The face has three doors — `/experiments diffs`, the shell's `Ctrl+X d`, and a
 * pending approval's `O` — and two of them are not inside the component that draws
 * it. The payload therefore lives in a module store: a door fills it in, the face
 * reads it, and no door has to thread props through the shell to reach a face it
 * does not own.
 *
 * The store holds the *content* only. Cursor, scroll position and which context
 * runs are open belong to the mounted face and reset when it closes, which is what
 * keeps a reopened diff from landing halfway down a file the user has not seen.
 */

import type { DiffPatchFile } from "@/cli/helpers/diff-patch";

/** One diff face's worth of work: a label, the files, and an optional note. */
export interface DiffFaceSource {
  /** What the title row says after "Diff ·" (`feat/tui-v2`, a file name). */
  label: string;
  files: readonly DiffPatchFile[];
  /** Shown under the title when the source has something to explain. */
  note?: string;
  /**
   * The worktree this came from, when there is one.
   *
   * Only the worktree door has it: the two that start from a tool result or an
   * approval have a diff, not a repository, and `O` (hand the work to the browser
   * viewer) needs a path to run git against.
   */
  path?: string;
}

type Listener = () => void;

let source: DiffFaceSource | null = null;
const listeners = new Set<Listener>();

export function subscribeToDiffFace(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The payload the face is showing, or `null` when nothing was loaded. */
export function getDiffFaceSource(): DiffFaceSource | null {
  return source;
}

/** Replace the payload (or clear it). The face re-renders; scroll does not. */
export function setDiffFaceSource(next: DiffFaceSource | null): void {
  source = next;
  for (const listener of listeners) listener();
}

/** Between tests: forget the last payload and the listeners. */
export function resetDiffFaceForTests(): void {
  source = null;
  listeners.clear();
}
