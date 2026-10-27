/**
 * `TopicQuery` — read the agent's topic index (requirement §5.11.8), and, on
 * request, the messages a marker covers (F-04 T-10, decision §2.3).
 *
 * The index itself lives in `backend/local/topic-index.ts`; the span projection
 * lives in `backend/local/topic-recall.ts` and is shared with `/topic show`, so
 * the model and the user read the same text for the same tier. This module is the
 * model-facing layer: argument validation, the current-agent/storage resolution,
 * and the result copy. The decisions that matter are pure functions so they can be
 * tested without a store — what counts as a valid query, and how the budget cuts a
 * result set.
 *
 * The tool is read-only. It never writes a marker and never touches the context,
 * the frozen prefix, or the transcript; the only write in the whole path is the
 * index's own self-heal, which rewrites the derived file, never the source.
 *
 * ## Why `include` is a tier instead of three tools
 *
 * `sections` (the default) is the cheap listing this tool has always returned.
 * `excerpt` costs one transcript read per topic it actually prints, and `full`
 * addresses exactly one topic by id. Making the caller ask twice is the same
 * two-step shape paging uses, and it keeps the zero-cost default zero-cost.
 */
import { getCurrentAgentId } from "@/agent/context";
import { type Backend, getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  queryTopicIndex,
  type TopicIndexEntry,
} from "@/backend/local/topic-index";
import {
  readTopicRecallSpan,
  recallTopicConversation,
  renderTopicRecall,
  TOPIC_RECALL_EXCERPT_MAX_CHARS,
} from "@/backend/local/topic-recall";

/**
 * Total character budget for one result set (requirement §5.11.8). The budget
 * covers the rendered output including its truncation notice; when it bites, the
 * **oldest** topics are dropped, because a question about recent work is the
 * common one.
 */
export const TOPIC_QUERY_MAX_CHARS = 4000;

/** How much of a section's first line a row carries. */
export const TOPIC_QUERY_SECTION_PREVIEW_CHARS = 200;

/** The largest `limit` the schema accepts. */
export const TOPIC_QUERY_MAX_LIMIT = 200;

/** The three tiers this tool answers in. */
export type TopicQueryInclude = "sections" | "excerpt" | "full";

export const TOPIC_QUERY_INCLUDE_VALUES: readonly TopicQueryInclude[] = [
  "sections",
  "excerpt",
  "full",
];

/** Indent under a row, shared by the section preview and a message body. */
const ROW_INDENT = "   ";

export interface TopicQueryArgs {
  keyword?: unknown;
  days?: unknown;
  session?: unknown;
  limit?: unknown;
  include?: unknown;
  topic_id?: unknown;
}

export interface TopicQueryDeps {
  backend?: Backend;
  agentId?: string;
  /** Tests pass a temporary root; production resolves it from the backend. */
  storageDir?: string;
}

export interface TopicQueryResult {
  content: string;
  status: "success" | "error";
}

export interface TopicQueryFilters {
  keyword?: string;
  days?: number;
  conversationId?: string;
  limit?: number;
  include: TopicQueryInclude;
  /** The one topic `include: "full"` addresses; a filter for the other tiers. */
  topicId?: string;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isTopicQueryInclude(value: unknown): value is TopicQueryInclude {
  return (
    typeof value === "string" &&
    (TOPIC_QUERY_INCLUDE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Validate and normalize the arguments. Every rejection carries the
 * model-facing reason, so a bad call comes back as a fixable message instead of
 * a silent empty result.
 */
export function validateTopicQueryArgs(
  args: TopicQueryArgs,
): ({ ok: true } & TopicQueryFilters) | { ok: false; content: string } {
  const filters: TopicQueryFilters = { include: "sections" };

  if (args.include !== undefined) {
    if (!isTopicQueryInclude(args.include)) {
      return {
        ok: false,
        content: `\`include\` must be one of ${TOPIC_QUERY_INCLUDE_VALUES.map((value) => `"${value}"`).join(", ")}. It defaults to "sections", the listing this tool returns without it.`,
      };
    }
    filters.include = args.include;
  }

  if (args.topic_id !== undefined) {
    if (typeof args.topic_id !== "string") {
      return {
        ok: false,
        content:
          "`topic_id` must be a string when provided — the `topic_id` column of a `sections` result.",
      };
    }
    const topicId = args.topic_id.trim();
    if (topicId.length === 0) {
      return {
        ok: false,
        content:
          "`topic_id` was empty. Pass the `topic_id` value from a `sections` result, or drop the parameter.",
      };
    }
    filters.topicId = topicId;
  }

  if (args.keyword !== undefined) {
    if (typeof args.keyword !== "string") {
      return {
        ok: false,
        content: "`keyword` must be a string when provided.",
      };
    }
    const keyword = collapseWhitespace(args.keyword);
    if (keyword.length > 0) filters.keyword = keyword;
  }

  if (args.days !== undefined) {
    if (
      typeof args.days !== "number" ||
      !Number.isFinite(args.days) ||
      args.days <= 0
    ) {
      return {
        ok: false,
        content:
          "`days` must be a positive number of days, for example 7 for the last week.",
      };
    }
    filters.days = args.days;
  }

  if (args.session !== undefined) {
    if (typeof args.session !== "string") {
      return {
        ok: false,
        content: "`session` must be a conversation id string when provided.",
      };
    }
    const session = args.session.trim();
    if (session.length > 0) filters.conversationId = session;
  }

  if (args.limit !== undefined) {
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > TOPIC_QUERY_MAX_LIMIT
    ) {
      return {
        ok: false,
        content: `\`limit\` must be a whole number between 1 and ${TOPIC_QUERY_MAX_LIMIT}.`,
      };
    }
    filters.limit = limit;
  }

  if (filters.include === "full") {
    // "full" is an address, not a search: it names one topic and returns one span.
    if (filters.topicId === undefined) {
      return {
        ok: false,
        content:
          '`include: "full"` needs `topic_id`. It prints one topic\'s messages, so name which one — the `topic_id` column of a `sections` result. For a peek at several topics at once, use `include: "excerpt"`.',
      };
    }
    const inapplicable = [
      filters.keyword === undefined ? undefined : "keyword",
      filters.days === undefined ? undefined : "days",
      filters.conversationId === undefined ? undefined : "session",
      filters.limit === undefined ? undefined : "limit",
    ].filter((name): name is string => name !== undefined);
    if (inapplicable.length > 0) {
      return {
        ok: false,
        content: `\`include: "full"\` addresses one topic by \`topic_id\`, so ${inapplicable
          .map((name) => `\`${name}\``)
          .join(", ")} do not apply. Drop ${
          inapplicable.length === 1 ? "it" : "them"
        }, or use \`include: "sections"\`/\`"excerpt"\` to filter a list.`,
      };
    }
  }

  return { ok: true, ...filters };
}

/**
 * The timestamp as it appears in a row: minute precision, UTC.
 *
 * An unparsable timestamp is passed through rather than dropped — a row with an
 * odd date is still a row the model should see.
 */
export function formatTopicQueryTimestamp(createdAt: string): string {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return createdAt;
  return new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
}

function sectionFirstLine(section: string | undefined): string {
  if (section === undefined) return "";
  const firstLine = section.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= TOPIC_QUERY_SECTION_PREVIEW_CHARS) return firstLine;
  return `${firstLine.slice(0, TOPIC_QUERY_SECTION_PREVIEW_CHARS - 1)}…`;
}

function indentBlock(body: string): string[] {
  return body
    .split("\n")
    .map((line) =>
      line.length === 0 ? ROW_INDENT.trimEnd() : `${ROW_INDENT}${line}`,
    );
}

/**
 * One row: identity, when it was marked, which conversation, who marked it, its
 * `topic_id` (an identity, never a path), the section's first line, and — on
 * request — the message projection under it.
 */
function formatEntryRow(
  entry: TopicIndexEntry,
  position: number,
  body?: string,
): string {
  const line = `${position}. ${entry.title} · ${formatTopicQueryTimestamp(
    entry.createdAt,
  )} · session ${entry.conversationId} · by ${entry.createdBy} · topic_id ${entry.topicId}`;
  const preview = sectionFirstLine(entry.section);
  const lines = preview.length > 0 ? [line, `${ROW_INDENT}${preview}`] : [line];
  if (body !== undefined) lines.push(...indentBlock(body));
  return lines.join("\n");
}

function truncationNotice(shown: number, total: number): string {
  return `[Output truncated: showing the newest ${shown} of ${total} topics within the ${TOPIC_QUERY_MAX_CHARS}-character budget. Narrow the query with keyword, days, or session to see the rest.]`;
}

function emptyResultHint(filters: TopicQueryFilters): string {
  const applied: string[] = [];
  if (filters.keyword !== undefined)
    applied.push(`keyword "${filters.keyword}"`);
  if (filters.days !== undefined)
    applied.push(`the last ${filters.days} day(s)`);
  if (filters.conversationId !== undefined) {
    applied.push(`session ${filters.conversationId}`);
  }
  if (applied.length === 0) {
    return "No topics are indexed for this agent yet. Topics only exist where someone marked one — the TopicMark tool or the user's /topic command — so this means nothing has been marked in the visible conversations, not that the conversations were empty.";
  }
  return `No topics match ${applied.join(" and ")}. Broadening the filter usually helps: try a shorter keyword, a larger \`days\`, or drop \`session\`. Conversations the user hid are excluded unless you name one with \`session\`.`;
}

/**
 * Render a result set under the character budget.
 *
 * The notice is reserved *before* a row is accepted, so the returned string —
 * rows plus notice — never exceeds {@link TOPIC_QUERY_MAX_CHARS}. Rows arrive
 * newest-first from the index, so dropping from the tail drops the oldest.
 *
 * `bodyFor` is what makes `excerpt` affordable: it is called only for rows that are
 * actually accepted, so a 200-topic listing costs zero transcript reads and a
 * budget-limited excerpt costs at most a handful.
 */
export function formatTopicQueryResults(input: {
  entries: readonly TopicIndexEntry[];
  keyword?: string;
  days?: number;
  conversationId?: string;
  bodyFor?: (entry: TopicIndexEntry) => string | undefined;
}): string {
  const { entries, bodyFor } = input;
  const filters: TopicQueryFilters = {
    include: "sections",
    ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
    ...(input.days === undefined ? {} : { days: input.days }),
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
  };
  if (entries.length === 0) return emptyResultHint(filters);

  const total = entries.length;
  const header = `${total} topic${total === 1 ? "" : "s"}, newest first, times in UTC.`;

  let body = header;
  let shown = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) break;
    const row = formatEntryRow(entry, index + 1, bodyFor?.(entry));
    const next = `${body}\n\n${row}`;
    const remaining = entries.length - (index + 1);
    // The notice only exists if a row is actually dropped, so it is reserved from
    // the budget only while rows remain after this one.
    const reserve =
      remaining > 0 ? truncationNotice(index + 1, total).length : 0;
    if (next.length + reserve > TOPIC_QUERY_MAX_CHARS) break;
    body = next;
    shown = index + 1;
  }

  if (shown === total) return body;
  return `${body}\n\n${truncationNotice(shown, total)}`;
}

/** What an `excerpt` row says when the marker's transcript is gone. */
export const TOPIC_QUERY_SPAN_UNREADABLE =
  "(this marker's span is not readable: the conversation transcript no longer holds it)";

/**
 * The message projection under one row, for `include: "excerpt"`.
 *
 * Returns the projection's `body` rather than its `text`: the row above it already
 * carries the title, time, session and source, so repeating the recall header would
 * print the same facts twice.
 */
export function topicQueryExcerptBody(input: {
  storageDir: string;
  agentId: string;
  entry: TopicIndexEntry;
}): string {
  const span = readTopicRecallSpan({
    storageDir: input.storageDir,
    agentId: input.agentId,
    conversationId: input.entry.conversationId,
    topicId: input.entry.topicId,
  });
  if (!span) return TOPIC_QUERY_SPAN_UNREADABLE;
  return renderTopicRecall({
    span,
    tier: "excerpt",
    maxChars: TOPIC_RECALL_EXCERPT_MAX_CHARS,
  }).body;
}

function topicNotFound(topicId: string): string {
  return `No topic with id ${topicId} is indexed for this agent. Take \`topic_id\` from a \`sections\` result; an id from another agent's index will not resolve.`;
}

/**
 * The tool entry point.
 *
 * `deps.storageDir` exists for tests and for callers that already hold a backend
 * root; without it the storage dir comes from the local backend, never from the
 * ambient default, so an alternate-root store can never index into the user's
 * real `~/.haruyuki/lc-local-backend`.
 */
export async function topic_query(
  args: TopicQueryArgs,
  deps: TopicQueryDeps = {},
): Promise<TopicQueryResult> {
  const validated = validateTopicQueryArgs(args);
  if (!validated.ok) {
    return { content: validated.content, status: "error" };
  }

  let agentId: string;
  try {
    agentId = deps.agentId ?? getCurrentAgentId();
  } catch {
    return {
      content:
        "A topic query needs the calling agent, which is not available in this execution context.",
      status: "error",
    };
  }

  let storageDir = deps.storageDir;
  if (storageDir === undefined) {
    const backend = deps.backend ?? getBackend();
    if (!(backend instanceof LocalBackend)) {
      return {
        content:
          "Topic markers are only available on the local backend. This conversation runs on the Letta API, where the transcript is managed by the server.",
        status: "error",
      };
    }
    storageDir = backend.getLocalStorageDir();
  }

  if (validated.include === "full") {
    // Addressed by id, so the listing filters are deliberately not applied (and
    // validation already rejected them): one id, one span.
    const entry = queryTopicIndex({ agentId, storageDir }).find(
      (candidate) => candidate.topicId === validated.topicId,
    );
    if (!entry) {
      return {
        content: topicNotFound(validated.topicId ?? ""),
        status: "error",
      };
    }
    const recalled = recallTopicConversation({
      storageDir,
      agentId,
      conversationId: entry.conversationId,
      topicId: entry.topicId,
      tier: "full",
    });
    if (!recalled) {
      return {
        content: `${TOPIC_QUERY_SPAN_UNREADABLE} The index still lists "${entry.title}" in session ${entry.conversationId}, but its marker is not in that transcript.`,
        status: "error",
      };
    }
    return { content: recalled.text, status: "success" };
  }

  let entries = queryTopicIndex({
    agentId,
    storageDir,
    ...(validated.keyword === undefined ? {} : { keyword: validated.keyword }),
    ...(validated.days === undefined ? {} : { days: validated.days }),
    ...(validated.conversationId === undefined
      ? {}
      : { conversationId: validated.conversationId }),
    ...(validated.limit === undefined ? {} : { limit: validated.limit }),
  });
  if (validated.topicId !== undefined) {
    entries = entries.filter((entry) => entry.topicId === validated.topicId);
    if (entries.length === 0) {
      return { content: topicNotFound(validated.topicId), status: "error" };
    }
  }

  const excerptStorage = storageDir;
  const bodyFor =
    validated.include === "excerpt"
      ? (entry: TopicIndexEntry) =>
          topicQueryExcerptBody({
            storageDir: excerptStorage,
            agentId,
            entry,
          })
      : undefined;

  return {
    content: formatTopicQueryResults({
      entries,
      ...(validated.keyword === undefined
        ? {}
        : { keyword: validated.keyword }),
      ...(validated.days === undefined ? {} : { days: validated.days }),
      ...(validated.conversationId === undefined
        ? {}
        : { conversationId: validated.conversationId }),
      ...(bodyFor === undefined ? {} : { bodyFor }),
    }),
    status: "success",
  };
}
