/**
 * Build-unit scanner for the vector index (feature 48, rework A1).
 *
 * The background builder consumes one unit at a time; this module answers the
 * question *which* units exist and what chunk plans each one has, using the same
 * corpus definitions the rest of recall uses:
 *
 * - **Transcript units** are conversations whose `conversation.json` names the
 *   requested agent and which are not hidden (unless explicitly included). One
 *   conversation = one unit whose plans are built per recallable message, so the
 *   parent unit stays the message exactly as in the lexical arm.
 * - **Memory units** are the paragraph records `memory-search` already defines,
 *   built by `buildMemoryVectorPlan`. Each memory file is one unit and every
 *   chunk carries its file-absolute `parentLineSpan`, which is what injection
 *   later uses to place a hit back onto the document's lines.
 *
 * No transcript is skipped rather than indexed empty: an empty unit would write
 * a generation with no records and make "has generations" a poor readiness test.
 * The scan is read-only, cancellable between units (`shouldStop`) and returns
 * plans in a stable order (conversation directory order, then memory file order).
 *
 * Layer: `backend/local/embedding*`. Imports sibling backend modules only; no
 * `cli/`, `websocket/`, `reminders/` or `agent/` imports.
 */

import { basename, join } from "node:path";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunk,
  type EmbeddingChunkOptions,
} from "@/backend/local/embedding-chunk";
import type {
  EmbeddingParentLineSpan,
  EmbeddingVectorUnit,
} from "@/backend/local/embedding-format";
import { buildMemoryVectorPlan } from "@/backend/local/embedding-memory";
import type { EmbeddingRunUnit } from "@/backend/local/embedding-runner";
import { readJsonFileOrUndefined } from "@/backend/local/local-transcript";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import {
  lineSpanWithinParent,
  readRecallMessageTexts,
} from "@/backend/local/recall-snippets";
import {
  conversationDirectories,
  conversationSearchRecord,
} from "@/backend/local/transcript-search";

/** Input for {@link scanEmbeddingBuildUnits}. */
export interface ScanEmbeddingBuildUnitsInput {
  readonly agentId: string;
  /** Space the scanned units will be written into. */
  readonly spaceId: string;
  /** Local-backend storage root (the directory holding `conversations/`). */
  readonly storageDir: string;
  /** Memory workspace root; defaults to the agent's local MemFS root. */
  readonly memoryDir?: string;
  /** B1 chunk options; defaults to the requirement's 200/256/32 window. */
  readonly chunkOptions?: EmbeddingChunkOptions;
  /** Cooperative cancellation, checked between units. */
  readonly shouldStop?: () => boolean;
  /** Include `hidden: true` conversations; default `false`. */
  readonly includeHidden?: boolean;
}

/** Aggregate counts for progress/log lines. */
export interface EmbeddingUnitSummary {
  readonly conversations: number;
  readonly memoryFiles: number;
  readonly chunks: number;
}

/**
 * The memory workspace an agent's local backend uses. Mirrors
 * `getLocalBackendMemoryFilesystemRoot` with the storage root made explicit so
 * a caller scanning one backend never resolves another backend's directory.
 */
export function resolveEmbeddingAgentMemoryDir(
  storageDir: string,
  agentId: string,
): string {
  return getLocalBackendMemoryFilesystemRoot(agentId, storageDir);
}

/**
 * Scan every unit the builder for `agentId`/`spaceId` should process.
 *
 * `shouldStop` is checked before each conversation and each memory file; the
 * returned list is a valid prefix of a full scan (a cancelled scan is never
 * misreported as complete by this module — the caller decides what to do).
 */
export function scanEmbeddingBuildUnits(
  input: ScanEmbeddingBuildUnitsInput,
): EmbeddingRunUnit[] {
  const stopped = (): boolean => input.shouldStop?.() === true;
  const units: EmbeddingRunUnit[] = [];

  for (const conversationDir of conversationDirectories(input.storageDir)) {
    if (stopped()) return units;
    const conversation = conversationSearchRecord(
      readJsonFileOrUndefined(join(conversationDir, "conversation.json")),
    );
    if (conversation === undefined || conversation.agent_id !== input.agentId) {
      continue;
    }
    if (conversation.hidden === true && input.includeHidden !== true) continue;
    const messages = readRecallMessageTexts(conversationDir);
    if (messages.length === 0) continue;
    const plans = messages.map((message) =>
      buildEmbeddingChunkPlan(
        { parentId: message.id, text: message.text },
        input.chunkOptions,
      ),
    );
    units.push({
      unit: {
        agentId: input.agentId,
        spaceId: input.spaceId,
        conversationKey: basename(conversationDir),
      },
      plans,
    });
  }

  if (stopped()) return units;

  const memoryDir =
    input.memoryDir ??
    resolveEmbeddingAgentMemoryDir(input.storageDir, input.agentId);
  const memoryPlan = buildMemoryVectorPlan(memoryDir, {
    ...(input.chunkOptions === undefined
      ? {}
      : { chunkOptions: input.chunkOptions }),
    ...(input.shouldStop === undefined ? {} : { shouldStop: input.shouldStop }),
  });
  for (const file of memoryPlan.files) {
    if (stopped()) return units;
    const spans = new Map<string, EmbeddingParentLineSpan>();
    for (const parent of file.parents) {
      for (const chunk of parent.plan.chunks) {
        spans.set(
          `${parent.parentId}:${chunk.chunkIndex}`,
          lineSpanWithinParent({
            parentText: parent.text,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
            parentStartLine: parent.startLine,
          }),
        );
      }
    }
    units.push({
      unit: {
        agentId: input.agentId,
        spaceId: input.spaceId,
        memoryFileKey: file.signature.fileKey,
      },
      plans: file.parents.map((parent) => parent.plan),
      parentLineSpan: (chunk: EmbeddingChunk) =>
        spans.get(`${chunk.parentId}:${chunk.chunkIndex}`),
    });
  }
  return units;
}

/** Counts units and chunks for progress display and log lines. */
export function summarizeEmbeddingUnits(
  units: readonly EmbeddingRunUnit[],
): EmbeddingUnitSummary {
  let conversations = 0;
  let memoryFiles = 0;
  let chunks = 0;
  for (const unit of units) {
    if (isMemoryUnit(unit.unit)) {
      memoryFiles += 1;
    } else {
      conversations += 1;
    }
    for (const plan of unit.plans) chunks += plan.chunks.length;
  }
  return { conversations, memoryFiles, chunks };
}

function isMemoryUnit(unit: EmbeddingVectorUnit): boolean {
  return "memoryFileKey" in unit;
}
