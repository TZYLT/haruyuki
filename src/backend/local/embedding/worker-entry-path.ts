/**
 * Which worker file to spawn: the TypeScript source under Bun, or the built
 * `embedding-worker.js` shipped in the npm package under Node (C7).
 *
 * 48-2 §4.4 requires one build entry and two runtime paths: `bun run dev`
 * executes `src/backend/local/embedding/worker-entry.ts` directly, while the
 * published package ships the bundle next to `haruyuki.js`. The caller owns
 * both candidate paths (it knows the package root and the source root); this
 * module owns the contract: the file-name constants that `build.js`,
 * `package.json` `files` and the runtime must agree on, plus the pure
 * resolution rule.
 *
 * Resolution prefers the candidate that fits the running runtime (Bun ->
 * source, Node -> bundle) and falls back to the other when the preferred file
 * is absent, so a dev checkout that also has stale build artifacts still runs
 * the source, and a published package never guesses at a missing `.ts` file.
 *
 * Layer: `backend/local/`; imports `node:fs` (`existsSync`) only.
 */

import { existsSync } from "node:fs";

/** Built worker file shipped in the npm package (`files` entry). */
export const EMBEDDING_WORKER_BUNDLE_FILENAME = "embedding-worker.js";

/** TypeScript worker entry used by `bun run dev` and the tests. */
export const EMBEDDING_WORKER_SOURCE_FILENAME = "worker-entry.ts";

/** Which of the two entries a resolution picked. */
export type EmbeddingWorkerEntryKind = "bundled" | "source";

/** Runtime the caller is on; both are real paths (48-2 §4.4). */
export type EmbeddingWorkerEntryRuntime = "bun" | "node";

/** The two absolute candidate paths, supplied by the caller. */
export interface EmbeddingWorkerEntryCandidates {
  /** Absolute path of the built worker inside the installed package. */
  readonly bundled: string;
  /** Absolute path of the TypeScript worker inside the source checkout. */
  readonly source: string;
}

/** A resolved worker entry. */
export interface EmbeddingWorkerEntryResolution {
  readonly path: string;
  readonly kind: EmbeddingWorkerEntryKind;
  readonly runtime: EmbeddingWorkerEntryRuntime;
  readonly candidates: EmbeddingWorkerEntryCandidates;
}

/** Options for {@link resolveEmbeddingWorkerEntry}. */
export interface EmbeddingWorkerEntryResolutionOptions {
  /** Existence probe (injectable for tests). Defaults to `existsSync`. */
  readonly exists?: (path: string) => boolean;
  /** Runtime the caller is on; detected from `process.versions` by default. */
  readonly runtime?: EmbeddingWorkerEntryRuntime;
  /** Try this kind first regardless of runtime (tests/diagnostics). */
  readonly prefer?: EmbeddingWorkerEntryKind;
}

/**
 * Thrown when neither candidate exists: the installation is incomplete or the
 * checkout is broken. Callers surface `candidates` instead of guessing.
 */
export class EmbeddingWorkerEntryMissingError extends Error {
  readonly candidates: EmbeddingWorkerEntryCandidates;
  readonly runtime: EmbeddingWorkerEntryRuntime;

  constructor(
    candidates: EmbeddingWorkerEntryCandidates,
    runtime: EmbeddingWorkerEntryRuntime,
  ) {
    super(
      `The embedding worker entry is missing (runtime: ${runtime}); expected the bundled worker at ${candidates.bundled} or the source entry at ${candidates.source}.`,
    );
    this.name = "EmbeddingWorkerEntryMissingError";
    this.candidates = candidates;
    this.runtime = runtime;
  }
}

/** True when the current process runs on Bun (source checkout/dev path). */
export function detectEmbeddingWorkerRuntime(): EmbeddingWorkerEntryRuntime {
  return process.versions.bun === undefined ? "node" : "bun";
}

/**
 * Pick the worker entry for this runtime. Bundled-first on Node (the published
 * package has no `.ts`), source-first on Bun (dev), with the other candidate
 * as the fallback. Throws {@link EmbeddingWorkerEntryMissingError} when neither
 * exists — never returns an unverified path.
 */
export function resolveEmbeddingWorkerEntry(
  candidates: EmbeddingWorkerEntryCandidates,
  options: EmbeddingWorkerEntryResolutionOptions = {},
): EmbeddingWorkerEntryResolution {
  const runtime = options.runtime ?? detectEmbeddingWorkerRuntime();
  const exists = options.exists ?? existsSync;
  const preferred: EmbeddingWorkerEntryKind =
    options.prefer ?? (runtime === "bun" ? "source" : "bundled");
  const fallback: EmbeddingWorkerEntryKind =
    preferred === "bundled" ? "source" : "bundled";
  for (const kind of [preferred, fallback]) {
    const path = kind === "bundled" ? candidates.bundled : candidates.source;
    if (exists(path)) return { path, kind, runtime, candidates };
  }
  throw new EmbeddingWorkerEntryMissingError(candidates, runtime);
}
