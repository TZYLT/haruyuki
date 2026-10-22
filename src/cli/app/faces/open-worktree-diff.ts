import { basename } from "node:path";
import type { ActiveOverlay } from "@/cli/app/types";
import type { CommandHandle } from "@/cli/commands/runner";
import { parseUnifiedDiff } from "@/cli/helpers/diff-patch";
import { resolveUiV2Once } from "@/experiments/ui-v2";
import { setDiffFaceSource } from "./diff-face-store";

/**
 * The diff face's first door: `/experiments diffs` picked a worktree.
 *
 * The face opens **before** git answers, with the command row saying what is being
 * read — a worktree diff can take a second on a large repository, and a face that
 * appeared only at the end would look like the command did nothing. Everything the
 * read can do afterwards is a rewrite of the same row: the payload lands in the
 * store (the face subscribes to it), or the failure is written where the user is
 * already looking.
 *
 * **The append shell keeps the browser viewer.** The face lives in the full-screen
 * shell's band, so under `ui_v2=off` this function does exactly what it did before
 * M6-P8: build the HTML viewer and open it. That is the compatibility mode's rule —
 * it stays frozen, and a door that raised a face it cannot draw would freeze the
 * composer with nothing on screen.
 *
 * The browser viewer is still reachable *inside* the face (`O`), which is the one
 * place that knows the worktree path.
 */
export async function openWorktreeDiffFace(
  worktreePath: string | undefined,
  deps: {
    openOverlay: (
      overlay: NonNullable<ActiveOverlay>,
      input: string,
      openingOutput: string,
      dismissOutput: string,
    ) => CommandHandle;
    commandRunner: { start: (input: string, output: string) => CommandHandle };
    /**
     * The row the caller already started for this request, if any.
     *
     * The worktree selector's own row (`/experiments diffs`) is the one that must
     * carry the result in both shells: starting a second row would print two lines
     * for one command, which the compatibility mode must not do (《33》§12: legacy
     * stays frozen).
     */
    existingCommand?: CommandHandle;
  },
): Promise<void> {
  const path = worktreePath ?? process.cwd();
  const label = basename(path) || path;

  if (!resolveUiV2Once()) {
    await openInBrowserViewer(path, deps);
    return;
  }

  deps.existingCommand?.finish("Worktree chosen", true);
  setDiffFaceSource(null);
  const command = deps.openOverlay(
    "diff",
    "/experiments diffs",
    `Reading the diff of ${label}…`,
    "Diff closed",
  );

  try {
    const { readWorktreeDiffPatch } = await import("@/web/worktree-diff-list");
    const patch = await readWorktreeDiffPatch(path);
    const files = parseUnifiedDiff(patch);
    setDiffFaceSource({ label, files, path });
    command.update({
      output:
        files.length === 0
          ? `No changes in ${label}`
          : `${files.length} file${files.length === 1 ? "" : "s"} · ${label}`,
      dimOutput: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setDiffFaceSource({
      label,
      files: [],
      path,
      note: `Could not read the diff: ${message}`,
    });
    command.update({
      output: `Could not read the diff of ${label}`,
      dimOutput: true,
    });
  }
}

/** The pre-M6-P8 behaviour, unchanged: render the viewer and hand it to the OS. */
async function openInBrowserViewer(
  path: string,
  deps: {
    commandRunner: { start: (input: string, output: string) => CommandHandle };
    existingCommand?: CommandHandle;
  },
): Promise<void> {
  const command =
    deps.existingCommand ??
    deps.commandRunner.start("/experiments", "Opening worktree diff...");
  try {
    const { generateAndOpenDiffViewer } = await import(
      "@/web/generate-diff-viewer"
    );
    const result = await generateAndOpenDiffViewer(path);
    const fileSummary = `${result.fileCount} file${result.fileCount === 1 ? "" : "s"}`;
    command.finish(
      result.opened
        ? `Opened worktree diff (${fileSummary})`
        : `Open manually: ${result.filePath} (${fileSummary})`,
      true,
    );
  } catch (error) {
    command.finish(
      `Failed to open diff: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}
