/**
 * Enumerate the units a stored embedding space already contains (feature 48,
 * rework A2).
 *
 * The status face and the vector recall arm both need the *set of units* in one
 * space directory: `current.json` is the only commit point of a unit, so a unit
 * counts only when its pointer is readable. Two consumers with different shapes
 * share this one scan:
 *
 * 1. {@link listEmbeddingSpaceUnitKeys} returns the space-relative key
 *    vocabulary `embedding-lifecycle.ts` already uses (`<conversationKey>` or
 *    `memory/<fileKey>`), which is what a reset/retention call passes to
 *    `removeEmbeddingUnitIndex`.
 * 2. {@link listEmbeddingSpaceUnits} returns the `RecallVectorUnit` shape
 *    (`transcript`/`memory`) that the B2 search arm consumes. It is declared
 *    structurally here rather than imported from `reminders/`, because
 *    `backend/` may not depend on the reminder layer; the two are assignable in
 *    both directions, so the caller can pass the result straight through.
 *
 * The scan is read-only, never throws, and orders results deterministically:
 * conversation keys in directory order, then memory keys, so two status reads
 * of an unchanged space print the same lines.
 *
 * Layer: `backend/local/embedding*`. Imports the sibling index format only.
 */

import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  EMBEDDING_MEMORY_DIR_NAME,
  readEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";

/** A unit's kind; mirrors `EmbeddingIndexMeta.unitKind`. */
export type EmbeddingSpaceUnitKind = "conversation" | "memory";

/** One usable unit in a space directory, keyed the way lifecycle calls spell it. */
export interface EmbeddingSpaceUnitKey {
  /** `<conversationKey>` or `memory/<fileKey>`; usable by `removeEmbeddingUnitIndex`. */
  readonly unitKey: string;
  readonly kind: EmbeddingSpaceUnitKind;
}

/**
 * The `RecallVectorUnit` shape (`reminders/recall-vector-source.ts`) declared
 * structurally so this layer stays below the reminder layer.
 *
 * A memory unit's `file` is its file key rather than the memory-relative path:
 * the key is all a space directory stores, and the parent reader owns the path
 * resolution (it is handed the memory workspace root separately).
 */
export type EmbeddingSpaceUnitRef =
  | { readonly kind: "transcript"; readonly conversationKey: string }
  | {
      readonly kind: "memory";
      readonly file: string;
      readonly memoryFileKey: string;
    };

/** One safe path component; same rule the index writer and lifecycle apply. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readDirectoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isUsableUnitDir(directory: string): boolean {
  return readEmbeddingIndexPointer(directory).ok;
}

/**
 * Every unit of `spaceDir` whose `current.json` is readable.
 *
 * A missing space directory (the normal state before the first build) returns
 * `[]`; files, dot-directories, the `memory` container itself and unsafe names
 * are skipped, so a staging leftover (`.tmp-*`) can never be reported as a
 * unit. Never throws.
 */
export function listEmbeddingSpaceUnitKeys(
  spaceDir: string,
): EmbeddingSpaceUnitKey[] {
  const units: EmbeddingSpaceUnitKey[] = [];
  for (const entry of readDirectoryEntries(spaceDir)) {
    if (!entry.isDirectory()) continue;
    if (entry.name === EMBEDDING_MEMORY_DIR_NAME) continue;
    if (!SAFE_SEGMENT.test(entry.name)) continue;
    if (!isUsableUnitDir(join(spaceDir, entry.name))) continue;
    units.push({ unitKey: entry.name, kind: "conversation" });
  }

  const memoryDir = join(spaceDir, EMBEDDING_MEMORY_DIR_NAME);
  for (const entry of readDirectoryEntries(memoryDir)) {
    if (!entry.isDirectory()) continue;
    if (!SAFE_SEGMENT.test(entry.name)) continue;
    if (!isUsableUnitDir(join(memoryDir, entry.name))) continue;
    units.push({
      unitKey: `${EMBEDDING_MEMORY_DIR_NAME}/${entry.name}`,
      kind: "memory",
    });
  }
  return units;
}

/**
 * The same units in the shape the B2 recall search arm consumes.
 *
 * Memory units carry the file key in both `file` and `memoryFileKey`; see
 * {@link EmbeddingSpaceUnitRef} for why the path is not recoverable here.
 */
export function listEmbeddingSpaceUnits(
  spaceDir: string,
): EmbeddingSpaceUnitRef[] {
  return listEmbeddingSpaceUnitKeys(spaceDir).map(
    (unit): EmbeddingSpaceUnitRef =>
      unit.kind === "memory"
        ? {
            kind: "memory",
            file: memoryFileKeyOf(unit.unitKey),
            memoryFileKey: memoryFileKeyOf(unit.unitKey),
          }
        : { kind: "transcript", conversationKey: unit.unitKey },
  );
}

function memoryFileKeyOf(unitKey: string): string {
  return unitKey.slice(EMBEDDING_MEMORY_DIR_NAME.length + 1);
}
