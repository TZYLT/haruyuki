import { Box, useStdout } from "ink";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { PendingApprovalStub } from "@/cli/components/PendingApprovalStub";
import {
  getCompactionSummaryVisible,
  getRecallDisplay,
  getSystemRemindersExpanded,
  getSystemRemindersVisible,
  getThinkingExpanded,
  subscribeToSystemReminderDisplay,
  subscribeToThinkingDisplay,
} from "@/cli/components/transcript-display-state";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import { ROW_SAFETY_COLUMNS } from "@/cli/display/statusline/formatting";
import { APP_KEY_CHORDS } from "@/cli/helpers/keymap";
import { getTerminalFrame } from "@/cli/helpers/terminal-frame";
import { TranscriptColumnsScope } from "@/cli/hooks/transcript-columns";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import { debugLog, isDebugLogFileReady } from "@/utils/debug";
import type { AppViewProps } from "./AppView";
import { fitBlockedItemsFromEnd } from "./blocked-window";
import {
  CHROME_RESERVE_ROWS,
  useChromeHeight,
  useMeasuredChromeHeight,
} from "./chrome-height";
import { composeTranscript, transcriptCoreIds } from "./composed-transcript";
import { FocusedApproval } from "./FocusedApproval";
import type { WalkIndex } from "./history-blocks";
import { historyBlockAt, historyBlockItems } from "./history-blocks";
import { MAX_VIEWPORT_ITEMS } from "./history-window";
import { hasFocusedApprovalItem, visibleLiveItems } from "./live-items";
import {
  evictOlderHistoryBlocksBefore,
  getOlderHistoryBlocks,
  getOlderHistoryItems,
  materializeOlderHistoryBlocks,
  olderHistoryCursor,
  olderHistoryPrefixItems,
  olderHistoryRenderedRange,
  reportOlderHistoryBlockRows,
  requestOlderHistory,
  requestOlderHistoryPages,
  setOlderHistoryProvider,
  setOlderHistoryRowsKey,
  subscribeToOlderHistory,
  transcriptLines,
} from "./older-history";
import {
  measureTranscriptItemRows,
  type RowLayoutOptions,
  type RowMeasureOptions,
  rowLayoutKey,
} from "./row-model";
import { ContextSidebarSlot } from "./shell/context-sidebar";
import { useHasContextSidebar } from "./shell/sidebar-scope";
import { sidebarGeometry } from "./shell/sidebar-sections";
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

/**
 * The transcript region's props: the app's projection plus the rows the shell
 * draws above the band.
 *
 * `reserveTopRows` is not part of `AppViewProps` because `AppView` does not draw
 * those rows — the full-screen shell does, and it is the only thing that knows
 * how many there are. The append shell draws none, so it passes none.
 */
export type ViewportTranscriptProps = AppViewProps & {
  reserveTopRows?: number;
};

/**
 * How many anomaly lines `HARUYUKI_DEBUG_VIEWPORT` may write per session.
 *
 * A cap, not a rate: the point is a handful of examples of a state the user can see
 * and the numbers behind it. An unbounded per-render log is what made the UI
 * unusable once already (see the log's own comment).
 */
const VIEWPORT_LOG_LIMIT = 40;

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
export function ViewportTranscript(props: ViewportTranscriptProps) {
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
    reserveTopRows = 0,
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
      (panelRows ?? 0) -
      reserveTopRows,
  );
  // The band's height **as laid out**, not as asked for. `height` above comes from
  // the chrome measured on the *previous* frame, so the frame that first draws a
  // taller chrome (the composer's popup and its agent block appear in one keystroke)
  // asks for more rows than are left, and the pinned frame makes Yoga take them back
  // from the band. Everything inside the band — the clip rectangle, the rail's rows,
  // and the window itself — has to follow the *laid-out* box, or it paints below the
  // band's real bottom: the machine photographed a `/font-width` help line inside the
  // input row, with the rail's divider running down the composer beside it.
  //
  // The measurement is a frame behind like the chrome's, but it **publishes**, so the
  // correction is a frame that is scheduled by this state change rather than one
  // waiting for the next keystroke — a stale frame is visible for as long as nothing
  // else repaints, which is exactly how it was found. `Math.min` keeps a band that is
  // taller than asked for (the chrome shrinking) from drawing rows the model did not
  // count.
  const { ref: bandRef, rows: measuredBandRows } = useMeasuredChromeHeight();
  const bandHeight = Math.min(height, measuredBandRows ?? height);

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

  // The committed ids, as the composition's duplicate check wants them. Built when a
  // commit lands rather than when a chunk does: the committed list only ever grows,
  // and this is the one pass over it that cannot be made lazy (`composed-transcript.ts`).
  const committedIds = useMemo(
    () => transcriptCoreIds(staticItems),
    [staticItems],
  );
  // The live rows that draw a row. The turn in flight, not the session — the only
  // list this component has to materialize now that the composition reads the
  // committed one by reference.
  const live = useMemo(
    () =>
      visibleLiveItems(liveItems, {
        currentApprovalToolCallId: currentApproval?.toolCallId,
        pendingIds,
        queuedIds,
      }),
    [liveItems, currentApproval?.toolCallId, pendingIds, queuedIds],
  );

  // The composed transcript is a **view** over the three lists, not a copy of them:
  // reading a row costs that row. The committed list grows for the whole session, so
  // an array built here would make every streaming chunk pay for the whole transcript
  // (`composed-transcript.ts` has the reasoning and `viewport-cost.test.ts` the gate).
  const items = useMemo(
    () =>
      composeTranscript({
        older: olderItems,
        committed: staticItems,
        live,
        committedIds,
      }),
    [staticItems, live, committedIds, olderItems],
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
  // Not a subscription: whether a compaction body is painted is an environment
  // fact (`HARUYUKI_DEBUG`), and it must be the same answer `EventMessage` gets —
  // a body nobody paints must not be measured (`《34》3.11`).
  const compactionSummaryVisible = getCompactionSummaryVisible();

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
    setViewportRows(bandHeight);
  }, [bandHeight]);

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
            return "consumed";
          },
        },
        {
          id: "transcript.scrollPageDown",
          chords: APP_KEY_CHORDS.scrollPageDown,
          run: () => {
            scrollTranscriptPage("down");
            return "consumed";
          },
        },
        {
          id: "transcript.scrollToNewest",
          chords: APP_KEY_CHORDS.scrollToNewest,
          run: () => {
            jumpTranscriptToNewest();
            return "consumed";
          },
        },
        {
          id: "transcript.scrollToOldest",
          chords: APP_KEY_CHORDS.scrollToOldest,
          run: () => {
            jumpTranscriptToOldest();
            return "consumed";
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
  // The band lays its content out two columns narrower than the terminal
  // (`ROW_SAFETY_COLUMNS`), and this is the one place that decides it — items are
  // both measured and drawn with this number, so they cannot disagree.
  //
  // Why the whole transcript and not one renderer at a time: a wrapped line that
  // ends one column past the terminal is wrapped *again* by the terminal, which
  // costs a physical line, which makes the frame taller than the screen, which
  // scrolls the alternate buffer and takes the top row (the tab strip) with it —
  // and every row the selection painter measured moves by one, so the highlight
  // lands on the wrong text. The machine has paid for that three times on three
  // different renderers (a tab title's `…`, a markdown table, a memory diff's
  // prose: 2026-10-20). Ink wraps with a width table that cannot know how wide this
  // terminal draws `“`, `”`, `—` or `…`; two columns of slack absorb the
  // disagreement, and a line that ends inside the terminal cannot wrap. The cost is
  // two columns of right margin on the transcript, which is the same trade the
  // chrome rows already make.
  // The rail takes its columns off the *band*, not off the frame: `《38》§6.3`'s
  // table says the transcript + gutter + rail always sum to the terminal's
  // columns, so the band lays out one gutter narrower than the frame and the
  // rail's divider sits in the last column before its own block.
  //
  // The width is `min(console, ink)` for the reason the strip already pays for:
  // on Windows the console answers with the screen *buffer*, and a row laid out
  // against the larger number is a row Ink wraps — which costs a physical line
  // and scrolls the top off the alternate screen. The strip resolves the same
  // pair the same way, so the `┬` and the divider land in one column.
  const { stdout } = useStdout();
  const inkColumns =
    typeof stdout?.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : undefined;
  const frameColumns =
    inkColumns === undefined ? columns : Math.min(columns, inkColumns);
  const hasRail = useHasContextSidebar();
  const geometry = hasRail
    ? sidebarGeometry(frameColumns, terminalRows)
    : { railWidth: 0, bandColumns: frameColumns, junctionColumn: 0 };
  const railWidth = geometry.railWidth;
  const bandColumns = geometry.bandColumns;
  const contentColumns = Math.max(1, bandColumns - ROW_SAFETY_COLUMNS);

  // Everything an item's height depends on, built **once** and used for both the
  // measurement below and the ledger key: a page's height is measured and then
  // *skipped* by every later walk, so a resize, a `Ctrl+T`/`Ctrl+R` toggle or an
  // expanded tool call would otherwise leave the ledger describing the layout the
  // reader just left. Deriving the key from the same value that measures is what keeps
  // the two from drifting (`row-model.ts` owns the field list and the exhaustiveness
  // check).
  const layout = useMemo<RowLayoutOptions>(
    () => ({
      columns: contentColumns,
      terminalRows,
      userPromptPrefix: statusLinePrompt ? `${statusLinePrompt} ` : undefined,
      reasoningExpanded,
      systemRemindersVisible,
      systemRemindersExpanded,
      recallDisplay,
      // Environment, not composed state: an item's height must include the
      // compaction body exactly when `EventMessage` paints it (`《34》3.11`).
      compactionSummaryVisible,
      showCompactionsEnabled,
      expandedToolCallId,
      lastShellToolCallId,
      diffCount: precomputedDiffs.size,
      substitutionsSignature: [
        currentApproval?.toolCallId ?? "",
        showApprovalPreview ? "preview" : "",
        pendingIds.size,
        queuedIds.size,
        stubDescriptions.size,
      ].join(","),
    }),
    [
      contentColumns,
      terminalRows,
      statusLinePrompt,
      reasoningExpanded,
      systemRemindersVisible,
      systemRemindersExpanded,
      recallDisplay,
      compactionSummaryVisible,
      showCompactionsEnabled,
      expandedToolCallId,
      lastShellToolCallId,
      precomputedDiffs,
      currentApproval?.toolCallId,
      showApprovalPreview,
      pendingIds.size,
      queuedIds.size,
      stubDescriptions.size,
    ],
  );

  const window = useMemo(() => {
    /**
     * The item a walk index points at, in this component's own array.
     *
     * The one place the walk's numbering meets the array being drawn: the walk counts every
     * page (evicted ones included, by `itemCount`), while `items` holds only the
     * materialized pages in front of the core — so a walk index sits `olderPrefix` above
     * its position here. Doing that subtraction anywhere else is what produced three
     * defects in this seam (`history-blocks.ts` names the walk's side).
     *
     * Declared here rather than beside the other locals so the memo does not have to
     * depend on a function identity that changes every render.
     */
    const itemAtWalkIndex = (index: WalkIndex): StaticItem | undefined =>
      items.at(index - olderPrefix);
    const debugRows: string[] = [];
    const measure = (index: WalkIndex): number => {
      const item = itemAtWalkIndex(index);
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
        ...layout,
        index,
        diffs: precomputedDiffs,
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
    };
    const fitted = fitBlockedItemsFromEnd({
      blocks: olderBlocks,
      coreItemCount: Math.max(
        0,
        items.length - (olderBlockItems - olderPrefix),
      ),
      height: bandHeight,
      maxItems: MAX_VIEWPORT_ITEMS,
      scrollFromBottom: scrollRows,
      anchor: scrollAnchor,
      // An item whose page is currently only a count cannot be measured. Its rows
      // still have to be *counted* for the walk to find the window (zero would let a
      // whole dropped page consume no offset at all), so the page's own average stands
      // in — while `isMaterialized` keeps that number out of the ledger, because a
      // page recorded from rows nobody measured can never be drawn again.
      isMaterialized: (index) => itemAtWalkIndex(index) !== undefined,
      measure,
    });
    if (process.env.HARUYUKI_DEBUG_VIEWPORT === "1") {
      // What the model *believes* about each visible item, for the anomaly line: the
      // over-measured item is the one whose number is a lie, and only the model's own
      // numbers can name it.
      for (let offset = 0; fitted.start + offset < fitted.end; offset += 1) {
        const index = (fitted.start + offset) as WalkIndex;
        const item = itemAtWalkIndex(index);
        // The tool's own name matters: "tool_call:35" cannot be checked against a
        // renderer, "tool_call(memory_apply_patch):35" can (2026-10-20).
        const label =
          item === undefined
            ? "page"
            : item.kind === "tool_call"
              ? `tool_call(${item.name})`
              : item.kind;
        debugRows.push(`${index}:${label}:${measure(index)}`);
      }
    }
    return { ...fitted, debugRows };
  }, [
    items,
    bandHeight,
    layout,
    precomputedDiffs,
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

  const rowsKey = useMemo(() => rowLayoutKey(layout), [layout]);

  /**
   * `HARUYUKI_DEBUG_VIEWPORT=1`: one line **per anomaly**, into the session log.
   *
   * The machine reported "big blocks of text vanish while scrolling" (2026-10-20):
   * the band painted content at its top and left the rest empty. Two different
   * causes produce exactly that picture — the row model over-measuring the visible
   * items (the content box is then shorter than the band, and the model's offset
   * lifted it off the bottom), or the window not being filled (a page that has not
   * been materialized contributes an estimate, an anchor that outlived its item, a
   * fit that clamps at the end of history).
   *
   * `blankTail` names both: it counts the empty rows at the band's bottom **in the
   * frame that was just written**, so one line carries what the model believed
   * (`window`, `offset`, `fromBottom`, `anchor`, `resident`) beside what the screen
   * got. A window that is clipped at the top (`start > 0`) has more rows above it,
   * so its content *should* reach the band's bottom: a blank tail there is the row
   * model over-counting, which is the one anomaly this line exists for. A window
   * that starts at 0 is the whole history and is allowed to stop short.
   *
   * Three guards, because the first version of this log was a mistake worth
   * recording: it wrote a line **per render**, and the session log can be initialised
   * *after* the shell draws, so those lines went to the console, Ink repainted for
   * each one, and the repaint wrote another line — a self-feeding loop that made the
   * UI unusable ("tens of thousands of frames of log", 2026-10-20). So: only when
   * something is actually wrong, only when the session log exists (a line that
   * cannot be persisted is a line that would be printed), and at most once per
   * second up to a hard cap.
   *
   * `HARUYUKI_DEBUG_VIEWPORT=1` also logs the frames where nothing is wrong, which
   * is what a report about "it looked fine a moment ago" needs; the rate limit and
   * the cap bound that too.
   */
  const logged = useRef({ at: 0, count: 0 });
  useEffect(() => {
    const everyFrame = process.env.HARUYUKI_DEBUG_VIEWPORT === "1";
    const frame = getTerminalFrame();
    const top = props.reserveTopRows ?? 0;
    let blankTail = 0;
    if (frame) {
      for (let row = top + bandHeight - 1; row > top; row -= 1) {
        if ((frame.lines[row] ?? "").trim().length > 0) break;
        blankTail += 1;
      }
    }
    const shortOfTheBand = blankTail > 0 && window.start > 0;
    if (!shortOfTheBand && !everyFrame) return;
    if (!isDebugLogFileReady()) return;
    const now = Date.now();
    if (now - logged.current.at < 1_000) return;
    if (logged.current.count >= VIEWPORT_LOG_LIMIT) return;
    logged.current.at = now;
    logged.current.count += 1;
    const resident = window.resident;
    debugLog(
      "viewport",
      `band=${bandHeight} blankTail=${blankTail} items=${items.length} prefix=${olderPrefix} pages=${olderBlocks.length} window=${window.start}..${window.end} offset=${window.contentOffset} fromBottom=${window.scrollFromBottom} anchor=${window.anchor.end}/${window.anchor.delta} resident=${resident === null ? "core" : `${resident.from}..${resident.to}`} rows=${window.debugRows?.join(",") ?? "-"}`,
    );
  }, [
    bandHeight,
    items.length,
    olderPrefix,
    olderBlocks.length,
    window,
    window.start,
    window.end,
    window.contentOffset,
    window.scrollFromBottom,
    window.anchor,
    window.resident,
    props.reserveTopRows,
  ]);

  // Forget the heights measured under the previous layout, so the walk re-measures
  // those pages instead of skipping them with a stale number. Publishes only on a real
  // change (a layout change, not a frame).
  useEffect(() => {
    setOlderHistoryRowsKey(rowsKey);
  }, [rowsKey]);

  // Keep the pages the window needs, and drop the ones it has left behind. The walk
  // counts **every** page — an evicted one still contributes its `itemCount` and its
  // measured rows — so the window is only drawable where the pages are materialized.
  // Materializing publishes, and the re-render re-fits the window with those rows
  // measured; that second pass is why this returns early instead of evicting in the
  // same frame.
  useEffect(() => {
    const resident = window.resident;
    if (resident === null) {
      // The window is entirely in the core: *every* page is behind it, which is the
      // steady state while following the newest — the one place residency has to be
      // bounded, or a session keeps every page it ever paged materialized. One page is
      // kept so that a window hovering on the core's edge does not evict and
      // materialize the same page on alternating frames.
      evictOlderHistoryBlocksBefore(Math.max(0, olderBlocks.length - 1));
      return;
    }
    if (materializeOlderHistoryBlocks(resident.from - 1, resident.to)) return;
    // A page whose messages were released beyond the residency budget has to be read
    // back before it can be drawn; asking for it is what moves the window forward, and
    // evicting in the same frame would only report the same page again.
    if (requestOlderHistoryPages(resident.from - 1, resident.to)) return;
    evictOlderHistoryBlocksBefore(Math.max(0, resident.from - 1));
  }, [window, olderBlocks.length]);

  // Hand the walk's own measurements back to the ledger. A page whose height is known
  // is one step on the next walk instead of one measurement per item, which is the
  // whole point of walking pages at all. The store publishes only when a height
  // actually moved, so reporting every frame costs no render.
  useEffect(() => {
    for (const block of window.measuredBlocks) {
      reportOlderHistoryBlockRows(block.key, block.rows, rowsKey);
    }
  }, [window, rowsKey]);

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
  // materialized pages, so reading the slice without converting shows rows from the
  // wrong part of the transcript, and once the walk is inside the evicted prefix it
  // shows nothing at all. The conversion is the store's (`older-history.ts`), which owns
  // both numbering spaces: doing the subtraction here is exactly what went wrong three
  // times.
  const visibleRange = olderHistoryRenderedRange(
    window.start,
    window.end,
    conversationId,
  );
  const visible = items.slice(visibleRange.from, visibleRange.to);

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
        ref={bandRef}
        height={height}
        flexDirection={railWidth > 0 ? "row" : "column"}
        overflow="hidden"
        flexShrink={1}
      >
        {/* **The clip box and the shift are two boxes, and that is the whole point.**
            The window's offset can be negative (a tall item scrolled to its middle),
            and Ink applies only the *innermost* clip (`output.js`: `clips.at(-1)`),
            so a box that both clips and carries the offset clips against its own
            moved rectangle — which is no clip at all. The machine showed exactly
            that: with one long item in the band, the transcript's first rows were
            painted over the tab row and the rule (the band's own rows ended at the
            band's width, so the rule survived to the right of them), and the rail,
            which does not move, sat two rows below them.

            Fixed outer box: the band's own rectangle, in the band's own place.
            Shifted inner box: no `overflow`, so the clip that reaches the items is
            the outer box's, and the rows the shift pushes past its top edge are
            dropped instead of drawn over the shell's chrome.

            **The shift is measured from the box's bottom, not its top.** The
            window's row count comes from the row model, which is an estimate: a
            documented approximation may be one row out, and the renderers and the
            model can disagree about a wrap. An offset computed from the top
            (`bandHeight - modelRows + delta`) spends that disagreement as blank
            rows at the band's bottom — the newest rows of the transcript stop
            short of the input, which is what the machine reported twice (2026-10-20,
            2026-10-22). `marginBottom` on a bottom-aligned box instead names the one
            thing the scroll position actually is: `delta` rows of the window's
            bottom item sit below the band. The box's real height then decides where
            its top lands, so the band's bottom edge always carries the newest
            visible row, whatever the model believed — and a row the model
            over-counted simply clips at the top. */}
        <Box
          flexDirection="column"
          flexShrink={0}
          width={railWidth > 0 ? bandColumns : undefined}
          height={bandHeight}
          maxHeight="100%"
          overflow="hidden"
          justifyContent="flex-end"
        >
          {/* The band's own width, for every renderer inside it. The items are
              measured at `contentColumns`, so they have to be *laid out* at it
              too: a renderer that reads the terminal's width instead draws rows
              the band clips at its right edge, and reports a height the row model
              disagrees with — which the viewport turns into blank rows at the
              band's bottom (`transcript-columns.ts`). The rail beside this box is
              not a transcript item and keeps the terminal's width. */}
          <TranscriptColumnsScope.Provider value={contentColumns}>
            <Box
              flexDirection="column"
              flexShrink={0}
              marginBottom={-window.anchor.delta}
            >
              {visible.map((item, offset) => {
                const index = window.start + offset;
                const marginTop = index > 0 ? 1 : 0;
                const toolCallId =
                  item.kind === "tool_call" ? item.toolCallId : undefined;
                const itemName =
                  item.kind === "tool_call" ? item.name : undefined;
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
                          toolCallId
                            ? stubDescriptions.get(toolCallId)
                            : undefined
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
                      columns={contentColumns}
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
          </TranscriptColumnsScope.Provider>
        </Box>

        {/* The rail, inside the band's row: it gets the band's own height, so a
            folded rail and a tall one are the same frame geometry, and the
            divider is the box's border rather than a glyph per line. */}
        {railWidth > 0 && (
          <ContextSidebarSlot
            view={props}
            height={bandHeight}
            width={railWidth}
          />
        )}
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
