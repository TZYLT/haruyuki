/**
 * Turn-end entry point for the incremental embedding catch-up (48-1 §6.8).
 *
 * The engine already schedules a catch-up at the *next* turn's start. The
 * transcript of a finished turn is on disk by the time the host emits its
 * `turn_end` event, so this is the earlier, cheaper moment: the build runs while
 * the user reads the answer instead of during their next keystroke.
 *
 * All three hosts call it (TUI conversation loop, headless, websocket listener),
 * so the policy stays in one place. It is fire-and-forget and swallows every
 * error: a failed catch-up must never affect turn completion.
 *
 * It also arms the cooldown-expiry self-check (`recall-embedding-autobuild.ts`):
 * when this turn is the last one for a while, the index is re-checked once the
 * cooldown expires instead of waiting for a user to send another message.
 *
 * Layer: `reminders/`. Imports `backend/` (lower layer) and the settings reader.
 */

import { getBackend } from "@/backend";
import { readEmbeddingSettings } from "@/recall-settings";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import {
  cancelScheduledEmbeddingSelfCheck,
  isEmbeddingAutobuildRequested,
  maybeScheduleEmbeddingCatchUp,
  scheduleEmbeddingIdleSelfCheck,
} from "./recall-embedding-autobuild";

/** Schedule one debounced catch-up for a finished turn. Never throws. */
export function scheduleEmbeddingCatchUpAfterTurn(
  agentId: string | null | undefined,
): void {
  if (agentId === null || agentId === undefined || agentId.length === 0) return;
  try {
    const settings = readEmbeddingSettings();
    const input = { backend: getBackend(), agentId, settings };
    if (!isEmbeddingAutobuildRequested(settings)) {
      // Turning embedding off also ends a pending self-check.
      cancelScheduledEmbeddingSelfCheck();
      return;
    }
    maybeScheduleEmbeddingCatchUp(input);
    // This turn may be the last one for a while: arm the cooldown-expiry
    // self-check so a build the cooldown/in-flight window refused, or one that
    // finished while more messages landed, is retried without a next turn.
    scheduleEmbeddingIdleSelfCheck(input);
  } catch (error) {
    debugWarn(
      "recall",
      `turn-end embedding catch-up not scheduled: ${getErrorMessage(error)}`,
    );
  }
}
