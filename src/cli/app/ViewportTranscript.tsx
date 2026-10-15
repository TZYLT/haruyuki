import { Box } from "ink";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { PendingApprovalStub } from "@/cli/components/PendingApprovalStub";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import { APP_KEY_CHORDS } from "@/cli/helpers/keymap";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import type { AppViewProps } from "./AppView";
import { useChromeHeight } from "./chrome-height";
import { shouldRenderLiveItem } from "./live-items";
import { measureTranscriptItemRows } from "./row-model";
import { TranscriptItemView } from "./TranscriptItem";
import type { StaticItem } from "./types";
import {
  getViewportScrollRequest,
  getViewportScrollVersion,
  jumpTranscriptToNewest,
  reportViewportPosition,
  scrollTranscriptPage,
  setViewportRows,
  subscribeToViewportScroll,
} from "./viewport-scroll";
import { fitScrolledItemsFromEnd } from "./viewport-window";

/** Fallback chrome reserve used until the shell reports its measured height. */
export const CHROME_RESERVE_ROWS = 4;

/** Hard cap on rendered items (bounded residency). */
export const MAX_VIEWPORT_ITEMS = 200;

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
  const measuredChromeRows = useChromeHeight();
  const height = Math.max(
    1,
    terminalRows - (measuredChromeRows ?? CHROME_RESERVE_ROWS),
  );

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

  // Read once per render: the map is mutated in place as diffs arrive, so its
  // identity is stable and a diff that lands after this render is picked up on the
  // next one (a one-frame drift, documented on the row model).
  const precomputedDiffs = precomputedDiffsRef.current;

  // Scroll position. The subscription keeps this component re-rendering on scroll
  // — and only this component, which is the point of the module store. Its return
  // value is not read: the request object below is what the window depends on, and
  // the store replaces that object whenever the position changes.
  useSyncExternalStore(
    subscribeToViewportScroll,
    getViewportScrollVersion,
    getViewportScrollVersion,
  );
  useEffect(() => {
    setViewportRows(height);
  }, [height]);

  // Scroll keys belong to the transcript, so they are registered here: the
  // append-style shell has no viewport and therefore no scroll keys.
  useKeyBindings("viewport", [
    {
      scope: "app",
      bindings: [
        {
          id: "transcript.scrollPageUp",
          chords: APP_KEY_CHORDS.scrollPageUp,
          run: () => {
            scrollTranscriptPage("up");
          },
        },
        {
          id: "transcript.scrollPageDown",
          chords: APP_KEY_CHORDS.scrollPageDown,
          run: () => {
            scrollTranscriptPage("down");
          },
        },
        {
          id: "transcript.scrollToNewest",
          chords: APP_KEY_CHORDS.scrollToNewest,
          run: () => {
            jumpTranscriptToNewest();
          },
        },
      ],
    },
  ]);

  // Heights mirror what is actually rendered, substitutions included: the current
  // approval is drawn by `ApprovalSwitch` and the parallel ones by
  // `PendingApprovalStub`, so measuring the tool call instead would size the
  // window from a node that is not on screen.
  //
  // Measured lazily from the end: this runs on every streaming frame, and a full
  // pass over a long transcript costs more than the frame budget (about 18us per
  // item, so ~22ms at 1000 items).
  const scrollRequest = getViewportScrollRequest();
  const scrollRows = scrollRequest.kind === "rows" ? scrollRequest.rows : 0;
  const scrollAnchor =
    scrollRequest.kind === "anchor" ? scrollRequest.anchor : undefined;
  const window = useMemo(() => {
    return fitScrolledItemsFromEnd(
      items.length,
      height,
      MAX_VIEWPORT_ITEMS,
      scrollRows,
      (index) => {
        const item = items[index];
        if (item === undefined) return 0;
        return measureTranscriptItemRows(item, {
          columns,
          index,
          terminalRows,
          diffs: precomputedDiffs,
          expandedToolCallId,
          lastShellToolCallId,
          substitutions: {
            currentApproval,
            currentApprovalContext,
            approvalMap,
            pendingIds,
            queuedIds,
            queuedDecisions,
            stubDescriptions,
            showPreview: showApprovalPreview,
          },
        });
      },
      scrollAnchor,
    );
  }, [
    items,
    columns,
    height,
    terminalRows,
    precomputedDiffs,
    expandedToolCallId,
    lastShellToolCallId,
    currentApproval,
    currentApprovalContext,
    approvalMap,
    pendingIds,
    queuedIds,
    queuedDecisions,
    stubDescriptions,
    showApprovalPreview,
    scrollRows,
    scrollAnchor,
  ]);

  // Tell the store what was actually shown, in content terms: the window's bottom
  // item and the rows of it below the viewport. From that point the position is
  // held by content, so rows arriving underneath do not move the view.
  useEffect(() => {
    reportViewportPosition({
      rows: window.scrollFromBottom,
      anchor: window.anchor,
    });
  }, [window]);

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
