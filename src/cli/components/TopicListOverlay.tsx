import { Box } from "ink";
import { useRef, useState } from "react";
import { getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import type { LocalTopicList } from "@/backend/local/local-topic-trim";
import {
  queryTopicIndex,
  type TopicIndexEntry,
} from "@/backend/local/topic-index";
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { namedKeyChords } from "@/cli/helpers/input-keys";
import {
  buildTopicPanelRows,
  TOPIC_PANEL_VIEWS,
  type TopicPanelRow,
  type TopicPanelView,
  topicPanelCommand,
  topicPanelCount,
  topicPanelEmpty,
  topicPanelNotes,
  topicPanelTitle,
} from "@/cli/helpers/topic-panel";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { colors } from "./colors";
import { Text } from "./Text";

/**
 * The one topic panel: `/topic list`, `/topic list --context` and
 * `/topic list --all` (requirement §5.11.10–11, amended 2026-10-28).
 *
 * Three views over the same data, one component and one key table: the blocks
 * of the current context (what `/compact <n>` numbers), this conversation's
 * markers in context order, and this agent's whole index newest first. The
 * command that was typed picks the opening view; Tab/Shift+Tab cycles, so the
 * other two are always one key away instead of one command away.
 *
 * Everything is read once, on mount. The queries are synchronous, so the first
 * frame is the list rather than a "loading" line, and the index's own self-heal
 * (§5.11.4) is what makes a stale file safe to read.
 *
 * Three things are deliberate:
 *
 * - **One line per row.** Label · description clipped separately, so the
 *   window's height (and the composer behind it) cannot depend on the data. The
 *   facts that do not fit open with Enter instead of wrapping the row.
 * - **The row models are pure functions** (`helpers/topic-panel.ts`): the frame
 *   tests assert on rows, and the printed forms keep reading the same copy.
 * - **The source is injectable.** The app passes nothing and gets the real
 *   transcript and index through the backend's own storage root —
 *   `getLocalStorageDir()` is the only root that is correct for a test or
 *   alternate-root backend (route §2.3), and a backend without one is reported
 *   as local-only rather than read from the default root.
 */

/** What the face has to show: both sources, or the reason there are none. */
export type TopicPanelData =
  | {
      kind: "loaded";
      list: LocalTopicList;
      entries: readonly TopicIndexEntry[];
    }
  | { kind: "unavailable" };

/** Where a panel reads from. Called once per mount. */
export type TopicPanelSource = () => TopicPanelData;

/**
 * The app's source: this conversation's transcript plus this agent's index,
 * both under the backend's storage root.
 *
 * A non-local backend has neither: `getLocalStorageDir()` is absent and its
 * conversations live server-side, so the face says so instead of reading the
 * user's real `~/.haruyuki/lc-local-backend` (route §2.3, 《31》A1).
 */
export function backendTopicPanelSource(
  agentId: string,
  conversationId: string,
): TopicPanelSource {
  return () => {
    const backend = getBackend();
    const storageDir = backend.getLocalStorageDir?.();
    if (!storageDir || !(backend instanceof LocalBackend)) {
      return { kind: "unavailable" };
    }
    return {
      kind: "loaded",
      list: backend.listTopics(conversationId, agentId),
      entries: queryTopicIndex({ agentId, storageDir }),
    };
  };
}

/**
 * Chrome the list does not get to use: the frame's header (command, rule, blank,
 * title + its margin = 5), the two indicator rows a windowed list always
 * reserves, and the footer's three lines plus their top margin. Every view
 * carries exactly two standing notes for this reason (`topicPanelNotes`): a
 * footer that grew would resize the window mid-session.
 */
const CHROME_ROWS = 11;

/** One marker, block or index record, on one line. */
function TopicRow({
  row,
  width,
  isCursor,
}: {
  row: TopicPanelRow;
  width: number;
  isCursor: boolean;
}) {
  const color = isCursor ? colors.selector.itemHighlighted : undefined;
  const available = Math.max(1, width - 2);
  const label = truncateText(row.label, available);
  const descBudget = available - terminalTextWidth(label) - 3;
  const description =
    row.description && descBudget > 3
      ? truncateText(row.description, descBudget)
      : null;
  return (
    <Box flexDirection="row">
      <Text color={color}>{isCursor ? "> " : "  "}</Text>
      <Text bold={isCursor} color={color}>
        {label}
      </Text>
      {description !== null && <Text dimColor>{` · ${description}`}</Text>}
    </Box>
  );
}

/** The whole row, plus whatever Enter opened, on the same face. */
function TopicDetail({
  row,
  command,
  view,
  width,
}: {
  row: TopicPanelRow;
  command: string;
  view: TopicPanelView;
  width: number;
}) {
  return (
    <OverlayFrame
      command={command}
      title={topicPanelTitle(view)}
      footer={
        <Text dimColor>
          {truncateText(
            "Esc back to the list · Tab switch view · q close",
            width,
          )}
        </Text>
      }
    >
      <Box flexDirection="column">
        <Text bold color={colors.selector.title}>
          {truncateText(row.label, width)}
        </Text>
        {row.description !== undefined && (
          <Text dimColor>{truncateText(row.description, width)}</Text>
        )}
        <Box height={1} />
        {row.detail.map((line, position) => (
          <Text key={`${row.key}:${position}`}>
            {truncateText(line, width)}
          </Text>
        ))}
      </Box>
    </OverlayFrame>
  );
}

export function TopicListOverlay({
  agentId,
  conversationId,
  view: initialView = "all",
  onClose,
  source,
}: {
  agentId: string;
  conversationId: string;
  /** The view the command names; Tab moves from here. */
  view?: TopicPanelView;
  onClose: () => void;
  /** Tests inject their data; the app reads the transcript and the index. */
  source?: TopicPanelSource;
}) {
  const [loaded] = useState<TopicPanelData>(() =>
    (source ?? backendTopicPanelSource(agentId, conversationId))(),
  );
  const [view, setView] = useState<TopicPanelView>(initialView);
  // The row whose detail is open. Held here, the one owner of "which view", so
  // Escape can mean detail-then-list-then-face, exactly like the hidden-sessions
  // browser.
  const [detail, setDetail] = useState<TopicPanelRow | null>(null);

  const rows =
    loaded.kind === "loaded" ? buildTopicPanelRows(view, loaded) : [];

  const terminalRows = useTerminalRows();
  const terminalWidth = useTerminalWidth();
  const listRows = Math.max(1, terminalRows - CHROME_ROWS);
  const footerWidth = Math.max(1, terminalWidth - 2);

  const items = rows.map((row) => ({ key: row.key, label: row.label }));

  // Assigned after the hook: the cycle handler is declared before `list` exists
  // (it is part of `list`'s own bindings), and it must reset the cursor of the
  // list that is on screen *now*, not the one captured in this render.
  const resetCursorRef = useRef<() => void>(() => {});

  const cycleView = (step: number): void => {
    const index = TOPIC_PANEL_VIEWS.indexOf(view);
    const next =
      TOPIC_PANEL_VIEWS[
        (index + step + TOPIC_PANEL_VIEWS.length) % TOPIC_PANEL_VIEWS.length
      ];
    if (next === undefined) return;
    setView(next);
    setDetail(null);
    resetCursorRef.current();
  };

  const list = useOverlayList({
    owner: "topic-panel",
    items,
    rows: listRows,
    // While a detail is open the list does not own the arrows or Enter; the
    // detail's own Enter/Escape take them (the `extra` table below).
    navigationEnabled: detail === null,
    onCancel: () => {
      if (detail !== null) {
        setDetail(null);
        return;
      }
      onClose();
    },
    onConfirm: (_key, index) => {
      const row = rows[index];
      if (row) setDetail(row);
    },
    extra: [
      {
        id: "topic-panel.tab",
        chords: [{ key: "tab" }],
        run: () => {
          cycleView(1);
          return "consumed";
        },
      },
      {
        id: "topic-panel.shift-tab",
        chords: [{ key: "tab", shift: true }],
        run: () => {
          cycleView(-1);
          return "consumed";
        },
      },
      {
        id: "topic-panel.quit",
        chords: [{ key: "q" }],
        run: () => {
          onClose();
          return "consumed";
        },
      },
      {
        id: "topic-panel.detail-back",
        chords: namedKeyChords("return"),
        run: () => {
          if (detail === null) return "declined";
          setDetail(null);
          return "consumed";
        },
      },
    ],
  });
  resetCursorRef.current = () => list.setCursor(0);

  if (loaded.kind === "unavailable") {
    return (
      <OverlayFrame command="/topic list" title="Topic markers">
        <Box flexDirection="column">
          <Text dimColor>
            {truncateText(TOPIC_COMMAND_LOCAL_ONLY, footerWidth)}
          </Text>
          <Box height={1} />
          <Text dimColor>esc close</Text>
        </Box>
      </OverlayFrame>
    );
  }

  if (detail !== null) {
    return (
      <TopicDetail
        row={detail}
        command={topicPanelCommand(view)}
        view={view}
        width={footerWidth}
      />
    );
  }

  const count = rows.length;
  const empty = topicPanelEmpty(view);
  const hint =
    count === 0
      ? "Tab switches view · Esc close"
      : `${topicPanelCount(view, count)} · Tab switch · ↑↓ scroll · PgUp/PgDn page · Enter detail · q close`;

  return (
    <OverlayFrame
      command={topicPanelCommand(view)}
      title={topicPanelTitle(view)}
      footer={
        <Box flexDirection="column">
          <Text dimColor>{truncateText(hint, footerWidth)}</Text>
          {topicPanelNotes(view).map((note) => (
            <Text key={note} dimColor>
              {truncateText(note, footerWidth)}
            </Text>
          ))}
        </Box>
      }
    >
      {count === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>{empty.message}</Text>
          <Text dimColor>{truncateText(empty.hint, footerWidth)}</Text>
        </Box>
      ) : (
        <OverlayListView
          items={items}
          cursor={list.cursor}
          rows={listRows}
          renderRow={(_item, index, isCursor) => {
            const row = rows[index];
            if (!row) return null;
            return (
              <TopicRow row={row} width={terminalWidth} isCursor={isCursor} />
            );
          }}
        />
      )}
    </OverlayFrame>
  );
}
