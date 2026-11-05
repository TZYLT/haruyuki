/**
 * The TUI seam that raises the vector-recall setup wizard (48-2 §4.9 D5).
 *
 * `/recall embedding connect` (and a first-run `/recall embedding on`) reaches D4's
 * command handler, which owns the text and asks its host whether it can open a
 * setup face (`EmbeddingCommandDeps.openSetup`). This module is that face's
 * shell half: it owns the overlay id, the command row's opening/dismiss text and
 * the return value the handler expects, so the pinned submit file only has to
 * hand over its `openOverlay`.
 *
 * Keeping it out of `use-submit-handler.ts` is the same split `/dream` uses: the
 * action module owns the entrances and the submit path only supplies the seam.
 * Nothing here renders or writes.
 */

import type { ActiveOverlay } from "@/cli/app/types";

/** The overlay id the wizard renders under (`ActiveOverlay`). */
export const EMBEDDING_WIZARD_OVERLAY = "embedding-wizard";

/** The command row the overlay belongs to. */
export const EMBEDDING_WIZARD_COMMAND = "/recall embedding connect";

/** The four `openOverlay` arguments, narrowed to what this seam needs. */
export type EmbeddingWizardOpenOverlay = (
  overlay: NonNullable<ActiveOverlay>,
  input: string,
  openingOutput: string,
  dismissOutput: string,
) => unknown;

/**
 * Raise the wizard and report that this shell has one.
 *
 * `true` is what D4's handler treats as "the wizard opened, say so"; it is the
 * whole contract of `EmbeddingCommandDeps.openSetup`.
 */
export function openEmbeddingWizard(
  openOverlay: EmbeddingWizardOpenOverlay,
  commandInput: string = EMBEDDING_WIZARD_COMMAND,
): boolean {
  openOverlay(
    EMBEDDING_WIZARD_OVERLAY,
    commandInput,
    "Opening the embedding connect wizard...",
    "Embedding setup closed",
  );
  return true;
}

/** `openSetup` in the shape D4's handler takes. */
export function embeddingWizardSetupOpener(
  openOverlay: EmbeddingWizardOpenOverlay,
): (commandInput: string) => boolean {
  return (commandInput) => openEmbeddingWizard(openOverlay, commandInput);
}
