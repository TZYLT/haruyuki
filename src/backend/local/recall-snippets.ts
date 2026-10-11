import {
  type LocalTranscriptManifest,
  readJsonFileOrUndefined,
  readJsonlFileTolerant,
  transcriptManifestPath,
  transcriptMessagesPath,
} from "./local-transcript";
import { type RecallMessageText, recallMessageTexts } from "./recall-index";
import { transcriptFormat } from "./transcript-search";

/**
 * Transcript snippets for recall hits.
 *
 * The recall index stores only a tokenized projection (`nt`), never the text — the
 * requirement fixed the record shape so the sidecar stays ~8% of the transcript.
 * A snippet therefore has to come back out of `messages.jsonl`, and that is the
 * expensive half of an injection: a conversation file is 0.04–2.4 MB.
 *
 * So the split here follows the cost: `readRecallMessageTexts` pays one read and
 * one corpus-boundary pass per conversation, and `transcriptRecallSnippet` is pure,
 * so a turn with several hits in the same conversation reads it exactly once.
 */

export type RecallTranscriptSnippet = {
  /** The matched message. */
  messageId: string;
  timestamp: string;
  /** The hit plus its neighbours, roles labelled, in transcript order. */
  text: string;
  /** Every message id the snippet contains, for rendering and diagnostics. */
  messageIds: string[];
};

/**
 * Every recallable message of a conversation, in transcript order.
 *
 * Reads through the workspace rather than the index: the index is a derived cache
 * and may be stale for the current conversation (which is never refreshed lazily),
 * while a snippet must show what is on disk now. The reads are the tolerant pair:
 * a snippet is a read on the turn path, and a transcript with one interrupted line
 * must still yield every message before it rather than none of them.
 */
export function readRecallMessageTexts(
  conversationDir: string,
): RecallMessageText[] {
  const rows = readJsonlFileTolerant<unknown>(
    transcriptMessagesPath(conversationDir),
  );
  if (rows.length === 0) return [];
  const manifest = readJsonFileOrUndefined<LocalTranscriptManifest>(
    transcriptManifestPath(conversationDir),
  );
  return recallMessageTexts(rows, transcriptFormat(manifest, rows));
}

/**
 * The hit message and `neighbors` messages on each side.
 *
 * A hit whose id is not in `messages` returns `undefined` rather than a fallback:
 * that means the index and the transcript disagree, and inventing a snippet from
 * the wrong message would be worse than dropping the hit.
 */
export function transcriptRecallSnippet(input: {
  messages: readonly RecallMessageText[];
  messageId: string;
  neighbors: number;
}): RecallTranscriptSnippet | undefined {
  const index = input.messages.findIndex(
    (message) => message.id === input.messageId,
  );
  if (index === -1) return undefined;
  const neighbors = Math.max(0, Math.trunc(input.neighbors));
  const window = input.messages.slice(
    Math.max(0, index - neighbors),
    Math.min(input.messages.length, index + neighbors + 1),
  );
  return {
    messageId: input.messageId,
    timestamp: input.messages[index]?.ts ?? "",
    text: window
      .map((message) => `${message.role}: ${message.text}`)
      .join("\n\n"),
    messageIds: window.map((message) => message.id),
  };
}
