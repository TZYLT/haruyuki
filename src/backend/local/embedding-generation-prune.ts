/**
 * Bounded retention for committed index generations (feature 48, rework A2/A3).
 *
 * Every successful build writes a brand-new immutable generation directory
 * (`embedding-format.ts`) and moves `current.json` to it. Nothing in the write
 * path can delete the superseded generation on its own — the old directory is
 * the rollback material of the build in flight (and the window a concurrent
 * reader may still be inside). Left alone, a space therefore keeps every
 * generation it ever wrote: the 10× corpus is 231 MB per generation and an
 * incremental build rewrites units repeatedly, so this grows without bound.
 *
 * This module is the smallest safe cleaner for that growth. After a commit it
 * keeps the generation `current.json` points at plus `keep` newer-than-nothing
 * predecessors (default one: the previous build) and removes only directories
 * that are older than that window. It is *not* the user-facing sweep
 * (`embedding-lifecycle.ts` `sweepEmbeddingOrphanGenerations` /
 * `deleteEmbeddingOrphanGenerations`), which previews and deletes on request;
 * this runs automatically, so it is conservative:
 *
 * - only real directories with a safe generation name are candidates; temp
 *   directories (`.<...>`), files and unknown names are never touched;
 * - the current generation is excluded by pointer, and the pointer is read
 *   again at delete time (preview/delete stay separate here too, docs/31 §2);
 * - every failure is reported as a warning, never thrown: cleanup is a cache
 *   concern and must not fail a build;
 * - the caller decides when to call it (the runner does so after a unit's
 *   generation is committed).
 *
 * Layer: `backend/local/`. Imports node builtins and the sibling index format
 * only; no `cli/`, `websocket/`, `reminders/` or `agent/` import.
 */

import { type Dirent, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readEmbeddingIndexPointer } from "./embedding-format";

/** Non-current generations kept after a commit (the previous build). */
export const EMBEDDING_GENERATION_KEEP_PREVIOUS = 1;

/** Same component rule the index writer enforces for a generation name. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One generation a prune would remove. */
export type EmbeddingGenerationPruneCandidate = {
  generation: string;
  path: string;
  /** Directory mtime in ms, or `0` when it vanished before it could be stat-ed. */
  mtimeMs: number;
};

/**
 * Read-only list of generations a prune would remove. Never throws; a missing
 * unit directory, a corrupt pointer or an unreadable entry degrade to "nothing
 * to prune" / skipped entries rather than an exception.
 */
export type EmbeddingGenerationPrunePreview = {
  unitDir: string;
  /** Generation `current.json` names, or `null` when it is missing/corrupt. */
  current: string | null;
  /** Non-current generations kept beyond `current` (see the module comment). */
  keep: number;
  candidates: readonly EmbeddingGenerationPruneCandidate[];
};

export type EmbeddingGenerationPruneResult = {
  deleted: string[];
  skipped: string[];
  warnings: string[];
};

function normalizeKeep(keep: number | undefined): number {
  return keep !== undefined && Number.isInteger(keep) && keep >= 0
    ? keep
    : EMBEDDING_GENERATION_KEEP_PREVIOUS;
}

function safeGenerationName(name: string): boolean {
  return SAFE_SEGMENT.test(name);
}

function readEntries(unitDir: string): Dirent[] | undefined {
  try {
    return readdirSync(unitDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

/**
 * Lists the generations a prune would remove: every committed generation older
 * than `current` plus the `keep` newest non-current ones ("older" is the
 * directory mtime, with the name as a deterministic same-millisecond
 * tie-break). A unit whose pointer cannot be read keeps its `keep` newest
 * generations as recovery material and reports the rest.
 */
export function previewEmbeddingGenerationPrune(
  unitDir: string,
  options: { keep?: number } = {},
): EmbeddingGenerationPrunePreview {
  const keep = normalizeKeep(options.keep);
  const pointer = readEmbeddingIndexPointer(unitDir);
  const current = pointer.ok ? pointer.pointer.generation : null;
  const candidates: EmbeddingGenerationPruneCandidate[] = [];
  const entries = readEntries(unitDir);
  if (entries === undefined) {
    return { unitDir, current, keep, candidates };
  }
  const generations: EmbeddingGenerationPruneCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!safeGenerationName(entry.name)) continue;
    const path = join(unitDir, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // A generation that vanished between readdir and stat is simply gone.
    }
    generations.push({ generation: entry.name, path, mtimeMs });
  }
  generations.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
    if (left.generation === right.generation) return 0;
    return left.generation < right.generation ? 1 : -1;
  });
  let kept = 0;
  for (const generation of generations) {
    if (current !== null && generation.generation === current) continue;
    if (kept < keep) {
      kept += 1;
      continue;
    }
    candidates.push(generation);
  }
  return { unitDir, current, keep, candidates };
}

/**
 * Deletes exactly the directories {@link previewEmbeddingGenerationPrune}
 * listed. Each path is re-validated (still inside `unitDir`, one safe segment,
 * still a directory) and re-checked against the unit's *current* pointer, so a
 * generation that became current after the preview is skipped. Never throws.
 */
export function pruneEmbeddingGenerations(
  unitDir: string,
  options: { keep?: number } = {},
): EmbeddingGenerationPruneResult {
  const preview = previewEmbeddingGenerationPrune(unitDir, options);
  const deleted: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const candidate of preview.candidates) {
    const expected = join(unitDir, candidate.generation);
    if (
      expected !== candidate.path ||
      candidate.generation.startsWith(".") ||
      !safeGenerationName(candidate.generation)
    ) {
      warnings.push(
        `generation path does not belong to the unit: ${candidate.path}`,
      );
      continue;
    }
    const pointer = readEmbeddingIndexPointer(unitDir);
    if (pointer.ok && pointer.pointer.generation === candidate.generation) {
      skipped.push(candidate.path);
      continue;
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(candidate.path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      skipped.push(candidate.path);
      continue;
    }
    try {
      rmSync(candidate.path, { recursive: true, force: true });
      deleted.push(candidate.path);
    } catch (error) {
      warnings.push(
        `cannot remove generation ${candidate.generation}: ${errorMessage(error)}`,
      );
    }
  }
  return { deleted, skipped, warnings };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
