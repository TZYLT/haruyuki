import { join } from "node:path";
import { searchMemoryFiles } from "@/backend/local/memory-search";
import type { RecallMessageText } from "@/backend/local/recall-index";
import { loadRecallCorpus } from "@/backend/local/recall-index";
import {
  readRecallMessageTexts,
  transcriptRecallSnippet,
} from "@/backend/local/recall-snippets";
import {
  rankMatches,
  type SearchStopSignal,
} from "@/backend/local/transcript-search";
import type {
  RecallCandidate,
  RecallSourceId,
  RecallSourceOutcome,
  RecallSourcePort,
  RecallSourceStatus,
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
  /**
   * The active agent's memory workspace.
   *
   * Required, not optional: the only caller always has a path
   * (`getLocalBackendMemoryFilesystemRoot` joins one from the agent id), and a
   * source that is switched off is left out of the list entirely rather than being
   * built and told it has nowhere to look.
   */
  memoryDir: string;
  /** `N`: message ids still in the context, so not recallable. */
  excludedMessageIds: ReadonlySet<string>;
  candidateLimit: number;
  neighbors: number;
  excerptLines: number;
  /**
   * The turn's cooperative time budget. A source that is stopped part-way
   * reports `degraded` instead of `searched`/`empty`, because a truncated scan
   * and a complete one that happened to score nothing mean different things.
   */
  shouldStop?: SearchStopSignal;
};

function outcome(
  source: RecallSourceId,
  candidates: RecallCandidate[],
  reason?: string,
  status?: RecallSourceStatus,
): RecallSourceOutcome {
  return {
    candidates,
    diagnostic: {
      source,
      status: status ?? (candidates.length > 0 ? "searched" : "empty"),
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
          shouldStop: input.shouldStop,
        });
        const searchable = corpus.records.filter(
          (record) =>
            !(
              record.conversationId === request.scope.currentConversationId &&
              input.excludedMessageIds.has(record.messageId)
            ),
        );
        const ranked = rankMatches(
          searchable,
          {
            terms: [...request.terms.terms],
            phrases: [...request.terms.phrases],
          },
          { shouldStop: input.shouldStop },
        )
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
          if (input.shouldStop?.()) break;
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
        const reasons: string[] = [];
        if (unavailable > 0) {
          reasons.push(`${unavailable} conversation(s) had no usable index`);
        }
        const degraded = input.shouldStop?.() === true;
        if (degraded) reasons.push("the recall deadline expired");
        // "No index anywhere in scope" is the source being unable to run, not an
        // empty corpus: nothing was searched. It is the state a fresh install is
        // in, and the only signal `/recall build` is the fix for, so it must not
        // be flattened into "nothing matched".
        const indexless =
          !degraded &&
          candidates.length === 0 &&
          corpus.records.length === 0 &&
          unavailable > 0;
        return outcome(
          "transcript",
          candidates,
          reasons.length > 0 ? reasons.join("; ") : undefined,
          degraded ? "degraded" : indexless ? "unavailable" : undefined,
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
      try {
        const result = searchMemoryFiles(
          input.memoryDir,
          {
            terms: [...request.terms.terms],
            phrases: [...request.terms.phrases],
          },
          {
            excerptLines: input.excerptLines,
            limit: input.candidateLimit,
            shouldStop: input.shouldStop,
          },
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
        const degraded = input.shouldStop?.() === true;
        const reasons: string[] = [];
        if (result.stats.skippedFiles > 0) {
          reasons.push(
            `${result.stats.skippedFiles} file(s) were not readable text`,
          );
        }
        if (degraded) reasons.push("the recall deadline expired");
        return outcome(
          "memory",
          candidates,
          reasons.length > 0 ? reasons.join("; ") : undefined,
          degraded ? "degraded" : undefined,
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
