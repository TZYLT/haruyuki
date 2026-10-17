import { Box } from "ink";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { PendingApprovalStub } from "@/cli/components/PendingApprovalStub";
import {
  getRecallDisplay,
  getSystemRemindersExpanded,
  getSystemRemindersVisible,
  getThinkingExpanded,
  subscribeToSystemReminderDisplay,
  subscribeToThinkingDisplay,
} from "@/cli/components/transcript-display-state";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import { APP_KEY_CHORDS } from "@/cli/helpers/keymap";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import type { AppViewProps } from "./AppView";
import { fitBlockedItemsFromEnd } from "./blocked-window";
import { useChromeHeight, useMeasuredChromeHeight } from "./chrome-height";
import { FocusedApproval } from "./FocusedApproval";
import { historyBlockAt, historyBlockItems } from "./history-blocks";
import { buildVisibleItems, hasFocusedApprovalItem } from "./live-items";
import {
  composeTranscriptItems,
  evictOlderHistoryBlocksBefore,
  getOlderHistoryBlocks,
  getOlderHistoryItems,
  materializeOlderHistoryBlocks,
  olderHistoryCursor,
  olderHistoryPrefixItems,
  reportOlderHistoryBlockRows,
  requestOlderHistory,
  setOlderHistoryProvider,
  subscribeToOlderHistory,
  transcriptLines,
} from "./older-history";
import { measureTranscriptItemRows, type RowMeasureOptions } from "./row-model";
import { TranscriptItemView } from "./TranscriptItem";
import type { StaticItem } from "./types";
import { ViewportPanel } from "./ViewportPanel";
import {
  getViewportScrollRequest,
  getViewportScrollVersion,
  jumpTranscriptToNewest,
  jumpTranscriptToOldest,
  reportViewportPosition,
  scrollTranscriptPage,
  setViewportRows,
  subscribeToViewportScroll,
  subscribeToViewportTop,
} from "./viewport-scroll";

/** Fallback chrome reserve used until the shell reports its measured height. */
export const CHROME_RESERVE_ROWS = 4;

/** Hard cap on rendered items (bounded residency). */
export const MAX_VIEWPORT_ITEMS = 200;

/**
 * The rows the full-screen viewport reserves for one item: exactly what
 * `TranscriptItemView` draws for it, with nothing added.
 *
 * A seam, because this number and the drawing agreeing is invisible in a frame
 * and expensive to get wrong. The row model already counts the one-row gap
 * between two items, and the item draws that gap itself (`marginTop` on its own
 * box); counting it a second time here reserved rows nothing filled, so the band's
 * bottom rows came out blank — one per visible item, hiding the newest lines of
 * the transcript above the input. `viewport-wheel.test.tsx` weighs this function
 * against a real render of the component for that reason. The two
 * substituted approval nodes are the one case where the viewport's own wrapper
 * carries the gap, and the model counts that gap through
 * `substitutedApprovalRows` — so nothing is added here for them either.
 */
export function viewportItemRows(
  item: StaticItem,
  options: RowMeasureOptions & { index: number },
): number {
  return measureTranscriptItemRows(item, options);
}

/**
 * Full-screen transcript region (`ui_v2=on`).
 *
 * Renders only the items that fit the viewport, bottom-anchored, using the same
 * per-item renderer as the append shell so the two never disagree about layout.
 * Heights come from the row model, so the window is chosen without rendering
 * the rest of the transcript.
 *
 * Below the band sits the region's own panel: the running-subagent group, and the
 * focused approval when the transcript cannot show it. The panel is chrome, but it
 * is measured here because its rows come out of the viewport height: the band sizes
 * itself from the chrome it is told about, and this panel is not part of that
 * number.
 */
export function ViewportTranscript(props: AppViewProps) {
  const {
    staticItems,
    liveItems,
    columns,
    agentId,
    buffersRef,
    conversationId,
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
    showApprovalPreview,
  } = props;

  const terminalRows = useTerminalRows();
  const measuredChromeRows = useChromeHeight();

  // The panel under the viewport (running subagents, and a focused approval the
  // transcript cannot show). It is measured the same way the shell measures its
  // chrome, and its rows come out of the viewport band — otherwise the panel would
  // push the input off the bottom of a small terminal.
  const { ref: panelRef, rows: panelRows } = useMeasuredChromeHeight();
  const height = Math.max(
    1,
    terminalRows -
      (measuredChromeRows ?? CHROME_RESERVE_ROWS) -
      (panelRows ?? 0),
  );

  // Older history, paged in behind the resume window's cap. Subscribing to the rows
  // themselves — not to a version counter — is what re-renders this component when a
  // page lands, and it is also a real dependency of the composition below. The cursor
  // is derived from the live buffer only when a page is actually asked for, because
  // the buffer is mutated in place and walking it per frame would cost more than the
  // frame it measures.
  const olderItems = useSyncExternalStore(subscribeToOlderHistory, () =>
    getOlderHistoryItems(conversationId),
  );
  useEffect(() => {
    setOlderHistoryProvider(() => ({
      conversationId,
      agentId,
      cursor: olderHistoryCursor(transcriptLines(buffersRef.current)),
    }));
    return () => {
      setOlderHistoryProvider(null);
    };
  }, [conversationId, agentId, buffersRef]);
  // The one signal that the user wants rows this process never loaded: an up-move
  // refused because the oldest loaded row is on screen (`viewport-scroll.ts`).
  useEffect(
    () =>
      subscribeToViewportTop((rows) => {
        void requestOlderHistory(rows);
      }),
    [],
  );

  const items = useMemo<StaticItem[]>(
    () =>
      composeTranscriptItems(
        olderItems,
        buildVisibleItems({
          staticItems,
          liveItems,
          currentApprovalToolCallId: currentApproval?.toolCallId,
          pendingIds,
          queuedIds,
        }),
      ),
    [
      staticItems,
      liveItems,
      currentApproval?.toolCallId,
      pendingIds,
      queuedIds,
      olderItems,
    ],
  );

  // Read once per render: the map is mutated in place as diffs arrive, so its
  // identity is stable and a diff that lands after this render is picked up on the
  // next one (a one-frame drift, documented on the row model).
  const precomputedDiffs = precomputedDiffsRef.current;

  // The transcript's display state lives in a module store because the keystroke
  // handler that toggles it (Ctrl+T / Ctrl+R) sits outside React. Rendering reads
  // it through `TranscriptItemView`'s own subscription, but the *window* is chosen
  // from measured heights, so this component has to subscribe as well: without it
  // an expanded reasoning body keeps being measured as the one-row header it was
  // before Ctrl+T, and the viewport would clip or misplace everything under it.
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
        {
          id: "transcript.scrollToOldest",
          chords: APP_KEY_CHORDS.scrollToOldest,
          run: () => {
            jumpTranscriptToOldest();
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
  // The paged history is walked over its **pages** (`blocked-window.ts`): a page
  // whose rows the viewport measured is one step, so a deep position costs
  // arithmetic per page passed instead of measuring every item in the history.
  //
  // Nothing is evicted yet, so the page list is a partition of `items`: the blocks
  // are the older part, in the same order, and the core is everything after them.
  // The differential test holds this window equal to the item walk's for that case.
  const olderBlocks = useSyncExternalStore(subscribeToOlderHistory, () =>
    getOlderHistoryBlocks(conversationId),
  );
  const olderBlockItems = historyBlockItems(olderBlocks);
  // Items the evicted pages still account for. The walk counts every page; the
  // rendered array only the materialized ones, so a walk index sits this far above
  // its rendered one.
  const olderPrefix = useSyncExternalStore(subscribeToOlderHistory, () =>
    olderHistoryPrefixItems(conversationId),
  );
  const window = useMemo(() => {
    return fitBlockedItemsFromEnd({
      blocks: olderBlocks,
      coreItemCount: Math.max(
        0,
        items.length - (olderBlockItems - olderPrefix),
      ),
      height,
      maxItems: MAX_VIEWPORT_ITEMS,
      scrollFromBottom: scrollRows,
      anchor: scrollAnchor,
      // An item whose page is currently only a count cannot be measured. Its rows
      // still have to be *counted* for the walk to find the window (zero would let a
      // whole dropped page consume no offset at all), so the page's own average stands
      // in — while `isMaterialized` keeps that number out of the ledger, because a
      // page recorded from rows nobody measured can never be drawn again.
      isMaterialized: (index) => items[index - olderPrefix] !== undefined,
      measure: (index) => {
        const item = items[index - olderPrefix];
        if (item === undefined) {
          const owning = historyBlockAt(olderBlocks, index);
          const block = owning === null ? undefined : olderBlocks[owning];
          const rows = block?.rows ?? null;
          if (rows === null) return 1;
          return Math.max(
            1,
            Math.ceil(rows / Math.max(1, block?.itemCount ?? 1)),
          );
        }
        return viewportItemRows(item, {
          columns,
          index,
          terminalRows,
          diffs: precomputedDiffs,
          expandedToolCallId,
          lastShellToolCallId,
          userPromptPrefix: statusLinePrompt
            ? `${statusLinePrompt} `
            : undefined,
          reasoningExpanded,
          systemRemindersVisible,
          systemRemindersExpanded,
          recallDisplay,
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
    });
  }, [
    items,
    columns,
    height,
    terminalRows,
    precomputedDiffs,
    expandedToolCallId,
    lastShellToolCallId,
    statusLinePrompt,
    reasoningExpanded,
    systemRemindersVisible,
    systemRemindersExpanded,
    recallDisplay,
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
    olderBlocks,
    olderBlockItems,
    olderPrefix,
  ]);

  // Keep the pages the window needs, and drop the ones it has left behind. The walk
  // counts **every** page — an evicted one still contributes its `itemCount` and its
  // measured rows — so the window is only drawable where the pages are materialized.
  // Materializing publishes, and the re-render re-fits the window with those rows
  // measured; that second pass is why this returns early instead of evicting in the
  // same frame.
  useEffect(() => {
    const resident = window.resident;
    if (resident === null) return;
    if (materializeOlderHistoryBlocks(resident.from - 1, resident.to)) return;
    evictOlderHistoryBlocksBefore(Math.max(0, resident.from - 1));
  }, [window]);

  // Hand the walk's own measurements back to the ledger. A page whose height is known
  // is one step on the next walk instead of one measurement per item, which is the
  // whole point of walking pages at all. The store publishes only when a height
  // actually moved, so reporting every frame costs no render.
  useEffect(() => {
    for (const block of window.measuredBlocks) {
      reportOlderHistoryBlockRows(block.key, block.rows);
    }
  }, [window]);

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

  // The window is fitted in the **walk's** item space, which counts every page —
  // including the ones eviction reduced to a count. The rendered array only holds the
  // materialized pages, so it sits `olderPrefix` items below the walk: reading the
  // slice without that offset shows rows from the wrong part of the transcript, and
  // once the walk is inside the evicted prefix it shows nothing at all.
  const visible = items.slice(
    Math.max(0, window.start - olderPrefix),
    Math.max(0, window.end - olderPrefix),
  );

  // Whether the focused approval is on screen. Its tool call can be missing from
  // the item list entirely (the backfill cap dropped it) or sit outside the
  // window; either way the input is disabled and the user would see no way to
  // answer, so the panel below pins the surface.
  const approvalIsDrawn = hasFocusedApprovalItem(
    visible,
    currentApproval?.toolCallId,
  );

  // `flexShrink={0}` on everything here is what makes the viewport *clip*.
  //
  // Yoga shrinks children by default, and the window deliberately contains a
  // whole item taller than the band (that is how a long answer is reachable at
  // all). Without this, Ink compresses the tall item to the box instead of
  // letting the overflow be hidden: its inner rows collapse and lines vanish
  // from the *middle* of the content — reported from a 12-row terminal as
  // "each page shows one item, with lines missing in between".
  const shrinkProof = { flexShrink: 0 } as const;

  return (
    <>
      {/* The band is the frame's one elastic box, and it has to be.
          `height` is computed from the chrome and panel measured on the
          *previous* frame, so the frame is regularly a row or two out of date —
          and when it is, Yoga has to take those rows from somewhere. It used to
          take them from the chrome, which is the input: the chrome box was
          squeezed to zero rows, `measureElement` reported the squeezed height,
          the band was sized as `rows - 0` again, and the input stayed off the
          frame for the rest of the session (reported from the machine as "nothing
          I type appears"). Giving the rows back here instead costs at most one
          frame of the transcript's newest rows, and the band is the only box
          whose measurement nothing depends on. Everything measured under it —
          the chrome, `ViewportPanel` — is `flexShrink={0}` for the same reason:
          a squeezed box reports a squeezed height. */}
      <Box
        height={height}
        flexDirection="column"
        overflow="hidden"
        flexShrink={1}
      >
        {/* The window's own offset: the band shows the rows this shift leaves
            inside it. A negative shift is what puts the middle of a tall item on
            screen, and what makes a wheel notch move the text instead of
            repainting the same frame. */}
        <Box
          flexDirection="column"
          flexShrink={0}
          marginTop={window.contentOffset}
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
                <Box
                  key={item.id}
                  flexDirection="column"
                  marginTop={marginTop}
                  {...shrinkProof}
                >
                  <FocusedApproval
                    view={props}
                    precomputedDiff={
                      toolCallId
                        ? precomputedDiffsRef.current.get(toolCallId)
                        : undefined
                    }
                  />
                </Box>
              );
            }

            const isQueued =
              toolCallId !== undefined && queuedIds.has(toolCallId);
            const isPending =
              toolCallId !== undefined && pendingIds.has(toolCallId);
            if (isQueued || isPending) {
              return (
                <Box
                  key={item.id}
                  flexDirection="column"
                  marginTop={marginTop}
                  {...shrinkProof}
                >
                  <PendingApprovalStub
                    toolName={
                      (toolCallId
                        ? approvalMap.get(toolCallId)?.toolName
                        : null) ||
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
              <Box key={item.id} flexDirection="column" {...shrinkProof}>
                <TranscriptItemView
                  item={item}
                  index={index}
                  columns={columns}
                  statusLinePrompt={statusLinePrompt}
                  showCompactionsEnabled={showCompactionsEnabled}
                  precomputedDiffs={precomputedDiffsRef.current}
                  hiddenToolCallId={expandedToolCallId ?? undefined}
                  lastShellToolCallId={lastShellToolCallId ?? undefined}
                />
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Below the band, above the input: running subagents, and the focused
          approval when the band does not draw it. */}
      <ViewportPanel
        panelRef={panelRef}
        approvalIsDrawn={approvalIsDrawn}
        approval={props}
      />
    </>
  );
}
