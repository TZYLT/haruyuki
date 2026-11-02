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
import { validateAgentName } from "@/cli/components/PinDialog";
import { Text } from "@/cli/components/Text";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  useInputScopeClaim,
  useKeyBindings,
} from "@/cli/hooks/use-input-router";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { DEFAULT_AGENT_NAME } from "@/constants";
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
 * **The two New rows are the page's one action that is not a navigation**
 * (R-10.2 / R-10.3, Q-36 / Q-54). Neither starts a conversation or an agent
 * itself: `New Session` is the app's own `/new` (`onSubmit("/new")`, so session
 * hooks, reminders, persistence and the busy/queue answer are the submit path's,
 * not a second implementation's), and `New Agent` is the existing
 * `handleCreateNewAgent(name)` flow with the name typed in-page. The name editor
 * replaces the header row for as long as it is open — the settings page's
 * contract for a page that must not raise a second box — and lives in this
 * component's state, never in `AppCoordinator` (`R-10.2` forbids new global
 * input state, and the pinned coordinator takes no T-10 wiring).
 *
 * **Neither callback reports its outcome.** `handleCreateNewAgent` resolves
 * whether it created the agent or failed (the failure is written to the
 * transcript behind this page), so the page watches the one fact it can see —
 * `agentId` changing — and reports the absence of a change after the call has
 * resolved and the app has had a settled frame to render it. `onSubmit("/new")`
 * answers `{ submitted }`, which is the guard's answer, not the backend's; when
 * it refuses, the page says so, and when it accepts the app's conversation
 * switch is what leaves the page.
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
 * The New Agent name editor's state (`Q-54`).
 *
 * Page-local on purpose (`R-10.2`): the editor is one row of this page, so it is
 * this component's state — no `AppCoordinator` state, no new input mode, and the
 * header-row editor contract is the settings page's.
 */
type NewAgentEditorState = { draft: string; error: string | null };

/** The editor row's label. Short enough to leave the field room at 40 columns. */
const NEW_AGENT_LABEL = "New agent name: ";

/**
 * How long after `handleCreateNewAgent` resolves the page waits for the app to
 * show the new agent before calling the creation a failure.
 *
 * The callback sets the new `agentId` *before* it resolves, so this is a settle
 * window for the app's next frame, not a timeout on the backend call — a slow
 * creation never starts the timer (it starts on the promise's resolution). It is
 * also the page's only failure signal: the pinned callback resolves for both
 * outcomes and writes its own failure to the transcript behind this page.
 */
const ACTION_SETTLE_MS = 500;

/** A creation the page is waiting to see land in the app's `agentId`. */
type PendingCreation = {
  /** The agent the page was on when the create was submitted. */
  fromAgentId: string;
  name: string;
  /** The settle timer, armed once the app callback has resolved. */
  timer: ReturnType<typeof setTimeout> | null;
};

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
  /** The inline New Agent name editor (`Q-54`); null when the list has the keys. */
  const [nameEditor, setNameEditor] = useState<NewAgentEditorState | null>(
    null,
  );

  /**
   * The live props, for async continuations.
   *
   * `handleCreateNewAgent` and `onSubmit` answer after awaits, and the component
   * that started them may have rendered several times by then; reading `view`
   * from the closure would ask whether the *old* agent moved.
   */
  const latestView = useRef(view);
  latestView.current = view;
  /** Whether the page is still mounted: a late answer has no page to land on. */
  const mounted = useRef(true);
  /** The creation whose app-side switch has not been observed yet. */
  const creation = useRef<PendingCreation | null>(null);

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

  // A creation's settle timer belongs to this page: unmounting (the app switched
  // away, which is what success looks like) must not leave a timer that sets
  // state on a page that no longer exists.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (creation.current?.timer) clearTimeout(creation.current.timer);
      creation.current = null;
    };
  }, []);

  // A creation succeeded when the app's agent changes: the callback switches to
  // the new agent before its promise resolves, and nothing else in this page
  // moves the agent. The conversation that switch put in the main area is the
  // target, and focusing its tab is this page's way out (R-10.4's navigation,
  // reused) — when the conversation id changed too, `use-conversation-tab` has
  // already opened and focused that tab, so this is a no-op by then.
  useEffect(() => {
    const pending = creation.current;
    if (pending === null || view.agentId === pending.fromAgentId) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    creation.current = null;
    setNote(null);
    focusTab(view.conversationId);
  }, [view.agentId, view.conversationId]);

  /** Report a creation the page saw fail, once, on the header's note line. */
  const reportCreationFailure = (name: string): void => {
    if (!mounted.current) return;
    setNote(`Couldn't create agent "${name}".`);
  };

  /** Enter in the name editor: validate, then hand the name to the app's flow. */
  const submitNewAgentName = (): void => {
    if (nameEditor === null) return;
    const typed = nameEditor.draft.trim();
    // The old New Agent form (`AgentSelector`'s New tab) treats Enter on an empty
    // field as "use the default name"; reusing the flow means reusing that
    // answer, not inventing a second one.
    const name = typed === "" ? DEFAULT_AGENT_NAME : typed;
    const validationError = validateAgentName(name);
    if (validationError !== null) {
      setNameEditor({ draft: nameEditor.draft, error: validationError });
      return;
    }
    setNameEditor(null);
    setNote(`Creating agent "${name}"…`);
    const pending: PendingCreation = {
      fromAgentId: latestView.current.agentId,
      name,
      timer: null,
    };
    creation.current = pending;
    void view
      .handleCreateNewAgent(name)
      .then(() => {
        if (!mounted.current || creation.current !== pending) return;
        // The callback resolves for both outcomes (see `PendingCreation`); give
        // the app's switch a settled frame before calling it a failure.
        pending.timer = setTimeout(() => {
          if (!mounted.current || creation.current !== pending) return;
          creation.current = null;
          reportCreationFailure(name);
        }, ACTION_SETTLE_MS);
      })
      .catch(() => {
        if (creation.current !== pending) return;
        if (pending.timer !== null) clearTimeout(pending.timer);
        creation.current = null;
        reportCreationFailure(name);
      });
  };

  /**
   * `New Session` is `/new` (R-10.3, Q-36): the submit path, entered through the
   * same callback the composer calls, so the session hooks, reminders,
   * persistence and the busy/queue answer are not re-implemented here. On
   * success the app switches `conversationId`, `use-conversation-tab` opens and
   * focuses the new tab, and the page is gone — that is the whole leave contract.
   */
  const startNewSession = (): void => {
    const wasBusy = latestView.current.isAgentBusy();
    setNote("Starting a new session…");
    void view
      .onSubmit("/new")
      .then((result) => {
        if (!mounted.current) return;
        if (result.submitted) {
          // Accepted — started now, or queued behind the turn; either way the
          // page leaves when the conversation actually switches. A busy agent
          // answers `/new` inside the submit path by writing the refusal to the
          // transcript this page is covering, so the header repeats it where it
          // can still be seen.
          if (wasBusy) setNote("/new is disabled while the agent is running.");
          return;
        }
        // The submit path's guard declined (pending approvals); nothing moved.
        setNote("Couldn't start a new session.");
      })
      .catch(() => {
        if (mounted.current) setNote("Couldn't start a new session.");
      });
  };

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
      // While the name editor owns the page, the pointer cannot move the page on:
      // `Enter` and `Esc` are the only ways out of that row, and the list behind
      // it is not a target until the editor is gone. A creation already in flight
      // owns the action for the same reason — the app callback has no re-entry
      // guard of its own.
      if (nameEditor !== null || creation.current !== null) return;
      if (target.kind === "agent") {
        setLevel({ kind: "conversations", agentId: target.agentId });
        setNote(null);
        return;
      }
      if (target.kind === "conversation" && level.kind === "conversations") {
        openConversation(level.agentId, target.conversationId);
        return;
      }
      if (target.kind === "new-agent") {
        // Q-54: the name is typed in-page, in the header row, and the existing
        // `handleCreateNewAgent` flow does the rest (it picks the model itself —
        // no model step here).
        setNote(null);
        setNameEditor({ draft: "", error: null });
        return;
      }
      if (target.kind === "new-session") {
        startNewSession();
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

  const headerWidth = useHeaderWidth(view);

  return (
    <PageFrame
      view={view}
      body={body}
      actions={actions}
      headerSlot={
        nameEditor !== null ? (
          <NewAgentEditor
            editor={nameEditor}
            width={headerWidth}
            onChange={(draft) => {
              setNameEditor((current) =>
                current === null ? current : { draft, error: null },
              );
            }}
            onSubmit={submitNewAgentName}
            onCancel={() => {
              setNameEditor(null);
            }}
          />
        ) : (
          <OverviewHeader
            width={headerWidth}
            crumbs={crumbs}
            aside={aside}
            note={note !== null}
            onSelectCrumb={selectCrumb}
          />
        )
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
  width,
  crumbs,
  aside,
  note,
  onSelectCrumb,
}: {
  width: number;
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

  const headerWidth = width;
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
 * The New Agent name editor (Q-54), drawn in the header row.
 *
 * A one-row step, not an overlay: the page behind it does not move, `Esc` puts
 * the list's keys back, and `Enter` hands the name to `handleCreateNewAgent`.
 * The settings page's inline editor is the precedent for both halves — the
 * header row *is* the editor while it is open, and it takes the `overlay` scope
 * so the frame's `↑↓`/`Esc` stand down and one owner has the keys.
 *
 * The error is clipped to the cells the label and the draft leave: this row is
 * part of the band's height budget, so an over-wide error would wrap and push
 * every row down by a line the frame never accounted for.
 */
function NewAgentEditor({
  editor,
  width,
  onChange,
  onSubmit,
  onCancel,
}: {
  editor: NewAgentEditorState;
  width: number;
  onChange: (draft: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  useInputScopeClaim("overlay", true);
  useKeyBindings("overview-new-agent", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "overview.new-agent.create",
          chords: [{ key: "return" }],
          label: "Create agent",
          run: () => {
            onSubmit();
            return "consumed";
          },
        },
        {
          id: "overview.new-agent.cancel",
          chords: [{ key: "escape" }],
          label: "Cancel",
          run: () => {
            onCancel();
            return "consumed";
          },
        },
      ],
    },
  ]);

  const used =
    terminalTextWidth(NEW_AGENT_LABEL) +
    terminalTextWidth(editor.draft) +
    (editor.error === null ? 0 : 2);
  const errorWidth = Math.max(0, width - used);
  const drawnError =
    editor.error !== null && errorWidth >= 8
      ? truncateText(editor.error, errorWidth)
      : null;

  return (
    <Box flexDirection="row">
      <Text color={colors.selector.itemHighlighted}>{NEW_AGENT_LABEL}</Text>
      <OverlayTextField
        value={editor.draft}
        onChange={onChange}
        marker={null}
        focus
      />
      {drawnError !== null && (
        <Text color={colors.status.error}>{`  ${drawnError}`}</Text>
      )}
    </Box>
  );
}

/**
 * The columns the header may use: the band's, less its padding.
 *
 * The frame computes the same number for the rows; the header is drawn in the
 * same box, so it has to clip to the same width. Asked by the page rather than
 * inside each header because both the breadcrumb header and the name editor that
 * stands in for it are one row of the same budget.
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
