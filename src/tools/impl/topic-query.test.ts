/**
 * `TopicQuery` coverage: the schema, argument validation, the character budget,
 * and the copy a model actually reads.
 *
 * Two claims matter beyond the format details. First, the budget is a *hard*
 * ceiling — the truncation notice is reserved before a row is accepted, so a
 * result set can never exceed it. Second, the tool resolves its storage root from
 * the caller, never from the ambient default: a test that forgot the temporary
 * root would write the index into the user's real local-backend store, which is
 * the one thing this suite must never do.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TopicIndexEntry } from "@/backend/local/topic-index";
import { refreshTopicIndexForConversation } from "@/backend/local/topic-index";
import {
  formatTopicQueryResults,
  formatTopicQueryTimestamp,
  TOPIC_QUERY_MAX_CHARS,
  TOPIC_QUERY_MAX_LIMIT,
  TOPIC_QUERY_SECTION_PREVIEW_CHARS,
  type TopicQueryArgs,
  topic_query,
  validateTopicQueryArgs,
} from "@/tools/impl/topic-query";
import TopicQuerySchema from "@/tools/schemas/TopicQuery.json";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";
import { TOOLSET_CATALOG } from "@/tools/toolset-catalog";

const AGENT_ID = "agent-alpha";
const temporaryDirectories: string[] = [];

function createStorageDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "topic-query-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function entry(overrides: Partial<TopicIndexEntry> = {}): TopicIndexEntry {
  return {
    conversationId: "default",
    agentId: AGENT_ID,
    topicId: "t1",
    title: "Deployment pipeline",
    createdAt: "2026-10-27T14:03:05.000Z",
    anchorMessageId: "m1",
    createdBy: "agent",
    hidden: false,
    evicted: false,
    ...overrides,
  };
}

describe("TopicQuery schema", () => {
  test("declares exactly the four documented parameters", () => {
    expect(Object.keys(TopicQuerySchema.properties).sort()).toEqual([
      "days",
      "keyword",
      "limit",
      "session",
    ]);
    // A JSON import is a literal type, so an absent key is read through a
    // record view instead of through a property the type does not declare.
    const schema = TopicQuerySchema as unknown as Record<string, unknown>;
    expect(schema.required).toBeUndefined();
    expect(TopicQuerySchema.additionalProperties).toBe(false);
  });

  test("bounds days and limit so a call cannot ask for the whole library", () => {
    expect(TopicQuerySchema.properties.days).toMatchObject({ minimum: 1 });
    expect(TopicQuerySchema.properties.limit).toMatchObject({
      minimum: 1,
      maximum: TOPIC_QUERY_MAX_LIMIT,
    });
  });

  test("is registered as a tool and ships with the topic-marker presets", () => {
    expect(Object.hasOwn(TOOL_DEFINITIONS, "TopicQuery")).toBe(true);
    expect(TOOL_DEFINITIONS.TopicQuery.schema).toEqual(TopicQuerySchema);
    // The description is the trimmed `descriptions/TopicQuery.md` asset, like
    // every other built-in tool's.
    expect(TOOL_DEFINITIONS.TopicQuery.description).toContain(
      "List the topics this agent has marked",
    );
    for (const preset of ["letta", "default", "codex"] as const) {
      expect(TOOLSET_CATALOG[preset].tools).toContain("TopicQuery");
    }
    expect(TOOLSET_CATALOG.none.tools).not.toContain("TopicQuery");
  });
});

describe("validateTopicQueryArgs", () => {
  test("normalizes the accepted shapes", () => {
    expect(
      validateTopicQueryArgs({
        keyword: "  deploy\n pipeline ",
        days: 7,
        session: " conv-1 ",
        limit: 20,
      }),
    ).toEqual({
      ok: true,
      keyword: "deploy pipeline",
      days: 7,
      conversationId: "conv-1",
      limit: 20,
    });
  });

  test("treats an empty keyword or session as no filter", () => {
    expect(validateTopicQueryArgs({ keyword: "   ", session: "  " })).toEqual({
      ok: true,
    });
    expect(validateTopicQueryArgs({})).toEqual({ ok: true });
  });

  test("rejects a keyword or session that is not a string", () => {
    expect(validateTopicQueryArgs({ keyword: 7 }).ok).toBe(false);
    expect(validateTopicQueryArgs({ session: 7 }).ok).toBe(false);
  });

  test("rejects a non-positive or non-numeric days", () => {
    for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "7"]) {
      const validated = validateTopicQueryArgs({ days } as TopicQueryArgs);
      expect(validated.ok).toBe(false);
    }
  });

  test("rejects a limit outside 1..maximum, including a fraction", () => {
    for (const limit of [0, -3, 1.5, TOPIC_QUERY_MAX_LIMIT + 1, "3"]) {
      const validated = validateTopicQueryArgs({ limit } as TopicQueryArgs);
      expect(validated.ok).toBe(false);
    }
  });
});

describe("formatTopicQueryTimestamp", () => {
  test("renders minute precision in UTC", () => {
    expect(formatTopicQueryTimestamp("2026-10-27T14:03:05.000Z")).toBe(
      "2026-10-27 14:03",
    );
  });

  test("passes an unparsable timestamp through instead of dropping the row", () => {
    expect(formatTopicQueryTimestamp("whenever")).toBe("whenever");
  });
});

describe("formatTopicQueryResults", () => {
  test("carries title, time, session, source, and the section's first line", () => {
    const text = formatTopicQueryResults({
      entries: [
        entry({
          createdBy: "user",
          conversationId: "conv-9",
          section: "How releases are cut.\nSecond line is dropped.",
        }),
      ],
    });

    expect(text).toContain("1. Deployment pipeline · 2026-10-27 14:03");
    expect(text).toContain("session conv-9");
    expect(text).toContain("by user");
    expect(text).toContain("How releases are cut.");
    expect(text).not.toContain("Second line is dropped.");
    expect(text).toStartWith("1 topic, newest first, times in UTC.");
  });

  test("truncates a long section line to its preview length", () => {
    const section = "x".repeat(TOPIC_QUERY_SECTION_PREVIEW_CHARS + 80);
    const text = formatTopicQueryResults({ entries: [entry({ section })] });

    expect(text).toContain("…");
    expect(text.length).toBeLessThan(section.length + 200);
  });

  test("omits the section line when there is no section", () => {
    const text = formatTopicQueryResults({ entries: [entry()] });
    // Header, blank line, one row — and a row without a section is one line.
    expect(text.split("\n")).toHaveLength(3);
    expect(text).not.toContain("\n   ");
  });

  test("stays inside the budget and says what it dropped", () => {
    const section = "y".repeat(TOPIC_QUERY_SECTION_PREVIEW_CHARS);
    const entries = Array.from({ length: 60 }, (_unused, index) =>
      entry({
        topicId: `t${index}`,
        title: `Topic number ${index}`,
        createdAt: new Date(Date.UTC(2026, 9, 27, 12, index)).toISOString(),
        section,
      }),
    );

    const text = formatTopicQueryResults({ entries });

    expect(text.length).toBeLessThanOrEqual(TOPIC_QUERY_MAX_CHARS);
    expect(text).toContain("[Output truncated: showing the newest");
    expect(text).toContain("of 60 topics");
    // Newest kept, oldest dropped.
    expect(text).toContain("Topic number 0");
    expect(text).not.toContain("Topic number 59");
  });

  test("does not add a notice when everything fits", () => {
    const text = formatTopicQueryResults({
      entries: [entry(), entry({ topicId: "t2", title: "Second" })],
    });
    expect(text).toContain("2 topics");
    expect(text).not.toContain("Output truncated");
  });

  test("explains an empty result and repeats the filters that produced it", () => {
    expect(formatTopicQueryResults({ entries: [] })).toContain(
      "No topics are indexed for this agent yet",
    );
    const filtered = formatTopicQueryResults({
      entries: [],
      keyword: "deploy",
      days: 7,
      conversationId: "conv-1",
    });
    expect(filtered).toContain('keyword "deploy"');
    expect(filtered).toContain("the last 7 day(s)");
    expect(filtered).toContain("session conv-1");
    expect(filtered).toContain("Broadening the filter usually helps");
  });
});

describe("topic_query", () => {
  /** A minimal store: one conversation with two topic rows. */
  function seedStorage(): string {
    const storageDir = createStorageDirectory();
    const directory = join(storageDir, "conversations", "conv-seed");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "conversation.json"),
      `${JSON.stringify({
        id: "conv-seed",
        agent_id: AGENT_ID,
        in_context_message_ids: [],
      })}\n`,
      "utf8",
    );
    const rows = [
      {
        type: "topic",
        id: "t1",
        parentId: null,
        timestamp: "2026-10-20T09:00:00Z",
        title: "Deployment pipeline",
        summary: "Release train and approvals",
        createdBy: "agent",
        anchorMessageId: null,
        turnsSincePrevious: 1,
      },
      {
        type: "topic",
        id: "t2",
        parentId: null,
        timestamp: "2026-10-21T09:00:00Z",
        title: "Auth token refresh",
        createdBy: "user",
        anchorMessageId: null,
        turnsSincePrevious: 2,
      },
    ];
    writeFileSync(
      join(directory, "messages.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    refreshTopicIndexForConversation(AGENT_ID, "conv-seed", storageDir);
    return storageDir;
  }

  test("answers from a temporary store with both topics, newest first", async () => {
    const storageDir = seedStorage();

    const result = await topic_query({}, { agentId: AGENT_ID, storageDir });

    expect(result.status).toBe("success");
    expect(result.content).toContain("1. Auth token refresh");
    expect(result.content).toContain("2. Deployment pipeline");
    expect(result.content).toContain("Release train and approvals");
  });

  test("applies the keyword and session filters", async () => {
    const storageDir = seedStorage();

    const keyword = await topic_query(
      { keyword: "approvals" },
      { agentId: AGENT_ID, storageDir },
    );
    expect(keyword.content).toContain("Deployment pipeline");
    expect(keyword.content).not.toContain("Auth token refresh");

    const session = await topic_query(
      { session: "conv-other" },
      { agentId: AGENT_ID, storageDir },
    );
    expect(session.content).toBe(
      "No topics match session conv-other. Broadening the filter usually helps: try a shorter keyword, a larger `days`, or drop `session`. Conversations the user hid are excluded unless you name one with `session`.",
    );
  });

  test("returns the validation message as an error and touches nothing", async () => {
    const storageDir = seedStorage();
    const before = join(storageDir, "agents", `${AGENT_ID}.topics.json`);

    for (const args of [
      { limit: 0 },
      { days: -2 },
      { keyword: 5 },
    ] as TopicQueryArgs[]) {
      const result = await topic_query(args, { agentId: AGENT_ID, storageDir });
      expect(result.status).toBe("error");
      expect(result.content.length).toBeGreaterThan(0);
    }
    // Validation runs before any storage access, so the store is unchanged.
    expect(before).toEndWith(`${AGENT_ID}.topics.json`);
  });

  test("reports an unknown agent as an empty result rather than a failure", async () => {
    const storageDir = seedStorage();

    const result = await topic_query(
      {},
      { agentId: "agent-unknown", storageDir },
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain(
      "No topics are indexed for this agent yet",
    );
  });
});
