/**
 * The dream-run context guard (F-06 Q-53).
 *
 * A dream run executes unattended in its own short-lived child process, and
 * the tools it needs are declared from the run conversation's
 * `origin: "dream"` record (`tools/toolset.ts`). Two properties follow:
 *
 * - the declared family only ever appears on that conversation, and
 * - a tool the model calls must not end in `ask`, because `ask` in a headless
 *   run is a denial — but the allowance must not widen for ordinary sessions.
 *
 * The runtime context carries `dreamRun` for exactly this purpose; the
 * permission checker consults it when deciding a tool's default.
 */

import {
  getRuntimeContext,
  type RuntimeContextSnapshot,
} from "@/runtime-context";

/**
 * Tools auto-allowed inside a dream run, and nowhere else.
 *
 * `MemoryCommit` is the reason this list exists: `acceptEdits` has no shell, so
 * a commit has to come from a harness tool, and without the explicit allowance
 * the unattended child would deny its own commit. The three after it are the
 * run's own self-reporting tools (M3): an `ask` would be a denial, and the run
 * has nobody to ask (Q-53 / §2.5). Declaring them here is safe before they are
 * implemented — `tools/toolset.ts` only declares the dream tools that exist in
 * `TOOL_DEFINITIONS`.
 */
export const DREAM_AUTO_ALLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "MemoryCommit",
  "DreamStatus",
  "DreamDone",
  "DreamAuthorization",
  // `DreamNote` writes one line to the agent's queue under the harness home
  // (no conversation, no memory write), so an unattended run can leave its next
  // self a note. Ordinary sessions allow it too, through the checker.
  "DreamNote",
]);

/** True when this turn belongs to a dream-run conversation. */
export function isDreamRun(
  runtimeContext: RuntimeContextSnapshot | undefined = getRuntimeContext(),
): boolean {
  return runtimeContext?.dreamRun === true;
}
