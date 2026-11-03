/**
 * R-26 embedding protocol handlers (D2, 48-2 §4.9).
 *
 * The eight command handlers are pure protocol adapters over a narrow
 * `EmbeddingCommandBackend`, so every test here injects a fake backend: command
 * dispatch/claiming, per-command response shapes, handler-side patch/scope
 * validation, typed backend declines, thrown-backend errors, and the
 * not-yet-wired placeholder backend all stay local to this file.
 */
import { describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import type {
  EmbeddingBuildCommand,
  EmbeddingCalibrateCommand,
  EmbeddingCalibrationSnapshot,
  EmbeddingCancelCommand,
  EmbeddingConfigureCommand,
  EmbeddingConfigurePatch,
  EmbeddingDisableCommand,
  EmbeddingEnableCommand,
  EmbeddingResetCommand,
  EmbeddingSettingsSnapshot,
  EmbeddingStatusCommand,
  EmbeddingStatusSnapshot,
} from "@/types/embedding-protocol";
import type { AgentRuntimeScope } from "@/types/runtime-scope";
import {
  createEmbeddingCommandBackend,
  EMBEDDING_INVALID_PATCH,
  EMBEDDING_INVALID_SCOPE,
  EMBEDDING_NOT_CONFIGURED,
  type EmbeddingBuildOptions,
  type EmbeddingCommandBackend,
  handleEmbeddingBuildCommand,
  handleEmbeddingCalibrateCommand,
  handleEmbeddingCancelCommand,
  handleEmbeddingConfigureCommand,
  handleEmbeddingDisableCommand,
  handleEmbeddingEnableCommand,
  handleEmbeddingProtocolCommand,
  handleEmbeddingResetCommand,
  handleEmbeddingStatusCommand,
} from "./embedding";
import type { SafeSocketSend } from "./types";

const AGENT = "agent-embedding-protocol";
const CONVERSATION = "conv-embedding-protocol";
const RUNTIME: AgentRuntimeScope = {
  agent_id: AGENT,
  conversation_id: CONVERSATION,
};

const SETTINGS: EmbeddingSettingsSnapshot = {
  enabled: true,
  backend: "builtin",
  model: "bge-small-zh-v1.5",
  endpoint: null,
  weight: 0.5,
  candidate_depth: 50,
  chunk_target: 200,
  chunk_max: 256,
  chunk_overlap: 32,
  max_chunks_per_message: 1_024,
  threads: 4,
  gpu: "auto",
  quantization: "float32",
  keep_spaces: 2,
};

const CALIBRATION: EmbeddingCalibrationSnapshot = {
  fingerprint: "fp-test",
  measured_at: "2026-11-03T00:00:00.000Z",
  query_latency_p50_ms: 1.7,
  query_latency_p90_ms: 5.2,
  batch_throughput_per_s: 8_800,
  gpu_role: "off",
  threads: 4,
  quantization: "float32",
};

function statusSnapshot(
  overrides: Partial<EmbeddingStatusSnapshot> = {},
): EmbeddingStatusSnapshot {
  return {
    enabled: true,
    ready: true,
    settings: SETTINGS,
    space: null,
    calibration: null,
    build: null,
    egress: false,
    failure: null,
    ...overrides,
  };
}

function statusCommand(): EmbeddingStatusCommand {
  return {
    type: "embedding_status",
    request_id: "r-status",
    runtime: RUNTIME,
  };
}

function configureCommand(
  patch: EmbeddingConfigurePatch = { enabled: true },
): EmbeddingConfigureCommand {
  return {
    type: "embedding_configure",
    request_id: "r-configure",
    runtime: RUNTIME,
    patch,
  };
}

function enableCommand(): EmbeddingEnableCommand {
  return {
    type: "embedding_enable",
    request_id: "r-enable",
    runtime: RUNTIME,
  };
}

function disableCommand(): EmbeddingDisableCommand {
  return {
    type: "embedding_disable",
    request_id: "r-disable",
    runtime: RUNTIME,
  };
}

function buildCommand(): EmbeddingBuildCommand {
  return {
    type: "embedding_build",
    request_id: "r-build",
    runtime: RUNTIME,
  };
}

function cancelCommand(buildId?: string): EmbeddingCancelCommand {
  return {
    type: "embedding_cancel",
    request_id: "r-cancel",
    runtime: RUNTIME,
    ...(buildId === undefined ? {} : { build_id: buildId }),
  };
}

function resetCommand(scope?: "index" | "all"): EmbeddingResetCommand {
  return {
    type: "embedding_reset",
    request_id: "r-reset",
    runtime: RUNTIME,
    ...(scope === undefined ? {} : { scope }),
  };
}

function calibrateCommand(): EmbeddingCalibrateCommand {
  return {
    type: "embedding_calibrate",
    request_id: "r-calibrate",
    runtime: RUNTIME,
  };
}

type Harness = {
  sent: unknown[];
  socket: WebSocket;
  send: SafeSocketSend;
};

function harness(): Harness {
  const sent: unknown[] = [];
  const socket = {} as WebSocket;
  const send: SafeSocketSend = (_socket, payload) => {
    sent.push(payload);
    return true;
  };
  return { sent, socket, send };
}

function lastSent(sent: unknown[]): Record<string, unknown> {
  const payload = sent.at(-1);
  if (payload === undefined) throw new Error("nothing was sent");
  return payload as Record<string, unknown>;
}

type FakeBackend = {
  backend: EmbeddingCommandBackend;
  calls: string[];
};

function createFakeBackend(
  overrides: Partial<EmbeddingCommandBackend> = {},
): FakeBackend {
  const calls: string[] = [];
  const backend: EmbeddingCommandBackend = {
    status: async (agentId) => {
      calls.push(`status:${agentId}`);
      return { configured: true, status: statusSnapshot() };
    },
    configure: async (agentId, patch) => {
      calls.push(`configure:${agentId}:${JSON.stringify(patch)}`);
      return {
        ok: true,
        value: { settings: SETTINGS, requiresRebuild: false },
      };
    },
    enable: async (agentId) => {
      calls.push(`enable:${agentId}`);
      return { ok: true, value: { enabled: true, buildStarted: true } };
    },
    disable: async (agentId) => {
      calls.push(`disable:${agentId}`);
      return { ok: true, value: { enabled: false } };
    },
    build: async (agentId, options) => {
      calls.push(`build:${agentId}:${options.mode}:${options.keepAfterExit}`);
      return { ok: true, value: { started: true, buildId: "build-1" } };
    },
    cancel: async (agentId, buildId) => {
      calls.push(`cancel:${agentId}:${buildId ?? ""}`);
      return { ok: true, value: { cancelled: true } };
    },
    reset: async (agentId, scope) => {
      calls.push(`reset:${agentId}:${scope}`);
      return { ok: true, value: { removedSpaces: 2, requiresRebuild: true } };
    },
    calibrate: async (agentId, persist) => {
      calls.push(`calibrate:${agentId}:${persist}`);
      return { ok: true, value: { calibration: CALIBRATION } };
    },
    ...overrides,
  };
  return { backend, calls };
}

describe("embedding protocol dispatch", () => {
  test("claims the eight commands and queues one detached task each", async () => {
    const queued: Array<{ name: string; task: () => Promise<void> }> = [];
    const { sent, socket, send } = harness();
    const context = {
      socket,
      safeSocketSend: send,
      runDetachedListenerTask: (name: string, task: () => Promise<void>) => {
        queued.push({ name, task });
      },
    };
    const { backend } = createFakeBackend();
    const commands: unknown[] = [
      statusCommand(),
      configureCommand(),
      enableCommand(),
      disableCommand(),
      buildCommand(),
      cancelCommand(),
      resetCommand(),
      calibrateCommand(),
    ];

    for (const command of commands) {
      expect(handleEmbeddingProtocolCommand(command, context, backend)).toBe(
        true,
      );
    }
    expect(queued.map((entry) => entry.name)).toEqual(
      commands.map(() => "embedding_protocol_command"),
    );

    await Promise.all(queued.map((entry) => entry.task()));
    expect(sent).toHaveLength(commands.length);
    expect(
      new Set(sent.map((payload) => (payload as { type: string }).type)),
    ).toEqual(
      new Set([
        "embedding_status_response",
        "embedding_configure_response",
        "embedding_enable_response",
        "embedding_disable_response",
        "embedding_build_response",
        "embedding_cancel_response",
        "embedding_reset_response",
        "embedding_calibrate_response",
      ]),
    );
  });

  test("commands outside the family are not claimed", () => {
    const { backend } = createFakeBackend();
    const context = {
      socket: {} as WebSocket,
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
    };
    expect(
      handleEmbeddingProtocolCommand(
        { type: "cron_list", request_id: "r1" },
        context,
        backend,
      ),
    ).toBe(false);
  });
});

describe("placeholder backend", () => {
  test("status and every write command answer not_configured", async () => {
    const backend = createEmbeddingCommandBackend();
    expect(await backend.status(AGENT)).toEqual({
      configured: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });
    const failures = [
      await backend.configure(AGENT, {}),
      await backend.enable(AGENT),
      await backend.disable(AGENT),
      await backend.build(AGENT, { mode: "incremental", keepAfterExit: false }),
      await backend.cancel(AGENT, undefined),
      await backend.reset(AGENT, "index"),
      await backend.calibrate(AGENT, true),
    ];
    for (const failure of failures) {
      expect(failure).toEqual({
        ok: false,
        error: EMBEDDING_NOT_CONFIGURED,
      });
    }
  });

  test("deps can override one method while the rest stay stubbed", async () => {
    const backend = createEmbeddingCommandBackend({
      enable: async () => ({
        ok: true,
        value: { enabled: true, buildStarted: false },
      }),
    });
    expect(await backend.enable(AGENT)).toEqual({
      ok: true,
      value: { enabled: true, buildStarted: false },
    });
    expect(await backend.status(AGENT)).toEqual({
      configured: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });
  });

  test("the handlers surface the placeholder as an actionable error", async () => {
    const { sent, socket, send } = harness();
    await handleEmbeddingStatusCommand(statusCommand(), socket, send);
    expect(lastSent(sent)).toEqual({
      type: "embedding_status_response",
      request_id: "r-status",
      success: false,
      status: null,
      error: EMBEDDING_NOT_CONFIGURED,
    });
  });
});

describe("embedding_status", () => {
  test("answers the backend snapshot on success", async () => {
    const { backend } = createFakeBackend();
    const { sent, socket, send } = harness();
    await handleEmbeddingStatusCommand(statusCommand(), socket, send, backend);
    expect(lastSent(sent)).toEqual({
      type: "embedding_status_response",
      request_id: "r-status",
      success: true,
      status: statusSnapshot(),
    });
  });

  test("a not-configured backend does not invent a snapshot", async () => {
    const { backend } = createFakeBackend({
      status: async () => ({
        configured: false,
        error: "builtin_model_missing",
      }),
    });
    const { sent, socket, send } = harness();
    await handleEmbeddingStatusCommand(statusCommand(), socket, send, backend);
    expect(lastSent(sent)).toEqual({
      type: "embedding_status_response",
      request_id: "r-status",
      success: false,
      status: null,
      error: "builtin_model_missing",
    });
  });

  test("a thrown backend error becomes the response error", async () => {
    const { backend } = createFakeBackend({
      status: async () => {
        throw new Error("state.json unreadable");
      },
    });
    const { sent, socket, send } = harness();
    await handleEmbeddingStatusCommand(statusCommand(), socket, send, backend);
    expect(lastSent(sent)).toMatchObject({
      success: false,
      status: null,
      error: "state.json unreadable",
    });
  });
});

describe("embedding_configure", () => {
  test("forwards the patch (api_key included) and never echoes the credential", async () => {
    const seen: { patch: EmbeddingConfigurePatch | null } = { patch: null };
    const { backend } = createFakeBackend({
      configure: async (_agentId, patch) => {
        seen.patch = patch;
        return {
          ok: true,
          value: { settings: SETTINGS, requiresRebuild: true },
        };
      },
    });
    const { sent, socket, send } = harness();
    const patch: EmbeddingConfigurePatch = {
      enabled: true,
      weight: 0.7,
      api_key: "sk-local-test",
    };
    await handleEmbeddingConfigureCommand(
      configureCommand(patch),
      socket,
      send,
      backend,
    );

    expect(seen.patch).toEqual(patch);
    expect(lastSent(sent)).toEqual({
      type: "embedding_configure_response",
      request_id: "r-configure",
      success: true,
      settings: SETTINGS,
      requires_rebuild: true,
    });
    expect(JSON.stringify(lastSent(sent))).not.toContain("sk-local-test");
  });

  test("a malformed patch is rejected before the backend sees it", async () => {
    const { backend, calls } = createFakeBackend();
    const { sent, socket, send } = harness();
    const command = {
      ...configureCommand(),
      patch: { weight: 2 },
    } as unknown as EmbeddingConfigureCommand;

    await handleEmbeddingConfigureCommand(command, socket, send, backend);
    expect(lastSent(sent)).toMatchObject({
      success: false,
      settings: null,
      requires_rebuild: false,
      error: EMBEDDING_INVALID_PATCH,
    });
    expect(calls).toEqual([]);
  });

  test("cross-field chunk bounds are rejected", async () => {
    const { backend, calls } = createFakeBackend();
    const { sent, socket, send } = harness();
    await handleEmbeddingConfigureCommand(
      configureCommand({ chunk_target: 300, chunk_max: 200 }),
      socket,
      send,
      backend,
    );
    expect(lastSent(sent)).toMatchObject({
      success: false,
      error: "embedding_chunk_target_exceeds_max",
    });
    expect(calls).toEqual([]);
  });

  test("a declined patch answers a typed failure", async () => {
    const { backend } = createFakeBackend({
      configure: async () => ({ ok: false, error: "settings_locked" }),
    });
    const { sent, socket, send } = harness();
    await handleEmbeddingConfigureCommand(
      configureCommand(),
      socket,
      send,
      backend,
    );
    expect(lastSent(sent)).toEqual({
      type: "embedding_configure_response",
      request_id: "r-configure",
      success: false,
      settings: null,
      requires_rebuild: false,
      error: "settings_locked",
    });
  });
});

describe("embedding_enable / disable", () => {
  test("enable reports the switch and whether the first build started", async () => {
    const { backend } = createFakeBackend();
    const { sent, socket, send } = harness();
    await handleEmbeddingEnableCommand(enableCommand(), socket, send, backend);
    expect(lastSent(sent)).toEqual({
      type: "embedding_enable_response",
      request_id: "r-enable",
      success: true,
      enabled: true,
      build_started: true,
    });
  });

  test("disable reports the switch", async () => {
    const { backend } = createFakeBackend();
    const { sent, socket, send } = harness();
    await handleEmbeddingDisableCommand(
      disableCommand(),
      socket,
      send,
      backend,
    );
    expect(lastSent(sent)).toEqual({
      type: "embedding_disable_response",
      request_id: "r-disable",
      success: true,
      enabled: false,
    });
  });
});

describe("embedding_build", () => {
  test("defaults to an incremental build and reports the build id", async () => {
    const seen: { options: EmbeddingBuildOptions | null } = { options: null };
    const { backend } = createFakeBackend({
      build: async (_agentId, options) => {
        seen.options = options;
        return { ok: true, value: { started: true, buildId: "build-1" } };
      },
    });
    const { sent, socket, send } = harness();
    await handleEmbeddingBuildCommand(buildCommand(), socket, send, backend);

    expect(seen.options).toEqual({
      mode: "incremental",
      keepAfterExit: false,
    });
    expect(lastSent(sent)).toEqual({
      type: "embedding_build_response",
      request_id: "r-build",
      success: true,
      started: true,
      build_id: "build-1",
    });
  });

  test("a declined launch is success with a reason, not an error", async () => {
    const { backend } = createFakeBackend({
      build: async () => ({
        ok: true,
        value: { started: false, reason: "build_locked" },
      }),
    });
    const { sent, socket, send } = harness();
    await handleEmbeddingBuildCommand(buildCommand(), socket, send, backend);
    expect(lastSent(sent)).toEqual({
      type: "embedding_build_response",
      request_id: "r-build",
      success: true,
      started: false,
      reason: "build_locked",
    });
  });

  test("an invalid mode is rejected before the backend", async () => {
    const { backend, calls } = createFakeBackend();
    const { sent, socket, send } = harness();
    const command = {
      ...buildCommand(),
      mode: "bogus",
    } as unknown as EmbeddingBuildCommand;
    await handleEmbeddingBuildCommand(command, socket, send, backend);
    expect(lastSent(sent)).toMatchObject({
      success: false,
      started: false,
      error: "invalid_embedding_build_mode",
    });
    expect(calls).toEqual([]);
  });
});

describe("embedding_cancel / reset / calibrate", () => {
  test("cancel forwards the optional build id", async () => {
    const seen: { buildId: string | undefined } = { buildId: undefined };
    const { backend } = createFakeBackend({
      cancel: async (_agentId, buildId) => {
        seen.buildId = buildId;
        return { ok: true, value: { cancelled: true } };
      },
    });
    const { sent, socket, send } = harness();
    await handleEmbeddingCancelCommand(
      cancelCommand("build-9"),
      socket,
      send,
      backend,
    );
    expect(seen.buildId).toBe("build-9");
    expect(lastSent(sent)).toEqual({
      type: "embedding_cancel_response",
      request_id: "r-cancel",
      success: true,
      cancelled: true,
    });
  });

  test("reset defaults to the index scope", async () => {
    const seen: { scope: "index" | "all" | null } = { scope: null };
    const { backend } = createFakeBackend({
      reset: async (_agentId, scope) => {
        seen.scope = scope;
        return { ok: true, value: { removedSpaces: 2, requiresRebuild: true } };
      },
    });
    const { sent, socket, send } = harness();
    await handleEmbeddingResetCommand(resetCommand(), socket, send, backend);
    expect(seen.scope).toBe("index");
    expect(lastSent(sent)).toEqual({
      type: "embedding_reset_response",
      request_id: "r-reset",
      success: true,
      removed_spaces: 2,
      requires_rebuild: true,
    });
  });

  test("calibrate defaults to persisting the result", async () => {
    const seen: { persist: boolean | null } = { persist: null };
    const { backend } = createFakeBackend({
      calibrate: async (_agentId, persist) => {
        seen.persist = persist;
        return { ok: true, value: { calibration: CALIBRATION } };
      },
    });
    const { sent, socket, send } = harness();
    await handleEmbeddingCalibrateCommand(
      calibrateCommand(),
      socket,
      send,
      backend,
    );
    expect(seen.persist).toBe(true);
    expect(lastSent(sent)).toEqual({
      type: "embedding_calibrate_response",
      request_id: "r-calibrate",
      success: true,
      calibration: CALIBRATION,
    });
  });
});

describe("typed backend declines", () => {
  test("every write command answers its shape's defaults on decline", async () => {
    const declined = async (): Promise<{
      ok: false;
      error: string;
    }> => ({ ok: false, error: "declined" });
    const { backend } = createFakeBackend({
      configure: declined,
      enable: declined,
      disable: declined,
      build: declined,
      cancel: declined,
      reset: declined,
      calibrate: declined,
    });
    const cases: Array<{
      type: string;
      defaults: Record<string, unknown>;
      run: (socket: WebSocket, send: SafeSocketSend) => Promise<void>;
    }> = [
      {
        type: "embedding_configure_response",
        defaults: { settings: null, requires_rebuild: false },
        run: (socket, send) =>
          handleEmbeddingConfigureCommand(
            configureCommand(),
            socket,
            send,
            backend,
          ),
      },
      {
        type: "embedding_enable_response",
        defaults: { enabled: false, build_started: false },
        run: (socket, send) =>
          handleEmbeddingEnableCommand(enableCommand(), socket, send, backend),
      },
      {
        type: "embedding_disable_response",
        defaults: { enabled: false },
        run: (socket, send) =>
          handleEmbeddingDisableCommand(
            disableCommand(),
            socket,
            send,
            backend,
          ),
      },
      {
        type: "embedding_build_response",
        defaults: { started: false },
        run: (socket, send) =>
          handleEmbeddingBuildCommand(buildCommand(), socket, send, backend),
      },
      {
        type: "embedding_cancel_response",
        defaults: { cancelled: false },
        run: (socket, send) =>
          handleEmbeddingCancelCommand(cancelCommand(), socket, send, backend),
      },
      {
        type: "embedding_reset_response",
        defaults: { removed_spaces: 0, requires_rebuild: false },
        run: (socket, send) =>
          handleEmbeddingResetCommand(resetCommand(), socket, send, backend),
      },
      {
        type: "embedding_calibrate_response",
        defaults: { calibration: null },
        run: (socket, send) =>
          handleEmbeddingCalibrateCommand(
            calibrateCommand(),
            socket,
            send,
            backend,
          ),
      },
    ];

    for (const item of cases) {
      const { sent, socket, send } = harness();
      await item.run(socket, send);
      expect(lastSent(sent)).toMatchObject({
        type: item.type,
        success: false,
        error: "declined",
        ...item.defaults,
      });
    }
  });
});

describe("scope validation", () => {
  test("an empty agent id is rejected before the backend runs", async () => {
    const { backend, calls } = createFakeBackend();
    const { sent, socket, send } = harness();
    const command: EmbeddingStatusCommand = {
      type: "embedding_status",
      request_id: "r-status",
      runtime: { agent_id: "", conversation_id: CONVERSATION },
    };
    await handleEmbeddingStatusCommand(command, socket, send, backend);
    expect(lastSent(sent)).toMatchObject({
      success: false,
      status: null,
      error: EMBEDDING_INVALID_SCOPE,
    });
    expect(calls).toEqual([]);
  });

  test("an empty conversation id is rejected before the backend runs", async () => {
    const { backend, calls } = createFakeBackend();
    const { sent, socket, send } = harness();
    const command: EmbeddingEnableCommand = {
      type: "embedding_enable",
      request_id: "r-enable",
      runtime: { agent_id: AGENT, conversation_id: "" },
    };
    await handleEmbeddingEnableCommand(command, socket, send, backend);
    expect(lastSent(sent)).toMatchObject({
      success: false,
      enabled: false,
      build_started: false,
      error: EMBEDDING_INVALID_SCOPE,
    });
    expect(calls).toEqual([]);
  });
});
