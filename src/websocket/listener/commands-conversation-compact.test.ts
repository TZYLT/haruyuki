/**
 * F-04's `conversation_compact` (M5, listener half).
 *
 * The desktop's compaction used to call the retired one-step
 * `compactConversationMessages`. It now runs the same `prepare → pick → apply`
 * as `/compact`, so this file pins the two things that make the desktop path
 * whole:
 *
 * - the default selection (no `topic_block`) compresses by the rate;
 * - a 1-based `topic_block` keeps exactly that block, resolved to its boundary
 *   message id before `apply` sees it;
 * - the response carries the legacy `compaction` shape *and* the additive
 *   `topic_report`, so a client compiled against the old protocol keeps working.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import type { ConversationMessageCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import type {
  CompactionPreview,
  CompactPick,
} from "@/backend/local/compaction-preview";
import { LocalBackend } from "@/backend/local/local-backend";
import { handleAgentConversationManagementCommand } from "@/websocket/listener/commands/agents-conversations";
import type { SafeSocketSend } from "@/websocket/listener/commands/types";

const temporaryDirectories: string[] = [];
const originalHaruyukiHome = process.env.HARUYUKI_HOME;

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "listener-compact-protocol-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  __testSetBackend(null);
  // 《31》red line A: the ledger must never reach the real `~/.haruyuki`.
  if (originalHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHaruyukiHome;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const okExecutor: HeadlessTurnExecutor = {
  async execute() {
    const chunks: LettaStreamingResponse[] = [
      {
        message_type: "assistant_message",
        content: [{ type: "text", text: "ok" }],
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse,
    ];
    return {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    } as never;
  },
};

interface Fixture {
  backend: LocalBackend;
  conversationId: string;
  agentId: string;
  seenPicks: CompactPick[];
}

async function fixture(turns: number): Promise<Fixture> {
  const storageDir = await createStorageDirectory();
  process.env.HARUYUKI_HOME = storageDir;
  const seenPicks: CompactPick[] = [];
  const backend = new (class extends LocalBackend {
    override async prepareCompaction(input: {
      conversationId: string;
      agentId?: string;
    }): Promise<CompactionPreview> {
      const agentId =
        input.agentId ??
        (
          backend as unknown as {
            store: { resolveAgentIdForConversation(id: string): string };
          }
        ).store.resolveAgentIdForConversation(input.conversationId);
      const store = (
        backend as unknown as {
          store: {
            listLocalMessages(
              conversationId: string,
              agentId: string,
            ): { id: string }[];
          };
        }
      ).store;
      const ids = store
        .listLocalMessages(input.conversationId, agentId)
        .map((message) => message.id);
      const first = ids[0] ?? "";
      const splitIndex = Math.max(1, Math.floor(ids.length / 2));
      const split = ids[splitIndex] ?? first;
      return {
        conversationId: input.conversationId,
        agentId,
        model: "openai/gpt-5.5",
        createdAt: "2026-01-01T00:00:00.000Z",
        topics: [
          { title: "Alpha", startMessageId: first, section: "alpha section" },
          { title: "Beta", startMessageId: split, section: "beta section" },
        ],
        overview: {
          restricted: {
            open: "",
            errors: "",
            relationship: "",
            memoryIndex: "",
          },
          narrative: "They talked through Alpha.",
        },
        blocks: [
          {
            index: 1,
            title: "Alpha",
            markerId: null,
            createdBy: "summarizer",
            summary: "alpha section",
            anchorMessageId: split,
            absorbedTitles: [],
            boundaryMessageId: first,
            startIndex: 0,
            endIndex: splitIndex,
            rewindTurns: 0,
            startMarkerAnchorMessageId: null,
            messageCount: splitIndex,
            tokens: 400,
            startsAt: "2026-01-01T00:00:00.000Z",
            sparse: false,
          },
          {
            index: 2,
            title: "Beta",
            markerId: null,
            createdBy: "summarizer",
            summary: "beta section",
            anchorMessageId: null,
            absorbedTitles: [],
            boundaryMessageId: split,
            startIndex: splitIndex,
            endIndex: ids.length,
            rewindTurns: 0,
            startMarkerAnchorMessageId: null,
            messageCount: ids.length - splitIndex,
            tokens: 500,
            startsAt: "2026-01-01T00:00:00.000Z",
            sparse: false,
          },
        ],
        numberedBlocks: 2,
        suggestionIndex: 2,
        usage: {
          promptTokens: 900,
          cachedInputTokens: 400,
          completionTokens: 120,
          wallMs: 2000,
        },
        degraded: null,
      };
    }

    override async applyCompaction(input: {
      preview: CompactionPreview;
      pick: CompactPick;
    }) {
      seenPicks.push(input.pick);
      return super.applyCompaction(input);
    }
  })({
    storageDir,
    executor: okExecutor,
    memfsEnabled: false,
  });
  __testSetBackend(backend);
  const agent = await backend.createAgent({
    name: "Compact Protocol Agent",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: 2_000,
    },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  for (let turn = 0; turn < turns; turn += 1) {
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: agent.id,
        messages: [
          { role: "user", content: `turn ${turn} ${"x".repeat(400)}` },
        ],
      } as ConversationMessageCreateBody,
    );
    for await (const _chunk of stream) {
      // drain
    }
  }
  return {
    backend,
    conversationId: conversation.id,
    agentId: agent.id,
    seenPicks,
  };
}

async function runCompactProtocol(
  f: Fixture,
  command: { relation?: "default" | "block"; topicBlock?: number } = {},
): Promise<Record<string, unknown>> {
  const sent: Record<string, unknown>[] = [];
  const safeSocketSend: SafeSocketSend = (_socket, payload) => {
    sent.push(payload as Record<string, unknown>);
    return true;
  };
  await handleAgentConversationManagementCommand(
    {
      type: "conversation_compact",
      request_id: "conversation-compact-1",
      conversation_id: f.conversationId,
      ...(command.topicBlock === undefined
        ? {}
        : { topic_block: command.topicBlock }),
    },
    { readyState: 1 } as unknown as WebSocket,
    safeSocketSend,
  );
  const response = sent.at(-1);
  if (!response) throw new Error("no conversation_compact_response was sent");
  return response;
}

describe("conversation_compact on the local backend", () => {
  test("with no block it compresses by the rate, and reports the table", async () => {
    const f = await fixture(8);

    const response = await runCompactProtocol(f);

    expect(response).toMatchObject({
      type: "conversation_compact_response",
      request_id: "conversation-compact-1",
      success: true,
    });
    // The default selection is the rate's, never a guess at a block.
    expect(f.seenPicks).toEqual([{ kind: "ratio_suggestion" }]);
    const report = response.topic_report as {
      overview: string;
      suggestion_index: number;
      numbered_blocks: number;
      applied: { executed: boolean };
    };
    expect(report.overview).toContain("They talked through Alpha.");
    expect(report.suggestion_index).toBe(2);
    expect(report.numbered_blocks).toBe(2);
    expect(report.applied.executed).toBe(true);
    // The legacy shape survives for a client that never learns `topic_report`.
    expect(response.compaction).toMatchObject({
      summary: expect.stringContaining("They talked through Alpha."),
    });
  });

  test("a 1-based topic_block keeps exactly that block", async () => {
    const f = await fixture(8);

    const response = await runCompactProtocol(f, { topicBlock: 2 });

    expect(response.success).toBe(true);
    expect(f.seenPicks).toEqual([
      { kind: "message", messageId: expect.any(String) },
    ]);
    const report = response.topic_report as {
      applied: { folded_topics: string[]; executed: boolean };
    };
    expect(report.applied.executed).toBe(true);
    expect(report.applied.folded_topics).toEqual(["Alpha"]);
  });

  test("an out-of-range block fails softly instead of compacting by the rate", async () => {
    const f = await fixture(4);

    const response = await runCompactProtocol(f, { topicBlock: 9 });

    expect(response.success).toBe(false);
    expect(response.compaction).toBeNull();
    expect(String(response.error)).toContain("There is no topic block 9");
    // A refused number must not fall through to the default selection.
    expect(f.seenPicks).toEqual([]);
  });
});
