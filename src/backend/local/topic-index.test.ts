/**
 * Topic-index coverage (requirement §5.11).
 *
 * The index is a derived view, so every claim here is "the derived file agrees
 * with the transcript" — never "the derived file is the truth". The fixtures are
 * written as raw transcript rows (not through `LocalBackend`) because that is
 * exactly what the reader sees on disk; the four update points are simulated by
 * the same operations the wiring performs (append a row, rewrite the in-context
 * list, copy markers into a fork, delete the conversation directory).
 *
 * Every test passes an explicit temporary `storageDir`. Nothing here may ever
 * reach the default root: the index is a new on-disk location, so a missed
 * argument would write into the user's real `~/.haruyuki/lc-local-backend`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queryTopicIndex,
  refreshTopicIndexForConversation,
  topicIndexPath,
} from "@/backend/local/topic-index";

const AGENT_ID = "agent-alpha";
const OTHER_AGENT_ID = "agent-beta";
const DAY_MS = 24 * 60 * 60 * 1000;

const temporaryDirectories: string[] = [];

function createStorageDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "topic-index-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface TopicRowInput {
  id: string;
  title: string;
  createdAt: string;
  createdBy?: "agent" | "user";
  summary?: string;
  anchorMessageId?: string | null;
}

function topicRow(input: TopicRowInput): Record<string, unknown> {
  return {
    type: "topic",
    id: input.id,
    parentId: null,
    timestamp: input.createdAt,
    title: input.title,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    createdBy: input.createdBy ?? "agent",
    anchorMessageId: input.anchorMessageId ?? null,
    turnsSincePrevious: 1,
  };
}

function sessionHeader(conversationId: string): Record<string, unknown> {
  return {
    type: "session",
    version: 3,
    id: conversationId,
    timestamp: new Date(0).toISOString(),
    cwd: "C:\\fixture",
  };
}

interface ConversationFixture {
  id: string;
  key?: string;
  agentId?: string;
  hidden?: boolean;
  inContextMessageIds?: string[];
}

function conversationDirectoryKey(conversation: ConversationFixture): string {
  return (
    conversation.key ??
    Buffer.from(`default:${conversation.agentId ?? AGENT_ID}`).toString(
      "base64url",
    )
  );
}

function conversationDirectoryPath(
  storageDir: string,
  conversation: ConversationFixture,
): string {
  return join(
    storageDir,
    "conversations",
    conversationDirectoryKey(conversation),
  );
}

/** Writes `conversation.json` plus a transcript made of the given rows. */
function writeConversation(
  storageDir: string,
  conversation: ConversationFixture,
  rows: readonly Record<string, unknown>[],
): void {
  const directory = conversationDirectoryPath(storageDir, conversation);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "conversation.json"),
    `${JSON.stringify({
      id: conversation.id,
      agent_id: conversation.agentId ?? AGENT_ID,
      ...(conversation.hidden === undefined
        ? {}
        : { hidden: conversation.hidden }),
      in_context_message_ids: conversation.inContextMessageIds ?? [],
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(directory, "messages.jsonl"),
    `${[sessionHeader(conversation.id), ...rows]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
    "utf8",
  );
}

function appendRows(
  storageDir: string,
  conversation: ConversationFixture,
  rows: readonly Record<string, unknown>[],
): void {
  appendFileSync(
    join(conversationDirectoryPath(storageDir, conversation), "messages.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

function rewriteConversationRecord(
  storageDir: string,
  conversation: ConversationFixture,
  patch: Record<string, unknown>,
): void {
  const path = join(
    conversationDirectoryPath(storageDir, conversation),
    "conversation.json",
  );
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(path, `${JSON.stringify({ ...current, ...patch })}\n`, "utf8");
}

function readIndexFile(storageDir: string, agentId = AGENT_ID): unknown {
  return JSON.parse(
    readFileSync(topicIndexPath(storageDir, agentId), "utf8"),
  ) as unknown;
}

const DEFAULT_CONVERSATION: ConversationFixture = { id: "default" };

describe("topicIndexPath", () => {
  test("is the single <storageDir>/agents/<agentId>.topics.json location", () => {
    expect(topicIndexPath("/store", "agent-x")).toBe(
      join("/store", "agents", "agent-x.topics.json"),
    );
  });

  test("refresh writes only that file, and creates no second index tree", () => {
    const storageDir = createStorageDirectory();
    writeConversation(storageDir, DEFAULT_CONVERSATION, [
      topicRow({ id: "t1", title: "First", createdAt: "2026-10-01T00:00:00Z" }),
    ]);

    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);

    expect(readdirSync(join(storageDir, "agents"))).toEqual([
      `${AGENT_ID}.topics.json`,
    ]);
    // The requirement document's earlier `topic-index/<agentId>.json` tree is
    // withdrawn; a change that reintroduces it must fail here.
    expect(existsSync(join(storageDir, "topic-index"))).toBe(false);
    // No temporary file survives a successful atomic write.
    expect(
      readdirSync(join(storageDir, "agents")).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });
});

describe("refreshTopicIndexForConversation", () => {
  test("indexes a conversation's markers so a query finds them immediately", () => {
    const storageDir = createStorageDirectory();
    writeConversation(storageDir, DEFAULT_CONVERSATION, [
      topicRow({
        id: "t1",
        title: "Deployment pipeline",
        createdAt: "2026-10-01T10:00:00Z",
        summary: "How releases are cut",
        anchorMessageId: "m3",
      }),
      topicRow({
        id: "t2",
        title: "Auth token refresh",
        createdAt: "2026-10-02T10:00:00Z",
        createdBy: "user",
        anchorMessageId: "m9",
      }),
    ]);
    rewriteConversationRecord(storageDir, DEFAULT_CONVERSATION, {
      in_context_message_ids: ["m3", "m9"],
    });

    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);

    expect(queryTopicIndex({ agentId: AGENT_ID, storageDir })).toEqual([
      {
        conversationId: "default",
        agentId: AGENT_ID,
        topicId: "t2",
        title: "Auth token refresh",
        createdAt: "2026-10-02T10:00:00Z",
        anchorMessageId: "m9",
        createdBy: "user",
        hidden: false,
        evicted: false,
      },
      {
        conversationId: "default",
        agentId: AGENT_ID,
        topicId: "t1",
        title: "Deployment pipeline",
        createdAt: "2026-10-01T10:00:00Z",
        anchorMessageId: "m3",
        createdBy: "agent",
        section: "How releases are cut",
        hidden: false,
        evicted: false,
      },
    ]);
  });

  test("merges conversations instead of replacing the agent file", () => {
    const storageDir = createStorageDirectory();
    const first: ConversationFixture = { id: "default" };
    const second: ConversationFixture = { id: "conv-2", key: "conv-2" };
    writeConversation(storageDir, first, [
      topicRow({
        id: "a1",
        title: "Alpha one",
        createdAt: "2026-10-01T00:00:00Z",
      }),
    ]);
    writeConversation(storageDir, second, [
      topicRow({
        id: "b1",
        title: "Beta one",
        createdAt: "2026-10-02T00:00:00Z",
      }),
    ]);

    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);
    refreshTopicIndexForConversation(AGENT_ID, "conv-2", storageDir);
    // A second refresh of the same conversation must be idempotent, and must not
    // drop the other conversation's slice.
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);

    const titles = queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
      (entry) => entry.title,
    );
    expect(titles).toEqual(["Beta one", "Alpha one"]);
  });

  test("a marker appended after the first refresh is visible after the next one", () => {
    const storageDir = createStorageDirectory();
    writeConversation(storageDir, DEFAULT_CONVERSATION, [
      topicRow({ id: "t1", title: "First", createdAt: "2026-10-01T00:00:00Z" }),
    ]);
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);

    appendRows(storageDir, DEFAULT_CONVERSATION, [
      topicRow({
        id: "t2",
        title: "Second",
        createdAt: "2026-10-02T00:00:00Z",
      }),
    ]);
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);

    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
        (entry) => entry.title,
      ),
    ).toEqual(["Second", "First"]);
  });

  test("a compaction write-back turns folded anchors into evicted entries", () => {
    const storageDir = createStorageDirectory();
    writeConversation(storageDir, DEFAULT_CONVERSATION, [
      topicRow({
        id: "t1",
        title: "Deployment pipeline",
        createdAt: "2026-10-01T00:00:00Z",
        anchorMessageId: "m3",
      }),
    ]);
    rewriteConversationRecord(storageDir, DEFAULT_CONVERSATION, {
      in_context_message_ids: ["m3", "m9"],
    });
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);
    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
        (entry) => entry.evicted,
      ),
    ).toEqual([false]);

    // The trim path: the folded topic's anchor leaves the context, and the
    // write-back records the folded topic's section as a new marker row.
    rewriteConversationRecord(storageDir, DEFAULT_CONVERSATION, {
      in_context_message_ids: ["summary-1"],
    });
    appendRows(storageDir, DEFAULT_CONVERSATION, [
      topicRow({
        id: "t1-section",
        title: "Deployment pipeline",
        createdAt: "2026-10-01T00:00:00Z",
        summary: "Release train: two approvals, then a tag.",
        anchorMessageId: "m3",
      }),
    ]);
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);

    const entries = queryTopicIndex({ agentId: AGENT_ID, storageDir });
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry.evicted).toBe(true);
    // The section is searchable, which is the point of §5.11.3 ②.
    expect(
      queryTopicIndex({
        agentId: AGENT_ID,
        storageDir,
        keyword: "two approvals",
      }).map((entry) => entry.section),
    ).toEqual(["Release train: two approvals, then a tag."]);
  });

  test("a fork's copied markers index separately from the source", () => {
    const storageDir = createStorageDirectory();
    const source: ConversationFixture = {
      id: "default",
      inContextMessageIds: ["m-source"],
    };
    const fork: ConversationFixture = { id: "conv-fork", key: "conv-fork" };
    writeConversation(storageDir, source, [
      topicRow({
        id: "src-1",
        title: "Inherited topic",
        createdAt: "2026-10-01T00:00:00Z",
        anchorMessageId: "m-source",
      }),
    ]);
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);

    // `copyTopicMarkersForFork` clones the rows with fresh entry ids and remapped
    // anchors.
    writeConversation(
      storageDir,
      { ...fork, inContextMessageIds: ["m-fork"] },
      [
        topicRow({
          id: "fork-1",
          title: "Inherited topic",
          createdAt: "2026-10-01T00:00:00Z",
          anchorMessageId: "m-fork",
        }),
      ],
    );
    refreshTopicIndexForConversation(AGENT_ID, "conv-fork", storageDir);

    const entries = queryTopicIndex({ agentId: AGENT_ID, storageDir });
    expect(entries.map((entry) => entry.topicId).sort()).toEqual([
      "fork-1",
      "src-1",
    ]);
    expect(entries.every((entry) => entry.evicted === false)).toBe(true);
    expect(
      queryTopicIndex({
        agentId: AGENT_ID,
        storageDir,
        conversationId: "conv-fork",
      }).map((entry) => entry.topicId),
    ).toEqual(["fork-1"]);
  });

  test("deleting the conversation removes its entries on the delete refresh", () => {
    const storageDir = createStorageDirectory();
    const doomed: ConversationFixture = {
      id: "conv-doomed",
      key: "conv-doomed",
    };
    const kept: ConversationFixture = { id: "default" };
    writeConversation(storageDir, doomed, [
      topicRow({
        id: "d1",
        title: "Doomed",
        createdAt: "2026-10-01T00:00:00Z",
      }),
    ]);
    writeConversation(storageDir, kept, [
      topicRow({ id: "k1", title: "Kept", createdAt: "2026-10-02T00:00:00Z" }),
    ]);
    refreshTopicIndexForConversation(AGENT_ID, "conv-doomed", storageDir);
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);

    rmSync(conversationDirectoryPath(storageDir, doomed), {
      recursive: true,
      force: true,
    });
    refreshTopicIndexForConversation(AGENT_ID, "conv-doomed", storageDir);

    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
        (entry) => entry.title,
      ),
    ).toEqual(["Kept"]);
  });

  test("never indexes a conversation that belongs to another agent", () => {
    const storageDir = createStorageDirectory();
    const foreign: ConversationFixture = {
      id: "conv-foreign",
      key: "conv-foreign",
      agentId: OTHER_AGENT_ID,
    };
    writeConversation(storageDir, foreign, [
      topicRow({
        id: "f1",
        title: "Foreign",
        createdAt: "2026-10-01T00:00:00Z",
      }),
    ]);

    refreshTopicIndexForConversation(AGENT_ID, "conv-foreign", storageDir);

    expect(queryTopicIndex({ agentId: AGENT_ID, storageDir })).toEqual([]);
    expect(existsSync(topicIndexPath(storageDir, AGENT_ID))).toBe(false);
  });

  test("resolves the agent's own `default` when another agent has one too", () => {
    const storageDir = createStorageDirectory();
    // Both agents own a conversation whose id is "default"; only the directory
    // key tells them apart, so a lookup by id alone would take whichever
    // directory came first on disk.
    writeConversation(storageDir, { id: "default" }, [
      topicRow({
        id: "mine",
        title: "Mine",
        createdAt: "2026-10-01T00:00:00Z",
      }),
    ]);
    writeConversation(storageDir, { id: "default", agentId: OTHER_AGENT_ID }, [
      topicRow({
        id: "theirs",
        title: "Theirs",
        createdAt: "2026-10-02T00:00:00Z",
      }),
    ]);

    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);
    refreshTopicIndexForConversation(OTHER_AGENT_ID, "default", storageDir);

    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
        (entry) => entry.topicId,
      ),
    ).toEqual(["mine"]);
    expect(
      queryTopicIndex({ agentId: OTHER_AGENT_ID, storageDir }).map(
        (entry) => entry.topicId,
      ),
    ).toEqual(["theirs"]);
  });
});

describe("queryTopicIndex", () => {
  function seededStorage(): string {
    const storageDir = createStorageDirectory();
    const hidden: ConversationFixture = {
      id: "conv-hidden",
      key: "conv-hidden",
      hidden: true,
    };
    writeConversation(storageDir, DEFAULT_CONVERSATION, [
      topicRow({
        id: "t1",
        title: "Deployment pipeline",
        createdAt: new Date(Date.now() - DAY_MS).toISOString(),
        summary: "Rollout plan and approvals",
      }),
      topicRow({
        id: "old",
        title: "Ancient history",
        createdAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
      }),
    ]);
    writeConversation(storageDir, hidden, [
      topicRow({
        id: "h1",
        title: "Private topic",
        createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      }),
    ]);
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);
    refreshTopicIndexForConversation(AGENT_ID, "conv-hidden", storageDir);
    return storageDir;
  }

  test("excludes hidden conversations unless one is named", () => {
    const storageDir = seededStorage();

    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
        (entry) => entry.topicId,
      ),
    ).not.toContain("h1");
    expect(
      queryTopicIndex({
        agentId: AGENT_ID,
        storageDir,
        conversationId: "conv-hidden",
      }).map((entry) => entry.topicId),
    ).toEqual(["h1"]);
  });

  test("matches the title and the section, case-insensitively", () => {
    const storageDir = seededStorage();
    const ids = (filters: { keyword: string }) =>
      queryTopicIndex({ agentId: AGENT_ID, storageDir, ...filters }).map(
        (entry) => entry.topicId,
      );

    expect(ids({ keyword: "DEPLOYMENT" })).toEqual(["t1"]);
    expect(ids({ keyword: "approvals" })).toEqual(["t1"]);
    expect(ids({ keyword: "rollout approval" })).toEqual(["t1"]);
    // Terms are ANDed across the title *and* the section, so a term from each
    // field still matches one topic; a term that appears in neither does not.
    expect(ids({ keyword: "rollout pipeline" })).toEqual(["t1"]);
    expect(ids({ keyword: "rollout nothing-here" })).toEqual([]);
    expect(ids({ keyword: "nothing-here" })).toEqual([]);
  });

  test("filters by age and keeps only the newest limit", () => {
    const storageDir = seededStorage();

    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir, days: 7 }).map(
        (entry) => entry.topicId,
      ),
    ).toEqual(["t1"]);
    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir, limit: 1 }).map(
        (entry) => entry.topicId,
      ),
    ).toEqual(["t1"]);
    // A non-positive or non-finite `days` is not a filter.
    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir, days: 0 }),
    ).toHaveLength(2);
  });

  test("answers empty, without creating a file, for an agent that has no index", () => {
    const storageDir = seededStorage();
    const stranger = "agent-unknown";

    expect(queryTopicIndex({ agentId: stranger, storageDir })).toEqual([]);
    expect(existsSync(topicIndexPath(storageDir, stranger))).toBe(false);
  });
});

describe("query-time self-healing", () => {
  function oneTopicStorage(): string {
    const storageDir = createStorageDirectory();
    writeConversation(storageDir, DEFAULT_CONVERSATION, [
      topicRow({ id: "t1", title: "First", createdAt: "2026-10-01T00:00:00Z" }),
    ]);
    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);
    return storageDir;
  }

  test("rebuilds when the transcript grew behind the index's back", () => {
    const storageDir = oneTopicStorage();
    appendRows(storageDir, DEFAULT_CONVERSATION, [
      topicRow({
        id: "t2",
        title: "Written elsewhere",
        createdAt: "2026-10-05T00:00:00Z",
      }),
    ]);

    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
        (entry) => entry.title,
      ),
    ).toEqual(["Written elsewhere", "First"]);
  });

  test("repairs a record whose entries no longer agree with its signature", () => {
    const storageDir = oneTopicStorage();
    const path = topicIndexPath(storageDir, AGENT_ID);
    const tampered = JSON.parse(readFileSync(path, "utf8")) as {
      conversations: Record<string, { entries: unknown[] }>;
    };
    const record = tampered.conversations.default;
    if (!record) throw new Error("fixture has no default record");
    record.entries = [];
    writeFileSync(path, `${JSON.stringify(tampered)}\n`, "utf8");

    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
        (entry) => entry.title,
      ),
    ).toEqual(["First"]);
    // The healed file is written back, so the repair is not repeated every query.
    const healed = readIndexFile(storageDir) as {
      conversations: Record<string, { entries: unknown[] }>;
    };
    expect(healed.conversations.default?.entries).toHaveLength(1);
  });

  test("drops a deleted conversation without waiting for a refresh", () => {
    const storageDir = oneTopicStorage();
    rmSync(conversationDirectoryPath(storageDir, DEFAULT_CONVERSATION), {
      recursive: true,
      force: true,
    });

    expect(queryTopicIndex({ agentId: AGENT_ID, storageDir })).toEqual([]);
  });

  test("a deleted index reads as empty and is restored by the next refresh", () => {
    const storageDir = oneTopicStorage();
    rmSync(topicIndexPath(storageDir, AGENT_ID), { force: true });

    expect(queryTopicIndex({ agentId: AGENT_ID, storageDir })).toEqual([]);
    expect(existsSync(topicIndexPath(storageDir, AGENT_ID))).toBe(false);

    refreshTopicIndexForConversation(AGENT_ID, "default", storageDir);
    expect(
      queryTopicIndex({ agentId: AGENT_ID, storageDir }).map(
        (entry) => entry.title,
      ),
    ).toEqual(["First"]);
  });

  test("a corrupt index file reads as empty rather than throwing", () => {
    const storageDir = oneTopicStorage();
    writeFileSync(topicIndexPath(storageDir, AGENT_ID), "{not json", "utf8");

    expect(queryTopicIndex({ agentId: AGENT_ID, storageDir })).toEqual([]);
  });

  test("a marker in a conversation reassigned to another agent is dropped", () => {
    const storageDir = oneTopicStorage();
    rewriteConversationRecord(storageDir, DEFAULT_CONVERSATION, {
      agent_id: OTHER_AGENT_ID,
    });

    expect(queryTopicIndex({ agentId: AGENT_ID, storageDir })).toEqual([]);
  });
});
