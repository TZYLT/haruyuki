// src/cli/app/experiments-command.ts

/**
 * Does this input ask for the experiments selector?
 *
 * `/config experiments diffs [path]` is a **different** command (the worktree diff face)
 * and is handled beside this one; everything else that starts with `/config experiments`
 * is the selector — no argument at all, or a name someone typed expecting it to
 * select that row (`/config experiments ui_v2`).
 *
 * That last case is why this is a function with a test. The handler only matched
 * the bare command, so `/config experiments ui_v2` fell through to the registry, which
 * answered "Opening experiments selector..." and opened nothing: the receipt
 * described an action nobody took. The maintainer hit it on 2026-10-23 and asked
 * for either a real open or a different sentence; opening it is the half that
 * cannot go stale, because the selector is where the switch actually lives.
 */
export function isExperimentsSelectorRequest(trimmed: string): boolean {
  if (trimmed === "/experiments") return true;
  if (!trimmed.startsWith("/experiments ")) return false;
  const [subcommand] = trimmed.slice("/experiments ".length).split(/\s+/);
  return subcommand !== "diffs";
}

/**
 * The selector's `openOverlay` arguments, in one place.
 *
 * They live here rather than at the call site because `use-submit-handler.ts` is
 * pinned at its line ceiling: the receipt it leaves ("Opening experiments
 * selector…") is part of this command's definition, so it belongs with the
 * predicate that decides when the command fires.
 */
export const EXPERIMENTS_OVERLAY_ARGS = [
  "experiment",
  "/experiments",
  "Opening experiments selector...",
  "Experiments dialog dismissed",
] as const;
