/**
 * Append the turn's transcript delta to the reflection transcript.
 *
 * Extracted from `use-conversation-loop.ts` (which is at its size cap): the
 * loop only decides *when* the turn ended, this module decides what the delta
 * is and how a failure is reported. The writer is injectable so the slicing and
 * the swallow-and-log behaviour can be tested without touching the disk.
 */

import { type Buffers, toLines } from "@/cli/helpers/accumulator";
import { appendTranscriptDeltaJsonl } from "@/cli/helpers/reflection-transcript";
import { debugWarn } from "@/utils/debug";

export interface TurnTranscriptDeltaInput {
  buffers: Buffers;
  agentId: string;
  conversationId: string;
  /** Line index the turn started at; `null` when nothing was captured. */
  startLineIndex: number | null;
  /** Injectable for tests. Defaults to the real JSONL writer. */
  write?: typeof appendTranscriptDeltaJsonl;
}

/** Best effort: a reflection-transcript failure never blocks the turn. */
export async function appendTurnTranscriptDelta(
  input: TurnTranscriptDeltaInput,
): Promise<void> {
  if (input.startLineIndex === null) return;
  const lines = toLines(input.buffers).slice(input.startLineIndex);
  const write = input.write ?? appendTranscriptDeltaJsonl;
  try {
    await write(input.agentId, input.conversationId, lines);
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to append transcript delta: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
