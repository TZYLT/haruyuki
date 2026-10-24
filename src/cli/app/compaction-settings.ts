/**
 * Turning a `/compact config` selection into the settings patch the backend stores,
 * plus the receipt line the overlay reports.
 *
 * Kept out of `use-configuration-handlers.ts` for two reasons: that file is at
 * its size ratchet (it may not grow), and "what does picking a mode change?"
 * is a pure question that deserves a pure, directly testable answer.
 */
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { CompactionSelection } from "@/cli/components/CompactionSelector";
import { assertCompactionModeForBackend } from "@/cli/helpers/compaction-mode";

/**
 * The concrete settings object `/compact config` writes. `AgentState` types the
 * stored value and its `mode` as optional, but this function always sets the
 * mode, so the patch narrows both.
 */
export type CompactionSettingsPatch = NonNullable<
  AgentState["compaction_settings"]
> & {
  mode: NonNullable<NonNullable<AgentState["compaction_settings"]>["mode"]>;
};

/**
 * Merge one overlay selection into the stored `compaction_settings`.
 *
 * The overlay reports only what the user actually changed: picking a mode leaves
 * the compression rate alone, and editing the rate leaves the mode alone.
 * Spreading `existing` is what preserves the compaction model and any other
 * field the backend keeps in there.
 *
 * Throws for a mode this backend cannot run — a queued overlay action can carry
 * one that was chosen before the backend changed.
 */
export function buildCompactionSettings(
  existing: AgentState["compaction_settings"] | null | undefined,
  selection: CompactionSelection,
): CompactionSettingsPatch {
  return {
    ...existing,
    mode: assertCompactionModeForBackend(selection.mode),
    ...(selection.compressionPercentage === undefined
      ? {}
      : { sliding_window_percentage: selection.compressionPercentage }),
  };
}

/**
 * The receipt for a saved selection. A mode pick keeps the wording it always
 * had; a rate edit has to say what the rate now does, because "compresses 30%"
 * is only meaningful next to "keeps 70%".
 */
export function formatCompactionUpdate(
  selection: CompactionSelection,
  savedMode: string,
): string {
  if (selection.compressionPercentage === undefined) {
    return `Updated compaction mode to: ${savedMode}`;
  }
  const percent = Math.round(selection.compressionPercentage * 100);
  return `Compression rate set to ${percent}%: each /compact compresses about ${percent}% of the conversation (keeps about ${100 - percent}%).`;
}
