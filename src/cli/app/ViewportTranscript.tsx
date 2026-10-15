import { Box } from "ink";
import { useMemo } from "react";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { PendingApprovalStub } from "@/cli/components/PendingApprovalStub";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import type { AppViewProps } from "./AppView";
import { shouldRenderLiveItem } from "./live-items";
import { measureTranscriptItemRows } from "./row-model";
import { TranscriptItemView } from "./TranscriptItem";
import type { StaticItem } from "./types";
import { fitWholeItems } from "./viewport-window";

/** Rows the shell keeps below the transcript for the input row and its margin. */
const CHROME_RESERVE_ROWS = 4;

/** Hard cap on rendered items (bounded residency). */
const MAX_VIEWPORT_ITEMS = 200;

/**
 * Full-screen transcript region (`ui_v2=on`).
 *
 * Renders only the items that fit the viewport, bottom-anchored, using the same
 * per-item renderer as the append shell so the two never disagree about layout.
 * Heights come from the row model, so the window is chosen without rendering
 * the rest of the transcript.
 */
export function ViewportTranscript(props: AppViewProps) {
  const {
    staticItems,
    liveItems,
    columns,
    statusLinePrompt,
    showCompactionsEnabled,
    precomputedDiffsRef,
    expandedToolCallId,
    lastShellToolCallId,
    loadingState,
    continueSession,
    agentState,
    currentApproval,
    currentApprovalContext,
    approvalMap,
    pendingIds,
    queuedIds,
    queuedDecisions,
    stubDescriptions,
    handleApproveCurrent,
    handleApproveAlways,
    handleDenyCurrent,
    handleCancelApprovals,
    showApprovalPreview,
  } = props;

  const terminalRows = useTerminalRows();
  const height = Math.max(1, terminalRows - CHROME_RESERVE_ROWS);

  const items = useMemo<StaticItem[]>(() => {
    const currentApprovalToolCallId = currentApproval?.toolCallId;
    const live = liveItems.filter((ln) =>
      shouldRenderLiveItem(ln, {
        currentApprovalToolCallId,
        pendingIds,
        queuedIds,
      }),
    );
    return [...staticItems, ...live];
  }, [
    staticItems,
    liveItems,
    currentApproval?.toolCallId,
    pendingIds,
    queuedIds,
  ]);

  const window = useMemo(() => {
    const heights = items.map((item, index) =>
      measureTranscriptItemRows(item, { columns, index }),
    );
    return fitWholeItems(heights, height, MAX_VIEWPORT_ITEMS);
  }, [items, columns, height]);

  if (loadingState !== "ready") {
    return (
      <WelcomeScreen
        loadingState={loadingState}
        continueSession={continueSession}
        agentState={agentState}
      />
    );
  }

  const visible = items.slice(window.start, window.end);

  return (
    <Box
      height={height}
      flexDirection="column"
      justifyContent="flex-end"
      overflow="hidden"
    >
      {visible.map((item, offset) => {
        const index = window.start + offset;
        const marginTop = index > 0 ? 1 : 0;
        const toolCallId =
          item.kind === "tool_call" ? item.toolCallId : undefined;
        const itemName = item.kind === "tool_call" ? item.name : undefined;
        const isCurrentApproval =
          toolCallId !== undefined &&
          toolCallId === currentApproval?.toolCallId;

        if (isCurrentApproval && currentApproval) {
          return (
            <Box key={item.id} flexDirection="column" marginTop={marginTop}>
              <ApprovalSwitch
                approval={currentApproval}
                onApprove={handleApproveCurrent}
                onApproveAlways={handleApproveAlways}
                onDeny={handleDenyCurrent}
                onCancel={handleCancelApprovals}
                precomputedDiff={
                  toolCallId
                    ? precomputedDiffsRef.current.get(toolCallId)
                    : undefined
                }
                allDiffs={precomputedDiffsRef.current}
                isFocused={true}
                approveAlwaysText={currentApprovalContext?.approveAlwaysText}
                allowPersistence={
                  currentApprovalContext?.allowPersistence ?? true
                }
                defaultScope={
                  currentApprovalContext?.defaultScope === "user"
                    ? "session"
                    : (currentApprovalContext?.defaultScope ?? "project")
                }
                showPreview={showApprovalPreview}
              />
            </Box>
          );
        }

        const isQueued = toolCallId !== undefined && queuedIds.has(toolCallId);
        const isPending =
          toolCallId !== undefined && pendingIds.has(toolCallId);
        if (isQueued || isPending) {
          return (
            <Box key={item.id} flexDirection="column" marginTop={marginTop}>
              <PendingApprovalStub
                toolName={
                  (toolCallId ? approvalMap.get(toolCallId)?.toolName : null) ||
                  itemName ||
                  "Unknown"
                }
                description={
                  toolCallId ? stubDescriptions.get(toolCallId) : undefined
                }
                decision={
                  isQueued && toolCallId
                    ? queuedDecisions.get(toolCallId)
                    : undefined
                }
              />
            </Box>
          );
        }

        return (
          <TranscriptItemView
            key={item.id}
            item={item}
            index={index}
            columns={columns}
            statusLinePrompt={statusLinePrompt}
            showCompactionsEnabled={showCompactionsEnabled}
            precomputedDiffs={precomputedDiffsRef.current}
            hiddenToolCallId={expandedToolCallId ?? undefined}
            lastShellToolCallId={lastShellToolCallId ?? undefined}
          />
        );
      })}
    </Box>
  );
}
