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
  type EmbeddingRuntimePort,
} from "@/cli/commands/embedding";

/** `receipt` is empty when no embedding flag was given. */
export type EmbeddingSetupFlagOutcome =
  | { ok: true; receipt: string }
  | { ok: false; error: string };

/**
 * The production runtime port for the non-interactive endpoint probe.
 *
 * Imported lazily: an ordinary start (no `--recall-embedding-endpoint`) must not
 * load the worker/ONNX/build modules, and until this existed both entry points
 * passed no runtime at all, so `--recall-embedding-endpoint` could never finish
 * its mandatory test-embed on a shell (48-1 §7.2's "三路径" requirement).
 */
export async function createEmbeddingSetupRuntimePort(): Promise<EmbeddingRuntimePort> {
  const { createEmbeddingRuntimePort } = await import(
    "@/cli/helpers/embedding-runtime"
  );
  return createEmbeddingRuntimePort({ lifecycle: "headless" });
}

/** The command seams plus the test hook for the default runtime port. */
export type EmbeddingSetupFlagDeps = EmbeddingCommandDeps & {
  /** Builds the port the endpoint probe needs; defaults to the real one. */
  createRuntime?: () => Promise<EmbeddingRuntimePort> | EmbeddingRuntimePort;
};

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
  deps: EmbeddingSetupFlagDeps = {},
): Promise<EmbeddingSetupFlagOutcome> {
  const parsed = parseEmbeddingSetupFlags(values);
  if ("error" in parsed) {
    return { ok: false, error: parsed.error };
  }
  const { createRuntime, ...commandDeps } = deps;
  // The endpoint form is accepted only after a real test-embed (48-1 §7.2),
  // and the probe needs a runtime port. Building it here rather than in each
  // entry point is what makes the three paths agree; it stays lazy so an
  // ordinary start does not load the worker/ONNX/build modules.
  let runtime: EmbeddingRuntimePort | undefined;
  if (
    parsed.flags.endpoint !== undefined &&
    commandDeps.runtime === undefined
  ) {
    try {
      runtime = await (createRuntime ?? createEmbeddingSetupRuntimePort)();
    } catch {
      // No port in this process: the writer below answers with the honest
      // "needs the runtime" refusal instead of throwing at startup.
      runtime = undefined;
    }
  }
  const receipt = await applyEmbeddingCliFlags(
    parsed.flags,
    scope,
    runtime === undefined ? commandDeps : { ...commandDeps, runtime },
  );
  return { ok: true, receipt };
}
