/**
 * One-time space-directory migration for the 48-4 identity change.
 *
 * 48-4 D-11 added `backend`, `maxChunks` and (for endpoints) the endpoint
 * fingerprint to the space-id payload. An existing built-in space therefore has
 * a directory named by the old formula. Re-embedding it would cost minutes for
 * data that is still correct, so this module renames the old directory to the
 * new id **only when** the current settings describe exactly that space.
 *
 * Endpoint spaces are deliberately not migrated: the old payload did not record
 * which URL produced the vectors, so a rename could hand one endpoint another
 * endpoint's index. They are left alone and simply rebuild.
 *
 * Layer: `backend/local/` (leaf). Imports sibling space/format modules only.
 */

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

import {
  EMBEDDING_INDEX_CHUNKER_VERSION,
  getRecallVectorsRoot,
} from "@/backend/local/embedding-format";
import {
  resolveEmbeddingSpace,
  resolveLegacyEmbeddingSpaceId,
} from "@/backend/local/embedding-space";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";

export type EmbeddingSpaceMigration = {
  readonly moved: boolean;
  readonly from?: string;
  readonly to?: string;
};

/**
 * Rename the pre-48-4 directory of the current built-in space, if it exists and
 * the new one does not. Idempotent; never throws (a failed rename leaves the
 * old space in place, which only costs a rebuild).
 */
export function migrateLegacyEmbeddingSpace(
  agentId: string,
  settings: ResolvedEmbeddingSettings,
  options: { readonly root?: string } = {},
): EmbeddingSpaceMigration {
  if (settings.backend !== "builtin") return { moved: false };
  try {
    const root = options.root ?? getRecallVectorsRoot();
    const space = resolveEmbeddingSpace(agentId, settings, { root });
    if (existsSync(space.spaceDir)) return { moved: false };
    const legacyId = resolveLegacyEmbeddingSpaceId({
      modelId: space.modelId,
      dimensions: space.dimensions,
      quantization: settings.quantization,
      chunkerVersion: EMBEDDING_INDEX_CHUNKER_VERSION,
      chunkTarget: settings.chunkTarget,
      chunkMax: settings.chunkMax,
      chunkOverlap: settings.chunkOverlap,
    });
    const legacyDir = join(root, agentId, legacyId);
    if (!existsSync(legacyDir)) return { moved: false };
    renameSync(legacyDir, space.spaceDir);
    return { moved: true, from: legacyId, to: space.spaceId };
  } catch {
    return { moved: false };
  }
}
