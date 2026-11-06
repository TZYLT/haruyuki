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
 * Layer: `reminders/`. Imports `backend/` (lower layer) and the settings reader.
 */

import { getBackend } from "@/backend";
import { readEmbeddingSettings } from "@/recall-settings";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import {
  isEmbeddingAutobuildRequested,
  maybeScheduleEmbeddingCatchUp,
} from "./recall-embedding-autobuild";

/** Schedule one debounced catch-up for a finished turn. Never throws. */
export function scheduleEmbeddingCatchUpAfterTurn(
  agentId: string | null | undefined,
): void {
  if (agentId === null || agentId === undefined || agentId.length === 0) return;
  try {
    const settings = readEmbeddingSettings();
    if (!isEmbeddingAutobuildRequested(settings)) return;
    maybeScheduleEmbeddingCatchUp({ backend: getBackend(), agentId, settings });
  } catch (error) {
    debugWarn(
      "recall",
      `turn-end embedding catch-up not scheduled: ${getErrorMessage(error)}`,
    );
  }
}
