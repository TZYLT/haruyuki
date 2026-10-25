/**
 * Path remapping after an import: rewrite only the known structured fields.
 *
 * M0 holds the shape only; M3 fills the body. Never a global string replace:
 * memory markdown, messages and transcripts keep whatever paths they contain
 * (requirement doc §5.9.5). Unreplaced path-shaped fields are reported, not
 * edited, so the user can see what still points at the old machine.
 */

import type { SnapshotRemap } from "./types";

export interface RemapResult {
  remapped: SnapshotRemap[];
  /** Path-shaped fields this pass deliberately did not touch. */
  notRemapped: string[];
}

/**
 * Rewrite `settings.json`'s `sessionsByServer` keys of the form
 * `local:<oldStorageDir>` to `local:<newStorageDir>`.
 *
 * Same root -> nothing to do. An existing target key keeps its current value
 * and is reported as a conflict. Unparseable JSON is an `io_error`, never a
 * guessed repair. The write is tmp+fsync+rename.
 */
export async function remapSettingsBucket(
  settingsPath: string,
  from: string,
  to: string,
): Promise<RemapResult> {
  void settingsPath;
  void from;
  void to;
  throw new Error("snapshot/remap.remapSettingsBucket: implemented at M3");
}
