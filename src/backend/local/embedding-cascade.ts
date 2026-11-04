/**
 * Deletion cascade for the vector-recall index (48-1 R-16 / G-09).
 *
 * The index is a rebuildable derivative of transcripts and memory, so deleting
 * a conversation or an agent must delete its vectors too. Without this the
 * unit directories outlive every transcript they describe and the space grows
 * monotonically — nothing reads them, but nothing collects them either.
 *
 * Both entry points are best-effort: a failure is reported, never thrown, and
 * never takes the caller's primary deletion with it. Doing less when the index
 * is already unreadable is safe because readers treat a missing unit as
 * missing and rebuild covers any leftover.
 *
 * Layer: `backend/local/`. Imports same-directory embedding modules and node
 * builtins only.
 */

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRecallVectorsRoot } from "./embedding-format";
import { removeEmbeddingUnitIndex } from "./embedding-lifecycle";
import { listEmbeddingSpaceDirs } from "./embedding-space";

/** Same segment rule the unit/generation names and the space layout use. */
const SAFE_AGENT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EmbeddingCascadeOptions {
  /** Recall-vectors root; defaults to `getRecallVectorsRoot()` (`HARUYUKI_HOME` aware). */
  readonly root?: string;
}

export interface EmbeddingCascadeResult {
  /** Unit directories whose pointer was invalidated (0 when nothing existed). */
  readonly removedUnits: number;
  /** True when an agent root directory was removed. */
  readonly removedAgentRoot: boolean;
  /** Non-fatal problems, already redacted to paths/a reasons. */
  readonly warnings: string[];
}

/**
 * Remove one conversation's transcript unit from every model space it has.
 *
 * `unitKey` is the encoded conversation key the builder used
 * (`EmbeddingVectorUnit.conversationKey`), not the conversation id, so callers
 * take it from the store that owns the transcript directory.
 */
export function removeEmbeddingConversationVectorUnits(
  agentId: string,
  unitKey: string,
  options: EmbeddingCascadeOptions = {},
): EmbeddingCascadeResult {
  const warnings: string[] = [];
  if (!SAFE_AGENT_SEGMENT.test(agentId)) {
    return {
      removedUnits: 0,
      removedAgentRoot: false,
      warnings: [`refusing unsafe agent id ${JSON.stringify(agentId)}`],
    };
  }
  const root = options.root ?? getRecallVectorsRoot();
  let removedUnits = 0;
  for (const space of listEmbeddingSpaceDirs(agentId, { root })) {
    const result = removeEmbeddingUnitIndex(space.spaceDir, unitKey);
    if (result.ok) {
      removedUnits += 1;
      warnings.push(...result.warnings);
    } else if (result.problem !== "io-error") {
      warnings.push(`${space.spaceId}: ${result.problem} (${result.detail})`);
    } else {
      warnings.push(`${space.spaceId}: ${result.detail ?? "io-error"}`);
    }
  }
  return { removedUnits, removedAgentRoot: false, warnings };
}

/**
 * Remove every vector space belonging to an agent (`<root>/<agentId>`).
 *
 * Used by agent deletion only. The directory is a direct child of the recall
 * root by construction, and the segment is validated before any removal.
 */
export function removeEmbeddingAgentVectorRoot(
  agentId: string,
  options: EmbeddingCascadeOptions = {},
): EmbeddingCascadeResult {
  const warnings: string[] = [];
  if (!SAFE_AGENT_SEGMENT.test(agentId)) {
    return {
      removedUnits: 0,
      removedAgentRoot: false,
      warnings: [`refusing unsafe agent id ${JSON.stringify(agentId)}`],
    };
  }
  const root = options.root ?? getRecallVectorsRoot();
  const target = join(root, agentId);
  if (dirname(target) !== root) {
    return {
      removedUnits: 0,
      removedAgentRoot: false,
      warnings: [`refusing to remove ${JSON.stringify(target)}`],
    };
  }
  try {
    rmSync(target, { recursive: true, force: true });
    return { removedUnits: 0, removedAgentRoot: true, warnings };
  } catch (error) {
    return {
      removedUnits: 0,
      removedAgentRoot: false,
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }
}
