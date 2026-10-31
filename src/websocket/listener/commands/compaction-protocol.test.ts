/**
 * F-04's multi-step compaction protocol (M5-A stage 2, listener half).
 *
 * `compaction_prepare → compaction_commit | compaction_cancel` splits the flow
 * the terminal already runs. This file pins the wire behaviour the desktop
 * depends on:
 *
 * - `prepare` hands back a table (`topic_report` without `applied`) and writes
 *   no ledger row — the summarizer's spend is settled once the preview ends;
 * - `commit` applies the pick, reports what the write-back did, and writes the
 *   attempt's real outcome exactly once;
 * - `cancel`, a superseded preview and an expired preview all settle the spend
 *   as `cancelled`; an unknown/consumed id answers `prepare_expired`;
 * - a `block_index` the report does not have is a request error that leaves the
 *   preview pending, so the client can retry without paying again;
 * - the legacy one-shot `conversation_compact` still answers its old shape (its
 *   regression lives in `commands-conversation-compact.test.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import {
  __testSetBackend,
  type Backend,
  type ConversationMessageCreateBody,
} from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import type {
  CompactionPreview,
  CompactPick,
} from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import { CompactionCancelledError } from "@/backend/local/compaction-summarizer";
import { withCompactUsage } from "@/backend/local/compaction-usage-error";
import { LocalBackend } from "@/backend/local/local-backend";
import type { CompactionTopicReport } from "@/types/task-control-protocol";
import { readUsageLedger, type UsageRecord } from "@/usage/ledger";
import {
  COMPACTION_LOCAL_BACKEND_REQUIRED_TEXT,
  handleCompactionProtocolCommand,
} from "@/websocket/listener/commands/compaction";
import type {
  RunDetachedListenerTask,
  SafeSocketSend,
} from "@/websocket/listener/commands/types";
import {
  __testCompactionPendingCount,
  __testSetCompactionPendingTtl,
} from "@/websocket/listener/compaction-pending";
import { __testResetLocalCompactionLocks } from "@/websocket/listener/local-compaction";

const temporaryDirectories: string[] = [];
const originalHaruyukiHome = process.env.HARUYUKI_HOME;

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "listener-compact-wire-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  __testSetBackend(null);
  __testSetCompactionPendingTtl(10 * 60 * 1000);
  __testResetLocalCompactionLocks();
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

interface FixtureBehavior {
  prepareGate?: { started: () => void; wait: Promise<void> };
  prepareError?: unknown;
  applyResult?: CompactionApplyResult;
}

interface Fixture {
  backend: LocalBackend;
  conversationId: string;
  agentId: string;
  seenPicks: CompactPick[];
}

function inContextIds(
  backend: LocalBackend,
  conversationId: string,
  agentId: string,
): string[] {
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
  return store
    .listLocalMessages(conversationId, agentId)
    .map((message) => message.id);
}

/** A scripted two-topic preview over the live message list. */
function previewFor(input: {
  backend: LocalBackend;
  conversationId: string;
  agentId: string;
}): CompactionPreview {
  const ids = inContextIds(input.backend, input.conversationId, input.agentId);
  const first = ids[0] ?? "";
  const splitIndex = Math.max(1, Math.floor(ids.length / 2));
  const split = ids[splitIndex] ?? first;
  return {
    conversationId: input.conversationId,
    agentId: input.agentId,
    model: "openai/gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: [
      { title: "Alpha", startMessageId: first, section: "alpha section" },
      { title: "Beta", startMessageId: split, section: "beta section" },
    ],
    overview: {
      restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
      narrative: "They talked through Alpha.",
    },
    blocks: [
      {
        index: 1,
        title: "Alpha",
        markerId: null,
        createdBy: "summarizer" as const,
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
        createdBy: "summarizer" as const,
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

function noopApplyResult(): CompactionApplyResult {
  return {
    executed: false,
    source: "ratio_suggestion",
    noopReason: "stale_preview",
    topicTitle: null,
    foldedTopicIds: [],
    foldedTitles: [],
    numMessagesBefore: 8,
    numMessagesAfter: 8,
    summarizedMessageCount: 0,
    summarizedTokens: 0,
    retainedTokens: 900,
    retentionCapTokens: null,
    stats: {},
  };
}

async function fixture(behavior: FixtureBehavior = {}): Promise<Fixture> {
  const storageDir = await createStorageDirectory();
  process.env.HARUYUKI_HOME = storageDir;
  const seenPicks: CompactPick[] = [];
  const backend = new (class extends LocalBackend {
    override async prepareCompaction(input: {
      conversationId: string;
      agentId?: string;
      signal?: AbortSignal;
    }): Promise<CompactionPreview> {
      if (behavior.prepareGate) {
        behavior.prepareGate.started();
        await behavior.prepareGate.wait;
      }
      if (behavior.prepareError !== undefined) throw behavior.prepareError;
      const agentId =
        input.agentId ??
        (
          backend as unknown as {
            store: { resolveAgentIdForConversation(id: string): string };
          }
        ).store.resolveAgentIdForConversation(input.conversationId);
      return previewFor({
        backend,
        conversationId: input.conversationId,
        agentId,
      });
    }

    override async applyCompaction(input: {
      preview: CompactionPreview;
      pick: CompactPick;
    }) {
      seenPicks.push(input.pick);
      if (behavior.applyResult) return behavior.applyResult;
      return super.applyCompaction(input);
    }
  })({
    storageDir,
    executor: okExecutor,
    memfsEnabled: false,
  });
  __testSetBackend(backend);
  const agent = await backend.createAgent({
    name: "Compaction Wire Agent",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: 2_000,
    },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  for (let turn = 0; turn < 8; turn += 1) {
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

interface ProtocolHarness {
  sent: Record<string, unknown>[];
  tasks: Promise<void>[];
  context: {
    socket: WebSocket;
    safeSocketSend: SafeSocketSend;
    runDetachedListenerTask: RunDetachedListenerTask;
  };
}

function protocolHarness(): ProtocolHarness {
  const sent: Record<string, unknown>[] = [];
  const tasks: Promise<void>[] = [];
  return {
    sent,
    tasks,
    context: {
      socket: {} as WebSocket,
      safeSocketSend: (_socket, payload) => {
        sent.push(payload as Record<string, unknown>);
        return true;
      },
      runDetachedListenerTask: (_name, task) => {
        tasks.push(task());
      },
    },
  };
}

async function sendCommand(
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const harness = protocolHarness();
  expect(handleCompactionProtocolCommand(command, harness.context)).toBe(true);
  await Promise.all(harness.tasks);
  const response = harness.sent.at(-1);
  if (!response) throw new Error("no compaction response was sent");
  return response;
}

function prepareCommand(
  f: Fixture,
  body: Record<string, unknown> | undefined = { agent_id: "" },
): Record<string, unknown> {
  return {
    type: "compaction_prepare",
    request_id: "prepare-1",
    conversation_id: f.conversationId,
    body:
      body === undefined
        ? undefined
        : {
            ...body,
            agent_id: body.agent_id === "" ? f.agentId : body.agent_id,
          },
  };
}

function prepareIdOf(response: Record<string, unknown>): string {
  const prepareId = response.prepare_id;
  if (typeof prepareId !== "string" || prepareId.length === 0) {
    throw new Error("the response carried no prepare_id");
  }
  return prepareId;
}

async function prepare(
  f: Fixture,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendCommand(prepareCommand(f, body));
}

async function commit(
  f: Fixture,
  prepareId: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return sendCommand({
    type: "compaction_commit",
    request_id: "commit-1",
    conversation_id: f.conversationId,
    prepare_id: prepareId,
    ...extra,
  });
}

async function cancel(
  f: Fixture,
  prepareId: string,
): Promise<Record<string, unknown>> {
  return sendCommand({
    type: "compaction_cancel",
    request_id: "cancel-1",
    conversation_id: f.conversationId,
    prepare_id: prepareId,
  });
}

async function ledgerRows(): Promise<UsageRecord[]> {
  return readUsageLedger({ prune: false });
}

describe("compaction protocol", () => {
  test("prepare returns the table without applied and writes no row yet", async () => {
    const f = await fixture();

    const response = await prepare(f);

    expect(response).toMatchObject({
      type: "compaction_prepare_response",
      request_id: "prepare-1",
      success: true,
    });
    expect(typeof prepareIdOf(response)).toBe("string");
    const report = response.topic_report as CompactionTopicReport;
    expect(report.applied).toBeUndefined();
    expect(report.blocks.map((block) => block.index)).toEqual([1, 2]);
    expect(report.blocks[1]?.title).toBe("Beta");
    expect(report.overview).toContain("They talked through Alpha.");
    expect(report.suggestion_index).toBe(2);
    expect(report.numbered_blocks).toBe(2);
    // The summarizer was paid for, but the answer is not committed yet: one
    // attempt, one row, written where the attempt ends.
    expect(await ledgerRows()).toHaveLength(0);
    expect(__testCompactionPendingCount()).toBe(1);
  });

  test("commit applies the chosen block, reports it, and writes one completed row", async () => {
    const f = await fixture();
    const prepareId = prepareIdOf(await prepare(f));

    const response = await commit(f, prepareId, { block_index: 2 });

    expect(response.success).toBe(true);
    const report = response.topic_report as CompactionTopicReport;
    expect(report.applied?.executed).toBe(true);
    expect(report.applied?.folded_topics).toEqual(["Alpha"]);
    expect(report.applied?.messages_after).toBeLessThan(
      report.applied?.messages_before ?? 0,
    );
    expect(f.seenPicks).toHaveLength(1);
    expect(f.seenPicks[0]?.kind).toBe("message");
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("compaction");
    expect(rows[0]?.outcome).toBe("completed");
    expect(rows[0]?.sessionId).toBe(f.conversationId);
    expect(rows[0]?.agentId).toBe(f.agentId);
    expect(rows[0]?.prompt).toBe(900);

    // Consumed: the same id cannot be applied twice, and nothing is re-billed.
    const again = await commit(f, prepareId);
    expect(again.success).toBe(false);
    expect(String(again.error)).toContain("prepare_expired");
    expect(await ledgerRows()).toHaveLength(1);
    expect(__testCompactionPendingCount()).toBe(0);
  });

  test("commit without block_index compresses by the rate", async () => {
    const f = await fixture();
    const prepareId = prepareIdOf(await prepare(f));

    const response = await commit(f, prepareId);

    expect(response.success).toBe(true);
    expect(f.seenPicks).toEqual([{ kind: "ratio_suggestion" }]);
    expect(
      (response.topic_report as CompactionTopicReport).applied?.executed,
    ).toBe(true);
    expect((await ledgerRows())[0]?.outcome).toBe("completed");
  });

  test("commit with an unknown prepare id answers prepare_expired and writes nothing", async () => {
    const f = await fixture();

    const response = await commit(f, "not-a-preview");

    expect(response.success).toBe(false);
    expect(String(response.error)).toContain("prepare_expired");
    expect(String(response.error)).toContain("compaction_prepare");
    expect(f.seenPicks).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  test("cancel settles the spend as cancelled and makes the id unusable", async () => {
    const f = await fixture();
    const prepareId = prepareIdOf(await prepare(f));

    const response = await cancel(f, prepareId);

    expect(response).toMatchObject({
      type: "compaction_cancel_response",
      success: true,
      cancelled: true,
    });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("cancelled");
    expect(rows[0]?.sessionId).toBe(f.conversationId);
    expect(rows[0]?.prompt).toBe(900);

    const late = await commit(f, prepareId);
    expect(late.success).toBe(false);
    expect(String(late.error)).toContain("prepare_expired");
    expect(await ledgerRows()).toHaveLength(1);
  });

  test("cancel of an unknown id answers prepare_expired without a row", async () => {
    const f = await fixture();

    const response = await cancel(f, "not-a-preview");

    expect(response).toMatchObject({
      type: "compaction_cancel_response",
      success: false,
      cancelled: false,
    });
    expect(String(response.error)).toContain("prepare_expired");
    expect(await ledgerRows()).toHaveLength(0);
  });

  test("a second prepare supersedes the first preview and settles its spend", async () => {
    const f = await fixture();
    const first = prepareIdOf(await prepare(f));
    const second = prepareIdOf(await prepare(f));
    expect(second).not.toBe(first);

    // The old id is gone the moment the client prepared again, and its
    // summarizer spend is not dropped.
    const stale = await commit(f, first);
    expect(stale.success).toBe(false);
    expect(String(stale.error)).toContain("prepare_expired");
    expect((await ledgerRows()).map((row) => row.outcome)).toEqual([
      "cancelled",
    ]);

    const response = await commit(f, second);
    expect(response.success).toBe(true);
    expect((await ledgerRows()).map((row) => row.outcome)).toEqual([
      "cancelled",
      "completed",
    ]);
  });

  test("an expired preview answers prepare_expired and is settled as cancelled", async () => {
    const f = await fixture();
    __testSetCompactionPendingTtl(0);
    const prepareId = prepareIdOf(await prepare(f));

    const response = await commit(f, prepareId);

    expect(response.success).toBe(false);
    expect(String(response.error)).toContain("prepare_expired");
    expect((await ledgerRows()).map((row) => row.outcome)).toEqual([
      "cancelled",
    ]);
    expect(__testCompactionPendingCount()).toBe(0);
  });

  test("a block_index the table does not have keeps the preview pending", async () => {
    const f = await fixture();
    const prepareId = prepareIdOf(await prepare(f));

    const rejected = await commit(f, prepareId, { block_index: 9 });

    expect(rejected.success).toBe(false);
    expect(String(rejected.error)).toContain("block_index 9");
    expect(String(rejected.error)).toContain("topic_report.blocks");
    // The summarizer was already paid for: this is a request error, not a
    // reason to throw the preview away.
    expect(await ledgerRows()).toHaveLength(0);
    expect(__testCompactionPendingCount()).toBe(1);

    const retried = await commit(f, prepareId, { block_index: 2 });
    expect(retried.success).toBe(true);
    expect((await ledgerRows()).map((row) => row.outcome)).toEqual([
      "completed",
    ]);
  });

  test("a write-back that does not execute is still one completed attempt", async () => {
    const f = await fixture({ applyResult: noopApplyResult() });
    const prepareId = prepareIdOf(await prepare(f));

    const response = await commit(f, prepareId);

    expect(response.success).toBe(true);
    expect(
      (response.topic_report as CompactionTopicReport).applied?.executed,
    ).toBe(false);
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("completed");
  });

  test("a second prepare while one is summarizing is refused with the busy sentence", async () => {
    let releaseStarted = () => {};
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let releaseSummary = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const f = await fixture({
      prepareGate: { started: releaseStarted, wait: gate },
    });

    const first = protocolHarness();
    expect(
      handleCompactionProtocolCommand(prepareCommand(f), first.context),
    ).toBe(true);
    await started;

    const refusal = await prepare(f);
    expect(refusal.success).toBe(false);
    expect(String(refusal.error)).toContain("already running");
    expect(await ledgerRows()).toHaveLength(0);

    releaseSummary();
    await Promise.all(first.tasks);
    const accepted = first.sent.at(-1);
    if (!accepted) throw new Error("the first prepare sent nothing");
    expect(accepted.success).toBe(true);
    const committed = await commit(f, prepareIdOf(accepted));
    expect(committed.success).toBe(true);
    expect(await ledgerRows()).toHaveLength(1);
  });

  test("a failed prepare records the tokens it burned", async () => {
    const f = await fixture({
      prepareError: withCompactUsage(new Error("provider refused"), {
        promptTokens: 1200,
        cachedInputTokens: 900,
        completionTokens: 0,
        wallMs: 3000,
      }),
    });

    const response = await prepare(f);

    expect(response.success).toBe(false);
    expect(String(response.error)).toContain("provider refused");
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("failed");
    expect(rows[0]?.prompt).toBe(1200);
    expect(rows[0]?.cachedInput).toBe(900);
    expect(rows[0]?.wallMs).toBe(3000);
    expect(__testCompactionPendingCount()).toBe(0);
  });

  test("a cancelled prepare answers the receipt and records a cancelled row", async () => {
    const f = await fixture({ prepareError: new CompactionCancelledError() });

    const response = await prepare(f);

    expect(response.success).toBe(false);
    expect(response.prepare_id).toBeNull();
    expect(response.error).toBe("Cancelled: the context is unchanged.");
    expect((await ledgerRows()).map((row) => row.outcome)).toEqual([
      "cancelled",
    ]);
  });

  test("the commands answer not_supported off the local backend", async () => {
    __testSetBackend({} as Backend);
    const commands: Record<string, unknown>[] = [
      {
        type: "compaction_prepare",
        request_id: "e1",
        conversation_id: "conv-1",
      },
      {
        type: "compaction_commit",
        request_id: "e2",
        conversation_id: "conv-1",
        prepare_id: "p1",
      },
      {
        type: "compaction_cancel",
        request_id: "e3",
        conversation_id: "conv-1",
        prepare_id: "p1",
      },
    ];
    for (const command of commands) {
      const response = await sendCommand(command);
      expect(response.success).toBe(false);
      expect(response.error).toBe(COMPACTION_LOCAL_BACKEND_REQUIRED_TEXT);
    }
  });

  test("the handler ignores commands outside the family", () => {
    const harness = protocolHarness();
    expect(
      handleCompactionProtocolCommand(
        { type: "cron_list", request_id: "r1" },
        harness.context,
      ),
    ).toBe(false);
    expect(harness.tasks).toHaveLength(0);
  });
});
