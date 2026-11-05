/**
 * Space-level retention (48-4 D-12).
 *
 * `keepSpaces` was stored and validated but never applied: every model switch
 * left its directory behind. This module applies the user's rule — keep the
 * active space plus up to `keep - 1` unpinned others, newest first, and never
 * touch a pinned space.
 *
 * It runs at build start, not after a successful build: the policy is about the
 * corpus, and waiting for a terminal phase would let a cancelled build leave the
 * directory count over the cap.
 *
 * Layer: `backend/local/` (leaf). Imports sibling space/profile modules only.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getRecallVectorsRoot } from "@/backend/local/embedding-format";
import {
  type EmbeddingProfile,
  embeddingProfilePath,
  parseEmbeddingProfile,
} from "@/backend/local/embedding-profile";

export type EmbeddingSpacePruneResult = {
  readonly removed: readonly string[];
  /** Spaces left behind because the user pinned them. */
  readonly pinned: readonly string[];
};

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function profileOf(spaceDir: string): EmbeddingProfile | null {
  try {
    return parseEmbeddingProfile(
      JSON.parse(readFileSync(embeddingProfilePath(spaceDir), "utf-8")),
    );
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Enforce the cap for one agent. `keep` counts the active space, so `keep=2`
 * leaves the active one plus one older unpinned space. Values below 1 are
 * treated as 1 (never delete the active space).
 */
export function pruneEmbeddingSpaces(
  agentId: string,
  activeSpaceId: string,
  keep: number,
  options: { readonly root?: string } = {},
): EmbeddingSpacePruneResult {
  const root = options.root ?? getRecallVectorsRoot();
  const agentDir = join(root, agentId);
  if (!SAFE_SEGMENT.test(agentId) || !existsSync(agentDir)) {
    return { removed: [], pinned: [] };
  }
  const cap = Math.max(1, Math.trunc(keep));
  const spaces: {
    spaceId: string;
    dir: string;
    mtime: number;
    pinned: boolean;
  }[] = [];
  try {
    for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) continue;
      const dir = join(agentDir, entry.name);
      const profile = profileOf(dir);
      spaces.push({
        spaceId: entry.name,
        dir,
        mtime: mtimeOf(dir),
        pinned: profile?.pinned === true,
      });
    }
  } catch {
    return { removed: [], pinned: [] };
  }

  const active = spaces.find((space) => space.spaceId === activeSpaceId);
  const others = spaces
    .filter((space) => space.spaceId !== activeSpaceId)
    .sort((left, right) => right.mtime - left.mtime);
  let budget = Math.max(0, cap - (active === undefined ? 0 : 1));
  const removed: string[] = [];
  const pinned: string[] = [];
  for (const space of others) {
    if (space.pinned) {
      pinned.push(space.spaceId);
      continue;
    }
    if (budget > 0) {
      budget -= 1;
      continue;
    }
    try {
      rmSync(space.dir, { recursive: true, force: true });
      removed.push(space.spaceId);
    } catch {
      // A directory that cannot be removed stays; the next build retries.
    }
  }
  return { removed, pinned };
}
