import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentCreateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
} from "@/backend";
import { LocalBackend } from "@/backend/local";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { rebuildConversationIndex } from "@/backend/local/recall-index";
import { conversationDirectories } from "@/backend/local/transcript-search";
import { runRecall } from "@/reminders/recall-service";

/**
 * The M3 acceptance: on a fixture conversation, assert exactly what would be
 * injected and what would not. Every other part of the feature is unit-tested in
 * isolation; this is the one that goes through the real store, the real index
 * sidecar, and the real memory workspace.
 */

const HISTORY_TEXT = "财务系统的记账方式是每日对账";
const QUERY = "财务系统是怎么记账的";

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

function createBody(
  text: string,
  agentId: string,
): ConversationMessageCreateBody {
  return {
    messages: [{ role: "user", content: text }],
    streaming: true,
    stream_tokens: true,
    include_pings: true,
    background: true,
    client_tools: [],
    client_skills: [],
    agent_id: agentId,
  } as unknown as ConversationMessageCreateBody;
}

/** The directory name the store gave a conversation, read back from disk. */
async function conversationDirFor(
  storageDir: string,
  conversationId: string,
): Promise<string> {
  for (const dir of conversationDirectories(storageDir)) {
    const record = JSON.parse(
      await readFile(join(dir, "conversation.json"), "utf8"),
    ) as { id?: string; agent_id?: string };
    if (record.id === conversationId) {
      return dir;
    }
  }
  throw new Error(`no conversation directory for ${conversationId}`);
}

async function buildIndex(
  storageDir: string,
  conversationId: string,
): Promise<void> {
  const conversationDir = await conversationDirFor(storageDir, conversationId);
  const record = JSON.parse(
    await readFile(join(conversationDir, "conversation.json"), "utf8"),
  ) as { id: string; agent_id: string };
  const result = rebuildConversationIndex({
    conversationDir,
    identity: {
      conversationKey: conversationDir.split(/[\\/]/).at(-1) ?? "",
      conversationId: record.id,
      agentId: record.agent_id,
    },
  });
  if ("error" in result) throw new Error(result.error);
}

async function writeMemoryFile(
  storageDir: string,
  agentId: string,
  path: string,
  content: string,
): Promise<void> {
  const memoryDir = getLocalBackendMemoryFilesystemRoot(agentId, storageDir);
  const target = join(memoryDir, ...path.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

type Fixture = {
  storageDir: string;
  backend: LocalBackend;
  agentId: string;
  currentConversationId: string;
  historyDirectory: string;
};

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: { memory?: boolean } = {},
): Promise<void> {
  const storageDir = await mkdtemp(join(tmpdir(), "haru-recall-service-"));
  try {
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
    });
    const agent = await backend.createAgent({
      name: "Recall Agent",
      model: "openai/gpt-test",
    } as AgentCreateBody);
    const history = await backend.createConversation({
      agent_id: agent.id,
    } as ConversationCreateBody);
    await drain(
      await backend.createConversationMessageStream(
        history.id,
        createBody(HISTORY_TEXT, agent.id),
      ),
    );

    // A second conversation stands in for the one the turn runs in. Its own
    // message has to be *in* the corpus for the `N` filter to be what excludes it.
    const current = await backend.createConversation({
      agent_id: agent.id,
    } as ConversationCreateBody);
    await drain(
      await backend.createConversationMessageStream(
        current.id,
        createBody(`${QUERY} 顺便也说说记账`, agent.id),
      ),
    );

    await buildIndex(storageDir, history.id);
    await buildIndex(storageDir, current.id);
    if (options.memory !== false) {
      await writeMemoryFile(storageDir, agent.id, "MEMORY.md", "root index\n");
      await writeMemoryFile(
        storageDir,
        agent.id,
        "reference/notes.md",
        "# 记账\n\n财务系统的记账口径在 reference 里，每日对账一次。\n",
      );
    }
    await run({
      storageDir,
      backend,
      agentId: agent.id,
      currentConversationId: current.id,
      historyDirectory:
        (await conversationDirFor(storageDir, history.id))
          .split(/[\\/]/)
          .at(-1) ?? "",
    });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
}

describe("runRecall", () => {
  test("injects history and memory, and never the current conversation's message", async () => {
    await withFixture(async (fixture) => {
      const decision = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        options: { diversity: "none", limit: 5 },
      });

      expect(decision.status).toBe("injected");
      const sources = decision.entries.map((entry) => entry.source);
      expect(sources).toContain("transcript");
      expect(sources).toContain("memory");

      const transcript = decision.entries.filter(
        (entry) => entry.source === "transcript",
      );
      // `N`: the current conversation's own message is still in context, so it is
      // not recallable even though its sidecar is in the corpus.
      expect(
        transcript.every(
          (entry) => entry.conversationKey === fixture.historyDirectory,
        ),
      ).toBe(true);
      expect(transcript[0]?.text).toContain("每日对账");

      const memory = decision.entries.find(
        (entry) => entry.source === "memory",
      );
      expect(memory?.file).toBe("reference/notes.md");
      expect(memory?.text).toContain("每日对账");
    });
  });

  test("keeps every entry inside the character budget", async () => {
    await withFixture(async (fixture) => {
      const decision = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        options: { excerptCharacters: 12, totalCharacters: 40, limit: 3 },
      });
      expect(decision.entries.length).toBeGreaterThan(0);
      for (const entry of decision.entries) {
        expect(entry.text.length).toBeLessThanOrEqual(12);
      }
      const total = decision.entries.reduce(
        (sum, entry) => sum + entry.text.length,
        0,
      );
      expect(total).toBeLessThanOrEqual(40);
    });
  });

  test("does not repeat what the window already covers", async () => {
    await withFixture(async (fixture) => {
      const first = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        options: { limit: 5 },
      });
      expect(first.entries.length).toBeGreaterThan(0);

      const sameTurn = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        options: { limit: 5 },
      });
      expect(sameTurn.entries).toEqual([]);
      expect(sameTurn.status).toBe("suppressed");

      // Past K turns the window has aged out and the same hits come back.
      const later = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 12,
        options: { limit: 5, dedupTurns: 10 },
      });
      expect(later.status).toBe("injected");
      expect(later.entries.length).toBe(first.entries.length);
    });
  });

  test("a turn with no searchable terms injects nothing and writes nothing", async () => {
    await withFixture(async (fixture) => {
      const decision = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: "!!!",
        currentTurn: 1,
      });
      expect(decision.status).toBe("no-match");
      expect(decision.entries).toEqual([]);
    });
  });

  test("memory can be switched off without losing the transcript source", async () => {
    await withFixture(async (fixture) => {
      const decision = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        memoryEnabled: false,
        options: { limit: 5 },
      });
      expect(decision.entries.length).toBeGreaterThan(0);
      expect(
        decision.entries.every((entry) => entry.source === "transcript"),
      ).toBe(true);
      expect(
        decision.diagnostics.sources.find(
          (diagnostic) => diagnostic.source === "memory",
        ),
      ).toBeUndefined();
    });
  });
});
