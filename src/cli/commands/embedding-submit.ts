/**
 * The TUI submit seam for `/recall embedding …` (48-1 §7.1, 48-2 §3.4 D6).
 *
 * D4's handler already serves every surface; the one thing the submit path can
 * add is the shell seam: a first-run `on`/`setup` should bring the user to the
 * settings page when the full-screen shell owns one, and fall back to D4's
 * copy-paste hint (which D4 writes when `openSetup` returns `false`) in the
 * append shell. Keeping that branch here — rather than in
 * `use-submit-handler.ts` — is what keeps the pinned submit file to an import
 * plus one call (the same split `/dream` uses, where the action module owns the
 * entrances and the submit path hands it the UI seams).
 *
 * The settings page is owned by the tab store (`focusTab`), not by this module:
 * `shell-commands.ts`'s `/settings` case is the same two lines, and choosing
 * the tab directly is the operation a first-run seam actually means. The shell
 * decision stays behind {@link resolveUiV2Once} so the append shell keeps
 * printing the copy-paste hint instead of claiming a page it cannot draw.
 */

import type { DreamCommandScope } from "@/agent/reflection-runs";
import { focusTab } from "@/cli/app/tabs";
import {
  type EmbeddingCommandDeps,
  handleEmbeddingCommand,
} from "@/cli/commands/embedding";
import { createEmbeddingRuntimePort } from "@/cli/helpers/embedding-runtime";
import { resolveUiV2Once } from "@/experiments/ui-v2";
import { getErrorMessage } from "@/utils/error";

/** The runner surface this seam needs; a real `createCommandRunner` fits it. */
export interface EmbeddingSubmitRunner {
  start(
    input: string,
    output: string,
  ): {
    finish(output: string, success?: boolean): void;
    fail(output: string): void;
  };
}

/**
 * Parse the words after `/recall embedding`.
 *
 * Exported because the parenthesis-thin part is exactly what a future surface
 * would copy; one splitter is cheaper than three that disagree on double
 * spaces.
 */
export function embeddingSubmitArgs(input: string): string[] {
  const rest = input.replace(/^\/recall\s+embedding\s*/, "").trim();
  return rest.length === 0 ? [] : rest.split(/\s+/);
}

/** Focus the settings page when the full-screen shell owns one. */
function openEmbeddingSettings(): boolean {
  if (!resolveUiV2Once()) return false;
  focusTab("settings");
  return true;
}

/**
 * Run one `/recall embedding …` from the TUI and paint its receipt.
 *
 * `deps` is forwarded to D4's handler; tests use it to inject settings/runtime
 * fakes and to short-circuit the setup seam.
 */
export async function runEmbeddingSubmitCommand(
  input: string,
  scope: DreamCommandScope | undefined,
  runner: EmbeddingSubmitRunner,
  deps: EmbeddingCommandDeps = {},
): Promise<string> {
  const command = runner.start(input, "Checking vector recall...");
  try {
    const output = await handleEmbeddingCommand(
      embeddingSubmitArgs(input),
      scope,
      {
        ...deps,
        // The TUI owns an in-process build: the receipt returns immediately and
        // progress reaches the status line through A5. Only the caller-supplied
        // runtime wins, so tests can still inject a fake.
        runtime:
          deps.runtime === undefined
            ? createEmbeddingRuntimePort({ lifecycle: "tui" })
            : deps.runtime,
        openSetup: deps.openSetup ?? openEmbeddingSettings,
      },
    );
    command.finish(output, true);
    return output;
  } catch (error) {
    // The handler is written not to throw for user errors; anything that still
    // throws is a bug and must reach the receipt row instead of a dead command.
    command.fail(`Vector recall failed: ${getErrorMessage(error)}`);
    throw error;
  }
}
