import type { MutableRefObject } from "react";
import { diffFaceFilesFromDiffs } from "@/cli/app/faces/diff-face-model";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { DiffPatchFile } from "@/cli/helpers/diff-patch";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { useKeyBindings } from "@/cli/hooks/use-input-router";

/**
 * The diff face's second door: `Ctrl+X d`, the most recent diff in the session.
 *
 * 《38》§16.2 lists three entries, and the second one is "the tool result's diff →
 * `Enter`". That key needs a **transcript row cursor**, which M6 does not have
 * anywhere — the band scrolls, and no row owns focus — so inventing one to reach a
 * reader would have been a much larger change than the face itself. The chord is
 * the honest substitute: it opens the newest diff the transcript can draw, which is
 * the one the user was just reading, and it costs the shell nothing but a key.
 *
 * Mounted by `V2Shell` and not by the append shell, like the message-history chord
 * next to it: the compatibility mode registers nothing and stays frozen. The hook
 * owns the key and hands the files over; raising the surface is the shell's, the
 * same division `use-message-history.ts` documents.
 */
export function useDiffFace(deps: {
  /** The diffs the transcript can draw, in arrival order. */
  precomputedDiffsRef: MutableRefObject<Map<string, AdvancedDiffSuccess>>;
  open: (files: DiffPatchFile[]) => void;
}): void {
  const { precomputedDiffsRef, open } = deps;
  useKeyBindings("diff-face-open", [
    {
      scope: "app",
      bindings: [
        {
          id: "leader.diff",
          leader: true,
          chords: LEADER_KEY_CHORDS.diff,
          label: "差异面",
          run: () => {
            const files = diffFaceFilesFromDiffs([
              ...precomputedDiffsRef.current.entries(),
            ]);
            if (files.length === 0) return "declined";
            open(files);
            return "consumed";
          },
        },
      ],
    },
  ]);
}
