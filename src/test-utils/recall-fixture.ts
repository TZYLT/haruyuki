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

/**
 * A local backend with one recallable past conversation, one current
 * conversation, and a small memory workspace.
 *
 * Feature ②'s behaviour only means anything against the real store: the index
 * sidecar, the transcript read that produces a snippet, the memory scan, and
 * `N` (which is a conversation record lookup) are four different code paths that a
 * hand-built candidate list would paper over. Both the service tests and the
 * injection tests therefore pay for this fixture once, here.
 */

/** The passage the fixture makes recallable, and its conversation. */
export const RECALL_FIXTURE_HISTORY_TEXT = "财务系统的记账方式是每日对账";

/** A query whose n-gram terms hit {@link RECALL_FIXTURE_HISTORY_TEXT}. */
export const RECALL_FIXTURE_QUERY = "财务系统是怎么记账的";

export type RecallFixture = {
  storageDir: string;
  backend: LocalBackend;
  agentId: string;
  /** The conversation the turn would run in; its own message stays in context. */
  currentConversationId: string;
  /** The directory name of the *history* conversation. */
  historyDirectory: string;
};

export async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

export function recallConversationBody(
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
export async function conversationDirFor(
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

/** Build the recall sidecar for a conversation the way ingestion would. */
export async function buildConversationRecallIndex(
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

export async function writeRecallMemoryFile(
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

export async function withRecallFixture(
  run: (fixture: RecallFixture) => Promise<void>,
  options: { memory?: boolean } = {},
): Promise<void> {
  const storageDir = await mkdtemp(join(tmpdir(), "haru-recall-fixture-"));
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
        recallConversationBody(RECALL_FIXTURE_HISTORY_TEXT, agent.id),
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
        recallConversationBody(
          `${RECALL_FIXTURE_QUERY} 顺便也说说记账`,
          agent.id,
        ),
      ),
    );

    await buildConversationRecallIndex(storageDir, history.id);
    await buildConversationRecallIndex(storageDir, current.id);
    if (options.memory !== false) {
      await writeRecallMemoryFile(
        storageDir,
        agent.id,
        "MEMORY.md",
        "root index\n",
      );
      await writeRecallMemoryFile(
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
