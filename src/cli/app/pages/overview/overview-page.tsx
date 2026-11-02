// src/cli/app/pages/overview/overview-page.tsx

import { Box, type DOMElement, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import {
  type ClickSegment,
  lineText,
  useLineClicks,
} from "@/cli/app/pages/click-line";
import { type PageActions, PageFrame } from "@/cli/app/pages/page-frame";
import type { PageBody, PageRow } from "@/cli/app/pages/page-model";
import { useHasContextSidebar } from "@/cli/app/shell/sidebar-scope";
import { sidebarGeometry } from "@/cli/app/shell/sidebar-sections";
import { focusTab } from "@/cli/app/tabs";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import {
  applyOverviewPreview,
  currentOverviewGeneration,
  isOverviewDataError,
  loadOverviewPreview,
  loadOverviewSnapshot,
  OVERVIEW_PREVIEW_ERROR_NOTE,
  OVERVIEW_SNAPSHOT_ERROR_NOTE,
  refreshOverviewSnapshot,
} from "./overview-data";
import {
  buildAgentRows,
  buildConversationRows,
  overviewRowTarget,
} from "./overview-rows";
import type { OverviewSnapshot } from "./overview-types";

/**
 * The `+` tab's page: agents, then one agent's conversations (T-10, W-15).
 *
 * Two levels, one page (R-10.2 / R-10.3): the first lists every agent, `Enter`
 * (or a click) on one opens its conversation list, and the breadcrumb or
 * `Esc`/`←` goes back. The rows themselves are `overview-rows.ts` — this file
 * owns the frame (through `PageFrame`), the two levels' state, the data reads
 * and what activating a row means.
 *
 * **Opening a conversation leaves the page.** That is not done here: the page
 * calls the navigation the rest of the app already uses — `tabStrip.onSelect`
 * for a conversation of the current agent, `handleAgentSelect(agentId,
 * {conversationId})` across agents — and those paths end by changing
 * `conversationId`, which `use-conversation-tab` turns into a focused tab and
 * therefore out of the page (R-10.4). One navigation, three entry points.
 *
 * **The data is W-12's.** The snapshot is read once on mount (TTL-cached by the
 * data layer, so re-entering the page is instant), `r` forces a fresh one, and
 * the message snippets are lazy: they are read when a conversation level is
 * shown, one read per conversation per snapshot generation, and a read that
 * lands after a refresh is dropped by the generation check rather than painted
 * onto the new snapshot (R-10.8).
 *
 * **The header is breadcrumb + keys**, the same shape as Settings (R-10.7): the
 * segments name the levels and the pointer can click them back up; the aside
 * says what the keyboard does here. A page owns the main area, so the header is
 * the only place those two facts can live without scrolling.
 *
 * **New Session / New Agent are not wired here.** Their rows are W-13's, and
 * their actions are W-17's package (R-10.2 / R-10.3, Q-36 / Q-54). Until then
 * they are selectable and say so, so a click is a visible no-op rather than a
 * dead one — and W-17 replaces the two branches below.
 */

/** The level the page is showing. */
type OverviewLevel =
  | { kind: "agents" }
  | { kind: "conversations"; agentId: string };

/** Where a breadcrumb segment goes. */
type OverviewCrumbTarget = "leave" | "agents";

/** The two levels' key hints, the Settings header's aside shape (R-10.7). */
const AGENT_HINT = "↑↓ move · ⏎ open · Esc back · r refresh";
const CONVERSATION_HINT = "↑↓ move · ⏎ open · Esc/← back · r refresh";

/** The crumb separator, the same one the settings tree uses. */
const CRUMB_SEPARATOR = " / ";

/** How long a transient header note stays up. */
const NOTE_MS = 4000;

/**
 * The blank line between the header and the content (R-10.7's "空一行").
 *
 * A `text` row rather than padding: the frame already owns the header row's
 * height, and a body row is the only blank line the window arithmetic counts.
 */
const BLANK_ROW: PageRow = { kind: "text", text: "" };

/** The first-level empty state (R-10.9): one line, no badge, no retry key. */
const NO_AGENTS_NOTE = "No agents to show yet.";

/** The second-level empty state (R-10.9). */
const NO_CONVERSATIONS_NOTE = "No conversations to show yet.";

export function OverviewPage(view: AppViewProps) {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * Whether the failure above is worth a retry key.
   *
   * The data layer's `OverviewDataError.retryable` is the answer; a failure that
   * is not retryable would be a broken contract (there is no page-level fix), so
   * the header says nothing rather than offering a key that cannot help.
   */
  const [retryable, setRetryable] = useState(true);
  const [level, setLevel] = useState<OverviewLevel>({ kind: "agents" });
  const [note, setNote] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  /**
   * The ticket of the load in flight. A load that lands after another one
   * started (or after the page unmounted) is dropped, so `r` twice cannot paint
   * the older snapshot over the newer one.
   */
  const loadTicket = useRef(0);
  const snapshotRef = useRef<OverviewSnapshot | null>(null);
  snapshotRef.current = snapshot;
  /** Previews already asked for, keyed by generation, agent and conversation. */
  const requestedPreviews = useRef(new Set<string>());

  // The first read. The data layer serves the cache while it is younger than
  // the TTL, so leaving the page and coming back does not re-read the backend.
  useEffect(() => {
    const ticket = loadTicket.current + 1;
    loadTicket.current = ticket;
    void loadOverviewSnapshot()
      .then((next) => {
        if (loadTicket.current !== ticket) return;
        setSnapshot(next);
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (loadTicket.current !== ticket) return;
        setFailed(true);
        setRetryable(isOverviewDataError(error) ? error.retryable : true);
      });
    return () => {
      // Unmounted: a late answer has no page to land on.
      loadTicket.current += 1;
    };
  }, []);

  // `r`: a forced snapshot re-read. The new snapshot takes the next generation,
  // which both cancels preview reads that are still open and (through the key
  // below) asks for the snippets again.
  const refresh = (): void => {
    const ticket = loadTicket.current + 1;
    loadTicket.current = ticket;
    setPreviewFailed(false);
    setNote("Refreshing…");
    void refreshOverviewSnapshot()
      .then((next) => {
        if (loadTicket.current !== ticket) return;
        setSnapshot(next);
        setFailed(false);
        setNote("Updated");
      })
      .catch((error: unknown) => {
        if (loadTicket.current !== ticket) return;
        const canRetry = isOverviewDataError(error) ? error.retryable : true;
        setRetryable(canRetry);
        if (snapshotRef.current) {
          // The page keeps showing what it has: a failed refresh is not a
          // failed page.
          setNote(
            canRetry
              ? "Couldn't refresh. Press r to retry."
              : "Couldn't refresh.",
          );
        } else {
          setFailed(true);
          setNote(null);
        }
      });
  };

  // A note is transient, like the settings page's: it reports one action and
  // leaves the header's key hint to come back.
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => {
      setNote(null);
    }, NOTE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [note]);

  // The lazy half of R-10.8. Entering a conversation level asks for the
  // snippets of every conversation it will draw; the data layer reads each one
  // at most once per generation, and a read that started before a refresh is
  // dropped (it lands as `stale`, not as data).
  useEffect(() => {
    if (!snapshot || level.kind !== "conversations") return;
    const generation = currentOverviewGeneration();
    const conversations = snapshot.conversations[level.agentId] ?? [];
    let cancelled = false;
    for (const conversation of conversations) {
      const key = `${generation}\u0000${level.agentId}\u0000${conversation.conversationId}`;
      if (requestedPreviews.current.has(key)) continue;
      requestedPreviews.current.add(key);
      void loadOverviewPreview(level.agentId, conversation.conversationId, {
        generation,
      }).then((result) => {
        if (cancelled || result.status === "stale") return;
        if (result.status === "error") {
          setPreviewFailed(true);
          return;
        }
        setSnapshot((current) =>
          current
            ? applyOverviewPreview(
                current,
                level.agentId,
                conversation.conversationId,
                result.preview,
              )
            : current,
        );
      });
    }
    return () => {
      cancelled = true;
    };
  }, [snapshot, level]);

  useKeyBindings("overview-page", [
    {
      scope: "page",
      bindings: [
        {
          id: "overview.refresh",
          chords: [{ key: "r" }],
          label: "Refresh",
          run: () => {
            refresh();
            return "consumed";
          },
        },
      ],
    },
  ]);

  const agentName =
    level.kind === "conversations"
      ? (snapshot?.agents.find((agent) => agent.agentId === level.agentId)
          ?.name ?? level.agentId)
      : null;

  /** Where a breadcrumb segment goes; the root's own name leaves the page. */
  const selectCrumb = (segment: ClickSegment<OverviewCrumbTarget>): void => {
    if (segment.target === "agents") {
      setLevel({ kind: "agents" });
      return;
    }
    if (segment.target === "leave" && view.conversationId) {
      focusTab(view.conversationId);
    }
  };

  /**
   * Open one conversation through the navigation that already exists.
   *
   * The two paths are the app's: a conversation of the current agent is the tab
   * strip's click (which focuses an open tab or switches, deferring while busy),
   * and a conversation of another agent is `handleAgentSelect` with the
   * conversation id — the same call `/search` makes. There is no third path to
   * write here: both end by changing `conversationId`, and the page leaves.
   */
  const openConversation = (
    targetAgentId: string,
    conversationId: string,
  ): void => {
    if (targetAgentId === view.agentId) {
      view.tabStrip.onSelect(conversationId);
      return;
    }
    void view.handleAgentSelect(targetAgentId, { conversationId }).catch(() => {
      setNote("Couldn't open the conversation.");
    });
  };

  const actions: PageActions = {
    activate: (row) => {
      if (row.kind !== "item") return;
      const target = overviewRowTarget(row.id);
      if (!target) return;
      if (target.kind === "agent") {
        setLevel({ kind: "conversations", agentId: target.agentId });
        setNote(null);
        return;
      }
      if (target.kind === "conversation" && level.kind === "conversations") {
        openConversation(level.agentId, target.conversationId);
        return;
      }
      // W-17 wires these two. Until it does they are a visible no-op: the rows
      // are selectable (W-13 built them), so an unhandled `Enter` would read as
      // a broken key.
      if (target.kind === "new-agent") {
        setNote("New Agent is not available yet.");
        return;
      }
      if (target.kind === "new-session") {
        setNote("New Session is not available yet.");
      }
    },
    back: () => {
      // Only the second level has a parent inside the page; at the root `Esc`
      // is the frame's own "back to the conversation".
      if (level.kind !== "conversations") return false;
      setLevel({ kind: "agents" });
      return true;
    },
  };

  const rowsFor = (width: number): readonly PageRow[] => {
    if (failed) {
      return [BLANK_ROW, { kind: "note", text: OVERVIEW_SNAPSHOT_ERROR_NOTE }];
    }
    if (!snapshot) {
      return [BLANK_ROW, { kind: "note", text: "Loading agents…" }];
    }
    const nowMs = snapshot.generatedAtMs;
    if (level.kind === "agents") {
      const built = buildAgentRows({
        agents: snapshot.agents,
        nowMs,
        width,
      });
      return snapshot.agents.length === 0
        ? [BLANK_ROW, ...built, { kind: "note", text: NO_AGENTS_NOTE }]
        : [BLANK_ROW, ...built];
    }
    const conversations = snapshot.conversations[level.agentId] ?? [];
    const built = buildConversationRows({ conversations, nowMs, width });
    return conversations.length === 0
      ? [BLANK_ROW, ...built, { kind: "note", text: NO_CONVERSATIONS_NOTE }]
      : [BLANK_ROW, ...built];
  };

  const body: PageBody = {
    title: "Agents",
    // One screen per level: entering a conversation list starts its cursor at
    // the top and returns the scroll offset, and coming back starts the agent
    // list at its own first row.
    screen:
      level.kind === "agents" ? "agents" : `conversations:${level.agentId}`,
    rows: (geometry) => rowsFor(geometry.width),
  };

  const crumbs: readonly ClickSegment<OverviewCrumbTarget>[] =
    level.kind === "agents"
      ? [{ label: "Agents", target: "leave" }]
      : [{ label: "Agents", target: "agents" }, { label: agentName ?? "" }];

  const aside = failed
    ? retryable
      ? "r retry"
      : ""
    : (note ??
      (previewFailed
        ? `${OVERVIEW_PREVIEW_ERROR_NOTE} r retry`
        : level.kind === "agents"
          ? AGENT_HINT
          : CONVERSATION_HINT));

  return (
    <PageFrame
      view={view}
      body={body}
      actions={actions}
      headerSlot={
        <OverviewHeader
          view={view}
          crumbs={crumbs}
          aside={aside}
          note={note !== null}
          onSelectCrumb={selectCrumb}
        />
      }
    />
  );
}

/**
 * The page's header row: the breadcrumb, then what the keys do here.
 *
 * It is pre-clipped to the band's width because the header is *one* row the
 * frame has already spent: an over-wide aside would wrap and push the page down
 * by a line the window arithmetic never budgeted. The segments themselves are
 * the click targets (`click-line.ts` walks them left to right), and a click on
 * the aside — or a segment with no target — is spent on nothing.
 */
function OverviewHeader({
  view,
  crumbs,
  aside,
  note,
  onSelectCrumb,
}: {
  view: AppViewProps;
  crumbs: readonly ClickSegment<OverviewCrumbTarget>[];
  aside: string;
  note: boolean;
  onSelectCrumb: (segment: ClickSegment<OverviewCrumbTarget>) => void;
}) {
  const headerRef = useRef<DOMElement | null>(null);
  useLineClicks<OverviewCrumbTarget>({
    ref: headerRef,
    segments: crumbs,
    onSelect: onSelectCrumb,
    separator: CRUMB_SEPARATOR,
    name: "overview-crumbs",
  });

  const headerWidth = useHeaderWidth(view);
  const crumbText = lineText(crumbs, CRUMB_SEPARATOR);
  const drawnCrumb = truncateText(crumbText, headerWidth);
  const crumbWidth = terminalTextWidth(drawnCrumb);
  // Three spaces separate the two halves, the same gap the settings header uses.
  const asideWidth = Math.max(0, headerWidth - crumbWidth - 3);
  const drawnAside = asideWidth >= 4 ? truncateText(aside, asideWidth) : "";

  return (
    <Box ref={headerRef} flexDirection="row">
      <Text bold>{drawnCrumb}</Text>
      {drawnAside !== "" && (
        <Text dimColor color={note ? colors.status.success : undefined}>
          {`   ${drawnAside}`}
        </Text>
      )}
    </Box>
  );
}

/**
 * The columns the header may use: the band's, less its padding.
 *
 * The frame computes the same number for the rows; the header is drawn in the
 * same box, so it has to clip to the same width. Asked here rather than passed
 * down because `headerSlot` is a fixed one-row contract the frame does not hand
 * geometry into (the settings page's header is short enough not to need it; this
 * one says more and is allowed to be on a narrow terminal).
 */
function useHeaderWidth(view: AppViewProps): number {
  const { stdout } = useStdout();
  const terminalRows = useTerminalRows();
  const hasSidebar = useHasContextSidebar();
  const inkColumns =
    typeof stdout?.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : undefined;
  const frameColumns =
    inkColumns === undefined
      ? view.columns
      : Math.min(view.columns, inkColumns);
  const geometry = hasSidebar
    ? sidebarGeometry(frameColumns, terminalRows)
    : { railWidth: 0, bandColumns: frameColumns };
  return Math.max(1, geometry.bandColumns - 2);
}
