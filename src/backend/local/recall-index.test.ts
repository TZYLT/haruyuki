import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION,
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
  LOCAL_TRANSCRIPT_SCHEMA_VERSION,
} from "@/backend/local/local-transcript";
import {
  ensureConversationIndex,
  ingestConversation,
  loadRecallCorpus,
  RECALL_INDEX_FILENAME,
  type RecallCorpusRecord,
  readRecallIndex,
  readSourceSignature,
  rebuildConversationIndex,
  recallIndexPath,
  stripReminderBlocks,
} from "@/backend/local/recall-index";
import {
  parseQuery,
  rankMatches,
  tokenize,
} from "@/backend/local/transcript-search";

const AGENT_ID = "agent-recall";

function modernManifest(): unknown {
  return {
    schema_version: LOCAL_TRANSCRIPT_SCHEMA_VERSION,
    message_format: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
    provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function legacyManifest(): unknown {
  return {
    schema_version: LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION,
    message_format: LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
    provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function text(value: string): { type: "text"; text: string } {
  return { type: "text", text: value };
}

function messageRow(
  id: string,
  role: string,
  content: unknown,
  second: number,
  timestamp = `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
): unknown {
  return {
    type: "message",
    id: `row-${id}-${second}`,
    parentId: null,
    timestamp,
    message: { id, role, content },
  };
}

async function writeFixture(input: {
  storageDir: string;
  directory: string;
  conversationId: string;
  agentId?: string;
  hidden?: boolean;
  rows: unknown[];
  manifest?: unknown;
}): Promise<string> {
  const conversationDir = join(
    input.storageDir,
    "conversations",
    input.directory,
  );
  await mkdir(conversationDir, { recursive: true });
  await writeFile(
    join(conversationDir, "conversation.json"),
    `${JSON.stringify({
      id: input.conversationId,
      agent_id: input.agentId ?? AGENT_ID,
      ...(input.hidden ? { hidden: true } : {}),
    })}\n`,
  );
  await writeFile(
    join(conversationDir, "manifest.json"),
    `${JSON.stringify(input.manifest ?? modernManifest())}\n`,
  );
  await writeFile(
    join(conversationDir, "messages.jsonl"),
    `${input.rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return conversationDir;
}

function alphaRows(): unknown[] {
  return [
    messageRow("m-1", "user", [text("记忆库索引的签名设计")], 1),
    messageRow(
      "m-2",
      "assistant",
      [
        text("签名只作漂移嗅探"),
        { type: "toolCall", name: "Bash", arguments: "工具调用不该被索引" },
      ],
      2,
    ),
    messageRow(
      "m-3",
      "user",
      [
        { type: "thinking", thinking: "思考内容不该被索引" },
        text("用户正文保留"),
      ],
      3,
    ),
    messageRow("m-4", "toolResult", [text("工具结果不该被索引")], 4),
    messageRow(
      "m-5",
      "user",
      [text("<system-reminder>注入的提醒块</system-reminder>")],
      5,
    ),
    messageRow(
      "m-6",
      "user",
      [text("<system-reminder>提醒</system-reminder>真正的用户问题")],
      6,
    ),
    messageRow(
      "m-7",
      "user",
      [text("引用未闭合标签 <system-reminder> 的正文")],
      7,
    ),
    messageRow("m-8", "user", [text("我养了一只猫，它叫小白。")], 8),
    messageRow(
      "m-9",
      "user",
      [text("记忆库索引的签名设计 记忆库索引的签名设计")],
      9,
    ),
    messageRow("m-10", "user", [text("旧版本正文")], 10),
    messageRow("m-10", "user", [text("新版本正文")], 11),
    {
      type: "compaction",
      id: "row-c-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:12.000Z",
      summary: "压缩摘要不该被索引",
      firstKeptEntryId: null,
      tokensBefore: 10,
      message: {
        id: "c-1",
        role: "user",
        content: [text("压缩摘要不该被索引")],
      },
    },
  ];
}

async function withFixture(
  run: (input: {
    storageDir: string;
    alphaDir: string;
    betaDir: string;
  }) => Promise<void>,
): Promise<void> {
  const storageDir = await mkdtemp(join(tmpdir(), "recall-index-"));
  try {
    const alphaDir = await writeFixture({
      storageDir,
      directory: "alpha",
      conversationId: "conv-alpha",
      rows: alphaRows(),
    });
    const betaDir = await writeFixture({
      storageDir,
      directory: "beta",
      conversationId: "conv-beta",
      rows: [
        messageRow(
          "b-1",
          "user",
          [text("贝塔会话的记忆库索引")],
          1,
          "2026-01-02T00:00:01.000Z",
        ),
      ],
    });
    await run({ storageDir, alphaDir, betaDir });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
}

function rankedIds(records: RecallCorpusRecord[], query: string): string[] {
  return rankMatches(records, parseQuery(query))
    .sort((a, b) =>
      a.score !== b.score
        ? b.score - a.score
        : b.timestamp.localeCompare(a.timestamp),
    )
    .map((record) => record.messageId);
}

describe("conversation recall index", () => {
  test("keeps only user and assistant text and drops reminder blocks", async () => {
    await withFixture(async ({ alphaDir }) => {
      const sidecar = ingestConversation({
        conversationDir: alphaDir,
        identity: {
          conversationKey: "alpha",
          conversationId: "conv-alpha",
          agentId: AGENT_ID,
        },
      });
      const ids = sidecar.records.map((record) => record.id);

      // m-4 is a tool result, m-5 was reminder-only, m-10 was appended twice.
      expect(ids).toEqual([
        "m-1",
        "m-2",
        "m-3",
        "m-6",
        "m-7",
        "m-8",
        "m-9",
        "m-10",
      ]);
      expect(sidecar.lineCount).toBe(alphaRows().length);
      expect(sidecar.records.find((record) => record.id === "m-10")?.nt).toBe(
        tokenize("新版本正文").join(" "),
      );

      const everything = sidecar.records.map((record) => record.nt).join("\n");
      for (const excluded of [
        "工具调用不该被索引",
        "工具结果不该被索引",
        "思考内容不该被索引",
        "压缩摘要不该被索引",
        "注入的提醒块",
      ]) {
        expect(everything).not.toContain(tokenize(excluded).join(" "));
      }
      // The reminder is removed, the user's own words in the same message stay.
      expect(everything).toContain(tokenize("真正的用户问题").join(" "));
      // An unpaired tag is a quotation, not an injected block.
      expect(everything).toContain(tokenize("<system-reminder>").join(" "));
    });
  });

  test("tokenizes nt with the transcript search tokenizer", async () => {
    expect(tokenize("我养了一只猫，它叫小白。")).toEqual([
      "我养了一只猫",
      "它叫小白",
    ]);

    await withFixture(async ({ alphaDir }) => {
      const sidecar = ingestConversation({
        conversationDir: alphaDir,
        identity: {
          conversationKey: "alpha",
          conversationId: "conv-alpha",
          agentId: AGENT_ID,
        },
      });
      for (const record of sidecar.records) {
        expect(record.nt.split(" ")).toEqual(
          tokenize(record.nt ? record.nt.split(" ").join(" ") : ""),
        );
      }
      expect(sidecar.records.find((record) => record.id === "m-8")?.nt).toBe(
        tokenize("我养了一只猫，它叫小白。").join(" "),
      );
    });
  });

  test("strips only paired reminder blocks", () => {
    expect(
      stripReminderBlocks("<system-reminder>a</system-reminder>正文"),
    ).toBe("正文");
    expect(
      stripReminderBlocks(
        "前缀<system-reminder>x</system-reminder>中缀<system-reminder>y</system-reminder>后缀",
      ),
    ).toBe("前缀中缀后缀");
    expect(stripReminderBlocks("引用 <system-reminder> 未闭合")).toBe(
      "引用 <system-reminder> 未闭合",
    );
  });

  test("writes the sidecar into the conversation directory and reads it back", async () => {
    await withFixture(async ({ alphaDir }) => {
      const rebuilt = rebuildConversationIndex({
        conversationDir: alphaDir,
        identity: {
          conversationKey: "alpha",
          conversationId: "conv-alpha",
          agentId: AGENT_ID,
        },
      });
      expect("sidecar" in rebuilt).toBe(true);
      expect(existsSync(join(alphaDir, RECALL_INDEX_FILENAME))).toBe(true);

      const read = readRecallIndex(alphaDir);
      expect("sidecar" in read).toBe(true);
      if (!("sidecar" in read)) return;
      expect(read.sidecar.records.length).toBe(8);
      expect(read.sidecar.conversationId).toBe("conv-alpha");
      expect(readSourceSignature(alphaDir)).toEqual(read.sidecar.signature);

      const raw = await readFile(recallIndexPath(alphaDir), "utf8");
      expect(JSON.parse(raw).version).toBe(1);
    });
  });

  test("reports a missing index as unavailable without writing one", async () => {
    await withFixture(async ({ storageDir, alphaDir }) => {
      const resolution = ensureConversationIndex({
        conversationDir: alphaDir,
        identity: {
          conversationKey: "alpha",
          conversationId: "conv-alpha",
          agentId: AGENT_ID,
        },
      });
      expect(resolution.status).toBe("unavailable");
      expect(resolution.sidecar).toBeUndefined();
      expect(existsSync(recallIndexPath(alphaDir))).toBe(false);

      const corpus = loadRecallCorpus(storageDir);
      expect(corpus.records).toEqual([]);
      expect(corpus.conversations).toBe(2);
      expect(corpus.maintenance.unavailable).toBe(2);
      expect(corpus.unavailable.length).toBe(2);
    });
  });

  test("reports a corrupt index as unavailable and leaves it alone", async () => {
    await withFixture(async ({ alphaDir }) => {
      await writeFile(recallIndexPath(alphaDir), "{ not json");

      const resolution = ensureConversationIndex({
        conversationDir: alphaDir,
        identity: {
          conversationKey: "alpha",
          conversationId: "conv-alpha",
          agentId: AGENT_ID,
        },
      });
      expect(resolution.status).toBe("unavailable");
      expect(await readFile(recallIndexPath(alphaDir), "utf8")).toBe(
        "{ not json",
      );

      // A schema mismatch is reported the same way.
      await writeFile(
        recallIndexPath(alphaDir),
        `${JSON.stringify({ version: 99, records: [] })}\n`,
      );
      expect(readRecallIndex(alphaDir)).toEqual({
        error: "recall index does not match its schema",
      });
    });
  });

  test("rebuilds only the conversation whose transcript moved", async () => {
    await withFixture(async ({ storageDir, alphaDir, betaDir }) => {
      for (const dir of [alphaDir, betaDir]) {
        rebuildConversationIndex({
          conversationDir: dir,
          identity: {
            conversationKey: dir.endsWith("alpha") ? "alpha" : "beta",
            conversationId: dir.endsWith("alpha") ? "conv-alpha" : "conv-beta",
            agentId: AGENT_ID,
          },
        });
      }

      const first = loadRecallCorpus(storageDir);
      expect(first.maintenance.ready).toBe(2);
      expect(first.records.length).toBe(9);

      await writeFile(
        join(alphaDir, "messages.jsonl"),
        `${JSON.stringify(messageRow("m-11", "user", [text("新增的一条记忆库索引")], 20))}\n`,
        { flag: "a" },
      );

      const second = loadRecallCorpus(storageDir);
      expect(second.maintenance.rebuilt).toBe(1);
      expect(second.maintenance.ready).toBe(1);
      expect(second.records.length).toBe(10);
      expect(second.records.some((record) => record.messageId === "m-11")).toBe(
        true,
      );
    });
  });

  test("never refreshes the current conversation lazily", async () => {
    await withFixture(async ({ storageDir, alphaDir }) => {
      rebuildConversationIndex({
        conversationDir: alphaDir,
        identity: {
          conversationKey: "alpha",
          conversationId: "conv-alpha",
          agentId: AGENT_ID,
        },
      });
      await writeFile(
        join(alphaDir, "messages.jsonl"),
        `${JSON.stringify(messageRow("m-11", "user", [text("新增的一条记忆库索引")], 20))}\n`,
        { flag: "a" },
      );

      const corpus = loadRecallCorpus(storageDir, {
        currentConversationId: "conv-alpha",
      });
      expect(corpus.maintenance.exempt).toBe(1);
      expect(corpus.records.some((record) => record.messageId === "m-11")).toBe(
        false,
      );
      // The transcript really did move; only the exemption kept the index stale.
      expect(readRecallIndex(alphaDir)).toBeDefined();

      const withoutExemption = loadRecallCorpus(storageDir);
      expect(withoutExemption.maintenance.rebuilt).toBe(1);
      expect(
        withoutExemption.records.some((record) => record.messageId === "m-11"),
      ).toBe(true);
    });
  });

  test("loads the full corpus and never refreshes when maintenance is off", async () => {
    await withFixture(async ({ storageDir, alphaDir, betaDir }) => {
      for (const dir of [alphaDir, betaDir]) {
        rebuildConversationIndex({
          conversationDir: dir,
          identity: {
            conversationKey: dir.endsWith("alpha") ? "alpha" : "beta",
            conversationId: dir.endsWith("alpha") ? "conv-alpha" : "conv-beta",
            agentId: AGENT_ID,
          },
        });
      }
      await writeFile(
        join(alphaDir, "messages.jsonl"),
        `${JSON.stringify(messageRow("m-11", "user", [text("新增的一条记忆库索引")], 20))}\n`,
        { flag: "a" },
      );

      const corpus = loadRecallCorpus(storageDir, { maintain: false });
      expect(corpus.maintenance.stale).toBe(1);
      expect(corpus.maintenance.ready).toBe(1);
      // Every indexed record is loaded; nothing is pre-filtered by a query.
      expect(corpus.records.length).toBe(9);
    });
  });

  test("mirrors the hidden conversation filter and the agent scope", async () => {
    await withFixture(async ({ storageDir, alphaDir, betaDir }) => {
      await writeFixture({
        storageDir,
        directory: "hidden",
        conversationId: "conv-hidden",
        hidden: true,
        rows: [messageRow("h-1", "user", [text("隐藏会话的记忆库索引")], 1)],
      });
      await writeFixture({
        storageDir,
        directory: "other-agent",
        conversationId: "conv-other",
        agentId: "agent-someone-else",
        rows: [messageRow("o-1", "user", [text("别的 agent 的记忆库索引")], 1)],
      });
      for (const dir of [
        alphaDir,
        betaDir,
        join(storageDir, "conversations", "hidden"),
        join(storageDir, "conversations", "other-agent"),
      ]) {
        const name = dir.slice(dir.lastIndexOf("\\") + 1);
        rebuildConversationIndex({
          conversationDir: dir,
          identity: {
            conversationKey: name,
            conversationId: `conv-${name}`,
            agentId: name === "other-agent" ? "agent-someone-else" : AGENT_ID,
          },
        });
      }

      const scoped = loadRecallCorpus(storageDir, { agentId: AGENT_ID });
      expect(scoped.conversations).toBe(2);
      expect(scoped.records.length).toBe(9);

      const withHidden = loadRecallCorpus(storageDir, {
        agentId: AGENT_ID,
        includeHidden: true,
      });
      expect(withHidden.conversations).toBe(3);
      expect(withHidden.records.length).toBe(10);
      expect(
        withHidden.records.some((record) => record.messageId === "h-1"),
      ).toBe(true);
      expect(
        withHidden.records.some((record) => record.messageId === "o-1"),
      ).toBe(false);
    });
  });

  test("ranks the index corpus with the transcript search scorer", async () => {
    await withFixture(async ({ storageDir, alphaDir, betaDir }) => {
      for (const dir of [alphaDir, betaDir]) {
        rebuildConversationIndex({
          conversationDir: dir,
          identity: {
            conversationKey: dir.endsWith("alpha") ? "alpha" : "beta",
            conversationId: dir.endsWith("alpha") ? "conv-alpha" : "conv-beta",
            agentId: AGENT_ID,
          },
        });
      }
      const { records } = loadRecallCorpus(storageDir);

      expect(rankedIds(records, "记忆库索引")).toEqual(["m-9", "b-1", "m-1"]);
      expect(rankedIds(records, "签名")).toEqual(["m-9", "m-2", "m-1"]);
      expect(rankedIds(records, "真正的用户问题")).toEqual(["m-6"]);
      expect(rankedIds(records, "未闭合标签")).toEqual(["m-7"]);
      expect(rankedIds(records, "工具结果")).toEqual([]);
      expect(rankedIds(records, "压缩摘要")).toEqual([]);
      expect(rankedIds(records, "注入的提醒块")).toEqual([]);
    });
  });

  test("indexes legacy transcripts with the same corpus boundary", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "recall-index-legacy-"));
    try {
      const conversationDir = await writeFixture({
        storageDir,
        directory: "legacy",
        conversationId: "conv-legacy",
        manifest: legacyManifest(),
        rows: [
          {
            id: "l-1",
            role: "user",
            content: "旧格式的记忆库索引",
            metadata: { created_at: "2026-01-01T00:00:01.000Z" },
          },
          {
            id: "l-2",
            role: "assistant",
            content: [
              {
                type: "text",
                text: "<system-reminder>提醒</system-reminder>助手正文",
              },
            ],
            metadata: { created_at: "2026-01-01T00:00:02.000Z" },
          },
          {
            id: "l-3",
            role: "toolResult",
            content: [{ type: "text", text: "工具结果不该被索引" }],
            metadata: { created_at: "2026-01-01T00:00:03.000Z" },
          },
        ],
      });
      const rebuilt = rebuildConversationIndex({
        conversationDir,
        identity: {
          conversationKey: "legacy",
          conversationId: "conv-legacy",
          agentId: AGENT_ID,
        },
      });
      expect("sidecar" in rebuilt).toBe(true);
      if (!("sidecar" in rebuilt)) return;
      expect(rebuilt.sidecar.records.map((record) => record.id)).toEqual([
        "l-1",
        "l-2",
      ]);
      expect(rebuilt.sidecar.records[1]?.ts).toBe("2026-01-01T00:00:02.000Z");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
