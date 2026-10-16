import { useEffect } from "react";
import type { SessionStatsSnapshot } from "@/agent/stats";
import { exitSummaryText, registerExitSummary } from "@/cli/app/exit-summary";

/** The slice of the shell projection the exit summary reads. */
export interface ExitSummarySource {
  showExitStats: boolean;
  sessionStatsRef: {
    readonly current: { getSnapshot(): SessionStatsSnapshot };
  };
  agentName: string | null;
  agentId: string;
  conversationId: string;
}

/**
 * Registers the exit summary for a shell whose frame Ink discards at teardown
 * (the alternate screen). The append shell keeps its frame, so it does not call
 * this and nothing is registered.
 *
 * The stats are read when the core asks for the summary — after teardown — so the
 * numbers are the session's last, not those of the frame that painted them.
 */
export function useExitSummaryAfterTeardown(source: ExitSummarySource): void {
  const { showExitStats, sessionStatsRef, agentName, agentId, conversationId } =
    source;

  useEffect(() => {
    if (!showExitStats) {
      return;
    }

    return registerExitSummary(() =>
      exitSummaryText({
        stats: sessionStatsRef.current.getSnapshot(),
        agentName,
        agentId,
        conversationId,
      }),
    );
  }, [showExitStats, sessionStatsRef, agentName, agentId, conversationId]);
}
