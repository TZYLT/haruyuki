/**
 * The shared environment for `/compact`'s tests.
 *
 * F-04's command is a state machine over a backend, a command runner and a
 * reminder runtime. Three test files cover it (dispatch/state machine, receipts
 * and the ledger, the pre-send pressure path), and each of them needs the same
 * fake conversation and the same recording runner — so they live here rather
 * than being copied three times.
 *
 * `localConversation` builds a **real** `LocalBackend` on a temporary storage
 * root, which is the only way to get real topic blocks (the numbering table the
 * command resolves a pick against). The summarizer and the write-back are *not*
 * exercised here: `fixtureRuntime` injects a preview and an apply result, because
 * the ordering and the cancellation exits are this command's, while the
 * summarizer's are M1's and the write-back's are M2's.
 *
 * Nothing in this module may touch the real home: every storage root is a
 * `mkdtemp` directory, and callers that reach the usage ledger redirect
 * `HARUYUKI_HOME` themselves (`《31》A2`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import type {
  CompactionPreview,
  CompactPick,
} from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import { LocalBackend } from "@/backend/local/local-backend";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import type {
  CompactCommandContext,
  CompactionRuntime,
  SendPressureContext,
} from "@/cli/app/submit-compact-commands";
import type { ActiveOverlay, AppCommandRunner } from "@/cli/app/types";
import {
  type ContextTracker,
  createContextTracker,
} from "@/cli/helpers/context-tracker";
import {
  createSharedReminderState,
  type SharedReminderState,
} from "@/reminders/state";

const temporaryDirectories: string[] = [];

/** A fresh temporary root, cleaned up by {@link cleanupCompactHarness}. */
export async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "compact-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Remove every root this module created. Call it from `afterEach`. */
export async function cleanupCompactHarness(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

const okExecutor: HeadlessTurnExecutor = {
  async execute() {
    return lettaStreamFromChunks([
      {
        message_type: "assistant_message",
        content: [{ type: "text", text: "ok" }],
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse,
    ]);
  },
};

export interface RecordedCommand {
  input: string;
  output: string;
  succeeded: boolean;
  failed: boolean;
}

/** A command runner stand-in that records what the flow told the user. */
export function recordingRunner(commands: RecordedCommand[]): AppCommandRunner {
  const start = (input: string, output: string) => {
    const record: RecordedCommand = {
      input,
      output,
      succeeded: false,
      failed: false,
    };
    commands.push(record);
    return {
      id: `cmd-${commands.length}`,
      input,
      update: (update: { output: string }) => {
        record.output = update.output;
      },
      finish: (output: string, success = true) => {
        record.output = output;
        record.succeeded = success;
      },
      fail: (output: string) => {
        record.output = output;
        record.failed = true;
      },
    };
  };
  return { start, getHandle: () => null } as unknown as AppCommandRunner;
}

export interface Harness {
  ctx: CompactCommandContext & SendPressureContext;
  commands: RecordedCommand[];
  overlays: ActiveOverlay[];
  reminderState: SharedReminderState;
  tracker: ContextTracker;
  descriptions: () => number;
}

export function harness(input: {
  conversationId: string;
  agentId: string;
  contextWindow?: number;
  contextTokens?: number;
}): Harness {
  const commands: RecordedCommand[] = [];
  const overlays: ActiveOverlay[] = [];
  const state = { descriptions: 0 };
  const reminderState = createSharedReminderState();
  const tracker = createContextTracker();
  tracker.lastContextTokens = input.contextTokens ?? 0;
  const ctx: CompactCommandContext & SendPressureContext = {
    agentDescription: null,
    agentId: input.agentId,
    agentName: "Local",
    agentStateRef: { current: null },
    appendTaskNotificationEvents: () => true,
    commandRunner: recordingRunner(commands),
    contextTrackerRef: { current: tracker },
    conversationIdRef: { current: input.conversationId },
    effectiveContextWindowSize: input.contextWindow,
    generateConversationDescription: async () => {
      state.descriptions += 1;
    },
    setActiveOverlay: (value) => {
      overlays.push(typeof value === "function" ? null : value);
    },
    setCommandRunning: () => {},
    sharedReminderStateRef: { current: reminderState },
  };
  return {
    ctx,
    commands,
    overlays,
    reminderState,
    tracker,
    descriptions: () => state.descriptions,
  };
}

/** A local conversation with `turns` turns of ~100 tokens each. */
export async function localConversation(
  turns: number,
  markAfter?: { afterTurn: number; title: string },
): Promise<{
  backend: LocalBackend;
  agentId: string;
  conversationId: string;
  markTopic: (title: string) => void;
}> {
  const backend = new LocalBackend({
    storageDir: await createStorageDirectory(),
    executor: okExecutor,
    complete: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }) as never,
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Local",
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
    if (markAfter && turn + 1 === markAfter.afterTurn) {
      backend.markTopic({
        conversationId: conversation.id,
        agentId: agent.id,
        title: markAfter.title,
        createdBy: "agent",
      });
    }
  }
  // The command resolves its backend through `getBackend()`, so the fixture has
  // to be the active one, not merely a value the test holds.
  __testSetBackend(backend);
  return {
    backend,
    agentId: agent.id,
    conversationId: conversation.id,
    markTopic(title: string) {
      backend.markTopic({
        conversationId: conversation.id,
        agentId: agent.id,
        title,
        createdBy: "agent",
      });
    },
  };
}

/** The topic blocks a conversation currently has, for a fixture preview. */
export function topicBlocks(
  backend: LocalBackend,
  conversationId: string,
  agentId: string,
): TopicBlock[] {
  return backend.listTopics(conversationId, agentId).blocks;
}

/**
 * A preview as the summarizer would have produced it, minus the model call.
 *
 * `model` and `usage` are the two fields the receipt and the ledger read, so the
 * fixture names them explicitly rather than leaving them to a default.
 */
export function previewFor(input: {
  conversationId: string;
  agentId: string;
  blocks: readonly TopicBlock[];
  suggestionIndex: number;
  degraded?: "whole-section" | null;
  model?: string;
}): CompactionPreview {
  return {
    conversationId: input.conversationId,
    agentId: input.agentId,
    model: input.model ?? "openai/gpt-5.5",
    createdAt: new Date().toISOString(),
    topics: [],
    overview: {
      restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
      narrative: "the story so far",
    },
    blocks: [...input.blocks],
    numberedBlocks: input.blocks.length,
    suggestionIndex: input.suggestionIndex,
    usage: {
      promptTokens: 1_200,
      cachedInputTokens: 800,
      completionTokens: 240,
      wallMs: 1_500,
    },
    degraded: input.degraded ?? null,
  };
}

export interface RuntimeCalls {
  prepared: Array<{
    conversationId: string;
    agentId: string;
    hasSignal: boolean;
  }>;
  applied: CompactPick[];
}

/** A `CompactionRuntime` that records what the command asked it to do. */
export function fixtureRuntime(options: {
  blocks: readonly TopicBlock[];
  suggestionIndex: number;
  degraded?: "whole-section" | null;
  prepareError?: Error;
  applyError?: Error;
  applyResult?: Partial<CompactionApplyResult>;
}): { runtime: CompactionRuntime; calls: RuntimeCalls } {
  const calls: RuntimeCalls = { prepared: [], applied: [] };
  const runtime: CompactionRuntime = {
    async prepare(input) {
      calls.prepared.push({
        conversationId: input.conversationId,
        agentId: input.agentId,
        hasSignal: input.signal !== undefined,
      });
      if (options.prepareError) throw options.prepareError;
      return previewFor({
        conversationId: input.conversationId,
        agentId: input.agentId,
        blocks: options.blocks,
        suggestionIndex: options.suggestionIndex,
        ...(options.degraded === undefined
          ? {}
          : { degraded: options.degraded }),
      });
    },
    async apply(input) {
      calls.applied.push(input.pick);
      if (options.applyError) throw options.applyError;
      return {
        executed: true,
        source:
          input.pick.kind === "ratio_suggestion"
            ? "ratio_suggestion"
            : "topic_pick",
        topicTitle: null,
        foldedTopicIds: ["topic-1"],
        foldedTitles: ["Alpha"],
        numMessagesBefore: 9,
        numMessagesAfter: 3,
        summarizedMessageCount: 6,
        summarizedTokens: 900,
        retainedTokens: 300,
        retentionCapTokens: 400,
        firstKeptMessageId: "kept",
        stats: { context_tokens_after: 320 },
        ...options.applyResult,
      };
    },
  };
  return { runtime, calls };
}
