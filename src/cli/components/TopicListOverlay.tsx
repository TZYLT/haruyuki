import { Box } from "ink";
import { useState } from "react";
import { getBackend } from "@/backend";
import {
  queryTopicIndex,
  type TopicIndexEntry,
} from "@/backend/local/topic-index";
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import {
  buildTopicIndexRows,
  TOPIC_LIST_ALL_NOTES,
  type TopicIndexRow,
} from "@/cli/helpers/topic-list";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { colors } from "./colors";
import { Text } from "./Text";

/**
 * `/topic list --all` — the full-screen browser over this agent's topic markers
 * (requirement §5.11.10).
 *
 * It replaced a printed table, and the reasons are the ones the requirement
 * gives: the transcript form has to fit every marker, its time, its conversation
 * and its source into lines that then stay in the scrollback forever, and it can
 * only be read top to bottom. The panel windows the same rows, sorts them newest
 * first (the printed table is oldest first, which is the order a *table* reads
 * in), and closes with `q`.
 *
 * Everything is read once, on mount, from the per-agent index. The query is
 * synchronous, so the first frame is the list rather than a "loading" line; the
 * index's own self-heal (§5.11.4) is what makes a stale file safe to read.
 *
 * Three things are deliberate:
 *
 * - **One line per row.** A row is title · time · conversation · source, clipped
 *   with `truncateText`, so the window's height cannot depend on the data — a
 *   two-line row would move the footer, and the composer behind it, on scroll.
 * - **No row numbers.** The printed table numbers markers by position so a user
 *   can talk about them; here the list is newest first, so a `#1` would name a
 *   different marker than the table's `#1`. The rows carry no number at all, and
 *   the note about what numbers mean stays with the table (`topic-list.ts`).
 * - **The source is injectable.** The app passes nothing and gets the real index
 *   through the backend's own storage root — `getLocalStorageDir()` is the only
 *   root that is correct for a test or alternate-root backend (§2.3), and a
 *   backend without one is reported as local-only rather than read from the
 *   default root. Tests pass a fixture instead of writing a transcript.
 */

/** What the face has to show: rows, or the reason there are none to read. */
export type TopicIndexRows =
  | { kind: "rows"; entries: readonly TopicIndexEntry[] }
  | { kind: "unavailable" };

/** Where a topic face reads from. Called once per mount (list) or keyword (search). */
export type TopicIndexSource = () => TopicIndexRows;

/**
 * The app's source: this agent's index file, under the backend's storage root.
 *
 * `getLocalStorageDir()` is optional on `Backend` and absent on a non-local one;
 * falling back to `getLocalBackendStorageDir()` there would read the *real*
 * `~/.haruyuki/lc-local-backend` for a conversation that is not even local
 * (route §2.3, 《31》A1).
 */
export function backendTopicIndexSource(agentId: string): TopicIndexSource {
  return () => {
    const storageDir = getBackend().getLocalStorageDir?.();
    if (!storageDir) return { kind: "unavailable" };
    return { kind: "rows", entries: queryTopicIndex({ agentId, storageDir }) };
  };
}

/**
 * Chrome the list does not get to use: the frame's header (command, rule, blank,
 * title + its margin), the two indicator rows a windowed list always reserves,
 * and the footer's three lines plus their top margin.
 */
const CHROME_ROWS = 11;

const EMPTY_MESSAGE = "No topic markers in this agent's conversations yet.";
const EMPTY_HINT =
  "Mark one with /topic <title>, or let the agent call TopicMark when a topic ends.";

/** One marker, one line: title · time · conversation · source. */
function TopicRow({
  row,
  width,
  isCursor,
}: {
  row: TopicIndexRow;
  width: number;
  isCursor: boolean;
}) {
  const color = isCursor ? colors.selector.itemHighlighted : undefined;
  return (
    <Box flexDirection="row">
      <Text color={color}>{isCursor ? "> " : "  "}</Text>
      <Text bold={isCursor} color={color}>
        {truncateText(row.line, Math.max(1, width - 2))}
      </Text>
    </Box>
  );
}

export function TopicListOverlay({
  agentId,
  onClose,
  source,
}: {
  agentId: string;
  onClose: () => void;
  /** Tests inject their rows; the app reads the index. */
  source?: TopicIndexSource;
}) {
  // Read once per mount. A ref would re-query on every render, and the index
  // query is the one call here that touches the disk.
  const [loaded] = useState<TopicIndexRows>(() =>
    (source ?? backendTopicIndexSource(agentId))(),
  );
  const rows =
    loaded.kind === "rows" ? buildTopicIndexRows(loaded.entries) : [];

  const terminalRows = useTerminalRows();
  const terminalWidth = useTerminalWidth();
  const listRows = Math.max(1, terminalRows - CHROME_ROWS);
  const footerWidth = Math.max(1, terminalWidth - 2);

  const items: OverlayListItem[] = rows.map((row) => ({
    key: row.key,
    label: row.title,
  }));

  const list = useOverlayList({
    owner: "topic-list",
    items,
    rows: listRows,
    onCancel: onClose,
    extra: [
      {
        id: "topic-list.quit",
        chords: [{ key: "q" }],
        run: () => {
          onClose();
          return "consumed";
        },
      },
    ],
  });

  if (loaded.kind === "unavailable") {
    return (
      <OverlayFrame command="/topic list --all" title="Topic markers">
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

  const count = rows.length;
  const hint =
    count === 0
      ? "esc close"
      : `${count} marker${count === 1 ? "" : "s"} · ↑↓ scroll · PgUp/PgDn page · q close`;

  return (
    <OverlayFrame
      command="/topic list --all"
      title="Topic markers (newest first)"
      footer={
        <Box flexDirection="column">
          <Text dimColor>{truncateText(hint, footerWidth)}</Text>
          {TOPIC_LIST_ALL_NOTES.map((note) => (
            <Text key={note} dimColor>
              {truncateText(note, footerWidth)}
            </Text>
          ))}
        </Box>
      }
    >
      {count === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>{EMPTY_MESSAGE}</Text>
          <Text dimColor>{truncateText(EMPTY_HINT, footerWidth)}</Text>
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
