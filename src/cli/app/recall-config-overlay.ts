/**
 * The TUI seam that raises `/recall embedding config`'s build-settings page.
 *
 * A bare `config` reaches `runEmbeddingSubmitCommand`, whose `openConfig`
 * dependency asks the shell "can you show this face?". It is the only spelling
 * that gets the page: `config <key>` and `config <key> <value>` keep printing,
 * which is what every non-interactive surface does.
 *
 * The split is `embedding-wizard-overlay.ts`'s: this module owns the overlay id,
 * the command row's copy and the boolean the seam expects, so the pinned submit
 * file hands over its `openOverlay` and nothing else. Nothing here renders.
 */

import type { ActiveOverlay } from "@/cli/app/types";

/** The overlay id the page renders under (`ActiveOverlay`). */
export const RECALL_EMBEDDING_CONFIG_OVERLAY = "recall-embedding-config";

/** The command row the face belongs to. */
export const RECALL_EMBEDDING_CONFIG_COMMAND = "/recall embedding config";

/** The four `openOverlay` arguments, narrowed to what this seam needs. */
export type RecallConfigOpenOverlay = (
  overlay: NonNullable<ActiveOverlay>,
  input: string,
  openingOutput: string,
  dismissOutput: string,
) => unknown;

/**
 * The spellings the recall picker owns.
 *
 * A bare `/recall` opens it; a bare `/recall config` opens the same face rather
 * than printing the table, because the table's keys are editable rows there.
 * Every other spelling — `config <key>`, `config <key> <value>`, `status` — keeps
 * its printed answer, which is what headless and the CLI subcommand do.
 *
 * The comparison is on collapsed whitespace: the registry splits a slash command
 * on any run of spaces, so `/recall   config` is the same command and must not
 * fall through to the printer.
 *
 * The predicate lives here, not inline in the pinned submit hook, so the rule is
 * a unit test instead of an assertion about a 2.9k-line callback.
 */
export function isRecallOverlayCommand(input: string): boolean {
  const collapsed = input.trim().replace(/\s+/g, " ");
  return collapsed === "/recall" || collapsed === "/recall config";
}

/**
 * Raise the page and report that this shell has one.
 *
 * `true` is the whole contract of `EmbeddingSubmitDeps.openConfig`; a shell
 * without the face omits the seam, which leaves the printed table in place.
 */
export function openRecallEmbeddingConfig(
  openOverlay: RecallConfigOpenOverlay,
  commandInput: string = RECALL_EMBEDDING_CONFIG_COMMAND,
): boolean {
  openOverlay(
    RECALL_EMBEDDING_CONFIG_OVERLAY,
    commandInput,
    "Opening vector recall build settings...",
    "Vector recall build settings dismissed",
  );
  return true;
}

/** `openConfig` in the shape the submit seam takes. */
export function embeddingConfigFaceOpener(
  openOverlay: RecallConfigOpenOverlay,
): () => boolean {
  return () => openRecallEmbeddingConfig(openOverlay);
}
