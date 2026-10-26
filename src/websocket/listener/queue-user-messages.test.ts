/**
 * The listener-path counter (F-03 §5.5.2): one count per **submitted user
 * message**, never for the automated items that share the queue.
 *
 * The two functions under test sit between the queue and the transcript state;
 * the queue-pump integration is covered by the listener smoke
 * (`turn-completion-reflection.test.ts`) and the pump timing tests, so this file
 * pins what a batch and an inbound payload actually contribute to the count.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReflectionTranscriptState } from "@/cli/helpers/reflection-transcript";
import type {
  DequeuedBatch,
  MessageQueueItem,
  QueueItem,
  TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  countInboundUserMessages,
  recordListenerInboundUserMessages,
  recordListenerQueuedUserMessages,
} from "./queue";
import type { IncomingMessage } from "./types";

const originalHome = process.env.HARUYUKI_HOME;
let root: string;

const messageItem = (
  agentId: string,
  conversationId: string,
): MessageQueueItem => ({
  id: `item-${crypto.randomUUID()}`,
  kind: "message",
  source: "user",
  agentId,
  conversationId,
  enqueuedAt: Date.now(),
  content: "remember this",
});

const notificationItem = (
  agentId: string,
  conversationId: string,
): TaskNotificationQueueItem => ({
  id: `item-${crypto.randomUUID()}`,
  kind: "task_notification",
  source: "system",
  agentId,
  conversationId,
  enqueuedAt: Date.now(),
  text: "<task-notification><summary>done</summary></task-notification>",
});

function batch(items: QueueItem[]): DequeuedBatch {
  return {
    batchId: `batch-${crypto.randomUUID()}`,
    items,
    mergedCount: items.length,
    queueLenAfter: 0,
  };
}

async function stateOf(agentId: string, conversationId: string) {
  return getReflectionTranscriptState(agentId, conversationId);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hryk-listener-count-"));
  process.env.HARUYUKI_HOME = root;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

describe("listener user-message counting", () => {
  test("a queued batch counts its user messages and ignores automated items", async () => {
    const agentId = `agent-count-${crypto.randomUUID()}`;
    const conversationId = "conv-count";
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      agentId,
      conversationId,
    );

    // Two submissions plus a task notification arrive as one coalesced batch:
    // only the two submissions are user messages (§5.5.2).
    await recordListenerQueuedUserMessages(
      runtime,
      batch([
        messageItem(agentId, conversationId),
        messageItem(agentId, conversationId),
        notificationItem(agentId, conversationId),
      ]),
    );

    const state = await stateOf(agentId, conversationId);
    expect(state.total_user_messages).toBe(2);
    expect(state.messages_since_last_successful_reflection).toBe(2);
    // Counting arms the one-shot trigger; the evaluator consumes it.
    expect(state.pending_user_message_trigger).toBe(true);
  });

  test("a batch with no user message writes nothing", async () => {
    const agentId = `agent-count-${crypto.randomUUID()}`;
    const conversationId = "conv-count";
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      agentId,
      conversationId,
    );

    await recordListenerQueuedUserMessages(
      runtime,
      batch([notificationItem(agentId, conversationId)]),
    );

    const state = await stateOf(agentId, conversationId);
    expect(state.total_user_messages).toBe(0);
    expect(state.pending_user_message_trigger).toBeUndefined();
  });

  test("a direct inbound payload counts each message that carries user content", async () => {
    const agentId = `agent-count-${crypto.randomUUID()}`;
    const conversationId = "conv-count";
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      agentId,
      conversationId,
    );
    const incoming = {
      type: "message",
      agentId,
      conversationId,
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    } as IncomingMessage;

    expect(countInboundUserMessages(incoming)).toBe(2);
    await recordListenerInboundUserMessages(runtime, incoming);

    expect((await stateOf(agentId, conversationId)).total_user_messages).toBe(
      2,
    );
  });

  test("an unscoped runtime counts nothing and does not throw", async () => {
    const runtime = getOrCreateScopedRuntime(createRuntime(), null, "conv-x");

    await recordListenerQueuedUserMessages(
      runtime,
      batch([messageItem("agent-1", "conv-x")]),
    );
    await recordListenerInboundUserMessages(runtime, {
      type: "message",
      messages: [{ role: "user", content: "hi" }],
    } as IncomingMessage);

    // Nothing to assert on disk: the point is that both calls resolved without a
    // write and without an exception.
    expect(runtime.agentId).toBeNull();
  });
});
