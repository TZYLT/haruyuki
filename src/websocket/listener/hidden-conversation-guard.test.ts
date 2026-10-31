/**
 * F-01/D-9: hidden conversations are read-only on the app-server protocol.
 *
 * Covers the shared guard (`isHiddenConversation`) plus the two downstream
 * refusal points the protocol router and queue pump reach:
 *
 * - `dispatchInboundMessageWhenReady` — a direct inbound message.
 * - `createConnectionTurnProcessor` — a queued inbound message.
 *
 * The router's own pre-ack check is wired in `message-router.ts`; these tests
 * exercise the layers it calls so the read-only rule holds even for callers
 * that reach them directly.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testSetBackend } from "@/backend";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { createConnectionTurnProcessor } from "./connection-lifecycle";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  HIDDEN_CONVERSATION_READ_ONLY,
  isHiddenConversation,
  isHiddenConversationAnnotation,
} from "./hidden-conversation-guard";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import type { StartListenerOptions } from "./types";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hryk-hidden-guard-"));
  process.env.HARUYUKI_HOME = home;
});

afterEach(() => {
  // Restore the suite home *before* resetting the process backend: `null`
  // recreates the default backend against whatever HOME is current, and this
  // file's home directory is removed next.
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  rmSync(home, { recursive: true, force: true });
  __testSetBackend(null);
  setActiveRuntime(null);
});

class MockSocket {
  readonly bufferedAmount = 0;
  readyState: number = WebSocket.OPEN;
  readonly sent: unknown[] = [];

  isOpen(): boolean {
    return this.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

function makeOptions(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "ws://app-server.test",
    deviceId: connectionId,
    connectionName: connectionId,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function stubConversationList(rows: unknown[]): void {
  __testSetBackend({
    listConversations: async () => rows,
  } as never);
}

async function openSubscribedListener(
  socket: MockSocket,
  scope: { agent_id: string; conversation_id: string },
) {
  const listener = createRuntime();
  setActiveRuntime(listener);
  openListenerConnection({
    runtime: listener,
    connectionId: "test-client",
    writer: socket as never,
    options: makeOptions("test-client"),
  });
  markListenerConnectionInitialized(listener, "test-client");
  subscribeListenerConnection(listener, "test-client", scope);
  return listener;
}

const HIDDEN_SCOPE = {
  agent_id: "agent-hidden",
  conversation_id: "conversation-hidden",
};
const VISIBLE_SCOPE = {
  agent_id: "agent-visible",
  conversation_id: "conversation-visible",
};

test("isHiddenConversation: the implicit default conversation is never hidden", async () => {
  __testSetBackend({
    listConversations: async () => {
      throw new Error("the default conversation must not be looked up");
    },
  } as never);

  expect(await isHiddenConversation("default")).toBe(false);
});

test("isHiddenConversation: reads the runtime hidden annotation from the list", async () => {
  stubConversationList([
    { id: HIDDEN_SCOPE.conversation_id, hidden: true },
    { id: VISIBLE_SCOPE.conversation_id },
  ]);

  expect(await isHiddenConversation(HIDDEN_SCOPE.conversation_id)).toBe(true);
  expect(await isHiddenConversation(VISIBLE_SCOPE.conversation_id)).toBe(false);
  expect(await isHiddenConversation("conversation-unknown")).toBe(false);
  // The annotation reader itself is strict about the literal boolean.
  expect(isHiddenConversationAnnotation({ hidden: true })).toBe(true);
  expect(isHiddenConversationAnnotation({ hidden: "true" })).toBe(false);
  expect(isHiddenConversationAnnotation(null)).toBe(false);
});

test("isHiddenConversation: a lookup failure does not reject normal input", async () => {
  __testSetBackend({
    listConversations: async () => {
      throw new Error("backend hiccup");
    },
  } as never);

  expect(await isHiddenConversation(HIDDEN_SCOPE.conversation_id)).toBe(false);
});

test("direct input to a hidden conversation is refused before the turn starts", async () => {
  stubConversationList([{ id: HIDDEN_SCOPE.conversation_id, hidden: true }]);
  const socket = new MockSocket();
  const listener = await openSubscribedListener(socket, HIDDEN_SCOPE);
  const scopedRuntime = getOrCreateScopedRuntime(
    listener,
    HIDDEN_SCOPE.agent_id,
    HIDDEN_SCOPE.conversation_id,
  );
  const processIncomingMessage = mock(async () => {});
  let ack:
    | { accepted: boolean; disposition?: "started" | "queued" }
    | undefined;

  dispatchInboundMessageWhenReady({
    listener,
    runtime: scopedRuntime,
    incoming: {
      type: "message",
      connectionId: "test-client",
      agentId: HIDDEN_SCOPE.agent_id,
      conversationId: HIDDEN_SCOPE.conversation_id,
      messages: [{ role: "user", content: "resume the hidden session" }],
    },
    socket: socket as never,
    options: makeOptions("test-client"),
    processQueuedTurn: mock(async () => {}),
    processIncomingMessage,
    trackListenerError: mock(() => {}),
    onInputAccepted: (result) => {
      ack = result;
    },
  });

  await waitFor(() => ack !== undefined, "input was not acknowledged");
  expect(ack).toEqual({ accepted: false });
  expect(processIncomingMessage).not.toHaveBeenCalled();
  expect(scopedRuntime.turnLifecycle.kind).toBe("idle");
  expect(JSON.stringify(socket.sent)).toContain(HIDDEN_CONVERSATION_READ_ONLY);
});

test("direct input to an ordinary conversation still starts a turn", async () => {
  stubConversationList([{ id: VISIBLE_SCOPE.conversation_id }]);
  const socket = new MockSocket();
  const listener = await openSubscribedListener(socket, VISIBLE_SCOPE);
  const scopedRuntime = getOrCreateScopedRuntime(
    listener,
    VISIBLE_SCOPE.agent_id,
    VISIBLE_SCOPE.conversation_id,
  );
  const processIncomingMessage = mock(async () => {});
  let ack: { accepted: boolean } | undefined;

  dispatchInboundMessageWhenReady({
    listener,
    runtime: scopedRuntime,
    incoming: {
      type: "message",
      connectionId: "test-client",
      agentId: VISIBLE_SCOPE.agent_id,
      conversationId: VISIBLE_SCOPE.conversation_id,
      messages: [{ role: "user", content: "hello" }],
    },
    socket: socket as never,
    options: makeOptions("test-client"),
    processQueuedTurn: mock(async () => {}),
    processIncomingMessage,
    trackListenerError: mock(() => {}),
    onInputAccepted: (result) => {
      ack = result;
    },
  });

  await waitFor(
    () => processIncomingMessage.mock.calls.length > 0,
    "ordinary input did not start a turn",
  );
  expect(ack?.accepted).toBe(true);
});

test("queued input to a hidden conversation is dropped before the turn starts", async () => {
  stubConversationList([{ id: HIDDEN_SCOPE.conversation_id, hidden: true }]);
  const socket = new MockSocket();
  const listener = await openSubscribedListener(socket, HIDDEN_SCOPE);
  const scopedRuntime = getOrCreateScopedRuntime(
    listener,
    HIDDEN_SCOPE.agent_id,
    HIDDEN_SCOPE.conversation_id,
  );
  scopedRuntime.dequeuedClientMessageIdsByBatchId.set("batch-hidden", ["cm-1"]);

  await createConnectionTurnProcessor(listener)(
    {
      type: "message",
      connectionId: "test-client",
      agentId: HIDDEN_SCOPE.agent_id,
      conversationId: HIDDEN_SCOPE.conversation_id,
      messages: [{ role: "user", content: "queued hidden input" }],
    },
    {
      batchId: "batch-hidden",
      items: [],
      mergedCount: 1,
      queueLenAfter: 0,
    },
  );

  expect(scopedRuntime.dequeuedClientMessageIdsByBatchId.size).toBe(0);
  expect(scopedRuntime.turnLifecycle.kind).toBe("idle");
  expect(JSON.stringify(socket.sent)).toContain(HIDDEN_CONVERSATION_READ_ONLY);
});
