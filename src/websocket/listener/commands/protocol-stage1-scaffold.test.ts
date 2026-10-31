import { describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import type { WsProtocolCommand } from "@/types/protocol_v2";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";
import { handleCompactionProtocolCommand } from "./compaction";
import { handleDreamProtocolCommand } from "./dream";
import { handleUsageProtocolCommand } from "./usage";

/**
 * Stage-1 scaffold: every new M5-A command is recognized by the parser-facing
 * validators and reaches its handler. The bodies answer `not_implemented` until
 * stage 2 fills them; that sentinel is asserted so the stub cannot ship
 * silently (the plan's gate).
 */

type Sent = { payload: unknown; errorType: string };

function harness() {
  const sent: Sent[] = [];
  return {
    sent,
    context: {
      socket: {} as WebSocket,
      safeSocketSend: (
        _socket: WebSocket,
        payload: unknown,
        errorType: string,
      ) => {
        sent.push({ payload, errorType });
        return true;
      },
      runDetachedListenerTask: (_name: string, task: () => Promise<void>) => {
        void task();
      },
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };

describe("M5-A stage 1 scaffold", () => {
  test("parser accepts the new commands and rejects malformed payloads", () => {
    const valid = [
      { type: "dream_status", request_id: "r1", runtime },
      { type: "dream_run", request_id: "r2", runtime },
      { type: "get_dream_settings", request_id: "r3", runtime },
      {
        type: "set_dream_settings",
        request_id: "r4",
        runtime,
        settings: { enabled: true, tiers: { tidy: false } },
      },
      { type: "compaction_prepare", request_id: "r5", conversation_id: "c1" },
      {
        type: "compaction_commit",
        request_id: "r6",
        conversation_id: "c1",
        prepare_id: "p1",
        block_index: 2,
      },
      {
        type: "compaction_cancel",
        request_id: "r7",
        conversation_id: "c1",
        prepare_id: "p1",
      },
      {
        type: "usage_aggregate",
        request_id: "r8",
        agent_id: "agent-1",
        run_id: "run-1",
      },
    ];
    for (const command of valid) {
      expect(
        parseServerMessage(Buffer.from(JSON.stringify(command)))?.type,
      ).toBe(command.type as WsProtocolCommand["type"]);
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
        type: "compaction_commit",
        request_id: "r3",
        conversation_id: "c1",
        prepare_id: "",
      },
      { type: "usage_aggregate", request_id: "r4" },
      {
        type: "usage_aggregate",
        request_id: "r5",
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

  test("dream commands are recognized and answer not_implemented", async () => {
    const cases: Array<[WsProtocolCommand, string]> = [
      [
        {
          type: "dream_status",
          request_id: "r1",
          runtime,
        } as WsProtocolCommand,
        "dream_status_response",
      ],
      [
        { type: "dream_run", request_id: "r2", runtime } as WsProtocolCommand,
        "dream_run_response",
      ],
      [
        {
          type: "get_dream_settings",
          request_id: "r3",
          runtime,
        } as WsProtocolCommand,
        "get_dream_settings_response",
      ],
      [
        {
          type: "set_dream_settings",
          request_id: "r4",
          runtime,
          settings: { enabled: true },
        } as WsProtocolCommand,
        "set_dream_settings_response",
      ],
    ];
    for (const [command, responseType] of cases) {
      const { sent, context } = harness();
      expect(handleDreamProtocolCommand(command, context)).toBe(true);
      await flush();
      const payload = sent[0]?.payload as {
        type?: string;
        success?: boolean;
        error?: string;
      };
      expect(payload.type).toBe(responseType);
      expect(payload.success).toBe(false);
      expect(payload.error).toBe("not_implemented");
    }
  });

  test("dream handler ignores other commands", () => {
    const { context } = harness();
    expect(
      handleDreamProtocolCommand(
        { type: "cron_list", request_id: "r" } as WsProtocolCommand,
        context,
      ),
    ).toBe(false);
  });

  test("compaction commands are recognized and answer not_implemented", async () => {
    const cases: Array<[WsProtocolCommand, string]> = [
      [
        {
          type: "compaction_prepare",
          request_id: "c1",
          conversation_id: "conv-1",
        } as WsProtocolCommand,
        "compaction_prepare_response",
      ],
      [
        {
          type: "compaction_commit",
          request_id: "c2",
          conversation_id: "conv-1",
          prepare_id: "p1",
        } as WsProtocolCommand,
        "compaction_commit_response",
      ],
      [
        {
          type: "compaction_cancel",
          request_id: "c3",
          conversation_id: "conv-1",
          prepare_id: "p1",
        } as WsProtocolCommand,
        "compaction_cancel_response",
      ],
    ];
    for (const [command, responseType] of cases) {
      const { sent, context } = harness();
      expect(handleCompactionProtocolCommand(command, context)).toBe(true);
      await flush();
      expect((sent[0]?.payload as { type?: string }).type).toBe(responseType);
      expect((sent[0]?.payload as { error?: string }).error).toBe(
        "not_implemented",
      );
    }
  });

  test("usage aggregate is recognized and answers not_implemented", async () => {
    const { sent, context } = harness();
    expect(
      handleUsageProtocolCommand(
        {
          type: "usage_aggregate",
          request_id: "u1",
          agent_id: "agent-1",
          run_id: "run-1",
        } as WsProtocolCommand,
        context,
      ),
    ).toBe(true);
    await flush();
    expect((sent[0]?.payload as { type?: string }).type).toBe(
      "usage_aggregate_response",
    );
    expect((sent[0]?.payload as { error?: string }).error).toBe(
      "not_implemented",
    );
  });
});
