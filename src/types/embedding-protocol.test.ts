/**
 * Contract coverage for the R-26 embedding command family (D1).
 *
 * The D2 handler owns behaviour; this file pins the wire shapes and proves they
 * reach the public protocol union (`@/types/app-server-protocol`), so a client
 * can compile against the family without importing the listener.
 */
import { describe, expect, test } from "bun:test";
import type {
  DeviceStatus,
  EmbeddingDeviceSummary,
  EmbeddingProtocolCommand,
  EmbeddingProtocolResponseMessage,
  EmbeddingSettingsSnapshot,
  EmbeddingStatusSnapshot,
  WsProtocolCommand,
  WsProtocolMessage,
} from "@/types/app-server-protocol";

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };

const settings: EmbeddingSettingsSnapshot = {
  enabled: true,
  backend: "builtin",
  model: "bge-small-zh-v1.5",
  endpoint: null,
  weight: 0.5,
  candidate_depth: 50,
  chunk_target: 200,
  chunk_max: 256,
  chunk_overlap: 32,
  max_chunks_per_message: 1024,
  threads: 0,
  gpu: "auto",
  quantization: "float32",
  keep_spaces: 2,
};

const status: EmbeddingStatusSnapshot = {
  enabled: true,
  ready: true,
  settings,
  space: {
    space_id: "space-1",
    model: "bge-small-zh-v1.5",
    dimensions: 512,
    quantization: "float32",
    coverage: 0.97,
    conversations: 12,
    chunks: 11270,
    bytes: 23_100_000,
    built_at: "2026-11-03T00:00:00.000Z",
  },
  calibration: {
    fingerprint: "fp-1",
    measured_at: "2026-11-03T00:00:00.000Z",
    query_latency_p50_ms: 12,
    query_latency_p90_ms: 28,
    batch_throughput_per_s: 320,
    gpu_role: "index-only",
    threads: 2,
    quantization: "float32",
  },
  build: {
    build_id: "build-1",
    mode: "full",
    state: "running",
    started_at: "2026-11-03T00:00:00.000Z",
    updated_at: "2026-11-03T00:00:05.000Z",
    progress: 0.34,
    processed_chunks: 1200,
    total_chunks: 3600,
    eta_ms: 480_000,
  },
  egress: false,
  failure: null,
};

const commands: EmbeddingProtocolCommand[] = [
  { type: "embedding_status", request_id: "req-status", runtime },
  {
    type: "embedding_connect",
    request_id: "req-connect",
    runtime,
    patch: {
      enabled: true,
      backend: "endpoint",
      endpoint: {
        kind: "openai",
        base_url: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        dimensions: 1536,
        timeout_ms: 10_000,
      },
      // O-18: api_key is accepted on the wire and only ever write-only.
      api_key: "sk-test",
      weight: 0.4,
      chunk_target: 180,
      chunk_max: 240,
      chunk_overlap: 24,
      max_chunks_per_message: 512,
      threads: 1,
      gpu: "off",
      quantization: "int8",
      keep_spaces: 1,
    },
  },
  { type: "embedding_enable", request_id: "req-enable", runtime },
  { type: "embedding_disable", request_id: "req-disable", runtime },
  {
    type: "embedding_build",
    request_id: "req-build",
    runtime,
    mode: "full",
    keep_after_exit: true,
  },
  {
    type: "embedding_cancel",
    request_id: "req-cancel",
    runtime,
    build_id: "build-1",
  },
  {
    type: "embedding_profiles_list",
    request_id: "req-profiles",
    runtime,
  },
  {
    type: "embedding_profile_select",
    request_id: "req-select",
    runtime,
    index: 1,
  },
  {
    type: "embedding_profile_delete",
    request_id: "req-delete",
    runtime,
    scope: "all",
    confirm: true,
  },
  {
    type: "embedding_profile_pin",
    request_id: "req-pin",
    runtime,
    index: 2,
    pinned: true,
  },
  {
    type: "embedding_config_get",
    request_id: "req-config-get",
    runtime,
    key: "threads",
  },
  {
    type: "embedding_config_set",
    request_id: "req-config-set",
    runtime,
    key: "gpu",
    value: "off",
  },
  { type: "embedding_device", request_id: "req-device", runtime },
  { type: "embedding_device_test", request_id: "req-device-test", runtime },
];

const responses: EmbeddingProtocolResponseMessage[] = [
  {
    type: "embedding_status_response",
    request_id: "req-status",
    success: true,
    status,
  },
  {
    type: "embedding_connect_response",
    request_id: "req-connect",
    success: true,
    settings,
    space_id: "space-1",
    requires_rebuild: true,
  },
  {
    type: "embedding_enable_response",
    request_id: "req-enable",
    success: true,
    enabled: true,
    build_started: true,
  },
  {
    type: "embedding_disable_response",
    request_id: "req-disable",
    success: true,
    enabled: false,
  },
  {
    type: "embedding_build_response",
    request_id: "req-build",
    success: true,
    started: false,
    reason: "a build is already running",
  },
  {
    type: "embedding_cancel_response",
    request_id: "req-cancel",
    success: true,
    cancelled: true,
  },
  {
    type: "embedding_profiles_list_response",
    request_id: "req-profiles",
    success: true,
    profiles: [
      {
        index: 1,
        space_id: "space-1",
        model: "bge-small-zh-v1.5",
        dimensions: 512,
        quantization: "float32",
        chunks: 11270,
        bytes: 23_100_000,
        built_at: "2026-11-03T00:00:00.000Z",
        active: true,
        pinned: false,
        legacy: false,
      },
    ],
  },
  {
    type: "embedding_profile_select_response",
    request_id: "req-select",
    success: true,
    settings,
    requires_rebuild: false,
  },
  {
    type: "embedding_profile_delete_response",
    request_id: "req-delete",
    success: true,
    removed_spaces: 1,
    requires_rebuild: true,
  },
  {
    type: "embedding_profile_pin_response",
    request_id: "req-pin",
    success: true,
    profiles: [],
  },
  {
    type: "embedding_config_get_response",
    request_id: "req-config-get",
    success: true,
    keys: [{ key: "threads", value: 2 }],
    settings,
  },
  {
    type: "embedding_config_set_response",
    request_id: "req-config-set",
    success: true,
    settings,
    requires_rebuild: false,
  },
  {
    type: "embedding_device_response",
    request_id: "req-device",
    success: true,
    device: {
      backend: "builtin",
      requested: ["cpu"],
      initialized: ["cpu"],
      gpu: false,
      degraded: false,
      threads: 2,
      warmup_ms: 120,
      measured_at: "2026-11-03T00:00:00.000Z",
    },
  },
  {
    type: "embedding_device_test_response",
    request_id: "req-device-test",
    success: true,
    calibration: status.calibration,
  },
];

describe("embedding protocol commands", () => {
  test("every command carries its discriminant and a non-empty request id", () => {
    expect(new Set(commands.map((command) => command.type)).size).toBe(14);
    for (const command of commands) {
      expect(command.type).toStartWith("embedding_");
      expect(command.request_id.length).toBeGreaterThan(0);
      expect(command.runtime.agent_id).toBe("agent-1");
    }
  });

  test("each command is assignable to the public WsProtocolCommand union", () => {
    const widened: WsProtocolCommand[] = commands;
    expect(widened).toHaveLength(commands.length);
    expect(widened[0]?.type).toBe("embedding_status");
  });
});

describe("embedding protocol responses", () => {
  test("every response correlates on its request id", () => {
    const responseTypes = responses.map((response) => response.type);
    expect(new Set(responseTypes).size).toBe(14);
    for (const expectedType of [
      "embedding_status_response",
      "embedding_connect_response",
      "embedding_enable_response",
      "embedding_disable_response",
      "embedding_build_response",
      "embedding_cancel_response",
      "embedding_profiles_list_response",
      "embedding_profile_select_response",
      "embedding_profile_delete_response",
      "embedding_profile_pin_response",
      "embedding_config_get_response",
      "embedding_config_set_response",
      "embedding_device_response",
      "embedding_device_test_response",
    ] as const) {
      expect(responseTypes).toContain(expectedType);
    }
    for (const response of responses) {
      expect(response.request_id).toStartWith("req-");
      expect(typeof response.success).toBe("boolean");
    }
  });

  test("each response is assignable to the public WsProtocolMessage union", () => {
    const widened: WsProtocolMessage[] = responses;
    expect(widened).toHaveLength(responses.length);
  });
});

describe("device_status.embedding projection", () => {
  test("summary keeps the idle case small and the running case informative", () => {
    const idle: EmbeddingDeviceSummary = { enabled: false, state: "idle" };
    const running: EmbeddingDeviceSummary = {
      enabled: true,
      state: "running",
      progress: 0.34,
      processed_chunks: 1200,
      total_chunks: 3600,
      eta_ms: 480_000,
      space_id: "space-1",
      model: "bge-small-zh-v1.5",
      failure: null,
    };
    const projected: NonNullable<DeviceStatus["embedding"]> = running;
    expect(idle.progress).toBeUndefined();
    expect(projected.state).toBe("running");
    expect(projected.eta_ms).toBe(480_000);
  });
});
