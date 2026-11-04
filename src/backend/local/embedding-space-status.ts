/**
 * Cheap summary of one embedding space directory (feature 48, rework A1).
 *
 * The status surface and the "should this space be reclaimed" decision need the
 * shape of a space without loading a single vector: the resident cache would
 * otherwise page in tens of megabytes just to print a line. Everything here
 * reads only `current.json` pointers and each generation's `meta.json`, which are
 * a few hundred bytes per unit.
 *
 * Invariants:
 *
 * - **Never throws.** A missing directory, an unreadable pointer, a corrupt
 *   `meta.json` or a half-deleted generation all degrade to "that unit does not
 *   count" (or `coverage: null`), because this runs on a status path where an
 *   exception would take down the command the user ran to diagnose the problem.
 * - **Space-wide values are only reported when unambiguous.** If two units
 *   disagree about width or precision, the space is not one vector space (a
 *   build bug or a hand-copied directory); `dimensions`/`quant` become `null`
 *   rather than reporting the first unit's value as if it described the whole.
 * - **`builtAt` is the newest committed unit**, not the directory mtime: a unit
 *   rebuild after a restore moves the fact the user cares about.
 * - **`coverage` is the aggregate char ratio** across the `meta.json` files that
 *   could be read (sum embedded / sum recallable); `null` when none could be.
 *
 * Layer: `backend/local/embedding*`. Imports the sibling index format only.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMBEDDING_INDEX_FILE_NAMES,
  type EmbeddingIndexQuant,
  embeddingGenerationDir,
  readEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";

/** Directory name holding memory units; same value `embedding-format.ts` uses. */
const MEMORY_DIR_NAME = "memory";

/** One safe path component; same rule the index writer enforces. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Aggregate shape of one space, with `null` where the truth is unknown. */
export interface EmbeddingSpaceSummary {
  /** Committed chunks across every unit; `0` when nothing is usable. */
  readonly chunks: number;
  /** Conversation units with a readable pointer. */
  readonly conversations: number;
  /** Memory-file units with a readable pointer. */
  readonly memoryFiles: number;
  /** Vector width when every unit agrees; otherwise `null`. */
  readonly dimensions: number | null;
  /** Storage precision when every unit agrees; otherwise `null`. */
  readonly quant: EmbeddingIndexQuant | null;
  /** Newest `updatedAt` among committed units (ISO string), or `null`. */
  readonly builtAt: string | null;
  /** Aggregate embedded/recallable char ratio, or `null` when unread. */
  readonly coverage: number | null;
}

type UnitKind = "conversation" | "memory";

type UnitDirectory = {
  readonly kind: UnitKind;
  readonly dir: string;
};

/**
 * Read the whole space summary in one pass. Never throws; an absent or
 * unreadable `spaceDir` is the all-zero summary.
 */
export function readEmbeddingSpaceSummary(
  spaceDir: string,
): EmbeddingSpaceSummary {
  let chunks = 0;
  let conversations = 0;
  let memoryFiles = 0;
  let dimensions: number | null = null;
  let dimensionsConflict = false;
  let quant: EmbeddingIndexQuant | null = null;
  let quantConflict = false;
  let builtAt: string | null = null;
  let embeddedChars = 0;
  let recallableChars = 0;
  let coverageSeen = false;

  for (const unit of listUnitDirectories(spaceDir)) {
    const pointerResult = readEmbeddingIndexPointer(unit.dir);
    if (!pointerResult.ok) continue;
    const pointer = pointerResult.pointer;
    if (unit.kind === "memory") memoryFiles += 1;
    else conversations += 1;
    chunks += Number.isFinite(pointer.chunkCount)
      ? Math.max(0, Math.trunc(pointer.chunkCount))
      : 0;
    if (dimensions === null) dimensions = pointer.dimensions;
    else if (dimensions !== pointer.dimensions) dimensionsConflict = true;
    if (quant === null) quant = pointer.quant;
    else if (quant !== pointer.quant) quantConflict = true;
    if (builtAt === null || pointer.updatedAt > builtAt) {
      builtAt = pointer.updatedAt;
    }
    const coverage = readGenerationCoverage(unit.dir, pointer.generation);
    if (coverage !== null) {
      coverageSeen = true;
      embeddedChars += coverage.embeddedChars;
      recallableChars += coverage.recallableChars;
    }
  }

  return {
    chunks,
    conversations,
    memoryFiles,
    dimensions: dimensionsConflict ? null : dimensions,
    quant: quantConflict ? null : quant,
    builtAt,
    coverage:
      coverageSeen && recallableChars > 0
        ? embeddedChars / recallableChars
        : null,
  };
}

/**
 * Whether the space has at least one unit whose `current.json` is valid. This is
 * the "can the query path find anything at all" test; it does not load vectors
 * and does not require the generations to be readable.
 */
export function hasUsableEmbeddingSpace(spaceDir: string): boolean {
  for (const unit of listUnitDirectories(spaceDir)) {
    if (readEmbeddingIndexPointer(unit.dir).ok) return true;
  }
  return false;
}

function readDirectoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isSafeSegment(name: string): boolean {
  return SAFE_SEGMENT.test(name);
}

/**
 * Every unit directory in the space: conversation keys directly below the
 * space, memory keys below `memory/`. Only real directories with safe names
 * count, so staging leftovers (`.tmp-*`), user files and symlinked oddities are
 * ignored rather than counted as units.
 */
function listUnitDirectories(spaceDir: string): UnitDirectory[] {
  const units: UnitDirectory[] = [];
  for (const entry of readDirectoryEntries(spaceDir)) {
    if (!entry.isDirectory()) continue;
    if (entry.name === MEMORY_DIR_NAME) {
      const memoryDir = join(spaceDir, MEMORY_DIR_NAME);
      for (const memoryEntry of readDirectoryEntries(memoryDir)) {
        if (!memoryEntry.isDirectory() || !isSafeSegment(memoryEntry.name)) {
          continue;
        }
        units.push({
          kind: "memory",
          dir: join(memoryDir, memoryEntry.name),
        });
      }
      continue;
    }
    if (!isSafeSegment(entry.name)) continue;
    units.push({ kind: "conversation", dir: join(spaceDir, entry.name) });
  }
  return units;
}

function readGenerationCoverage(
  unitDir: string,
  generation: string,
): { embeddedChars: number; recallableChars: number } | null {
  let raw: string;
  try {
    const generationDir = embeddingGenerationDir(unitDir, generation);
    raw = readFileSync(
      join(generationDir, EMBEDDING_INDEX_FILE_NAMES.meta),
      "utf8",
    );
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const coverage = (parsed as Record<string, unknown>).coverage;
  if (typeof coverage !== "object" || coverage === null) return null;
  const record = coverage as Record<string, unknown>;
  const embeddedChars = record.embeddedChars;
  const recallableChars = record.recallableChars;
  if (!isNonNegativeFinite(embeddedChars)) return null;
  if (!isNonNegativeFinite(recallableChars)) return null;
  return { embeddedChars, recallableChars };
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
