/**
 * `TopicQuery` — read the agent's topic index (requirement §5.11.8).
 *
 * The index itself lives in `backend/local/topic-index.ts`; this module is the
 * model-facing layer: argument validation, the current-agent/storage resolution,
 * and the result copy. Two decisions live here and are pure functions so they can
 * be tested without a store — what counts as a valid query, and how the budget
 * cuts a result set.
 *
 * The tool is read-only. It never writes a marker and never touches the context,
 * the frozen prefix, or the transcript; the only write in the whole path is the
 * index's own self-heal, which rewrites the derived file, never the source.
 */
import { getCurrentAgentId } from "@/agent/context";
import { type Backend, getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  queryTopicIndex,
  type TopicIndexEntry,
} from "@/backend/local/topic-index";

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

export interface TopicQueryArgs {
  keyword?: unknown;
  days?: unknown;
  session?: unknown;
  limit?: unknown;
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
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Validate and normalize the arguments. Every rejection carries the
 * model-facing reason, so a bad call comes back as a fixable message instead of
 * a silent empty result.
 */
export function validateTopicQueryArgs(
  args: TopicQueryArgs,
): ({ ok: true } & TopicQueryFilters) | { ok: false; content: string } {
  const filters: TopicQueryFilters = {};

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

function formatEntryRow(entry: TopicIndexEntry, position: number): string {
  const line = `${position}. ${entry.title} · ${formatTopicQueryTimestamp(
    entry.createdAt,
  )} · session ${entry.conversationId} · by ${entry.createdBy}`;
  const preview = sectionFirstLine(entry.section);
  return preview.length > 0 ? `${line}\n   ${preview}` : line;
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
 */
export function formatTopicQueryResults(input: {
  entries: readonly TopicIndexEntry[];
  keyword?: string;
  days?: number;
  conversationId?: string;
}): string {
  const { entries } = input;
  const filters: TopicQueryFilters = {
    ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
    ...(input.days === undefined ? {} : { days: input.days }),
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
  };
  if (entries.length === 0) return emptyResultHint(filters);

  const total = entries.length;
  const header = `${total} topic${total === 1 ? "" : "s"}, newest first, times in UTC.`;
  const rows = entries.map((entry, index) => formatEntryRow(entry, index + 1));

  let body = header;
  let shown = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const next = `${body}\n\n${rows[index]}`;
    const remaining = rows.length - (index + 1);
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

  const entries = queryTopicIndex({
    agentId,
    storageDir,
    ...(validated.keyword === undefined ? {} : { keyword: validated.keyword }),
    ...(validated.days === undefined ? {} : { days: validated.days }),
    ...(validated.conversationId === undefined
      ? {}
      : { conversationId: validated.conversationId }),
    ...(validated.limit === undefined ? {} : { limit: validated.limit }),
  });

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
    }),
    status: "success",
  };
}
