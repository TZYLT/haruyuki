/**
 * The non-interactive half of vector-recall startup (48-1 §7.1 R-12).
 *
 * `applyEmbeddingSetupFlags` writes the `--recall-embedding*` settings; this
 * module is what makes the flag mean the same thing headless as it does in the
 * TUI: when the flags turned the feature on and the agent is configured, one
 * incremental build starts before the first turn, with `lifecycle: "headless"`
 * so A2 waits for the outcome and the caller can print its receipt.
 *
 * A refusal never fails startup: `buildEmbeddingFromSettings` answers with
 * copy (missing assets, endpoint not configured, another build holds the lock)
 * and that copy is returned. No build runs when the flags are absent/off, when
 * the first-run path wrote nothing (`--recall-embedding on` without a backend
 * choice), or when no agent id is known.
 *
 * Layer: `cli/helpers/`. Imports A2's build entry and D3's settings reader.
 */

import {
  type CliParsedValues,
  type EmbeddingSetupFlagName,
  parseEmbeddingSetupFlags,
} from "@/cli/args";
import { buildEmbeddingFromSettings } from "@/cli/helpers/embedding-runtime";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import { getErrorMessage } from "@/utils/error";

/** The build entry A2 exports; injected so tests never spawn a worker. */
export type EmbeddingHeadlessBuild = typeof buildEmbeddingFromSettings;

/** Seams for {@link applyEmbeddingHeadlessBuild}; every field has a default. */
export interface EmbeddingHeadlessDeps {
  /** Settings reader; defaults to the resolved global embedding settings. */
  readSettings?: () => ResolvedEmbeddingSettings;
  /** Build entry; defaults to A2's `buildEmbeddingFromSettings`. */
  build?: EmbeddingHeadlessBuild;
}

/** Copy for "the flags asked for a build but this process has no agent". */
export const EMBEDDING_HEADLESS_NO_AGENT =
  "Vector recall is on, but this process has no agent id, so no index was built. Start a session for the agent, or run `haruyuki recall embedding build --agent <id>`.";

/**
 * Run the headless build the `--recall-embedding*` flags asked for.
 *
 * Returns the receipt to print after the settings receipt, or `""` when the
 * flags did not ask for a build (no flags, `off`, or a first run that wrote
 * nothing). Never throws: a build refusal is copy, and an unexpected failure is
 * reported as a sentence.
 */
export async function applyEmbeddingHeadlessBuild(
  values: Pick<CliParsedValues, EmbeddingSetupFlagName>,
  scope?: { agentId?: string | null },
  deps: EmbeddingHeadlessDeps = {},
): Promise<string> {
  const parsed = parseEmbeddingSetupFlags(values);
  // A malformed flag combination was already reported by the caller's
  // `applyEmbeddingSetupFlags`; do not stack a second refusal.
  if ("error" in parsed) return "";
  if (parsed.flags.enabled !== true) return "";

  const settings = (deps.readSettings ?? readEmbeddingSettings)();
  // The first-run hint path writes no settings, so the switch is still off.
  if (!settings.enabled) return "";

  const agentId = scope?.agentId?.trim() ?? "";
  if (agentId.length === 0) return EMBEDDING_HEADLESS_NO_AGENT;

  try {
    return await (deps.build ?? buildEmbeddingFromSettings)({
      agentId,
      mode: "incremental",
      keepAfterExit: false,
      lifecycle: "headless",
    });
  } catch (error) {
    return `Could not start the embedding build: ${getErrorMessage(error)}. Nothing is running.`;
  }
}
