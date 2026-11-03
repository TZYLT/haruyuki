/**
 * Process boundary for the embedding worker (split out of `worker-client.ts`
 * for C7: the client grows a watchdog and must stay under the 1,000-line
 * ceiling, and "how to spawn and normalize a child" is its own concern).
 *
 * The shape is deliberately minimal so tests can inject any object with the
 * same surface (`worker-client.ts` does exactly that for spawn/handshake
 * failures). The default implementation is the only place in the embedding
 * subsystem that calls `node:child_process`.
 *
 * Layer: `backend/local/`; imports `node:child_process` only.
 */

import { spawn } from "node:child_process";

/** How the process ended. `error` is set when the spawn itself failed. */
export interface EmbeddingWorkerExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: Error;
}

/**
 * Minimal normalized handle over a spawned child. The default implementation
 * wraps `node:child_process`; tests may inject any object with the same shape.
 */
export interface EmbeddingWorkerProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  write(line: string): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  readonly exited: Promise<EmbeddingWorkerExit>;
}

/** Environment/working directory for the spawned worker. */
export interface EmbeddingWorkerSpawnOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/** Injectable process spawner (`process.execPath` + worker path by default). */
export type EmbeddingWorkerSpawner = (
  command: string,
  args: readonly string[],
  options: EmbeddingWorkerSpawnOptions,
) => EmbeddingWorkerProcessHandle;

/**
 * Spawn the worker via `process.execPath`. Kept exported (rather than hidden)
 * so callers can reuse the exact same process shape for diagnostics, and so
 * tests can assert the default handle's error handling.
 */
export function spawnEmbeddingWorkerProcess(
  command: string,
  args: readonly string[],
  options: EmbeddingWorkerSpawnOptions,
): EmbeddingWorkerProcessHandle {
  const child = spawn(command, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  const stdin = child.stdin;
  if (stdout === null || stderr === null || stdin === null) {
    throw new Error("The embedding worker was spawned without piped stdio.");
  }
  let stdinError: Error | null = null;
  stdin.on("error", (error: Error) => {
    stdinError = error;
  });
  const exited = new Promise<EmbeddingWorkerExit>((resolveExit) => {
    let settled = false;
    const settle = (value: EmbeddingWorkerExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(value);
    };
    child.on("exit", (code, signal) => {
      settle({ code, signal: signal ?? null });
    });
    child.on("error", (error) => {
      settle({ code: null, signal: null, error });
    });
  });
  return {
    pid: child.pid,
    stdout,
    stderr,
    write(line: string): void {
      if (stdinError !== null) throw stdinError;
      stdin.write(line);
    },
    kill(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
      try {
        child.kill(signal);
      } catch {
        // The process may already be gone; the exit promise is the truth.
      }
    },
    exited,
  };
}

/** Stable one-line description of a process exit (diagnostics only). */
export function describeEmbeddingWorkerExit(exit: EmbeddingWorkerExit): string {
  if (exit.error !== undefined) return exit.error.message;
  if (exit.signal !== null) return `was killed by ${exit.signal}`;
  return `exited with code ${String(exit.code)}`;
}
