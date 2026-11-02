// src/cli/app/pages/overview/overview-fetch.ts

/**
 * The `+` overview's backend reads (W-12, T-10).
 *
 * One snapshot is built from exactly three kinds of read (《47-1》R-10.8):
 *
 * 1. `listAgents` — the first level's rows. One large-limit call, no pagination:
 *    the page is a browse surface, not a search surface, and a second page
 *    would be a second round trip before the first frame.
 * 2. `listConversations` — **one** large-limit pass over every agent at once,
 *    grouped by `agent_id` afterwards. This is what makes the session count an
 *    aggregate instead of a per-agent round trip. Hidden conversations are
 *    excluded (Q-35); when the pass comes back full it is treated as truncated
 *    and every count renders as `N+` (R-10.8, `conversationCountTruncated`).
 * 3. The per-agent `default` conversation, which the list never returns (the
 *    local backend filters `id !== "default"`), so it is read explicitly —
 *    Q-53's 补读. One cheap read per agent: its newest message is enough to
 *    know whether the conversation has any history and when it last moved.
 *
 * Message snippets are **not** read here. They are the lazy part (R-10.8): the
 * second level asks for one conversation's snippets when it shows that
 * conversation, `overview-data` reads each conversation at most once per
 * snapshot generation. The records this module returns therefore carry
 * `lastUserMessage: null` / `lastAgentMessage: null` — the contract's "not
 * loaded yet" value.
 *
 * Everything here takes the `Backend` explicitly. The React-free tests inject a
 * fake backend, and the page's loader passes `getBackend()`; no module-level
 * backend singleton is captured.
 */
import type { MessageType } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import { SYSTEM_ALERT_OPEN, SYSTEM_REMINDER_OPEN } from "@/constants";
import { debugLog } from "@/utils/debug";
import type {
  OverviewAgentRecord,
  OverviewConversationRecord,
  OverviewSnapshot,
} from "./overview-types";

/**
 * How many agents one pass asks for.
 *
 * Large on purpose: the agent level has no `N+` affordance in the frozen
 * contract, so a small limit would silently hide agents rather than truncate a
 * count. The local backend's default is 20.
 */
export const OVERVIEW_AGENT_LIST_LIMIT = 1000;

/**
 * The single aggregation pass's cap (R-10.8, Q-37).
 *
 * It is the only number that decides `conversationCountTruncated`: a full page
 * means the aggregate is a lower bound. Per-agent display is capped separately
 * by {@link OVERVIEW_AGENT_CONVERSATION_LIMIT}.
 */
export const OVERVIEW_CONVERSATION_LIST_LIMIT = 1000;

/** Conversations carried per agent for the second level (R-10.8's 首屏 20 条). */
export const OVERVIEW_AGENT_CONVERSATION_LIMIT = 20;

/** Messages one preview read asks for; enough for the newest user + agent text. */
export const OVERVIEW_PREVIEW_MESSAGE_LIMIT = 20;

/** A snippet is one row's worth of text; the row builder clips to its width. */
export const OVERVIEW_SNIPPET_MAX_LENGTH = 120;

/** The implicit conversation the backend never lists (Q-53). */
export const OVERVIEW_DEFAULT_CONVERSATION_ID = "default";

/** Its row title: the backend carries no summary for the implicit conversation. */
export const OVERVIEW_DEFAULT_CONVERSATION_TITLE = "Default";

/**
 * How many `default` conversations are read at once.
 *
 * The supplement is one read per agent, and an account with many agents would
 * otherwise open that many requests in a single `Promise.all`.
 */
const DEFAULT_CONVERSATION_READ_CONCURRENCY = 8;

const PREVIEW_MESSAGE_TYPES: MessageType[] = [
  "user_message",
  "assistant_message",
];

/**
 * The two snippets a preview read produces.
 *
 * `null` is the contract's "no such message" (the record's "not loaded yet" is
 * a record whose snippets are both `null` before the lazy read lands).
 */
export interface OverviewConversationPreview {
  lastUserMessage: string | null;
  lastAgentMessage: string | null;
}

export interface FetchOverviewSnapshotOptions {
  /** The snapshot's `generatedAtMs`; injected so tests and the cache share one clock. */
  nowMs?: number;
}

/** The agent fields the overview reads, without the SDK's full `AgentState`. */
interface OverviewAgentSource {
  id: string;
  name?: string | null;
  description?: string | null;
}

/** The conversation fields the overview reads. `hidden` is a runtime annotation. */
interface OverviewConversationSource {
  id: string;
  agent_id?: string | null;
  summary?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_message_at?: string | null;
  hidden?: boolean | null;
}

/** The message fields snippet extraction reads. */
interface OverviewMessageSource {
  message_type?: string | null;
  content?: unknown;
  date?: string | null;
  created_at?: string | null;
}

/**
 * Read the whole overview in one pass.
 *
 * Throws whatever the backend throws; `overview-data` wraps it in the retryable
 * error the page renders. A single failed `default` supplement does not fail the
 * snapshot — that conversation is simply absent, which is the same shape as an
 * agent whose `default` has no history.
 */
export async function fetchOverviewSnapshot(
  backend: Backend,
  options: FetchOverviewSnapshotOptions = {},
): Promise<OverviewSnapshot> {
  const generatedAtMs = options.nowMs ?? Date.now();

  const [agentPage, conversationPage] = await Promise.all([
    backend.listAgents({ limit: OVERVIEW_AGENT_LIST_LIMIT }),
    backend.listConversations({
      limit: OVERVIEW_CONVERSATION_LIST_LIMIT,
      order: "desc",
      order_by: "last_message_at",
    }),
  ]);

  const agents = pageItems<OverviewAgentSource>(agentPage);
  const conversations = pageItems<OverviewConversationSource>(conversationPage);
  // A full page is a lower bound, not a proof of equality: the backend never
  // says how many more rows it holds.
  const conversationListTruncated =
    conversations.length >= OVERVIEW_CONVERSATION_LIST_LIMIT;

  const agentIds = new Set(agents.map((agent) => agent.id));
  const grouped = new Map<string, OverviewConversationRecord[]>();
  for (const conversation of conversations) {
    if (conversation.hidden === true) continue; // Q-35
    const agentId = conversation.agent_id;
    // Agent-free conversations (and agents beyond the agent cap) have no first
    // level to hang from, so they cannot be shown and are not counted.
    if (!agentId || !agentIds.has(agentId)) continue;
    const record = toConversationRecord(conversation, agentId);
    const bucket = grouped.get(agentId);
    if (bucket) bucket.push(record);
    else grouped.set(agentId, [record]);
  }

  const built = await mapWithConcurrency(
    agents,
    DEFAULT_CONVERSATION_READ_CONCURRENCY,
    async (agent) => {
      const visible = grouped.get(agent.id) ?? [];
      const defaultConversation = await readDefaultConversation(
        backend,
        agent.id,
      );
      // The default conversation joins the same recency order as the listed
      // ones: R-10.3 orders the second level by last message time, and default
      // is a conversation like any other once it has history.
      const all = defaultConversation
        ? [...visible, defaultConversation]
        : [...visible];
      all.sort(compareConversationsByActivityDesc);
      const carried = all.slice(0, OVERVIEW_AGENT_CONVERSATION_LIMIT);
      const newestActivity = all[0]?.lastActivityAtMs ?? null;

      const record: OverviewAgentRecord = {
        agentId: agent.id,
        name: agent.name?.trim() || agent.id,
        description: normalizeDescription(agent.description),
        conversationCount: carried.length,
        totalConversationCount: all.length,
        conversationCountTruncated: conversationListTruncated,
        lastActivityAtMs: newestActivity,
      };
      return { record, conversations: carried };
    },
  );

  const ordered = [...built].sort((a, b) =>
    compareActivityDesc(a.record.lastActivityAtMs, b.record.lastActivityAtMs),
  );
  const conversationsByAgent: Record<
    string,
    readonly OverviewConversationRecord[]
  > = {};
  for (const entry of ordered) {
    conversationsByAgent[entry.record.agentId] = entry.conversations;
  }

  return {
    agents: ordered.map((entry) => entry.record),
    conversations: conversationsByAgent,
    generatedAtMs,
  };
}

/**
 * Read one conversation's newest user and agent message for the second level.
 *
 * One read per conversation per snapshot generation (R-10.8). The `desc` order
 * means the newest text of each role is the first one met, so the read never
 * needs the rest of the conversation.
 */
export async function fetchConversationPreview(
  backend: Backend,
  agentId: string,
  conversationId: string,
): Promise<OverviewConversationPreview> {
  const page = await backend.listConversationMessages(conversationId, {
    limit: OVERVIEW_PREVIEW_MESSAGE_LIMIT,
    order: "desc",
    include_return_message_types: PREVIEW_MESSAGE_TYPES,
    agent_id: agentId,
  });
  return previewFromMessages(pageItems<OverviewMessageSource>(page));
}

/**
 * The agent's `default` conversation, when it has history (Q-53).
 *
 * One read of the newest message answers both questions the second level needs:
 * does the conversation exist yet, and when did it last move. Snippets stay
 * lazy, exactly like every listed conversation's.
 *
 * A failed read is logged and treated as "no default": one agent's supplement
 * must not take the whole overview down.
 */
async function readDefaultConversation(
  backend: Backend,
  agentId: string,
): Promise<OverviewConversationRecord | null> {
  try {
    const page = await backend.listConversationMessages(
      OVERVIEW_DEFAULT_CONVERSATION_ID,
      { limit: 1, order: "desc", agent_id: agentId },
    );
    const newest = pageItems<OverviewMessageSource>(page)[0];
    if (!newest) return null;
    return {
      conversationId: OVERVIEW_DEFAULT_CONVERSATION_ID,
      agentId,
      title: OVERVIEW_DEFAULT_CONVERSATION_TITLE,
      lastActivityAtMs: messageTimestampMs(newest),
      createdAtMs: null,
      lastUserMessage: null,
      lastAgentMessage: null,
    };
  } catch (error) {
    debugLog(
      "Overview",
      "default conversation read failed; hiding that row",
      agentId,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function toConversationRecord(
  conversation: OverviewConversationSource,
  agentId: string,
): OverviewConversationRecord {
  return {
    conversationId: conversation.id,
    agentId,
    title: conversation.summary?.trim() || "Untitled",
    lastActivityAtMs:
      toMs(conversation.last_message_at) ??
      toMs(conversation.updated_at) ??
      toMs(conversation.created_at),
    createdAtMs: toMs(conversation.created_at),
    lastUserMessage: null,
    lastAgentMessage: null,
  };
}

function normalizeDescription(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Newest activity first; `null` (no known activity) sorts after every instant. */
function compareConversationsByActivityDesc(
  a: OverviewConversationRecord,
  b: OverviewConversationRecord,
): number {
  return compareActivityDesc(a.lastActivityAtMs, b.lastActivityAtMs);
}

function compareActivityDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function previewFromMessages(
  newestFirst: readonly OverviewMessageSource[],
): OverviewConversationPreview {
  let lastUserMessage: string | null = null;
  let lastAgentMessage: string | null = null;
  for (const message of newestFirst) {
    if (lastUserMessage !== null && lastAgentMessage !== null) break;
    if (message.message_type === "user_message" && lastUserMessage === null) {
      lastUserMessage = messageSnippet(message, "user");
    } else if (
      message.message_type === "assistant_message" &&
      lastAgentMessage === null
    ) {
      lastAgentMessage = messageSnippet(message, "agent");
    }
  }
  return { lastUserMessage, lastAgentMessage };
}

function messageSnippet(
  message: OverviewMessageSource,
  role: "user" | "agent",
): string | null {
  const texts = textParts(message.content);
  // A user message's newest text part is the user's own words; the agent's
  // first text part is its answer (tool calls around it are not shown).
  const ordered = role === "user" ? [...texts].reverse() : texts;
  for (const text of ordered) {
    if (role === "user" && isSystemReminderText(text)) continue;
    const snippet = normalizeSnippet(text);
    if (snippet) return snippet;
  }
  return null;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (
      record.type === "text" &&
      typeof record.text === "string" &&
      record.text
    ) {
      texts.push(record.text);
    }
  }
  return texts;
}

function isSystemReminderText(text: string): boolean {
  return (
    text.startsWith(SYSTEM_REMINDER_OPEN) || text.startsWith(SYSTEM_ALERT_OPEN)
  );
}

function normalizeSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > OVERVIEW_SNIPPET_MAX_LENGTH
    ? `${collapsed.slice(0, OVERVIEW_SNIPPET_MAX_LENGTH - 3)}...`
    : collapsed;
}

function messageTimestampMs(message: OverviewMessageSource): number | null {
  return toMs(message.date) ?? toMs(message.created_at);
}

/** An ISO string, a numeric instant, or nothing. */
function toMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * The SDK pages (`PagePromise`) expose `getPaginatedItems()`; the local backend
 * returns `{ items }`; a fake returns a plain array. All three are one shape here.
 */
function pageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const maybePage = page as {
      getPaginatedItems?: () => T[];
      items?: T[];
    };
    if (typeof maybePage.getPaginatedItems === "function") {
      return maybePage.getPaginatedItems();
    }
    if (Array.isArray(maybePage.items)) return maybePage.items;
  }
  return [];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await mapper(item);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
