/**
 * F-01/D-9: `runtime_start` must not resume a hidden conversation.
 *
 * The `conversation_id` scope is the only way a client names an existing
 * conversation, and returning it would let the client start turns on a
 * reflection/dream/subagent session it may only view.
 *
 * Uses the fake-headless backend (not the local one) because it stores the
 * runtime `hidden` annotation on `retrieveConversation` without paying for
 * local agent/repo initialization; that is the annotation `runtime_start`
 * reads.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import type { RuntimeStartCommand } from "@/types/protocol_v2";
import { openListenerConnection } from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { HIDDEN_CONVERSATION_READ_ONLY } from "@/websocket/listener/hidden-conversation-guard";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { getConversationRuntime } from "@/websocket/listener/runtime";
import type { StartListenerOptions } from "@/websocket/listener/types";
import { handleRuntimeStartCommand } from "./runtime-start";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hryk-runtime-start-hidden-"));
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
});

test("runtime_start refuses a hidden conversation and keeps ordinary ones working", async () => {
  const backend = new FakeHeadlessBackend();
  __testSetBackend(backend);
  const agent = await backend.createAgent({
    name: "Hidden guard",
    model: "dev/fake-headless",
  } as AgentCreateBody);
  const hidden = await backend.createConversation({
    agent_id: agent.id,
    hidden: true,
  } as never);
  const visible = await backend.createConversation({
    agent_id: agent.id,
  } as never);

  const listener = createRuntime();
  const responses: Array<Record<string, unknown>> = [];
  openListenerConnection({
    runtime: listener,
    connectionId: "test",
    writer: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    options: {} as StartListenerOptions,
  });
  const context: Parameters<typeof handleRuntimeStartCommand>[1] = {
    socket: {} as WebSocket,
    connectionId: "test",
    runtime: listener,
    safeSocketSend: (_socket, data) => {
      responses.push(data as Record<string, unknown>);
      return true;
    },
    runDetachedListenerTask: () => {},
    getOrCreateScopedRuntime,
    replaySyncStateForRuntime: async () => {},
  };

  const command = (
    conversationId: string,
    requestId: string,
  ): RuntimeStartCommand => ({
    type: "runtime_start",
    request_id: requestId,
    agent_id: agent.id,
    conversation_id: conversationId,
    recover_approvals: false,
  });

  await handleRuntimeStartCommand(command(hidden.id, "hidden"), context);
  expect(responses.at(-1)).toMatchObject({
    success: false,
    runtime: null,
    error: HIDDEN_CONVERSATION_READ_ONLY,
  });
  // Refusal happens before a runtime scope is registered for the hidden id.
  expect(getConversationRuntime(listener, agent.id, hidden.id)).toBeNull();

  await handleRuntimeStartCommand(command(visible.id, "visible"), context);
  expect(responses.at(-1)).toMatchObject({ success: true });
  expect(getConversationRuntime(listener, agent.id, visible.id)).not.toBeNull();

  // The `default` pseudo-conversation never goes through the retrieve branch,
  // so the hidden guard must not touch it.
  await handleRuntimeStartCommand(command("default", "default"), context);
  expect(responses.at(-1)).toMatchObject({ success: true });
});
