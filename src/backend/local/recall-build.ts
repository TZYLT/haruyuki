import { basename, join } from "node:path";
import { readJsonFile } from "./local-transcript";
import { readSourceSignature, rebuildConversationIndex } from "./recall-index";
import {
  conversationDirectories,
  conversationSearchRecord,
} from "./transcript-search";

/**
 * `build`: write the conversation recall sidecars.
 *
 * The lazy path (`ensureConversationIndex`) only ever covers *drift* — a sidecar
 * whose signature no longer matches its transcript. A conversation that has never
 * been indexed is out of scope for it by design, which is what makes the first
 * turn after an upgrade cheap and what leaves a fresh install with no index at all
 * (《26》§6.10). This is the other half: the explicit, whole-store pass behind
 * `/recall build` and `haruyuki recall build`.
 *
 * Every conversation is re-ingested, including ones whose sidecar is current.
 * "Refresh everything" is the honest meaning of a command a user runs when they
 * suspect the index, and a selective pass would leave in place the very sidecars
 * they distrust.
 */

export interface RecallBuildFailure {
  conversationKey: string;
  reason: string;
}

export interface RecallBuildResult {
  /** Conversations with a transcript, i.e. the ones worth indexing. */
  conversations: number;
  /** Sidecars written (or rewritten). */
  indexed: number;
  /** Index records written across those sidecars. */
  records: number;
  /** Conversations skipped because they have no transcript to index. */
  skipped: number;
  failures: RecallBuildFailure[];
  elapsedMs: number;
}

export interface RecallBuildProgress {
  done: number;
  total: number;
  conversationKey: string;
}

export interface RecallBuildOptions {
  /**
   * Called after each conversation. The TUI prints a counter; a caller that does
   * not care simply omits it.
   */
  onProgress?: (progress: RecallBuildProgress) => void;
  /**
   * Conversations to index between event-loop yields.
   *
   * Re-ingesting the whole store is one long synchronous loop — a second or two
   * for a few dozen conversations, and it grows with the transcripts. Yielding
   * lets an interactive caller repaint instead of freezing; `0` disables it for
   * callers with nothing to repaint (tests, and a CLI that is about to exit).
   */
  yieldEvery?: number;
  /** Clock seam for the elapsed-time receipt. */
  now?: () => number;
}

/** Let the event loop turn so an interactive caller can repaint. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function buildRecallCorpus(
  storageDir: string,
  options: RecallBuildOptions = {},
): Promise<RecallBuildResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const yieldEvery = Math.max(0, Math.trunc(options.yieldEvery ?? 0));
  const directories = conversationDirectories(storageDir);

  const result: RecallBuildResult = {
    conversations: 0,
    indexed: 0,
    records: 0,
    skipped: 0,
    failures: [],
    elapsedMs: 0,
  };

  let done = 0;
  for (const conversationDir of directories) {
    const conversationKey = basename(conversationDir);
    // The record reader is shared with the corpus loader, so the two cannot
    // disagree about what counts as a conversation.
    const conversation = conversationSearchRecord(
      readJsonFile(join(conversationDir, "conversation.json")),
    );
    if (!conversation || !readSourceSignature(conversationDir)) {
      // No transcript means there is nothing to recall from it; that is not a
      // failure and must not be counted as one.
      result.skipped += 1;
      continue;
    }
    result.conversations += 1;

    const rebuilt = rebuildConversationIndex({
      conversationDir,
      identity: {
        conversationKey,
        conversationId: conversation.id,
        agentId: conversation.agent_id,
      },
    });
    if ("error" in rebuilt) {
      result.failures.push({ conversationKey, reason: rebuilt.error });
    } else {
      result.indexed += 1;
      result.records += rebuilt.sidecar.records.length;
    }

    done += 1;
    options.onProgress?.({ done, total: directories.length, conversationKey });
    if (yieldEvery > 0 && done % yieldEvery === 0) {
      await yieldToEventLoop();
    }
  }

  result.elapsedMs = Math.max(0, now() - startedAt);
  return result;
}
