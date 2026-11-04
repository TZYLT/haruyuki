/**
 * Deleting stored vector spaces for `/recall embedding reset` (feature 48,
 * rework A2).
 *
 * The command offers three targets — the current model's space, one model's
 * space, or every space for this agent — and all three share one rule: **only a
 * directory that is provably `<recall root>/<agentId>/<spaceId>` is ever
 * touched**. A reset is irreversible, so the path check runs before anything is
 * read or deleted, and a target that does not exist reports "nothing was
 * deleted" instead of a deletion it never made.
 *
 * The delete order is the one `embedding-lifecycle.ts` already argues for:
 * invalidate every unit's `current.json` first (readers then degrade to lexical
 * recall), then remove the unit indexes, then the now-empty space directory. A
 * partial failure is reported and the next reset finishes the cleanup.
 *
 * Layer: `cli/helpers/`. Imports `backend/local/` and the command contract.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  EMBEDDING_INDEX_FILE_NAMES,
  EMBEDDING_MEMORY_DIR_NAME,
  embeddingGenerationDir,
  readEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";
import { removeEmbeddingUnitIndex } from "@/backend/local/embedding-lifecycle";
import {
  listEmbeddingSpaceDirs,
  resolveEmbeddingSpace,
} from "@/backend/local/embedding-space";
import { listEmbeddingSpaceUnitKeys } from "@/backend/local/embedding-space-units";
import type {
  EmbeddingResetTarget,
  EmbeddingRuntimeScope,
} from "@/cli/commands/embedding-runtime-contract";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";

/** Same segment rule A4's host, A3's runner and B2's writer apply. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Input for {@link resetEmbeddingSpaces}. */
export interface ResetEmbeddingSpacesInput {
  readonly scope: EmbeddingRuntimeScope;
  readonly target: EmbeddingResetTarget;
  /** Settings the "current" space is resolved from. */
  readonly settings: ResolvedEmbeddingSettings;
  /** Recall-vectors root; defaults to the call-time resolver at the caller. */
  readonly root: string;
}

/**
 * Delete the spaces the requested target names and return the user-facing
 * receipt. Never throws for a missing target; an IO failure is reported in the
 * receipt (the caller still catches unexpected errors).
 */
export function resetEmbeddingSpaces(input: ResetEmbeddingSpacesInput): string {
  const { scope, target, settings, root } = input;
  // Only existing, validated dirs count: a reset before the first build must
  // say "nothing was deleted".
  const candidates = resolveResetTargets(input).filter(
    (spaceDir) =>
      isSpaceDirInsideRoot(spaceDir, root, scope.agentId) &&
      existsSync(spaceDir),
  );
  let removed = 0;
  let failed = 0;
  for (const spaceDir of candidates) {
    if (deleteSpaceDir(spaceDir)) removed += 1;
    else failed += 1;
  }
  return resetReceipt(scope, target, removed, failed, root, settings);
}

/** A space directory this module may remove: exactly `<root>/<agent>/<space>`. */
export function isSpaceDirInsideRoot(
  spaceDir: string,
  root: string,
  agentId: string,
): boolean {
  const spaceId = spaceDir.slice(spaceDir.lastIndexOf(sep) + 1);
  if (!SAFE_SEGMENT.test(agentId) || !SAFE_SEGMENT.test(spaceId)) return false;
  if (spaceId === EMBEDDING_MEMORY_DIR_NAME) return false;
  const expected = join(resolve(root), agentId, spaceId);
  return resolve(spaceDir) === expected;
}

/** The `modelId` recorded by the newest readable unit of one space. */
function readSpaceModelId(spaceDir: string): string | null {
  for (const unit of listEmbeddingSpaceUnitKeys(spaceDir)) {
    const unitDir =
      unit.kind === "memory"
        ? join(
            spaceDir,
            EMBEDDING_MEMORY_DIR_NAME,
            unit.unitKey.slice(EMBEDDING_MEMORY_DIR_NAME.length + 1),
          )
        : join(spaceDir, unit.unitKey);
    const pointer = readEmbeddingIndexPointer(unitDir);
    if (!pointer.ok) continue;
    try {
      const metaPath = join(
        embeddingGenerationDir(unitDir, pointer.pointer.generation),
        EMBEDDING_INDEX_FILE_NAMES.meta,
      );
      const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as {
        modelId?: unknown;
      };
      if (typeof parsed.modelId === "string" && parsed.modelId.length > 0) {
        return parsed.modelId;
      }
    } catch {
      // A unit whose meta cannot be read does not identify the space; keep looking.
    }
  }
  return null;
}

function resolveResetTargets(input: ResetEmbeddingSpacesInput): string[] {
  const { scope, target, settings, root } = input;
  const current = resolveEmbeddingSpace(scope.agentId, settings, { root });
  if (target.kind === "current") return [current.spaceDir];
  const spaces = listEmbeddingSpaceDirs(scope.agentId, { root });
  if (target.kind === "all") return spaces.map((space) => space.spaceDir);
  const wanted = target.model.trim();
  return spaces
    .filter((space) => readSpaceModelId(space.spaceDir) === wanted)
    .map((space) => space.spaceDir);
}

/**
 * Invalidate a space's units (pointer first, then generations) and remove the
 * now-empty directory. Only paths validated by {@link isSpaceDirInsideRoot} are
 * ever touched.
 */
function deleteSpaceDir(spaceDir: string): boolean {
  for (const unit of listEmbeddingSpaceUnitKeys(spaceDir)) {
    removeEmbeddingUnitIndex(spaceDir, unit.unitKey);
  }
  try {
    rmSync(spaceDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function resetReceipt(
  scope: EmbeddingRuntimeScope,
  target: EmbeddingResetTarget,
  removed: number,
  failed: number,
  root: string,
  settings: ResolvedEmbeddingSettings,
): string {
  const what = describeTarget(target, settings);
  if (removed === 0) {
    return `No matching vector space found for ${what} under ${join(root, scope.agentId)}; nothing was deleted.`;
  }
  const lines = [
    `Deleted ${removed} vector space${removed === 1 ? "" : "s"} (${what}).`,
    "Transcripts, memory files and settings are untouched.",
    "Run /recall embedding build to rebuild the index when you want it back.",
  ];
  if (failed > 0) {
    lines.push(
      `${failed} space directory could not be fully removed; run the reset again to finish the cleanup.`,
    );
  }
  return lines.join("\n");
}

function describeTarget(
  target: EmbeddingResetTarget,
  settings: ResolvedEmbeddingSettings,
): string {
  if (target.kind === "all") return "every stored vector space for this agent";
  if (target.kind === "model") {
    return `the stored vector space for model "${target.model}"`;
  }
  return `the stored vector space for the current model (${settings.model})`;
}
