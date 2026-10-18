import type {
  Message,
  MessageType,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { Box } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Backend, getBackend } from "@/backend";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { usePagedList } from "@/cli/overlay/use-pagination";
import { SYSTEM_ALERT_OPEN, SYSTEM_REMINDER_OPEN } from "@/constants";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { Text } from "./Text";

interface ConversationSelectorProps {
  agentId: string;
  agentName?: string;
  currentConversationId: string;
  onSelect: (
    conversationId: string,
    context?: {
      summary?: string;
      messageCount: number;
    },
  ) => void;
  onNewConversation?: () => void;
  onCancel: () => void;
}

// Preview line with role prefix
interface PreviewLine {
  role: "user" | "assistant";
  text: string;
}

// Enriched conversation with message data
interface EnrichedConversation {
  conversation: Conversation;
  previewLines: PreviewLine[] | null; // null = not yet loaded
  searchPreview?: string;
  lastActiveAt: string | null; // Falls back to updated_at until enriched
  messageCount: number; // -1 = unknown/loading
  enriched: boolean; // Whether message data has been fetched
}

const MAX_DISPLAY_PAGE_SIZE = 5;
const FETCH_PAGE_SIZE = 20;
const ENRICH_MESSAGE_LIMIT = 20; // Same as original fetch limit

const RESUME_PREVIEW_MESSAGE_TYPES: MessageType[] = [
  "user_message",
  "assistant_message",
];

export function buildConversationSelectorHints(): string {
  return "Enter select · ↑↓ navigate · Esc clear/cancel";
}

function paginatedItems<T>(value: T[] | { getPaginatedItems(): T[] }): T[] {
  return Array.isArray(value) ? value : value.getPaginatedItems();
}

/**
 * Format a relative time string from a date
 */
function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60)
    return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  if (diffHours < 24)
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return `${diffWeeks} week${diffWeeks === 1 ? "" : "s"} ago`;
}

export function formatConversationTimestampText(params: {
  lastActiveAt: string | null | undefined;
  createdAt: string | null | undefined;
}): string {
  const activeTime = formatRelativeTime(params.lastActiveAt);
  const createdAt = params.createdAt;

  if (!createdAt) {
    return `Active ${activeTime}`;
  }

  const createdDate = new Date(createdAt);
  const activeDate = params.lastActiveAt ? new Date(params.lastActiveAt) : null;

  // Created-after-active is not a real timeline. This can happen for the
  // synthetic "default" row if we invent a creation time at selector render.
  if (
    Number.isNaN(createdDate.getTime()) ||
    (activeDate &&
      !Number.isNaN(activeDate.getTime()) &&
      createdDate.getTime() > activeDate.getTime() + 60_000)
  ) {
    return `Active ${activeTime}`;
  }

  return `Active ${activeTime} · Created ${formatRelativeTime(createdAt)}`;
}

function getMessageTimestamp(message: Message | undefined): string | null {
  if (!message) return null;
  return (
    (message as Message & { date?: string; created_at?: string }).date ??
    (message as Message & { date?: string; created_at?: string }).created_at ??
    null
  );
}

/**
 * Extract preview text from a user message
 * Content can be a string or an array of content parts like [{ type: "text", text: "..." }]
 */
function extractUserMessagePreview(message: Message): string | null {
  // User messages have a 'content' field
  const content = (
    message as Message & {
      content?: string | Array<{ type?: string; text?: string }>;
    }
  ).content;

  if (!content) return null;

  let textToShow: string | null = null;

  if (typeof content === "string") {
    textToShow = content;
  } else if (Array.isArray(content)) {
    // Find the last text part that isn't a system-reminder
    // (system-reminders are auto-injected context, not user text)
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i];
      if (part?.type === "text" && part.text) {
        // Skip system-reminder blocks
        if (
          part.text.startsWith(SYSTEM_REMINDER_OPEN) ||
          part.text.startsWith(SYSTEM_ALERT_OPEN)
        ) {
          continue;
        }
        textToShow = part.text;
        break;
      }
    }
  }

  if (!textToShow) return null;

  // Strip newlines and collapse whitespace
  textToShow = textToShow.replace(/\s+/g, " ").trim();

  // Truncate to a reasonable preview length
  const maxLen = 60;
  if (textToShow.length > maxLen) {
    return `${textToShow.slice(0, maxLen - 3)}...`;
  }
  return textToShow;
}

/**
 * Extract preview text from an assistant message
 * Content can be a string or array of content parts (text, images, etc.)
 */
function extractAssistantMessagePreview(message: Message): string | null {
  // Assistant messages have content field directly on message
  const content = (
    message as Message & {
      content?: string | Array<{ type?: string; text?: string }>;
    }
  ).content;

  if (!content) return null;

  let textToShow: string | null = null;

  if (typeof content === "string") {
    textToShow = content.trim();
  } else if (Array.isArray(content)) {
    // Find the first text part
    for (const part of content) {
      if (part?.type === "text" && part.text) {
        textToShow = part.text.trim();
        break;
      }
    }
  }

  if (!textToShow) return null;

  // Strip newlines and collapse whitespace
  textToShow = textToShow.replace(/\s+/g, " ").trim();

  // Truncate to a reasonable preview length
  const maxLen = 60;
  if (textToShow.length > maxLen) {
    return `${textToShow.slice(0, maxLen - 3)}...`;
  }
  return textToShow;
}

/**
 * Get preview lines and stats from messages
 */
function getMessageStats(messages: Message[]): {
  previewLines: PreviewLine[];
  lastActiveAt: string | null;
  messageCount: number;
} {
  if (messages.length === 0) {
    return { previewLines: [], lastActiveAt: null, messageCount: 0 };
  }

  // Find last 3 user/assistant messages with actual content (searching from end)
  const previewLines: PreviewLine[] = [];
  for (let i = messages.length - 1; i >= 0 && previewLines.length < 3; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.message_type === "user_message") {
      const text = extractUserMessagePreview(msg);
      if (text) {
        previewLines.unshift({ role: "user", text });
      }
    } else if (msg.message_type === "assistant_message") {
      const text = extractAssistantMessagePreview(msg);
      if (text) {
        previewLines.unshift({ role: "assistant", text });
      }
    }
  }

  // Last activity is the timestamp of the last message
  const lastMessage = messages[messages.length - 1];
  const lastActiveAt = getMessageTimestamp(lastMessage);

  return { previewLines, lastActiveAt, messageCount: messages.length };
}

export function buildDefaultConversationEntry(
  agentId: string,
  stats: {
    previewLines: PreviewLine[];
    lastActiveAt: string | null;
    messageCount: number;
  },
  createdAt: string | null = null,
): EnrichedConversation {
  return {
    conversation: {
      id: "default",
      agent_id: agentId,
      created_at: createdAt,
      updated_at: stats.lastActiveAt,
    } as Conversation,
    previewLines: stats.previewLines,
    lastActiveAt: stats.lastActiveAt,
    messageCount: stats.messageCount,
    enriched: true,
  };
}

export function ConversationSelector({
  agentId,
  agentName,
  currentConversationId,
  onSelect,
  onCancel,
}: ConversationSelectorProps) {
  const backendRef = useRef<Backend | null>(null);
  const selectorBackend = useCallback(() => {
    const backend = backendRef.current ?? getBackend();
    backendRef.current = backend;
    return backend;
  }, []);

  // The list itself is the toolkit's now: `usePagedList` owns the cursor, the
  // loading/error machine and the identity de-duplication a page needs, and
  // `use-overlay-list` owns the cursor, the keys and the window. What this face
  // still owns is what a conversation *is* — the progressive enrichment below,
  // the two-source search merge, and the row markup.
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState<
    EnrichedConversation[] | null
  >(null);
  const [searching, setSearching] = useState(false);
  const [, setEnriching] = useState(false);

  // Fetch one page of conversations, plus — for the first page only — the
  // agent's `default` conversation, which sits above the page's own rows and is
  // not part of it (it is not a cursor for page two).
  const fetchPage = useCallback(
    async (after: string | null) => {
      const backend = selectorBackend();

      const conversationListPromise = backend.listConversations({
        agent_id: agentId,
        limit: FETCH_PAGE_SIZE,
        ...(after && { after }),
        order: "desc",
        order_by: "last_run_completion",
      });

      // Fetch default conversation in parallel (not sequentially before)
      const defaultPromise: Promise<EnrichedConversation | null> = !after
        ? Promise.all([
            backend.listAgentMessages(agentId, {
              conversation_id: "default",
              limit: ENRICH_MESSAGE_LIMIT,
              order: "desc",
              include_return_message_types: RESUME_PREVIEW_MESSAGE_TYPES,
            }),
            backend.listAgentMessages(agentId, {
              conversation_id: "default",
              limit: 1,
              order: "asc",
            }),
          ])
            .then(([msgs, firstMsgs]) => {
              const items = paginatedItems(msgs);
              if (items.length === 0) return null;
              const firstMessage = paginatedItems(firstMsgs)[0];
              const stats = getMessageStats([...items].reverse());
              return buildDefaultConversationEntry(
                agentId,
                stats,
                getMessageTimestamp(firstMessage),
              );
            })
            .catch(() => null)
        : Promise.resolve(null);

      const [result, defaultConversation] = await Promise.all([
        conversationListPromise,
        defaultPromise,
      ]);

      // Build unenriched conversation list using data already on the object.
      // Empties are not filtered yet: only enrichment can confirm a count.
      const items: EnrichedConversation[] = result.map((conv) => ({
        conversation: conv,
        previewLines: null, // Not loaded yet
        lastActiveAt: conv.updated_at ?? conv.created_at ?? null,
        messageCount: -1, // Unknown until enriched
        enriched: false,
      }));

      return {
        items,
        prefix: defaultConversation ? [defaultConversation] : [],
      };
    },
    [agentId, selectorBackend],
  );

  const page = usePagedList<EnrichedConversation>({
    keyOf: (entry) => entry.conversation.id,
    pageSize: FETCH_PAGE_SIZE,
    fetchPage,
  });
  const { setItems } = page;
  // `idle` counts as loading: this face asks for its first page on mount, so the
  // first paint has to be the loading line rather than the empty state.
  const isLoading = page.status === "idle" || page.status === "loading";
  const loadingMore = page.status === "loading-more";
  const error = page.error;

  // Enrich a single conversation with message data, updating state in-place
  const enrichConversation = useCallback(
    async (backend: Backend, convId: string) => {
      try {
        const messages = await backend.listConversationMessages(convId, {
          limit: ENRICH_MESSAGE_LIMIT,
          order: "desc",
          include_return_message_types: RESUME_PREVIEW_MESSAGE_TYPES,
          agent_id: agentId,
        });
        const chronological = [...paginatedItems(messages)].reverse();
        const stats = getMessageStats(chronological);
        setItems((prev) =>
          prev.map((c) =>
            c.conversation.id === convId
              ? {
                  ...c,
                  previewLines: stats.previewLines,
                  lastActiveAt: stats.lastActiveAt || c.lastActiveAt,
                  messageCount: stats.messageCount,
                  enriched: true,
                }
              : c,
          ),
        );
        setSearchResults(
          (prev) =>
            prev?.map((c) =>
              c.conversation.id === convId
                ? {
                    ...c,
                    previewLines: stats.previewLines,
                    lastActiveAt: stats.lastActiveAt || c.lastActiveAt,
                    messageCount: stats.messageCount,
                    enriched: true,
                  }
                : c,
            ) ?? null,
        );
        return stats.messageCount;
      } catch {
        // Mark as enriched even on error so we don't retry
        setItems((prev) =>
          prev.map((c) =>
            c.conversation.id === convId
              ? { ...c, previewLines: [], enriched: true }
              : c,
          ),
        );
        setSearchResults(
          (prev) =>
            prev?.map((c) =>
              c.conversation.id === convId
                ? { ...c, previewLines: [], enriched: true }
                : c,
            ) ?? null,
        );
        return -1;
      }
    },
    [agentId, setItems],
  );

  /**
   * Phase 2: enrich a page's rows — the first few in parallel, the rest one by
   * one — and drop the ones that turn out to hold no messages.
   *
   * It runs after the page has landed rather than inside the fetch, because the
   * rows it edits are the page hook's state: an enrichment that resolved before
   * the page was committed would have nothing to update.
   */
  const enrichLoaded = useCallback(
    async (pageItems: EnrichedConversation[]) => {
      const backend = selectorBackend();
      const toEnrich = pageItems.filter((c) => !c.enriched);
      setEnriching(toEnrich.length > 0);
      const firstPageItems = toEnrich.slice(0, MAX_DISPLAY_PAGE_SIZE);
      const restItems = toEnrich.slice(MAX_DISPLAY_PAGE_SIZE);

      // Enrich first page in parallel
      const firstPageResults = await Promise.all(
        firstPageItems.map((c) =>
          enrichConversation(backend, c.conversation.id),
        ),
      );

      // Remove conversations that turned out empty after enrichment
      const emptyConvIds = new Set(
        firstPageItems
          .filter((_, i) => firstPageResults[i] === 0)
          .map((c) => c.conversation.id),
      );
      if (emptyConvIds.size > 0) {
        setItems((prev) =>
          prev.filter((c) => !emptyConvIds.has(c.conversation.id)),
        );
      }

      // Enrich remaining conversations one by one in background
      for (const item of restItems) {
        const count = await enrichConversation(backend, item.conversation.id);
        if (count === 0) {
          setItems((prev) =>
            prev.filter((c) => c.conversation.id !== item.conversation.id),
          );
        }
      }

      setEnriching(false);
    },
    [enrichConversation, selectorBackend, setItems],
  );

  // Initial load. The list is shown as soon as the page lands; enrichment
  // continues behind it.
  const { loadFirst, loadMore, hasMore } = page;
  useEffect(() => {
    void (async () => {
      const loaded = await loadFirst();
      if (loaded) await enrichLoaded(loaded);
    })();
  }, [loadFirst, enrichLoaded]);

  const terminalRows = useTerminalRows();
  const listPageSize = Math.max(
    1,
    Math.min(MAX_DISPLAY_PAGE_SIZE, Math.floor((terminalRows - 11) / 4)),
  );

  useEffect(() => {
    const query = searchInput.trim();
    if (!query) {
      setSearchResults(null);
      setSearching(false);
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(() => {
      (async () => {
        const backend = backendRef.current ?? selectorBackend();
        backendRef.current = backend;
        setSearching(true);
        try {
          const page = await backend.listConversations({
            agent_id: agentId,
            limit: 20,
            order: "desc",
            order_by: "last_run_completion",
            summary_search: query,
          });
          const results = paginatedItems<Conversation>(page);
          const seenConversationIds = new Set<string>();
          const dedupedResults = results.filter((conversation) => {
            const conversationId = conversation.id;
            if (seenConversationIds.has(conversationId)) return false;
            seenConversationIds.add(conversationId);
            return true;
          });
          if (cancelled) return;
          setSearchResults(
            dedupedResults.map((conversation) => ({
              conversation,
              preview: null,
              previewLines: null,
              searchPreview: conversation.summary || undefined,
              lastActiveAt:
                conversation.updated_at ?? conversation.created_at ?? null,
              messageCount: -1,
              enriched: false,
            })),
          );
        } catch {
          if (!cancelled) {
            setSearchResults(null);
          }
        } finally {
          if (!cancelled) {
            setSearching(false);
          }
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [agentId, searchInput, selectorBackend]);

  const normalizedSearch = searchInput.trim().toLowerCase();
  const locallyFilteredConversations = normalizedSearch
    ? page.items.filter((item) => {
        const summary = item.conversation.summary?.toLowerCase() ?? "";
        const searchPreview = item.searchPreview?.toLowerCase() ?? "";
        const id = item.conversation.id.toLowerCase();
        return (
          summary.includes(normalizedSearch) ||
          searchPreview.includes(normalizedSearch) ||
          id.includes(normalizedSearch)
        );
      })
    : page.items;
  const filteredConversations = normalizedSearch
    ? (() => {
        const merged: EnrichedConversation[] = [];
        const seenConversationIds = new Set<string>();
        for (const item of searchResults ?? []) {
          merged.push(item);
          seenConversationIds.add(item.conversation.id);
        }
        for (const item of locallyFilteredConversations) {
          if (!seenConversationIds.has(item.conversation.id)) {
            merged.push(item);
          }
        }
        return merged;
      })()
    : page.items;

  // The toolkit's list: `rows` here is also the PageUp/PageDown step, and the
  // same number goes to `OverlayListView` below, which is what windows.
  const listItems = useMemo(
    () =>
      filteredConversations.map((entry) => ({
        key: entry.conversation.id,
        label: entry.conversation.summary ?? entry.conversation.id,
      })),
    [filteredConversations],
  );

  const resetCursorRef = useRef<(index: number) => void>(() => {});
  const conversationList = useOverlayList({
    owner: "conversation-selector",
    items: listItems,
    // One row is three lines tall here (title, preview, timestamp), so the budget
    // is in items and the chrome reserve is what it was.
    rows: listPageSize,
    // `center`, not the model lists' `edge`: this face's own window arithmetic
    // held the cursor in the middle, and the migration keeps what it showed.
    anchor: "center",
    // `j`/`k` are search text: the query field is always live here, which is
    // exactly the case `list-bindings.ts` documents. Before the toolkit they were
    // bound *and* typed — one press moved the cursor and inserted the letter.
    vimKeys: false,
    navigationEnabled: !isLoading,
    onConfirm: (key) => {
      const selected = filteredConversations.find(
        (entry) => entry.conversation.id === key,
      );
      if (!selected) return;
      onSelect(key, {
        summary: selected.conversation.summary ?? undefined,
        messageCount: selected.messageCount,
      });
    },
    onCancel,
    extra: [
      // Escape clears the search first and only cancels when there is nothing to
      // clear. While the first page is in flight the whole key path is inert,
      // which is what this face did before the toolkit (`if (loading) return`) —
      // including Escape, so it must be consumed rather than left to the list's
      // own cancel.
      {
        id: "conversation-selector.escape",
        chords: [{ key: "escape" }],
        run: () => {
          if (isLoading) return "consumed";
          if (!searchInput) return "declined";
          setSearchInput("");
          return "consumed";
        },
      },
    ],
  });
  resetCursorRef.current = conversationList.setCursor;
  const visibleConversations = filteredConversations.slice(
    conversationList.window.start,
    conversationList.window.end,
  );

  // Re-enrich when visible conversations change (including search results).
  useEffect(() => {
    const backend = backendRef.current;
    if (!backend || isLoading) return;

    const unenriched = visibleConversations.filter((c) => !c.enriched);
    if (unenriched.length === 0) return;

    for (const item of unenriched) {
      enrichConversation(backend, item.conversation.id);
    }
  }, [isLoading, visibleConversations, enrichConversation]);

  // Fetch the next page once the cursor is within a row of the end, which is
  // where the old handler asked for it (on the downward key itself).
  const nearEnd = conversationList.cursor >= filteredConversations.length - 2;
  useEffect(() => {
    if (normalizedSearch || !nearEnd || !hasMore || isLoading) return;
    void loadMore();
  }, [normalizedSearch, nearEnd, hasMore, isLoading, loadMore]);

  // Render conversation item
  const renderConversationItem = (
    enrichedConv: EnrichedConversation,
    _index: number,
    isSelected: boolean,
  ) => {
    const {
      conversation: conv,
      previewLines,
      lastActiveAt,
      messageCount,
    } = enrichedConv;
    const isCurrent = conv.id === currentConversationId;

    const timestampText = formatConversationTimestampText({
      lastActiveAt,
      createdAt: conv.created_at,
    });

    // Build preview content: (1) summary if exists, (2) preview lines, (3) message count fallback
    // Uses L-bracket indentation style for visual hierarchy
    const renderPreview = () => {
      const bracket = <Text dimColor>{`${CLI_GLYPHS.result}  `}</Text>;
      const indent = "   "; // Same width as "└  " for alignment

      // Still loading message data
      if (previewLines === null) {
        if (enrichedConv.searchPreview) {
          return (
            <Box flexDirection="row" marginLeft={2}>
              {bracket}
              <Text dimColor italic>
                {enrichedConv.searchPreview}
              </Text>
            </Box>
          );
        }
        return (
          <Box flexDirection="row" marginLeft={2}>
            {bracket}
            <Text dimColor italic>
              Loading preview...
            </Text>
          </Box>
        );
      }

      // Has preview lines from messages
      if (previewLines.length > 0) {
        return (
          <>
            {previewLines.map((line, idx) => (
              <Box
                key={`${line.role}-${idx}`}
                flexDirection="row"
                marginLeft={2}
              >
                {idx === 0 ? bracket : <Text>{indent}</Text>}
                <Text dimColor>
                  {line.role === "assistant" ? "👾 " : "👤 "}
                </Text>
                <Text dimColor italic>
                  {line.text}
                </Text>
              </Box>
            ))}
          </>
        );
      }

      // Priority 3: Message count fallback
      if (messageCount > 0) {
        return (
          <Box flexDirection="row" marginLeft={2}>
            {bracket}
            <Text dimColor italic>
              {messageCount} message{messageCount === 1 ? "" : "s"} (no
              in-context user/agent messages)
            </Text>
          </Box>
        );
      }

      return (
        <Box flexDirection="row" marginLeft={2}>
          {bracket}
          <Text dimColor italic>
            No in-context messages
          </Text>
        </Box>
      );
    };

    const isDefault = conv.id === "default";

    return (
      <Box key={conv.id} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {isSelected ? ">" : " "}
          </Text>
          <Text> </Text>
          <Text
            bold={isSelected}
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {conv.summary
              ? `${conv.summary.length > 40 ? `${conv.summary.slice(0, 37)}...` : conv.summary} (${conv.id})`
              : isDefault
                ? "default"
                : conv.id}
          </Text>
          {!conv.summary && isDefault && (
            <Text dimColor> (agent's default conversation)</Text>
          )}
          {isCurrent && (
            <Text color={colors.selector.itemCurrent}> (current)</Text>
          )}
        </Box>
        {renderPreview()}
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>{timestampText}</Text>
        </Box>
      </Box>
    );
  };

  const terminalWidth = useTerminalWidth();

  return (
    <OverlayFrame command="/resume" title="Resume a previous conversation">
      <Box marginBottom={1}>
        <Text dimColor>Search: </Text>
        <PasteAwareTextInput
          value={searchInput}
          onChange={(value) => {
            if (value === searchInput) return;
            setSearchInput(value);
            resetCursorRef.current(0);
          }}
          placeholder="search conversation titles"
        />
      </Box>

      {/* Error state */}
      {error && (
        <Box flexDirection="column">
          <Text color="red">Error: {error}</Text>
          <Text dimColor>Press ESC to cancel</Text>
        </Box>
      )}

      {/* Loading state */}
      {isLoading && (
        <Box>
          <Text dimColor>Loading conversations...</Text>
        </Box>
      )}

      {/* Search indicator */}
      {!isLoading && searching && (
        <Box marginBottom={1}>
          <Text dimColor italic>
            Searching conversations...
          </Text>
        </Box>
      )}

      {/* Empty state */}
      {!isLoading && !error && filteredConversations.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>
            {searchInput
              ? "No matching conversations"
              : `No conversations for ${agentName || agentId.slice(0, 12)}`}
          </Text>
          <Text dimColor>Press Esc to cancel</Text>
        </Box>
      )}

      {/* Conversation list. `indicators={false}` because the footer below says
          the same thing in this face's own words ("Showing 1-3 of 21+"). */}
      {!isLoading && !error && filteredConversations.length > 0 && (
        <OverlayListView
          items={listItems}
          cursor={conversationList.cursor}
          rows={listPageSize}
          anchor="center"
          indicators={false}
          renderRow={(_item, index, isCursor) => {
            const entry = filteredConversations[index];
            if (!entry) return null;
            return renderConversationItem(entry, index, isCursor);
          }}
        />
      )}

      {/* Footer */}
      {!isLoading &&
        !error &&
        filteredConversations.length > 0 &&
        (() => {
          const footerWidth = Math.max(0, terminalWidth - 2);
          const pageText = `Showing ${conversationList.window.start + 1}-${conversationList.window.end} of ${filteredConversations.length}${!normalizedSearch && hasMore ? "+" : ""}${loadingMore ? " (loading...)" : ""}`;
          const hintsText = buildConversationSelectorHints();

          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Box width={2} flexShrink={0} />
                <Box flexGrow={1} width={footerWidth}>
                  <MarkdownDisplay text={pageText} dimColor />
                </Box>
              </Box>
              <Box flexDirection="row">
                <Box width={2} flexShrink={0} />
                <Box flexGrow={1} width={footerWidth}>
                  <MarkdownDisplay text={hintsText} dimColor />
                </Box>
              </Box>
            </Box>
          );
        })()}
    </OverlayFrame>
  );
}
