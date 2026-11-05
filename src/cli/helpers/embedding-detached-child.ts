/**
 * The detached child that outlives its embedding-build host (48-2 §4.8).
 *
 * `startEmbeddingBuild` decides *whether* to detach; this module owns the
 * process boundary: the spawn options that make a child survive the parent
 * (`detached`, `windowsHide`, no stdio) and the guard that turns an immediate
 * spawn failure into a thrown error.
 *
 * **Why the pid guard.** `child_process.spawn` reports ENOENT/EACCES as an
 * asynchronous `error` event, not as a throw, and returns a handle with no
 * `pid`. Without this check the host would announce "detached (pid ?)" while
 * nothing was running. The host repeats the check because tests inject a
 * spawner; both layers must agree that "no pid" is a failure.
 *
 * Layer: `cli/helpers/`; imports `node:child_process` and `@/utils/debug`.
 */

import { spawn } from "node:child_process";
import { debugWarn } from "@/utils/debug";

/** Minimal handle over the detached child; tests inject a fake. */
export interface EmbeddingDetachedChild {
  readonly pid?: number;
  unref(): void;
  /** Used by {@link cancelEmbeddingBuild} while this host still owns the child. */
  kill?(signal?: "SIGTERM" | "SIGKILL"): boolean;
}

/** Literal so a test can assert the Windows-relevant three without a real child. */
export interface EmbeddingDetachedSpawnOptions {
  detached: true;
  windowsHide: true;
  stdio: "ignore";
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Test seam: capture the call and return a fake child instead of spawning. */
export type EmbeddingDetachedSpawner = (
  command: string,
  args: readonly string[],
  options: EmbeddingDetachedSpawnOptions,
) => EmbeddingDetachedChild;

/** This build's own re-entry command, handed to the detached child. */
export interface EmbeddingDetachedCommand {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Extra child environment, merged over this process's environment. */
  env?: Record<string, string | undefined>;
}

/**
 * Spawn the re-entry command detached. Throws when the child got no pid, so the
 * host reports a refusal instead of a phantom running build.
 */
export function spawnDetachedBuildChild(
  command: string,
  args: readonly string[],
  options: EmbeddingDetachedSpawnOptions,
): EmbeddingDetachedChild {
  const child = spawn(command, [...args], options);
  child.once("error", (error) => {
    debugWarn(
      "embedding",
      `detached build "${command}" could not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (child.pid === undefined) {
    throw new Error(`detached build "${command}" did not start (no pid)`);
  }
  return child;
}
