import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { Box } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBackend } from "@/backend";
import { colors } from "@/cli/components/colors";
import {
  type HiddenSessionHistory,
  type HiddenSessionHistoryRequest,
  hasBoundaryId,
  nextHiddenSessionAfter,
  readHiddenSessionHistory,
  readMoreHiddenSessionNewMessages,
} from "@/cli/helpers/hidden-session-history";
import {
  type HiddenSessionRow,
  projectHiddenSessionRows,
} from "@/cli/helpers/hidden-session-rows";
import { namedKeyChords } from "@/cli/helpers/input-keys";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import {
  type HiddenConversationSummary,
  readConversationProvenance,
} from "@/types/conversation-provenance";
import { HiddenSessionDeleteConfirm } from "./HiddenSessionDeleteConfirm";
import { Text } from "./Text";

/**
 * The read-only detail behind `/maintenance sessions` (`docs/44-1` §5.3).
 *
 * What it shows is decided by `hidden-session-history` (which seam the record has,
 * and whether the seam could be proven) and how a message becomes a line by
 * `hidden-session-rows`; this file owns only the frame, the window and the keys.
 * `OverlayFrame` + a window over flat lines, the way `MemfsTreeViewer`'s full view
 * draws a file — **not** `OverlayListView`, whose window counts items and cannot
 * hold a row that grows when expanded (§5.3.6).
 *
 * Three properties are load-bearing.
 *
 * - **The frame's height is constant.** The body renders exactly `visible` lines
 *   and pads the rest, and every line is clipped to the terminal width. A long
 *   tool result therefore cannot grow the frame, and the detail view does not
 *   shove the shell around while it scrolls (narrow terminals included).
 * - **A message is not a line.** `hidden-session-rows` projects one message into
 *   one row per tool call, and a row's expanded `detail` is many lines. The
 *   cursor is therefore a *line* index, its owner row keyed as
 *   `<message id>#<occurrence>` (an assistant message with four tool calls is
 *   four rows under one id), and `Enter` toggles that owner.
 * - **State is this leaf's.** Cursor, window start, expansion and the reasoning
 *   toggle live here — no `AppCoordinator` state, no timer, no store. The only
 *   reads are the history reader's, so the face cannot write a session (§5.3.7).
 *
 * The expansion is capped (`HIDDEN_SESSION_DETAIL_MAX_LINES`): a 50k-line tool
 * return would otherwise become 50k line objects in one render. Past the cap the
 * row says how many lines it withheld rather than pretending the output ended.
 */

/** Header, separator and footer rows the body does not get. */
const CHROME_ROWS = 12;

/** How many lines one expanded row may add before it is cut with a notice. */
const HIDDEN_SESSION_DETAIL_MAX_LINES = 200;

type DetailLineKind = "meta" | "row" | "detail" | "separator" | "note";

interface DetailLine {
  /** React key, stable while the window is on screen. */
  key: string;
  text: string;
  /**
   * The owning row (`<message id>#<occurrence>`), for `Enter`. Header, separator
   * and note lines own nothing and are inert.
   */
  rowKey: string | null;
  kind: DetailLineKind;
}

/** Everything the layout needs; pure so a key handler can re-run it. */
interface DetailLayoutInput {
  history: HiddenSessionHistory;
  origin: string;
  parentConversationId: string | null | undefined;
  contextMode: string | null | undefined;
  /** The record's own `inherited_message_count`; `0` is the empty-fork signal. */
  boundaryCount: number | null | undefined;
  showReasoning: boolean;
  expanded: ReadonlySet<string>;
  width: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** One row per message (or per tool call), each keyed uniquely. */
function keyedRows(
  messages: readonly Message[],
  showReasoning: boolean,
): Array<{ key: string; row: HiddenSessionRow }> {
  const seen = new Map<string, number>();
  return projectHiddenSessionRows(messages, { showReasoning }).map((row) => {
    const occurrence = seen.get(row.id) ?? 0;
    seen.set(row.id, occurrence + 1);
    return { key: `${row.id}#${occurrence}`, row };
  });
}

/** The lines one row draws: always its head, then its detail when expanded. */
function rowLines(
  key: string,
  row: HiddenSessionRow,
  expanded: boolean,
  width: number,
): DetailLine[] {
  const head = `${row.time ? `${row.time} ` : ""}${row.role}: ${row.text}`;
  const lines: DetailLine[] = [
    {
      key: `${key}:head`,
      text: truncateText(head, width),
      rowKey: key,
      kind: "row",
    },
  ];
  if (!expanded) return lines;

  const detail = row.detail.split("\n").filter((line) => line.length > 0);
  const shown = detail.slice(0, HIDDEN_SESSION_DETAIL_MAX_LINES);
  for (const [index, line] of shown.entries()) {
    lines.push({
      key: `${key}:detail:${index}`,
      text: truncateText(`    ${line}`, width),
      rowKey: key,
      kind: "detail",
    });
  }
  const withheld = detail.length - shown.length;
  if (withheld > 0) {
    lines.push({
      key: `${key}:withheld`,
      text: truncateText(
        `    ... ${withheld} more line${withheld === 1 ? "" : "s"} not shown`,
        width,
      ),
      rowKey: key,
      kind: "note",
    });
  }
  return lines;
}

/**
 * Lay the whole view out as lines: header, the seam, the hidden-segment rule, the
 * rows after it (or every loaded row when the seam is unknown), and the notes a
 * reader needs to know why they are seeing this much.
 */
function layOutDetail(input: DetailLayoutInput): DetailLine[] {
  const { history, width } = input;
  const lines: DetailLine[] = [];
  const boundary = history.lastInherited;
  const standalone = history.mode === "standalone";
  // A record that says it inherited nothing is not an unknown seam: the fork is
  // empty on purpose (§5.3.2), so the view shows its own rows without a rule. The
  // count has to be an explicit zero — a legacy record with no count is unknown,
  // not empty.
  const explicitCount = history.inheritedCount ?? input.boundaryCount;
  const emptyInheritance =
    !standalone && !hasBoundaryId(boundary?.id) && explicitCount === 0;
  const inheritedCount = history.inheritedCount ?? (boundary ? 1 : 0);

  const parent = input.parentConversationId
    ? `parent ${input.parentConversationId}`
    : "parent unavailable";
  const newCount = history.newMessages.length;

  if (standalone) {
    lines.push({
      key: "meta",
      text: truncateText(
        `${input.origin} · standalone · ${newCount} message${newCount === 1 ? "" : "s"}`,
        width,
      ),
      rowKey: null,
      kind: "meta",
    });
  } else if (emptyInheritance) {
    lines.push({
      key: "meta",
      text: truncateText(
        `${input.origin} · ${parent} · no inherited context · ${newCount} new`,
        width,
      ),
      rowKey: null,
      kind: "meta",
    });
  } else if (history.boundaryKnown) {
    lines.push({
      key: "meta",
      text: truncateText(
        `${input.origin} · ${parent} · ${inheritedCount} inherited hidden · ${newCount} new`,
        width,
      ),
      rowKey: null,
      kind: "meta",
    });
  } else {
    lines.push({
      key: "meta",
      text: truncateText(
        `${input.origin} · ${parent} · boundary unknown · ${newCount} new`,
        width,
      ),
      rowKey: null,
      kind: "meta",
    });
  }

  const pushRows = (messages: readonly Message[]): void => {
    for (const { key, row } of keyedRows(messages, input.showReasoning)) {
      lines.push(...rowLines(key, row, input.expanded.has(key), width));
    }
  };

  if (boundary) pushRows([boundary]);

  if (standalone) {
    pushRows(history.newMessages);
  } else if (emptyInheritance) {
    pushRows(history.newMessages);
  } else if (history.boundaryKnown) {
    lines.push({
      key: "separator",
      text: truncateText(
        `── inherited context hidden · ${inheritedCount} message${inheritedCount === 1 ? "" : "s"} ──`,
        width,
      ),
      rowKey: null,
      kind: "separator",
    });
    pushRows(history.newMessages);
    if (history.newMessages.length === 0) {
      lines.push({
        key: "no-new",
        text: truncateText("no new messages", width),
        rowKey: null,
        kind: "note",
      });
    }
  } else {
    // The seam could not be proven, so the loaded window is shown in full: hiding
    // a prefix on a guess is the one thing §5.3.3 forbids.
    lines.push({
      key: "unknown",
      text: truncateText(
        "boundary unknown; showing every loaded message",
        width,
      ),
      rowKey: null,
      kind: "note",
    });
    pushRows(history.newMessages);
  }

  if (
    lines.every((line) => line.kind === "meta" || line.kind === "separator")
  ) {
    lines.push({
      key: "empty",
      text: truncateText("(no messages)", width),
      rowKey: null,
      kind: "note",
    });
  }

  if (history.truncatedByBudget) {
    lines.push({
      key: "truncated",
      text: truncateText(
        "older messages were not loaded (read budget reached)",
        width,
      ),
      rowKey: null,
      kind: "note",
    });
  }

  return lines;
}

/**
 * Where the window starts so the cursor is inside it. `previous` is kept when it
 * already contains the cursor, which is what makes a scroll feel anchored instead
 * of re-centring on every key.
 */
function windowStart(
  previous: number,
  cursor: number,
  visible: number,
  count: number,
): number {
  const maxStart = Math.max(0, count - visible);
  const base = clamp(previous, 0, maxStart);
  if (cursor < base) return clamp(cursor, 0, maxStart);
  if (cursor >= base + visible) return clamp(cursor - visible + 1, 0, maxStart);
  return base;
}

export interface HiddenSessionDetailProps {
  /** The list row this detail was opened from (provenance and counts included). */
  session: HiddenConversationSummary;
  /** Escape: back to the list, not out of the face (§5.1.4). */
  onBack: () => void;
  /** Ctrl+C: the overlay's own cancel, from any view. */
  onClose: () => void;
  /** After a successful `d`: the list must drop the row and reload. */
  onDeleted?: () => void;
}

export function HiddenSessionDetail({
  session,
  onBack,
  onClose,
  onDeleted,
}: HiddenSessionDetailProps) {
  const terminalRows = useTerminalRows();
  const terminalWidth = useTerminalWidth();
  const visible = Math.max(3, terminalRows - CHROME_ROWS);

  const provenance = readConversationProvenance(session);
  const boundaryId = provenance.inherited_through_message_id ?? null;
  const boundaryCount = provenance.inherited_message_count ?? null;
  const contextMode = provenance.context_mode ?? null;
  const conversationCreatedAt = session.created_at ?? null;
  const agentId = session.agent_id;
  const conversationId = session.id;

  const request = useMemo<HiddenSessionHistoryRequest>(
    () => ({
      backend: getBackend(),
      conversationId,
      agentId,
      conversationCreatedAt,
      boundaryId,
      boundaryCount,
      contextMode,
    }),
    [
      conversationId,
      agentId,
      conversationCreatedAt,
      boundaryId,
      boundaryCount,
      contextMode,
    ],
  );

  const [history, setHistory] = useState<HiddenSessionHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [cursor, setCursor] = useState(0);
  const [start, setStart] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loadingMoreRef = useRef(false);

  // The first window: one boundary read or a bounded backwards walk, never the
  // whole transcript (§5.3.1).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const read = await readHiddenSessionHistory(request);
        if (!cancelled) setHistory(read);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  const origin = provenance.origin;
  const parentConversationId = provenance.parent_conversation_id ?? null;
  // Memoized: a fresh object every render would invalidate the `lines` memo
  // below and re-lay the whole window on every key, including the ones that only
  // move the cursor.
  const layoutInput = useMemo<Omit<
    DetailLayoutInput,
    "showReasoning" | "expanded" | "width"
  > | null>(
    () =>
      history
        ? {
            history,
            origin,
            parentConversationId,
            contextMode,
            boundaryCount,
          }
        : null,
    [history, origin, parentConversationId, contextMode, boundaryCount],
  );

  const lines = useMemo<DetailLine[]>(() => {
    if (!layoutInput) return [];
    return layOutDetail({
      ...layoutInput,
      showReasoning,
      expanded,
      width: Math.max(1, terminalWidth - 2),
    });
  }, [layoutInput, showReasoning, expanded, terminalWidth]);

  const lineCount = lines.length;
  const cursorLine = clamp(cursor, 0, Math.max(0, lineCount - 1));
  const startLine = windowStart(start, cursorLine, visible, lineCount);
  const endLine = Math.min(lineCount, startLine + visible);

  const follow = useCallback(
    (target: number, nextCount: number) => {
      const next = clamp(target, 0, Math.max(0, nextCount - 1));
      setCursor(next);
      setStart((previous) => windowStart(previous, next, visible, nextCount));
    },
    [visible],
  );

  const scrollBy = (delta: number) => {
    follow(cursorLine + delta, lineCount);
  };

  const toggleRowAtCursor = () => {
    const owner = lines[cursorLine]?.rowKey;
    if (!owner || !layoutInput) return;
    const nextExpanded = new Set(expanded);
    if (nextExpanded.has(owner)) nextExpanded.delete(owner);
    else nextExpanded.add(owner);
    const nextLines = layOutDetail({
      ...layoutInput,
      showReasoning,
      expanded: nextExpanded,
      width: Math.max(1, terminalWidth - 2),
    });
    setExpanded(nextExpanded);
    // Collapsing from inside a long detail must land on the row's first line, so
    // the cursor never ends up on a line that the collapse removed.
    const anchor = nextLines.findIndex((line) => line.rowKey === owner);
    follow(anchor >= 0 ? anchor : cursorLine, nextLines.length);
  };

  const toggleReasoning = () => {
    if (!layoutInput) return;
    const owner = lines[cursorLine]?.rowKey ?? null;
    const nextShow = !showReasoning;
    const nextLines = layOutDetail({
      ...layoutInput,
      showReasoning: nextShow,
      expanded,
      width: Math.max(1, terminalWidth - 2),
    });
    setShowReasoning(nextShow);
    // Keep the reader where they were: the same row, not the same index.
    const anchor = owner
      ? nextLines.findIndex((line) => line.rowKey === owner)
      : -1;
    follow(anchor >= 0 ? anchor : cursorLine, nextLines.length);
  };

  const bindings = [
    {
      id: "hidden-session-detail.close",
      chords: [{ key: "c", ctrl: true }],
      run: () => {
        onClose();
        return "consumed" as const;
      },
    },
    {
      id: "hidden-session-detail.back",
      chords: namedKeyChords("escape"),
      run: () => {
        onBack();
        return "consumed" as const;
      },
    },
    {
      id: "hidden-session-detail.expand",
      chords: namedKeyChords("return"),
      run: () => {
        toggleRowAtCursor();
        return "consumed" as const;
      },
    },
    {
      id: "hidden-session-detail.reasoning",
      chords: [{ key: "r" }],
      run: () => {
        toggleReasoning();
        return "consumed" as const;
      },
    },
    {
      id: "hidden-session-detail.up",
      chords: [...namedKeyChords("upArrow"), { key: "k" }],
      run: () => {
        scrollBy(-1);
        return "consumed" as const;
      },
    },
    {
      id: "hidden-session-detail.down",
      chords: [...namedKeyChords("downArrow"), { key: "j" }],
      run: () => {
        scrollBy(1);
        return "consumed" as const;
      },
    },
    {
      id: "hidden-session-detail.delete",
      chords: [{ key: "d" }],
      run: () => {
        setConfirmDelete(true);
        return "consumed" as const;
      },
    },
    {
      id: "hidden-session-detail.page-up",
      chords: [{ key: "pageUp" }],
      run: () => {
        scrollBy(-visible);
        return "consumed" as const;
      },
    },
    {
      id: "hidden-session-detail.page-down",
      chords: [{ key: "pageDown" }],
      run: () => {
        scrollBy(visible);
        return "consumed" as const;
      },
    },
  ];
  // The confirmation owns every key while it is up (its table lives in the higher
  // `modal` layer), so this face's own table is emptied rather than left to
  // decline: a matched-but-declined binding does not pass to the next owner.
  useKeyBindings("hidden-session-detail", [
    { scope: "overlay", bindings: confirmDelete ? [] : bindings },
  ]);

  // Page the new segment on demand, and only when the reader reaches the end of
  // what is loaded: a full first page may or may not be the last one (§5.3.1).
  useEffect(() => {
    if (!history || history.mode !== "boundary" || history.exhausted) return;
    if (lineCount === 0 || cursorLine < lineCount - 1) return;
    if (loadingMoreRef.current || !nextHiddenSessionAfter(history)) return;
    loadingMoreRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const next = await readMoreHiddenSessionNewMessages(request, history);
        if (!cancelled) setHistory(next);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        loadingMoreRef.current = false;
      }
    })();
    // Esc unmounts this view while the page is in flight; the reply must not
    // set state on the list that replaced it.
    return () => {
      cancelled = true;
    };
  }, [history, request, cursorLine, lineCount]);

  const heading = truncateText(
    session.summary?.trim() || session.id,
    Math.max(1, terminalWidth - 4),
  );

  if (confirmDelete) {
    return (
      <HiddenSessionDeleteConfirm
        session={session}
        newCount={history?.newMessages.length ?? null}
        onCancel={() => setConfirmDelete(false)}
        onDeleted={() => {
          setConfirmDelete(false);
          if (onDeleted) onDeleted();
          else onBack();
        }}
      />
    );
  }

  const footerWidth = Math.max(1, terminalWidth - 2);
  const position =
    lineCount === 0
      ? "no lines"
      : `lines ${startLine + 1}-${endLine} of ${lineCount}${history && !history.exhausted ? " (more below)" : ""}`;

  const body: DetailLine[] = [];
  if (lines.length > 0) {
    body.push(...lines.slice(startLine, endLine));
  }
  const padCount = Math.max(0, visible - body.length);

  return (
    <OverlayFrame
      command="/maintenance sessions"
      title={heading}
      footer={
        <Box flexDirection="column">
          <Text dimColor>{truncateText(position, footerWidth)}</Text>
          <Text dimColor>
            {truncateText(
              `${showReasoning ? "r hides reasoning" : "r shows reasoning"} · ↑↓/j k scroll · PgUp/PgDn · Enter expands · Esc back`,
              footerWidth,
            )}
          </Text>
          <Text dimColor>
            {truncateText(
              "Read-only. A running session's content may be incomplete.",
              footerWidth,
            )}
          </Text>
        </Box>
      }
    >
      {loadError ? (
        <Box flexDirection="column">
          <Text color="red">{`Error reading this session: ${loadError}`}</Text>
          <Text dimColor>esc goes back to the list.</Text>
        </Box>
      ) : !history ? (
        <Box>
          <Text dimColor>Loading this session...</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {body.map((line) => {
            const isCursor = line === lines[cursorLine];
            return (
              <Text
                key={line.key}
                bold={isCursor}
                color={isCursor ? colors.selector.itemHighlighted : undefined}
              >
                {line.text || " "}
              </Text>
            );
          })}
          {Array.from(
            { length: padCount },
            (_, index) => `pad:${startLine}:${index}`,
          ).map((spacerKey) => (
            <Text key={spacerKey}> </Text>
          ))}
        </Box>
      )}
    </OverlayFrame>
  );
}
