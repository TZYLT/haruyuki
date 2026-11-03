/**
 * The non-interactive `--recall-embedding*` startup path (48-1 §7.1 R-12).
 *
 * D4 owns the flag parser (`args.ts`) and the writer
 * (`applyEmbeddingCliFlags` in `commands/embedding.ts`); this module is only the
 * assembly the non-interactive entry point calls, kept out of both files so
 * neither grows a second copy of the "parse, then apply" sequence. The headless
 * path is the only caller today.
 *
 * The outcome is deliberately not a throw and not a process exit: the caller
 * decides how a bad combination is reported (headless prints it and exits 1,
 * matching every other startup-flag refusal).
 */

import {
  type CliParsedValues,
  type EmbeddingSetupFlagName,
  parseEmbeddingSetupFlags,
} from "@/cli/args";
import {
  applyEmbeddingCliFlags,
  type EmbeddingCommandDeps,
} from "@/cli/commands/embedding";

/** `receipt` is empty when no embedding flag was given. */
export type EmbeddingSetupFlagOutcome =
  | { ok: true; receipt: string }
  | { ok: false; error: string };

/**
 * Validate the five embedding flags and apply them, returning what to print.
 *
 * Validation happens before any settings read or write, so a mistyped
 * combination (a key variable with no endpoint, an endpoint on the builtin
 * backend) leaves the settings untouched and names the flag to fix.
 */
export async function applyEmbeddingSetupFlags(
  values: Pick<CliParsedValues, EmbeddingSetupFlagName>,
  scope?: { agentId?: string | null; conversationId?: string | null },
  deps: EmbeddingCommandDeps = {},
): Promise<EmbeddingSetupFlagOutcome> {
  const parsed = parseEmbeddingSetupFlags(values);
  if ("error" in parsed) {
    return { ok: false, error: parsed.error };
  }
  const receipt = await applyEmbeddingCliFlags(parsed.flags, scope, deps);
  return { ok: true, receipt };
}
