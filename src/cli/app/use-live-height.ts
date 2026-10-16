/**
 * Live-area height estimate for the append-style shell.
 *
 * The append shell and the full-screen viewport measure with the same row model,
 * so the estimate has to carry the same *display state* the renderer uses. That
 * state lives in a module store because the keystroke handler that changes it
 * (ctrl+t expands reasoning, ctrl+r reminders, the recall tier) sits outside
 * React. `ViewportTranscript` subscribes to it because its window comes from
 * measured heights; the hook below exists so the append shell's overflow
 * heuristic takes the same four values instead of measuring every expanded body
 * as the collapsed header it used to be.
 */
import { useMemo, useSyncExternalStore } from "react";
import {
  getRecallDisplay,
  getSystemRemindersExpanded,
  getSystemRemindersVisible,
  getThinkingExpanded,
  subscribeToSystemReminderDisplay,
  subscribeToThinkingDisplay,
} from "@/cli/components/transcript-display-state";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { RecallDisplay } from "@/reminders/recall-display";
import { measureTranscriptItemRows } from "./row-model";
import type { StaticItem } from "./types";

/** Description + URL + status + margin, per running subagent. */
const LINES_PER_SUBAGENT = 4;

/**
 * Fixed buffer for header, input area, status bar, margins. Deliberately larger
 * than the chrome it stands for: it absorbs render-timing lag, so a frame that
 * sees a tall item before the chrome settles still counts as overflowing.
 */
const FIXED_BUFFER = 20;

export interface LiveHeightOptions {
  items: readonly StaticItem[];
  columns: number;
  terminalRows: number;
  diffs: ReadonlyMap<string, AdvancedDiffSuccess>;
  expandedToolCallId: string | null;
  lastShellToolCallId: string | null;
  /** ctrl+t: whether collapsed reasoning rows render their body. */
  reasoningExpanded: boolean;
  /** ctrl+r: whether system-reminder blocks render at all. */
  systemRemindersVisible: boolean;
  /** ctrl+r: whether reminder and recall blocks render their full body. */
  systemRemindersExpanded: boolean;
  /** Recall tier the transcript renders recall blocks with. */
  recallDisplay: RecallDisplay;
  subagentCount: number;
}

/** What a caller knows; the display state is read from the transcript store. */
export type LiveHeightInput = Omit<
  LiveHeightOptions,
  | "reasoningExpanded"
  | "systemRemindersVisible"
  | "systemRemindersExpanded"
  | "recallDisplay"
>;

export function estimateLiveHeight(options: LiveHeightOptions): number {
  let liveItemsHeight = 0;

  options.items.forEach((item, index) => {
    // Committed items precede the live area, so the first live item carries the
    // separator blank line like every item after it.
    liveItemsHeight += measureTranscriptItemRows(item, {
      columns: options.columns,
      index: index + 1,
      terminalRows: options.terminalRows,
      diffs: options.diffs,
      expandedToolCallId: options.expandedToolCallId,
      lastShellToolCallId: options.lastShellToolCallId,
      reasoningExpanded: options.reasoningExpanded,
      systemRemindersVisible: options.systemRemindersVisible,
      systemRemindersExpanded: options.systemRemindersExpanded,
      recallDisplay: options.recallDisplay,
    });
  });

  return (
    liveItemsHeight + options.subagentCount * LINES_PER_SUBAGENT + FIXED_BUFFER
  );
}

/**
 * `estimateLiveHeight` plus the transcript display state it depends on, so a
 * Ctrl+T / Ctrl+R toggle re-measures even though the keystroke is handled
 * outside React.
 */
export function useEstimatedLiveHeight(input: LiveHeightInput): number {
  const reasoningExpanded = useSyncExternalStore(
    subscribeToThinkingDisplay,
    getThinkingExpanded,
  );
  const systemRemindersVisible = useSyncExternalStore(
    subscribeToSystemReminderDisplay,
    getSystemRemindersVisible,
  );
  const systemRemindersExpanded = useSyncExternalStore(
    subscribeToSystemReminderDisplay,
    getSystemRemindersExpanded,
  );
  const recallDisplay = useSyncExternalStore(
    subscribeToSystemReminderDisplay,
    getRecallDisplay,
  );

  const {
    items,
    columns,
    terminalRows,
    diffs,
    expandedToolCallId,
    lastShellToolCallId,
    subagentCount,
  } = input;

  return useMemo(
    () =>
      estimateLiveHeight({
        items,
        columns,
        terminalRows,
        diffs,
        expandedToolCallId,
        lastShellToolCallId,
        reasoningExpanded,
        systemRemindersVisible,
        systemRemindersExpanded,
        recallDisplay,
        subagentCount,
      }),
    [
      items,
      columns,
      terminalRows,
      diffs,
      expandedToolCallId,
      lastShellToolCallId,
      subagentCount,
      reasoningExpanded,
      systemRemindersVisible,
      systemRemindersExpanded,
      recallDisplay,
    ],
  );
}
