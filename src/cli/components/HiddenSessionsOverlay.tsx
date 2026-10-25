import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { Box } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Backend, getBackend } from "@/backend";
import type { ConversationMessageListBody } from "@/backend/backend";
import { colors } from "@/cli/components/colors";
import { buildConversationTitleMessages } from "@/cli/helpers/conversation-title";
import { namedKeyChords } from "@/cli/helpers/input-keys";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import type { PageSlice } from "@/cli/overlay/pagination";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { usePagedList } from "@/cli/overlay/use-pagination";
import {
  type HiddenConversationSummary,
  readConversationProvenance,
  toHiddenConversationSummary,
} from "@/types/conversation-provenance";
import { HiddenSessionDeleteConfirm } from "./HiddenSessionDeleteConfirm";
import { HiddenSessionDetail } from "./HiddenSessionDetail";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { Text } from "./Text";

/**
 * `/maintenance sessions` — the read-only list of hidden conversations
 * (`docs/44-1` §5.1–§5.2).
 *
 * This face is the `/messages history` skeleton with a page source: `usePagedList`
 * owns the fetch, the loading/error machine and page identity, `useOverlayList`
 * owns the cursor, the keys and the window, `OverlayFrame`/`OverlayListView` draw
 * it. Nothing here invents a second list or key pipeline, and all state — cursor,
 * query, agent scope, the titles fetched for summary-less rows — stays in this
 * leaf (`src/cli/AGENTS.md`): no `AppCoordinator` state, no timer, no `<Static>`.
 *
 * What the list reads is `hidden_only: true` on the backend, never a client-side
 * filter over visible conversations (§6.4) — a row that is not hidden must not
 * even be fetched. `context_message_count` is the in-context size, not the log's
 * length (§5.2.4), so the list never pages a transcript for a count.
 *
 * The list, its search and its agent scope, plus the two actions the record
 * supports: `Enter` opens the read-only detail and `d` asks before deleting. The
 * detail and the confirmation own the keys while they are up; this file only
 * decides which of the three views is on screen.
 *
 * The one read beyond the page is the title fallback (§5.2.3): a row with no
 * summary has no title, and the requirement's fallback is the conversation's
 * first user message. It is fetched once per row (one row, `limit: 1`), cached for
 * the mount, and only for rows that already landed on a page; a row whose read
 * fails shows `(untitled)` rather than pushing the list back into loading.
 */

/** Rows the backend is asked for at a time (§5.2.7). */
const PAGE_SIZE = 20;

/** A row is three lines plus the blank line that separates it from the next. */
const ROW_LINES = 4;

/** Header, search line, footer and the list's own indicator rows, reserved. */
const CHROME_ROWS = 11;

const UNTITLED = "(untitled)";

/** The standing privacy line (§6.3), not a per-row note. */
const PRIVACY_LINE =
  "Background sessions can contain reasoning and tool output; read-only, never in the normal lists.";

type ListableConversation = Conversation & {
  hidden?: boolean;
  context_message_count?: number;
};

type MessagePage = Message[] | { getPaginatedItems(): Message[] };

function pageItems(page: MessagePage): Message[] {
  return Array.isArray(page) ? page : page.getPaginatedItems();
}

/**
 * Project a list row onto what this face renders.
 *
 * The local backend already annotates each item, but the `Backend` interface
 * still types `listConversations` as the SDK's `Conversation[]` and another
 * backend need not fill the extras in — so the row goes through the same shared
 * projector the backend and the listener use.
 */
function toHiddenRow(
  conversation: ListableConversation,
): HiddenConversationSummary {
  return toHiddenConversationSummary(conversation);
}

/** `last_message_at` first, then the other two timestamps (§5.2.3/§5.2.5). */
function lastActivityAt(
  conversation: HiddenConversationSummary,
): string | null {
  return (
    conversation.last_message_at ??
    conversation.updated_at ??
    conversation.created_at ??
    null
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** A timestamp in the terms a log reads in. */
function relativeTime(value: string | null): string {
  if (!value) return "time unknown";
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return "time unknown";
  const elapsed = Date.now() - at;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d ago`;
  return `${Math.floor(elapsed / WEEK)}w ago`;
}

/** The agent a row belongs to, short enough to share a line with origin and ctx. */
function agentLabel(agentId: string | null | undefined): string {
  if (!agentId) return "agent-free";
  return agentId.length > 12 ? `${agentId.slice(0, 11)}~` : agentId;
}

/**
 * The conversation's first user message, which is what a summary-less row shows.
 *
 * `limit: 1` and `order: "asc"` on the log (`include_out_of_context`), so an
 * inherited prefix that has fallen out of the in-context list still answers.
 * `buildConversationTitleMessages` is the owner of "how a message becomes title
 * text" — system reminders stripped, images marked — so the extraction is not
 * copied here.
 */
async function firstUserMessage(
  backend: Backend,
  row: HiddenConversationSummary,
): Promise<string | null> {
  try {
    const body: ConversationMessageListBody & {
      include_out_of_context: true;
    } = {
      agent_id: row.agent_id,
      limit: 1,
      order: "asc",
      include_return_message_types: ["user_message"],
      include_out_of_context: true,
    };
    const page = await backend.listConversationMessages(row.id, body);
    const [title] = buildConversationTitleMessages(
      pageItems(page as MessagePage),
    );
    return title?.role === "user" ? title.content : null;
  } catch {
    // A row we cannot title is still a row: `(untitled)` is the documented
    // fallback, and a failed read here must not take the list down with it.
    return null;
  }
}

/** One conversation, three lines: title, `origin · agent · ctx N`, when. */
function SessionRow({
  row,
  title,
  isCursor,
  width,
}: {
  row: HiddenConversationSummary;
  title: string;
  isCursor: boolean;
  width: number;
}) {
  const provenance = readConversationProvenance(row);
  const line = Math.max(1, width - 2);
  const titleColor = isCursor ? colors.selector.itemHighlighted : undefined;
  const meta = truncateText(
    `${provenance.origin} · ${agentLabel(row.agent_id)} · ctx ${row.context_message_count}`,
    line,
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Text color={titleColor}>{isCursor ? "> " : "  "}</Text>
        <Text bold={isCursor} color={titleColor}>
          {truncateText(title, line)}
        </Text>
      </Box>
      <Box flexDirection="row" marginLeft={2}>
        <Text dimColor>{meta}</Text>
      </Box>
      <Box flexDirection="row" marginLeft={2}>
        <Text dimColor>{relativeTime(lastActivityAt(row))}</Text>
      </Box>
    </Box>
  );
}

export function HiddenSessionsOverlay({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const backendRef = useRef<Backend | null>(null);

  // The fetch reads these through a ref, the way the toolkit's key tables read
  // the render that is on screen: `fetchPage` keeps one identity across renders
  // while the filters it applies are always the current ones.
  const [query, setQuery] = useState("");
  const [allAgents, setAllAgents] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  // The row whose detail is open. Held here, the one owner of "which view", so
  // the detail needs no second list state and Escape can mean list-then-face.
  const [detail, setDetail] = useState<HiddenConversationSummary | null>(null);
  // The row the confirmation is about; non-null means the face is the question.
  const [pendingDelete, setPendingDelete] =
    useState<HiddenConversationSummary | null>(null);
  const filtersRef = useRef({ query: "", allAgents: false });
  filtersRef.current = { query, allAgents };

  // Titles for summary-less rows, keyed by conversation id. The map is the cache
  // (a re-render must not re-read) and the state is the paint.
  const titleCacheRef = useRef(new Map<string, string>());
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const fetchPage = useCallback(
    async (
      after: string | null,
    ): Promise<PageSlice<HiddenConversationSummary>> => {
      const backend = backendRef.current ?? getBackend();
      backendRef.current = backend;
      const active = filtersRef.current;
      const listed = await backend.listConversations({
        ...(active.allAgents ? {} : { agent_id: agentId }),
        hidden_only: true,
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
        ...(active.query ? { summary_search: active.query } : {}),
      });
      return {
        items: (listed as ListableConversation[]).map(toHiddenRow),
      };
    },
    [agentId],
  );

  const page = usePagedList<HiddenConversationSummary>({
    keyOf: (row) => row.id,
    pageSize: PAGE_SIZE,
    fetchPage,
  });

  const rows = page.items;
  // `idle` counts as loading: the face asks for its first page on mount, so the
  // first paint is the loading line rather than a flash of the empty state.
  const isLoading = page.status === "idle" || page.status === "loading";
  const loadingMore = page.status === "loading-more";

  const { loadFirst } = page;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `query` and `allAgents` are the reload triggers, not inputs to this body — `fetchPage` reads them through `filtersRef` so its identity (and the page machine's registration) survives a keystroke.
  useEffect(() => {
    void loadFirst();
  }, [loadFirst, query, allAgents]);

  // Fill in the title fallback for the page's summary-less rows, once each.
  useEffect(() => {
    const untitled = rows.filter(
      (row) => !row.summary?.trim() && !titleCacheRef.current.has(row.id),
    );
    if (untitled.length === 0) return;

    let cancelled = false;
    void (async () => {
      const backend = backendRef.current ?? getBackend();
      backendRef.current = backend;
      const resolved = await Promise.all(
        untitled.map(async (row) => {
          const first = await firstUserMessage(backend, row);
          return [
            row.id,
            first ? first.replace(/\s+/g, " ").trim() : UNTITLED,
          ] as const;
        }),
      );
      if (cancelled) return;
      for (const [id, title] of resolved) {
        titleCacheRef.current.set(id, title);
      }
      setTitles(new Map(titleCacheRef.current));
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const titleFor = useCallback(
    (row: HiddenConversationSummary): string => {
      const summary = row.summary?.trim();
      if (summary) return summary;
      return titles.get(row.id) ?? UNTITLED;
    },
    [titles],
  );

  const listItems = useMemo<OverlayListItem[]>(
    () => rows.map((row) => ({ key: row.id, label: titleFor(row) })),
    [rows, titleFor],
  );

  const terminalRows = useTerminalRows();
  const terminalWidth = useTerminalWidth();
  const listRows = Math.max(
    1,
    Math.floor((terminalRows - CHROME_ROWS) / ROW_LINES),
  );

  const list = useOverlayList({
    owner: "hidden-sessions",
    items: listItems,
    rows: listRows,
    // `j`/`k` are search text while the query field is focused — the case
    // `list-bindings.ts` documents. The arrows keep working either way. Home/End
    // are the caret's while that field has focus, and the list's otherwise; that
    // claim has to be conditional rather than merely declined, because the editor
    // re-registers when it remounts (`list-bindings.ts`'s `edgeKeys`).
    vimKeys: !searchMode,
    edgeKeys: !searchMode,
    // While the detail or the confirmation is open the list must not answer keys:
    // Escape there means "back"/"cancel", not "close the face", and an Enter
    // would re-open a row. `navigationEnabled` gates movement/confirm, but the
    // list's cancel binding is unconditional, so it is dropped explicitly.
    navigationEnabled: detail === null && pendingDelete === null,
    onCancel: detail === null && pendingDelete === null ? onClose : undefined,
    // Enter belongs to the search field while it is focused: the list must not
    // claim it, or the field never sees the key that leaves it.
    ...(searchMode
      ? {}
      : {
          onConfirm: (key: string) => {
            const row = rows.find((candidate) => candidate.id === key);
            if (row) setDetail(row);
          },
        }),
    extra: [
      {
        id: "hidden-sessions.search",
        chords: [{ key: "/" }],
        run: () => {
          if (searchMode) return "declined";
          setSearchMode(true);
          return "consumed";
        },
      },
      {
        id: "hidden-sessions.scope",
        chords: [{ key: "a" }],
        run: () => {
          if (searchMode) return "declined";
          setAllAgents((current) => !current);
          return "consumed";
        },
      },
      {
        id: "hidden-sessions.delete",
        chords: [{ key: "d" }],
        run: () => {
          if (searchMode) return "declined";
          const row = rows[list.cursor];
          if (!row) return "declined";
          setPendingDelete(row);
          return "consumed";
        },
      },
      {
        id: "hidden-sessions.escape",
        chords: namedKeyChords("escape"),
        run: () => {
          // Escape leaves the search first and closes the face second; with the
          // field unfocused the list's own cancel owns it.
          if (!searchMode) return "declined";
          setSearchMode(false);
          if (query) setQuery("");
          return "consumed";
        },
      },
    ],
  });

  // Ask for the next page once the cursor is within a row of the end, which is
  // what "scroll to the bottom" means on a windowed list. The page machine ends
  // the sequence on a short page, so no bookkeeping is needed here — and search
  // pages the same way (§5.2.7), because the cursor is the last matching row's id.
  const nearEnd = list.cursor >= rows.length - 2;
  useEffect(() => {
    if (isLoading || !nearEnd || !page.hasMore) return;
    void page.loadMore();
  }, [isLoading, nearEnd, page.hasMore, page.loadMore]);

  const scopeHint = allAgents ? "a this agent only" : "a all agents";
  const hintLine = searchMode
    ? "type to filter · enter leaves the field · esc clears · ↑↓ still scroll"
    : `↑↓ scroll · / search · ${scopeHint} · esc close`;
  // Both footer lines are clipped to one line each: a wrapped footer changes the
  // frame's height as the terminal narrows, which would push the rows the window
  // reserved out of the frame (the height budget below counts two footer lines).
  const footerWidth = Math.max(1, terminalWidth - 2);

  const emptyMessage = query
    ? `No hidden sessions match "${query}".`
    : allAgents
      ? "No hidden sessions yet. Background sessions appear after a reflection or a subagent runs."
      : "No hidden sessions for this agent.";
  const emptyHint = query
    ? "esc clears the search."
    : allAgents
      ? undefined
      : "Press a to look across all agents.";

  if (pendingDelete) {
    return (
      <HiddenSessionDeleteConfirm
        session={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onDeleted={() => {
          setPendingDelete(null);
          // The row's title cache entry must die with it, or the next page that
          // reuses the id would show the deleted session's title.
          titleCacheRef.current.delete(pendingDelete.id);
          void loadFirst();
        }}
      />
    );
  }

  if (detail) {
    return (
      <HiddenSessionDetail
        session={detail}
        onBack={() => setDetail(null)}
        onDeleted={() => {
          setDetail(null);
          titleCacheRef.current.delete(detail.id);
          void loadFirst();
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <OverlayFrame
      command="/hidden-sessions"
      title="Hidden sessions"
      footer={
        <Box flexDirection="column">
          <Text dimColor>{truncateText(hintLine, footerWidth)}</Text>
          <Text dimColor>{truncateText(PRIVACY_LINE, footerWidth)}</Text>
        </Box>
      }
    >
      <Box flexDirection="row" marginBottom={1}>
        <Text dimColor>Search: </Text>
        <PasteAwareTextInput
          value={query}
          focus={searchMode}
          onChange={(value) => {
            if (value === query) return;
            setQuery(value);
            list.setCursor(0);
          }}
          onSubmit={() => setSearchMode(false)}
          placeholder={searchMode ? "type to filter" : "press / to search"}
        />
      </Box>

      {page.error && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red">{`Error reading hidden sessions: ${page.error}`}</Text>
          <Text dimColor>esc closes the list.</Text>
        </Box>
      )}

      {/* The loading line is for the first page only: a filter refetch keeps the
          rows it already has, so it does not grow the frame by a line per
          keystroke. */}
      {isLoading && rows.length === 0 && (
        <Box>
          <Text dimColor>Loading hidden sessions...</Text>
        </Box>
      )}

      {!isLoading && !page.error && rows.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>{emptyMessage}</Text>
          {emptyHint !== undefined && <Text dimColor>{emptyHint}</Text>}
        </Box>
      )}

      {rows.length > 0 && (
        <OverlayListView
          items={listItems}
          cursor={list.cursor}
          rows={listRows}
          renderRow={(_item, index, isCursor) => {
            const row = rows[index];
            if (!row) return null;
            return (
              <SessionRow
                row={row}
                title={titleFor(row)}
                isCursor={isCursor}
                width={terminalWidth}
              />
            );
          }}
        />
      )}

      {loadingMore && (
        <Box>
          <Text dimColor>Loading more...</Text>
        </Box>
      )}
    </OverlayFrame>
  );
}
