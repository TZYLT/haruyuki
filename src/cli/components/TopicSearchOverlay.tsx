import { Box } from "ink";
import { useMemo, useRef, useState } from "react";
import { getBackend } from "@/backend";
import {
  queryTopicIndex,
  type TopicIndexEntry,
} from "@/backend/local/topic-index";
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import { namedKeyChords } from "@/cli/helpers/input-keys";
import {
  buildTopicIndexRows,
  type TopicIndexRow,
} from "@/cli/helpers/topic-list";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { Text } from "./Text";

/**
 * `/topic search <kw>` — keyword search over this agent's topic markers
 * (requirement §5.11.9).
 *
 * The shape is `/search`'s: a field, a result list, Enter to expand a hit. What
 * it searches is different, and so is the corpus: the per-agent topic index
 * (§5.11), never the message store — the point of the index is that "which
 * conversation was that in?" is answerable without reading any transcript.
 *
 * **Searching never writes a marker.** The command used to fall through the
 * registry's `/topic` branch, which treats its first word as a title, so typing
 * `/topic search deploy` recorded a marker called "search" (route C-22). The fix
 * is at the dispatch (`registry.ts` plus the submit-layer branch), and this face
 * only reads: `queryTopicIndex` is a query, and the one write it can make is the
 * index's own self-heal (§5.11.4), which never touches the transcript.
 *
 * The source is injectable for the same reason as the list's: a fixture is a
 * test's rows, while the app passes nothing and reads the backend's own storage
 * root (`getLocalStorageDir()`, route §2.3).
 */

/** What the face has to show: rows, or the reason there are none to read. */
export type TopicIndexRows =
  | { kind: "rows"; entries: readonly TopicIndexEntry[] }
  | { kind: "unavailable" };

/** Where a search reads from: one keyword, one answer. */
export type TopicSearchSource = (keyword: string) => TopicIndexRows;

export function backendTopicSearchSource(agentId: string): TopicSearchSource {
  return (keyword: string) => {
    const storageDir = getBackend().getLocalStorageDir?.();
    if (!storageDir) return { kind: "unavailable" };
    const trimmed = keyword.trim();
    return {
      kind: "rows",
      entries: queryTopicIndex({
        agentId,
        storageDir,
        ...(trimmed.length > 0 ? { keyword: trimmed } : {}),
      }),
    };
  };
}

/** Rows on screen at once, which is also the PageUp/PageDown step. */
const VISIBLE_ITEMS = 8;

/** One hit, one line: title · time · conversation · source. */
function ResultRow({
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

export function TopicSearchOverlay({
  agentId,
  onClose,
  initialQuery,
  source,
}: {
  agentId: string;
  onClose: () => void;
  /** The keyword `/topic search <kw>` was invoked with, if any. */
  initialQuery?: string;
  /** Tests inject their rows; the app reads the index. */
  source?: TopicSearchSource;
}) {
  // The source must not be re-created per render: the app passes nothing and the
  // default is built here, while a test passes a stable fixture function.
  const sourceRef = useRef<TopicSearchSource>(
    source ?? backendTopicSearchSource(agentId),
  );

  const [input, setInput] = useState(initialQuery ?? "");
  const [active, setActive] = useState((initialQuery ?? "").trim());
  const [expanded, setExpanded] = useState<TopicIndexRow | null>(null);

  // Re-query when the committed keyword changes, not on every keystroke:
  // `active` is what Enter commits, and a ref-held source keeps this a function
  // of the keyword alone.
  const loaded = useMemo<TopicIndexRows>(
    () => sourceRef.current(active),
    [active],
  );
  const rows = useMemo(
    () => (loaded.kind === "rows" ? buildTopicIndexRows(loaded.entries) : []),
    [loaded],
  );

  const terminalWidth = useTerminalWidth();
  const footerWidth = Math.max(1, terminalWidth - 2);

  const items = useMemo<OverlayListItem[]>(
    () => rows.map((row) => ({ key: row.key, label: row.title })),
    [rows],
  );

  const cursorRef = useRef(0);
  const list = useOverlayList({
    owner: "topic-search",
    items,
    rows: VISIBLE_ITEMS,
    anchor: "center",
    // The field beside the list is a live editor: `j`/`k` are search text. `q`
    // is too — this face is closed with Escape, like `/search`.
    vimKeys: false,
    navigationEnabled: expanded === null,
    onCancel: onClose,
    extra: [
      {
        id: "topic-search.escape",
        chords: namedKeyChords("escape"),
        run: () => {
          if (expanded) {
            setExpanded(null);
            return "consumed";
          }
          if (input || active) {
            setInput("");
            setActive("");
            return "consumed";
          }
          // Nothing to clear: the list's own cancel owns Escape.
          return "declined";
        },
      },
      {
        id: "topic-search.enter",
        chords: namedKeyChords("return"),
        run: () => {
          if (expanded) return "consumed";
          // A typed keyword that has not been committed yet is the search.
          if (input.trim() && input.trim() !== active) {
            setActive(input.trim());
            return "consumed";
          }
          const row = rows[cursorRef.current];
          if (row) setExpanded(row);
          return "consumed";
        },
      },
    ],
  });
  cursorRef.current = list.cursor;

  if (expanded) {
    const meta = `${expanded.when} · ${expanded.conversationId} · ${expanded.createdBy}${
      expanded.evicted ? " · trimmed" : ""
    }`;
    return (
      <OverlayFrame command="/topic search">
        <Box flexDirection="column" paddingX={1}>
          <Box marginBottom={1}>
            <Text bold color={colors.selector.title}>
              {expanded.title}
            </Text>
          </Box>
          <Text dimColor>{truncateText(meta, footerWidth)}</Text>
          <Box height={1} />
          <Text>
            {expanded.section ??
              "No section was recorded for this topic. A section is written when a compaction folds the topic in."}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>Esc back to results</Text>
          </Box>
        </Box>
      </OverlayFrame>
    );
  }

  if (loaded.kind === "unavailable") {
    return (
      <OverlayFrame command="/topic search" title="Search this agent's topics">
        <Box flexDirection="column">
          <Text dimColor>
            {truncateText(TOPIC_COMMAND_LOCAL_ONLY, footerWidth)}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>esc close</Text>
          </Box>
        </Box>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      command="/topic search"
      title="Search this agent's topics"
      footer={
        <Box flexDirection="column">
          {rows.length > 0 && (
            <Text dimColor>
              {list.cursor + 1}/{rows.length} results
            </Text>
          )}
          <Text dimColor>
            {truncateText(
              "Enter search · ↑↓ navigate · PgUp/PgDn page · Esc clear · Esc again closes",
              footerWidth,
            )}
          </Text>
        </Box>
      }
    >
      <Box flexDirection="row" marginBottom={1}>
        <Text dimColor>Keyword: </Text>
        {/* No `onSubmit` on purpose: the list's own Enter binding owns the key,
            so it can mean "search" and "expand the hit under the cursor"
            depending on the state. An input that submitted as well would consume
            Enter before the expansion could see it. */}
        <PasteAwareTextInput
          value={input}
          onChange={setInput}
          placeholder="(type a keyword, then Enter)"
        />
        {input.trim() && input.trim() !== active ? (
          <Text dimColor> (press Enter to search)</Text>
        ) : null}
      </Box>

      {rows.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>
            {active
              ? `No topic markers match "${active}".`
              : "No topic markers indexed for this agent yet."}
          </Text>
          <Text dimColor>
            {active
              ? "Esc clears the keyword; an empty field lists every indexed topic."
              : "Mark one with /topic <title>, then search for it here."}
          </Text>
        </Box>
      ) : (
        <OverlayListView
          items={items}
          cursor={list.cursor}
          rows={VISIBLE_ITEMS}
          anchor="center"
          indicators={false}
          renderRow={(_item, index, isCursor) => {
            const row = rows[index];
            if (!row) return null;
            return (
              <ResultRow row={row} width={terminalWidth} isCursor={isCursor} />
            );
          }}
        />
      )}
    </OverlayFrame>
  );
}
