/**
 * Cross-process cancellation for an embedding build (48-1 §6.8).
 *
 * `cancelEmbeddingBuild` can only signal a child this process spawned. A build
 * started earlier (a detached `--keep-after-exit` child, or another host) has no
 * handle here, so the request travels as a file inside the space directory the
 * runner already owns: the runner checks it between units and stops at its next
 * checkpoint.
 *
 * The file is best effort and never authoritative on its own: a stale request
 * left by a dead owner is cleared when the next run takes the lock, so it cannot
 * cancel a build that started afterwards.
 *
 * Layer: `backend/local/`. Node built-ins only.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Sentinel file name, next to `.build.lock` and `.build.lease`. */
export const EMBEDDING_BUILD_CANCEL_FILE_NAME = ".build.cancel";

export interface EmbeddingCrossProcessCancel {
  /** The build id the caller wanted to stop; omitted = whichever is live. */
  buildId?: string;
  requestedAt: number;
}

/** The sentinel path for one space directory. */
export function embeddingCancelFilePath(spaceDir: string): string {
  return join(spaceDir, EMBEDDING_BUILD_CANCEL_FILE_NAME);
}

/**
 * Ask the process that owns this space to stop.
 *
 * Written through a temp file + rename so a reader never sees half a JSON
 * object. Never throws: a cancellation request that cannot be written is
 * reported by the caller's receipt, not by an exception.
 */
export function requestEmbeddingCrossProcessCancel(
  spaceDir: string,
  request: Omit<EmbeddingCrossProcessCancel, "requestedAt"> = {},
): boolean {
  const path = embeddingCancelFilePath(spaceDir);
  const temp = `${path}.tmp`;
  try {
    writeFileSync(
      temp,
      JSON.stringify({
        ...request,
        requestedAt: Date.now(),
      } satisfies EmbeddingCrossProcessCancel),
      { encoding: "utf8" },
    );
    renameSync(temp, path);
    return true;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing else to do: the caller reports that the request failed.
    }
    return false;
  }
}

/** The pending request, or `null` when the file is absent or unreadable. */
export function readEmbeddingCrossProcessCancel(
  spaceDir: string,
): EmbeddingCrossProcessCancel | null {
  const path = embeddingCancelFilePath(spaceDir);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.buildId === "string"
        ? { buildId: record.buildId }
        : {}),
      requestedAt:
        typeof record.requestedAt === "number" ? record.requestedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Drop the sentinel (a new owner or a finished run). Never throws. */
export function clearEmbeddingCrossProcessCancel(spaceDir: string): void {
  try {
    rmSync(embeddingCancelFilePath(spaceDir), { force: true });
  } catch {
    // The next owner clears it again; a leftover cannot cancel a later run.
  }
}
