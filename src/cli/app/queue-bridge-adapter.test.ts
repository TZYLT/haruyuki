import { describe, expect, test } from "bun:test";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { enqueueBridgeMessage } from "./queue-bridge-adapter";

/**
 * The bridge mapping (P1-2/F2): a message's agent/conversation scope must reach
 * the queue item instead of being dropped, or routing in listener mode decides
 * on incomplete information.
 */

function fakeRuntime(): {
  runtime: QueueRuntime;
  enqueued: Array<Record<string, unknown>>;
} {
  const enqueued: Array<Record<string, unknown>> = [];
  const runtime = {
    enqueue: (input: Record<string, unknown>) => {
      enqueued.push(input);
      return { ...input, id: `item-${enqueued.length}`, enqueuedAt: 0 };
    },
  } as unknown as QueueRuntime;
  return { runtime, enqueued };
}

describe("enqueueBridgeMessage", () => {
  test("a user message keeps its scope and scheduled source", () => {
    const { runtime, enqueued } = fakeRuntime();
    const item = enqueueBridgeMessage(runtime, {
      kind: "user",
      text: "scheduled prompt",
      source: "cron",
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(enqueued[0]).toMatchObject({
      kind: "message",
      source: "cron",
      content: "scheduled prompt",
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(item?.id).toBe("item-1");
  });

  test("a task notification keeps its content and scope", () => {
    const { runtime, enqueued } = fakeRuntime();
    enqueueBridgeMessage(runtime, {
      kind: "task_notification",
      text: "<task-notification/>",
      content: [{ type: "text", text: "done" }],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(enqueued[0]).toMatchObject({
      kind: "task_notification",
      source: "task_notification",
      text: "<task-notification/>",
      agentId: "agent-1",
      conversationId: "conv-1",
    });
  });

  test("a message without scope omits the fields instead of sending undefined", () => {
    const { runtime, enqueued } = fakeRuntime();
    enqueueBridgeMessage(runtime, { kind: "user", text: "hi" });

    expect(enqueued[0]).toMatchObject({ kind: "message", source: "user" });
    expect("agentId" in (enqueued[0] ?? {})).toBe(false);
    expect("conversationId" in (enqueued[0] ?? {})).toBe(false);
  });
});
