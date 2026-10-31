import { describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import type { WsProtocolCommand } from "@/types/protocol_v2";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";
import { handleCompactionProtocolCommand } from "./compaction";
import { handleDreamProtocolCommand } from "./dream";
import { handleUsageProtocolCommand } from "./usage";

/**
 * M5-A wire-contract acceptance: the parser-facing validators recognize every
 * command in the three new families, and each family handler claims exactly its
 * own commands.
 *
 * The bodies are covered by the families' own tests (`commands/dream.test.ts`,
 * `commands/usage.test.ts`, `compaction-protocol.test.ts`); this file never runs
 * a detached task, so it needs no backend or settings fixture.
 */

type QueuedTask = { name: string; task: () => Promise<void> };

function harness() {
  const queued: QueuedTask[] = [];
  return {
    queued,
    context: {
      socket: {} as WebSocket,
      safeSocketSend: () => true,
      runDetachedListenerTask: (name: string, task: () => Promise<void>) => {
        queued.push({ name, task });
      },
    },
  };
}

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };

const dreamCommands: WsProtocolCommand[] = [
  { type: "dream_status", request_id: "r1", runtime },
  { type: "dream_run", request_id: "r2", runtime },
  { type: "get_dream_settings", request_id: "r3", runtime },
  {
    type: "set_dream_settings",
    request_id: "r4",
    runtime,
    settings: { enabled: true, tiers: { tidy: false } },
  },
];

const compactionCommands: WsProtocolCommand[] = [
  { type: "compaction_prepare", request_id: "c1", conversation_id: "conv-1" },
  {
    type: "compaction_commit",
    request_id: "c2",
    conversation_id: "conv-1",
    prepare_id: "p1",
    block_index: 2,
  },
  {
    type: "compaction_cancel",
    request_id: "c3",
    conversation_id: "conv-1",
    prepare_id: "p1",
  },
];

const usageCommands: WsProtocolCommand[] = [
  {
    type: "usage_aggregate",
    request_id: "u1",
    agent_id: "agent-1",
    run_id: "run-1",
  },
];

describe("M5-A protocol wire contract", () => {
  test("parser accepts the new commands and rejects malformed payloads", () => {
    for (const command of [
      ...dreamCommands,
      ...compactionCommands,
      ...usageCommands,
    ]) {
      expect(
        parseServerMessage(Buffer.from(JSON.stringify(command)))?.type,
      ).toBe(command.type);
    }

    const invalid = [
      { type: "dream_status", request_id: "r1", runtime: {} },
      {
        type: "set_dream_settings",
        request_id: "r2",
        runtime,
        settings: { enabled: "yes" },
      },
      {
        type: "set_dream_settings",
        request_id: "r3",
        runtime,
        settings: { enabled: true },
        scope: "local_project",
      },
      {
        type: "compaction_commit",
        request_id: "r4",
        conversation_id: "c1",
        prepare_id: "",
      },
      { type: "usage_aggregate", request_id: "r5" },
      {
        type: "usage_aggregate",
        request_id: "r6",
        agent_id: "a",
        from: "not-a-time",
      },
    ];
    for (const command of invalid) {
      expect(
        parseServerMessage(Buffer.from(JSON.stringify(command))),
      ).toBeNull();
    }
  });

  test("the dream handler claims the dream commands only", () => {
    const { queued, context } = harness();
    for (const command of dreamCommands) {
      expect(handleDreamProtocolCommand(command, context)).toBe(true);
    }
    expect(queued.map((task) => task.name)).toEqual([
      "dream_protocol_command",
      "dream_protocol_command",
      "dream_protocol_command",
      "dream_protocol_command",
    ]);
    for (const command of [...compactionCommands, ...usageCommands]) {
      expect(handleDreamProtocolCommand(command, context)).toBe(false);
    }
    expect(queued).toHaveLength(dreamCommands.length);
  });

  test("the compaction handler claims the compaction commands only", () => {
    const { queued, context } = harness();
    for (const command of compactionCommands) {
      expect(handleCompactionProtocolCommand(command, context)).toBe(true);
    }
    expect(queued.map((task) => task.name)).toEqual([
      "compaction_protocol_command",
      "compaction_protocol_command",
      "compaction_protocol_command",
    ]);
    for (const command of [...dreamCommands, ...usageCommands]) {
      expect(handleCompactionProtocolCommand(command, context)).toBe(false);
    }
    expect(queued).toHaveLength(compactionCommands.length);
  });

  test("the usage handler claims usage_aggregate only", () => {
    const { queued, context } = harness();
    for (const command of usageCommands) {
      expect(handleUsageProtocolCommand(command, context)).toBe(true);
    }
    expect(queued.map((task) => task.name)).toEqual(["usage_protocol_command"]);
    for (const command of [...dreamCommands, ...compactionCommands]) {
      expect(handleUsageProtocolCommand(command, context)).toBe(false);
    }
    expect(queued).toHaveLength(usageCommands.length);
  });
});
