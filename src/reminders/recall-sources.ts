import { join } from "node:path";
import { searchMemoryFiles } from "@/backend/local/memory-search";
import type { RecallMessageText } from "@/backend/local/recall-index";
import { loadRecallCorpus } from "@/backend/local/recall-index";
import {
  readRecallMessageTexts,
  transcriptRecallSnippet,
} from "@/backend/local/recall-snippets";
import { rankMatches } from "@/backend/local/transcript-search";
import type {
  RecallCandidate,
  RecallSourceId,
  RecallSourceOutcome,
  RecallSourcePort,
} from "./recall-port";

/**
 * The two v1 recall sources, wired to the local backend.
 *
 * Each source owns its own scope rules, because the two corpora do not share them.
 * A transcript hit can be excluded by `N` (it is still in the context); a memory
 * hit cannot, since nothing in the memory workspace is "in context" as a message.
 * The index corpus already carries the agent and hidden-conversation filters, so
 * neither is repeated here.
 */

export type RecallSourceInput = {
  storageDir: string;
  /** `undefined` when the active agent has no memory workspace. */
  memoryDir?: string | undefined;
  /** `N`: message ids still in the context, so not recallable. */
  excludedMessageIds: ReadonlySet<string>;
  candidateLimit: number;
  neighbors: number;
  excerptLines: number;
};

function outcome(
  source: RecallSourceId,
  candidates: RecallCandidate[],
  reason?: string,
): RecallSourceOutcome {
  return {
    candidates,
    diagnostic: {
      source,
      status: candidates.length > 0 ? "searched" : "empty",
      candidates: candidates.length,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function failed(source: RecallSourceId, error: unknown): RecallSourceOutcome {
  return {
    candidates: [],
    diagnostic: {
      source,
      status: "failed",
      candidates: 0,
      reason: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Conversation transcripts.
 *
 * Order matters: `rankMatches` scores against the whole index corpus (document
 * frequencies may never come from a candidate subset), and only then is the result
 * cut to the candidate pool. Reading a transcript is by far the expensive step, so
 * hits are grouped by conversation and each file is read at most once per search.
 */
function transcriptSource(input: RecallSourceInput): RecallSourcePort {
  return {
    id: "transcript",
    search(request): RecallSourceOutcome {
      try {
        const corpus = loadRecallCorpus(input.storageDir, {
          agentId: request.scope.agentId,
          currentConversationId: request.scope.currentConversationId,
        });
        const searchable = corpus.records.filter(
          (record) =>
            !(
              record.conversationId === request.scope.currentConversationId &&
              input.excludedMessageIds.has(record.messageId)
            ),
        );
        const ranked = rankMatches(searchable, {
          terms: [...request.terms.terms],
          phrases: [...request.terms.phrases],
        })
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.conversationKey.localeCompare(right.conversationKey) ||
              left.messageId.localeCompare(right.messageId),
          )
          .slice(0, Math.max(0, input.candidateLimit));

        const textsByConversation = new Map<string, RecallMessageText[]>();
        const candidates: RecallCandidate[] = [];
        for (const record of ranked) {
          let texts = textsByConversation.get(record.conversationKey);
          if (!texts) {
            texts = readRecallMessageTexts(
              join(input.storageDir, "conversations", record.conversationKey),
            );
            textsByConversation.set(record.conversationKey, texts);
          }
          const snippet = transcriptRecallSnippet({
            messages: texts,
            messageId: record.messageId,
            neighbors: input.neighbors,
          });
          // No snippet means the index and the transcript disagree about this
          // message. Dropping the hit is the safe answer; a wrong snippet is not.
          if (!snippet) continue;
          candidates.push({
            source: "transcript",
            fingerprint: `transcript:${record.conversationKey}:${record.messageId}`,
            file: record.conversationKey,
            conversationKey: record.conversationKey,
            messageId: record.messageId,
            timestamp: snippet.timestamp,
            text: snippet.text,
            score: record.score,
          });
        }

        const unavailable = corpus.unavailable.length;
        return outcome(
          "transcript",
          candidates,
          unavailable > 0
            ? `${unavailable} conversation(s) had no usable index`
            : undefined,
        );
      } catch (error) {
        return failed("transcript", error);
      }
    },
  };
}

/** The MemFS workspace. Scanned on demand; there is no memory index by design. */
function memorySource(input: RecallSourceInput): RecallSourcePort {
  return {
    id: "memory",
    search(request): RecallSourceOutcome {
      if (!input.memoryDir) {
        return {
          candidates: [],
          diagnostic: {
            source: "memory",
            status: "unavailable",
            candidates: 0,
            reason: "the active agent has no memory workspace",
          },
        };
      }
      try {
        const result = searchMemoryFiles(
          input.memoryDir,
          {
            terms: [...request.terms.terms],
            phrases: [...request.terms.phrases],
          },
          { excerptLines: input.excerptLines, limit: input.candidateLimit },
        );
        const candidates: RecallCandidate[] = result.entries.map((entry) => ({
          source: "memory" as const,
          // Several paragraphs of one file can match, but the window suppresses the
          // document: re-sending another paragraph of a file the model has already
          // seen most of is what the window exists to prevent.
          fingerprint: `memory:${entry.path}`,
          file: entry.path,
          startLine: entry.startLine,
          endLine: entry.endLine,
          text: entry.text,
          score: entry.score,
        }));
        return outcome(
          "memory",
          candidates,
          result.stats.skippedFiles > 0
            ? `${result.stats.skippedFiles} file(s) were not readable text`
            : undefined,
        );
      } catch (error) {
        return failed("memory", error);
      }
    },
  };
}

export function buildRecallSources(
  input: RecallSourceInput,
): RecallSourcePort[] {
  return [transcriptSource(input), memorySource(input)];
}
