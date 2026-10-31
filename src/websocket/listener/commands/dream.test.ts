/**
 * F-06 dream protocol handlers + the `execute_command "dream"` text entry.
 *
 * The protocol family answers from real reads where it can (settings, signal
 * state, launcher decline); the two edges that would leave the test process —
 * the status read and the launcher spawn — are injected so the assertions stay
 * local. The last block drives `handleExecuteCommand` itself, because ruling 3
 * turned `dream` from a reflection alias into the dream command, and that
 * dispatch boundary is the breaking change.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import type {
  DreamRunCommand,
  DreamStatusCommand,
  DreamStatusSnapshot,
  GetDreamSettingsCommand,
  SetDreamSettingsCommand,
} from "@/types/dream-protocol";
import type { ExecuteCommandCommand } from "@/types/protocol_v2";
import { handleExecuteCommand } from "@/websocket/listener/commands";
import type { ConversationRuntime } from "@/websocket/listener/types";
import {
  DREAM_TEXT_USAGE,
  formatDreamRelativeTime,
  formatDreamRunStatusLabel,
  handleDreamProtocolCommand,
  handleDreamRunCommand,
  handleDreamStatusCommand,
  handleDreamTextCommand,
  handleGetDreamSettingsCommand,
  handleSetDreamSettingsCommand,
  toDreamSettingsSnapshot,
} from "./dream";
import type { SafeSocketSend } from "./types";

const AGENT = "agent-dream-protocol";
const CONVERSATION = "conv-dream-protocol";
const previousHome = process.env.HOME;
const previousHaruyukiHome = process.env.HARUYUKI_HOME;
let testHome: string;

type Sent = unknown[];

function harness(): { sent: Sent; socket: WebSocket; send: SafeSocketSend } {
  const sent: Sent = [];
  const socket = {} as WebSocket;
  const send: SafeSocketSend = (_socket, payload) => {
    sent.push(payload);
    return true;
  };
  return { sent, socket, send };
}

function lastSent<T = Record<string, unknown>>(sent: Sent): T {
  const payload = sent.at(-1);
  if (payload === undefined) throw new Error("nothing was sent");
  return payload as T;
}

function conversationRuntime(
  agentId: string | null = AGENT,
): ConversationRuntime {
  return { agentId, conversationId: CONVERSATION } as ConversationRuntime;
}

function statusSnapshot(
  overrides: Partial<DreamStatusSnapshot> = {},
): DreamStatusSnapshot {
  return {
    enabled: true,
    running: null,
    nextEligibleAt: null,
    lastRun: null,
    ...overrides,
  };
}

const fixedNow = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));

beforeEach(async () => {
  await settingsManager.reset();
  testHome = await mkdtemp(join(tmpdir(), "hryk-dream-protocol-"));
  process.env.HARUYUKI_HOME = testHome;
  process.env.HOME = testHome;
  await settingsManager.initialize();
});

afterEach(async () => {
  __testSetBackend(null);
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(testHome, { recursive: true, force: true });
});

describe("dream protocol dispatch", () => {
  test("unrelated commands are not claimed", () => {
    const { socket, send } = harness();
    expect(
      handleDreamProtocolCommand(
        { type: "cron_list", request_id: "r1" },
        {
          socket,
          safeSocketSend: send,
          runDetachedListenerTask: (_name, task) => void task(),
        },
      ),
    ).toBe(false);
  });
});

describe("dream_status", () => {
  test("answers the read snapshot when the read succeeds", async () => {
    const { sent, socket, send } = harness();
    const command: DreamStatusCommand = {
      type: "dream_status",
      request_id: "status-1",
      runtime: { agent_id: AGENT, conversation_id: CONVERSATION },
    };
    await handleDreamStatusCommand(command, socket, send, async () =>
      statusSnapshot({ enabled: false }),
    );

    expect(lastSent<Record<string, unknown>>(sent)).toEqual({
      type: "dream_status_response",
      request_id: "status-1",
      success: true,
      status: {
        enabled: false,
        running: null,
        nextEligibleAt: null,
        lastRun: null,
      },
    });
  });

  test("a failing read answers success:false with the reason", async () => {
    const { sent, socket, send } = harness();
    await handleDreamStatusCommand(
      {
        type: "dream_status",
        request_id: "status-2",
        runtime: { agent_id: AGENT, conversation_id: CONVERSATION },
      },
      socket,
      send,
      async () => {
        throw new Error("settings unavailable");
      },
    );

    expect(lastSent<Record<string, unknown>>(sent)).toEqual({
      type: "dream_status_response",
      request_id: "status-2",
      success: false,
      status: null,
      error: "settings unavailable",
    });
  });

  test("the real read reports the disabled default", async () => {
    const { sent, socket, send } = harness();
    await handleDreamStatusCommand(
      {
        type: "dream_status",
        request_id: "status-3",
        runtime: { agent_id: AGENT, conversation_id: CONVERSATION },
      },
      socket,
      send,
    );

    const response = lastSent<{
      success: boolean;
      status: DreamStatusSnapshot;
    }>(sent);
    expect(response.success).toBe(true);
    expect(response.status.enabled).toBe(false);
    expect(response.status.running).toBeNull();
    expect(response.status.lastRun).toBeNull();
  });
});

describe("dream_run", () => {
  const command: DreamRunCommand = {
    type: "dream_run",
    request_id: "run-1",
    runtime: { agent_id: AGENT, conversation_id: CONVERSATION },
  };

  test("a started run returns its id", async () => {
    const { sent, socket, send } = harness();
    await handleDreamRunCommand(command, socket, send, async () => ({
      started: true,
      runId: "dream-launch-abc",
    }));

    expect(lastSent<Record<string, unknown>>(sent)).toEqual({
      type: "dream_run_response",
      request_id: "run-1",
      success: true,
      started: true,
      runId: "dream-launch-abc",
    });
  });

  test("a declined launch carries the reason and starts nothing", async () => {
    const { sent, socket, send } = harness();
    await handleDreamRunCommand(command, socket, send, async () => ({
      started: false,
      runId: null,
      reason: "a dream run is already in progress for this agent",
    }));

    expect(lastSent<Record<string, unknown>>(sent)).toEqual({
      type: "dream_run_response",
      request_id: "run-1",
      success: true,
      started: false,
      reason: "a dream run is already in progress for this agent",
    });
  });

  test("the default launcher declines while dream is disabled", async () => {
    const { sent, socket, send } = harness();
    await handleDreamRunCommand(command, socket, send);
    const response = lastSent<{
      success: boolean;
      started: boolean;
      reason?: string;
    }>(sent);
    expect(response.success).toBe(true);
    expect(response.started).toBe(false);
    expect(response.reason).toContain("not enabled");
  });

  test("a throwing launcher is a failed command", async () => {
    const { sent, socket, send } = harness();
    await handleDreamRunCommand(command, socket, send, async () => {
      throw new Error("spawn exploded");
    });

    expect(lastSent<Record<string, unknown>>(sent)).toEqual({
      type: "dream_run_response",
      request_id: "run-1",
      success: false,
      started: false,
      error: "spawn exploded",
    });
  });
});

describe("get_dream_settings", () => {
  test("returns the resolved defaults for the runtime agent", () => {
    const { sent, socket, send } = harness();
    const command: GetDreamSettingsCommand = {
      type: "get_dream_settings",
      request_id: "get-1",
      runtime: { agent_id: AGENT, conversation_id: CONVERSATION },
    };
    handleGetDreamSettingsCommand(command, socket, send);

    const response = lastSent<{
      type: string;
      success: boolean;
      settings: Record<string, unknown>;
    }>(sent);
    expect(response.type).toBe("get_dream_settings_response");
    expect(response.success).toBe(true);
    expect(response.settings).toMatchObject({
      agent_id: AGENT,
      enabled: false,
      permissionMode: "acceptEdits",
      silenceMinutes: 30,
      pressureThreshold: 75_000,
      budgetFactor: 0.8,
      maxPerRun: 100_000,
      maxPerDay: null,
      timeLimitMinutes: null,
      tiers: { tidy: true, think: true, task: true, wander: true },
      autoTrigger: true,
      overBudgetApprovals: 1,
    });
  });
});

describe("set_dream_settings", () => {
  function setCommand(
    requestId: string,
    settings: SetDreamSettingsCommand["settings"],
    scope?: SetDreamSettingsCommand["scope"],
  ): SetDreamSettingsCommand {
    return {
      type: "set_dream_settings",
      request_id: requestId,
      runtime: { agent_id: AGENT, conversation_id: CONVERSATION },
      settings,
      ...(scope === undefined ? {} : { scope }),
    };
  }

  test("the default scope writes the global layer and reads it back", () => {
    const { sent, socket, send } = harness();
    handleSetDreamSettingsCommand(
      setCommand("set-1", { enabled: true, tiers: { tidy: false } }),
      socket,
      send,
    );

    const response = lastSent<{
      success: boolean;
      settings: {
        enabled: boolean;
        tiers: Record<string, boolean>;
      };
    }>(sent);
    expect(response.success).toBe(true);
    expect(response.settings.enabled).toBe(true);
    // A one-tier patch must not reset the other three switches.
    expect(response.settings.tiers).toEqual({
      tidy: false,
      think: true,
      task: true,
      wander: true,
    });
    expect(settingsManager.getSettings().dreamEnabled).toBe(true);
  });

  test("scope agent writes this agent's override map only", () => {
    const { sent, socket, send } = harness();
    handleSetDreamSettingsCommand(
      setCommand("set-2", { enabled: true }, "agent"),
      socket,
      send,
    );

    expect(lastSent<{ success: boolean }>(sent).success).toBe(true);
    expect(settingsManager.getSettings().dreamEnabled).toBeUndefined();
    expect(
      settingsManager.getSettings().dreamSettingsByAgent?.[AGENT],
    ).toMatchObject({ enabled: true });
  });

  test("a scope outside the two-layer vocabulary is rejected loudly", () => {
    const { sent, socket, send } = harness();
    const command = {
      ...setCommand("set-3", { enabled: true }),
      scope: "local_project",
    } as unknown as SetDreamSettingsCommand;
    handleSetDreamSettingsCommand(command, socket, send);

    const response = lastSent<{ success: boolean; error?: string }>(sent);
    expect(response.success).toBe(false);
    expect(response.error).toContain("Unsupported dream settings scope");
  });
});

describe("toDreamSettingsSnapshot", () => {
  test("copies the resolved knobs without aliasing the source", () => {
    const { socket, send } = harness();
    void socket;
    void send;
    const settings = {
      enabled: true,
      permissionMode: "unrestricted" as const,
      idleWindows: [{ start: "22:00", end: "07:00" }],
      silenceMinutes: 10,
      pressureThreshold: 1_000,
      budgetFactor: 0.5,
      maxPerRun: 2_000,
      maxPerDay: 4_000,
      timeLimitMinutes: 30,
      tiers: { tidy: false, think: true, task: false, wander: true },
      autoTrigger: false,
      overBudgetApprovals: 0,
    };
    const snapshot = toDreamSettingsSnapshot(AGENT, settings);
    expect(snapshot.agent_id).toBe(AGENT);
    expect(snapshot.idleWindows).toEqual([{ start: "22:00", end: "07:00" }]);
    expect(snapshot.idleWindows).not.toBe(settings.idleWindows);
  });
});

describe("execute_command dream text entry", () => {
  test("bare /dream is status", async () => {
    const output = await handleDreamTextCommand(conversationRuntime(), "", {
      readStatus: async () => statusSnapshot({ enabled: false }),
      now: () => fixedNow,
    });
    expect(output).toContain("dream: disabled");
    expect(output).toContain("running: no active run");
    expect(output).toContain("next automatic run: not scheduled");
    expect(output).toContain("last run: none recorded");
  });

  test("status renders the live run, the window and the last run", async () => {
    const nowMs = fixedNow.getTime();
    const output = await handleDreamTextCommand(
      conversationRuntime(),
      "status",
      {
        readStatus: async () =>
          statusSnapshot({
            running: {
              runId: "run-live",
              startedAt: nowMs - 60_000,
              spentTokens: 1_200,
              budgetTokens: 5_000,
              tier: "tidy",
            },
            nextEligibleAt: "2026-01-01T22:00:00.000Z",
            lastRun: {
              runId: "run-last",
              status: "succeeded",
              triggerSource: "manual",
              startedAt: nowMs - 7_200_000,
              endedAt: nowMs - 3_600_000,
            },
          }),
        now: () => fixedNow,
      },
    );

    expect(output).toContain(
      "running: run-live · tidy · 1,200 / 5,000 tokens · started 1m ago",
    );
    expect(output).toContain("next automatic run: 2026-01-01T22:00:00.000Z");
    expect(output).toContain(
      "last run: succeeded (manual) · started 2h ago · ended 1h ago",
    );
  });

  test("run reports the launcher's started run id", async () => {
    const output = await handleDreamTextCommand(conversationRuntime(), "run", {
      startRun: async () => ({ started: true, runId: "dream-launch-xyz" }),
    });
    expect(output).toBe("Dream run started: dream-launch-xyz.");
  });

  test("a declined run keeps the launcher's reason", async () => {
    const output = await handleDreamTextCommand(conversationRuntime(), "run", {
      startRun: async () => ({
        started: false,
        runId: null,
        reason: "a dream run is already in progress for this agent",
      }),
    });
    expect(output).toBe(
      "Dream run not started: a dream run is already in progress for this agent",
    );
  });

  test("an unknown subcommand is a usage error naming where the switches went", async () => {
    for (const args of ["on", "off", "config", "status extra", "run now"]) {
      await expect(
        handleDreamTextCommand(conversationRuntime(), args),
      ).rejects.toThrow(DREAM_TEXT_USAGE);
    }
  });

  test("a conversation without an agent cannot answer", async () => {
    await expect(
      handleDreamTextCommand(conversationRuntime(null), "status"),
    ).rejects.toThrow("No agent ID");
  });

  test("formatDreamRelativeTime covers the status-line buckets", () => {
    const now = 1_000_000_000_000;
    expect(formatDreamRelativeTime(null, now)).toBe("unknown");
    expect(formatDreamRelativeTime(now - 1_000, now)).toBe("just now");
    expect(formatDreamRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatDreamRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatDreamRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatDreamRunStatusLabel("budget_exhausted")).toBe(
      "budget exhausted",
    );
  });
});

describe("handleExecuteCommand dispatch", () => {
  async function execute(
    commandId: string,
    args: string,
    agentId: string | null,
  ): Promise<Array<Record<string, unknown>>> {
    const { __listenClientTestUtils } = await import(
      "@/websocket/listener/client"
    );
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      agentId,
      CONVERSATION,
    );
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      send: (value: string) => sent.push(value),
    };
    await handleExecuteCommand(
      {
        type: "execute_command",
        command_id: commandId,
        args,
        request_id: `cmd-${commandId}`,
        runtime: { agent_id: agentId, conversation_id: CONVERSATION },
      } as unknown as ExecuteCommandCommand,
      socket as unknown as WebSocket,
      runtime,
      {},
    );
    return sent.map((value) => JSON.parse(value) as Record<string, unknown>);
  }

  test("dream status answers through the execute_command path", async () => {
    const messages = await execute("dream", "status", AGENT);
    const response = messages.find(
      (message) => message.type === "execute_command_response",
    );
    expect(response).toMatchObject({ success: true });
    expect(String(response?.output)).toContain("dream: disabled");
  });

  test("dream run is handled by the dream command, not reflection", async () => {
    const messages = await execute("dream", "on", AGENT);
    const response = messages.find(
      (message) => message.type === "execute_command_response",
    );
    expect(response).toMatchObject({ success: false });
    expect(String(response?.output)).toContain("Usage: /dream [status|run]");
  });

  test("reflect still dispatches to the reflection handler", async () => {
    // No agent: the reflection path rejects before any launch, which proves the
    // `reflect` wire id still routes to reflection (not to the dream command).
    const messages = await execute("reflect", "", null);
    const response = messages.find(
      (message) => message.type === "execute_command_response",
    );
    expect(response).toMatchObject({ success: false });
    expect(String(response?.output)).toContain("reflection");
  });
});
