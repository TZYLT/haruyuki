/**
 * Startup boundary recovery for the embedding build (48-2 §3.1 A5, S-02).
 *
 * A crash can leave A2's `.build.lock` / `.build.lease` (and the atomic-write
 * `.reap` marker) behind, which keeps every later build from starting until an
 * operator removes them. A5's {@link recoverEmbeddingBoundary} already decides,
 * from pid liveness and the OS start token, whether the previous owner is
 * provably gone; it never signals or kills a process and treats a pid it cannot
 * disprove as live. This module only finds the spaces worth asking about: a TUI
 * start must not walk the unit directories of every space on disk, so a space is
 * considered only when it still carries one of those ownership files.
 *
 * The pass is best-effort and non-fatal: one unreadable space (or one recovery
 * failure) is debug-logged and the rest continue. It is called with
 * `void ... .catch(...)` from the TUI startup assembly, never awaited.
 *
 * Layer: `cli/helpers/`. Imports A5's recovery and A1/B2's path resolvers.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getRecallVectorsRoot } from "@/backend/local/embedding-format";
import { EMBEDDING_LEASE_FILE_NAME } from "@/backend/local/embedding-lease";
import { EMBEDDING_BUILD_LOCK_FILE_NAME } from "@/backend/local/embedding-lock";
import {
  type EmbeddingBoundaryRecoveryOptions,
  type EmbeddingRecoveryReport,
  recoverEmbeddingBoundary,
} from "@/cli/helpers/embedding-boundary-recovery";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";

/** Same path-component rule A1/A2/A4 apply; anything else is skipped. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A lock's reap marker is named next to it; A5 treats it as residue. */
const REAP_MARKER_NAME = `${EMBEDDING_BUILD_LOCK_FILE_NAME}.reap`;

/** Bounded number of spaces one startup pass may inspect. */
export const EMBEDDING_STARTUP_MAX_SPACES = 64;

/** Seams for {@link recoverEmbeddingBoundariesAtStartup}. */
export interface EmbeddingStartupRecoveryDeps {
  /** Recall-vectors root; defaults to A1/B2's call-time resolver. */
  root?: string;
  /** A5's recovery pass; defaults to `recoverEmbeddingBoundary`. */
  recover?: typeof recoverEmbeddingBoundary;
  /**
   * Extra A5 options (pid liveness, clock, residue age). Tests inject these;
   * production passes none, so A5's real probes decide.
   */
  recoveryOptions?: Partial<EmbeddingBoundaryRecoveryOptions>;
}

/** Subdirectories of `dir`, tolerating a missing/unreadable directory. */
function subdirectories(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) continue;
    paths.push(join(dir, entry.name));
  }
  return paths;
}

/** Whether a space still carries a previous owner's ownership file. */
function hasOwnershipResidue(spaceDir: string): boolean {
  return [
    EMBEDDING_BUILD_LOCK_FILE_NAME,
    EMBEDDING_LEASE_FILE_NAME,
    REAP_MARKER_NAME,
  ].some((name) => existsSync(join(spaceDir, name)));
}

/**
 * Recover embedding-build ownership left behind by a crash.
 *
 * Returns the reports that changed something. Only spaces with a stale
 * ownership file are inspected; A5 then leaves live owners untouched. Never
 * throws for a single bad space, and never deletes a transcript, memory file or
 * index directory — only A5's listed residue inside the space directory.
 */
export async function recoverEmbeddingBoundariesAtStartup(
  deps: EmbeddingStartupRecoveryDeps = {},
): Promise<EmbeddingRecoveryReport[]> {
  const root = deps.root ?? getRecallVectorsRoot();
  const recover = deps.recover ?? recoverEmbeddingBoundary;
  const recovered: EmbeddingRecoveryReport[] = [];
  let inspected = 0;

  for (const agentDir of subdirectories(root)) {
    const agentId = basename(agentDir);
    for (const spaceDir of subdirectories(agentDir)) {
      if (inspected >= EMBEDDING_STARTUP_MAX_SPACES) return recovered;
      if (!hasOwnershipResidue(spaceDir)) continue;
      inspected += 1;
      const spaceId = basename(spaceDir);
      try {
        const report = await recover({
          ...deps.recoveryOptions,
          spaceDir,
          agentId,
          spaceId,
        });
        if (report.removed.length > 0 || report.markedInterrupted) {
          recovered.push(report);
          debugWarn(
            "embedding",
            `recovered a stale embedding build in ${spaceDir}: ${report.removed.length} leftover item(s) removed${report.markedInterrupted ? ", state marked cancelled" : ""}.`,
          );
        }
      } catch (error) {
        debugWarn(
          "embedding",
          `startup boundary recovery skipped ${spaceDir}: ${getErrorMessage(error)}`,
        );
      }
    }
  }
  return recovered;
}
