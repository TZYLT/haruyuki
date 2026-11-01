/**
 * Run-end decay ledger update (F-06 / 46-6-Fix-A W11, design §5.10.2).
 *
 * `dream-run.ts` owns the lifecycle and must stay unit-testable, so the whole
 * file/git side of the ledger update lives here and reaches the controller
 * through the `applyDecay` dependency seam:
 *
 * ```text
 * read this run's marks → baseline..HEAD changed files → applyRunToIndex
 *   → write the ledger → clear the marks
 * ```
 *
 * Two properties are load-bearing:
 *
 * - **Best-effort.** A ledger failure is logged and swallowed: it must never
 *   change the run's terminal state, which was decided before this is called.
 *   A run without a working ledger still did its work.
 * - **The run-start view is the input.** The seed's `decay` view carries the
 *   interval increment and the run-start ranking; recomputing it at the end
 *   would score the run's own edits as churn. The layout comes from the seed
 *   for the same reason.
 *
 * Layer: `agent/` — dream domain; imports `agent/` siblings and `utils/`.
 */

import {
  applyRunToIndex,
  collectTrackedBlobShas,
  readDecayIndex,
  writeDecayIndex,
} from "@/agent/dream/dream-decay";
import {
  listMemoryFiles,
  type MemoryChangeSet,
  type MemoryFileChange,
  recentChanges,
} from "@/agent/dream/dream-manifest";
import {
  clearReviewMarks,
  type DreamReviewMark,
} from "@/agent/dream/dream-review-marks";
import type { DreamSeed } from "@/agent/dream/dream-seed";
import { debugWarn } from "@/utils/debug";

export interface ApplyDreamRunDecayInput {
  agentId: string;
  memoryDir: string;
  runId: string;
  /** The commit the run started from; the change range is `baseline..HEAD`. */
  baselineSha: string;
  /** The run-start seed (layout + decay view); both blocks may be degraded. */
  seed: DreamSeed;
  /** Marks the `DreamReviewMark` tool wrote during this run. */
  marks: readonly DreamReviewMark[];
  /** Epoch ms of the run end. */
  now: number;
}

/** Merge per-commit file entries into one change per path (added + deleted). */
function mergeChangedFiles(changes: MemoryChangeSet): MemoryFileChange[] {
  const byPath = new Map<string, MemoryFileChange>();
  for (const commit of changes.commits) {
    for (const file of commit.files) {
      const existing = byPath.get(file.path);
      if (existing === undefined) {
        byPath.set(file.path, { ...file });
        continue;
      }
      existing.added += file.added;
      existing.deleted += file.deleted;
      existing.status = file.status;
    }
  }
  return [...byPath.values()];
}

/**
 * Apply a finished run to the decay ledger, then drop its marks.
 *
 * A seed whose layout or decay block was degraded cannot update the ledger
 * (there is no view to score against and no core set to weight); it logs why
 * and returns. Marks are cleared in every case — they are per-run state, and a
 * leftover file would only describe a run that already ended.
 */
export async function applyDreamRunDecay(
  input: ApplyDreamRunDecayInput,
): Promise<void> {
  const layout = input.seed.layout;
  const view = input.seed.decay;
  if (layout === null || view === null) {
    debugWarn(
      "dream-decay",
      `run ${input.runId}: skipping the ledger update because the run-start layout or decay block was unavailable`,
    );
    await clearReviewMarks(input.runId);
    return;
  }
  try {
    const index = await readDecayIndex(input.agentId);
    const manifest = await listMemoryFiles(input.memoryDir, {
      includeUnprojected: true,
    });
    const changes = await recentChanges(
      input.memoryDir,
      input.baselineSha.length > 0 ? input.baselineSha : null,
    );
    const blobShas = await collectTrackedBlobShas(input.memoryDir);
    const next = applyRunToIndex({
      index,
      runId: input.runId,
      layout,
      now: input.now,
      headSha: changes.headSha,
      view,
      manifest,
      blobShas,
      changedFiles: mergeChangedFiles(changes),
      marks: input.marks,
    });
    await writeDecayIndex(input.agentId, next);
  } catch (error) {
    debugWarn(
      "dream-decay",
      `run ${input.runId}: ledger update failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await clearReviewMarks(input.runId);
  }
}
