/**
 * The production `EmbeddingCommandBackend` (D2, 48-2 §4.9).
 *
 * Every case injects `EmbeddingCommandBackendDeps`: no worker is spawned, no
 * index is written and no network is reached. The handler tests stay in
 * `embedding.test.ts`; this file owns the D3/A2/C5 mapping.
 */
import { describe, expect, test } from "bun:test";
import type { EmbeddingBuildStateSnapshot } from "@/backend/local/embedding-build-state";
import {
  EmbeddingSettingsError,
  type EmbeddingSettingsPatch,
  previewEmbeddingSettings,
} from "@/cli/app/pages/settings/embedding-settings";
import type {
  EmbeddingRuntimePort,
  EmbeddingRuntimeStatus,
} from "@/cli/commands/embedding-runtime-contract";
import type { BuildEmbeddingFromSettingsRequest } from "@/cli/helpers/embedding-runtime";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";
import type { EmbeddingCalibrationSnapshot } from "@/types/embedding-protocol";
import {
  createEmbeddingCommandBackend,
  EMBEDDING_ENDPOINT_CONFIG_REQUIRED,
  EMBEDDING_NOT_CONFIGURED,
  type EmbeddingCommandBackend,
  type EmbeddingCommandBackendDeps,
} from "./embedding-backend";

/** A stored endpoint, used by the merged-coherence configure tests. */
const STORED_ENDPOINT: ResolvedEmbeddingSettings["endpoint"] = {
  kind: "openai",
  baseUrl: "https://api.example.com/v1",
  model: "text-embedding-3-small",
  dimensions: 384,
};

const AGENT = "agent-embedding-protocol";
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

// ── Production backend ──────────────────────────────────────────────

const MODEL_ID = "bge-small-zh-v1.5";
const DIMENSIONS = 384;
const NOW = 1_700_000_000_000;

function resolvedSettings(
  overrides: Partial<ResolvedEmbeddingSettings> = {},
): ResolvedEmbeddingSettings {
  return { ...EMBEDDING_SETTING_DEFAULTS, enabled: true, ...overrides };
}

function runtimeStatus(
  overrides: Partial<EmbeddingRuntimeStatus> = {},
): EmbeddingRuntimeStatus {
  return {
    ready: true,
    space: {
      model: MODEL_ID,
      dimensions: DIMENSIONS,
      chunks: 100,
      conversations: 2,
      coverage: 0.5,
      builtAt: "2026-11-03T00:00:00.000Z",
    },
    build: null,
    buildSnapshot: null,
    calibration: null,
    egress: false,
    failure: null,
    ...overrides,
  };
}

const BUILD_SNAPSHOT: EmbeddingBuildStateSnapshot = {
  schemaVersion: 1,
  agentId: AGENT,
  spaceId: "space-test",
  buildId: "build-7",
  mode: "incremental",
  phase: "running",
  updatedAt: NOW,
  startedAt: NOW - 1_000,
  finishedAt: null,
  progress: {
    embeddedChunks: 25,
    totalChunks: 100,
    processedConversations: 1,
    totalConversations: 4,
    remainingChunks: 75,
    fraction: 0.25,
  },
  coverage: { embeddedChars: 10, recallableChars: 20, ratio: 0.5 },
  rate: { chunksPerSecond: 2, windowMs: 1_000, sampleCount: 2 },
  eta: { remainingChunks: 75, remainingMs: 3_000 },
  failures: [],
  device: null,
};

interface BackendHarness {
  deps: EmbeddingCommandBackendDeps;
  writes: EmbeddingSettingsPatch[];
  savedKeys: Array<[string, string]>;
  builds: BuildEmbeddingFromSettingsRequest[];
  settings: () => ResolvedEmbeddingSettings;
  buildBackend: () => EmbeddingCommandBackend;
}

function backendHarness(
  options: {
    settings?: Partial<ResolvedEmbeddingSettings>;
    runtime?: EmbeddingRuntimePort;
    buildReceipt?: string;
    calibration?: EmbeddingCalibrationSnapshot;
    writeSettings?: (
      patch: EmbeddingSettingsPatch,
    ) => ResolvedEmbeddingSettings;
    buildFromSettings?: (
      request: BuildEmbeddingFromSettingsRequest,
    ) => Promise<string>;
  } = {},
): BackendHarness {
  let current = resolvedSettings(options.settings);
  const writes: EmbeddingSettingsPatch[] = [];
  const savedKeys: Array<[string, string]> = [];
  const builds: BuildEmbeddingFromSettingsRequest[] = [];
  const write =
    options.writeSettings ??
    ((patch: EmbeddingSettingsPatch) => {
      writes.push(patch);
      current = previewEmbeddingSettings(patch, current);
      return current;
    });
  const deps: EmbeddingCommandBackendDeps = {
    runtime: options.runtime ?? {
      readStatus: async () => runtimeStatus(),
      build: async () => options.buildReceipt ?? "Build started (incremental).",
      cancel: async () =>
        "Cancelled the embedding build; committed chunks stay.",
      reset: async () =>
        "Deleted 1 vector space (the stored vector space for the current model).",
    },
    readSettings: () => current,
    writeSettings: write,
    saveApiKey: async (value, agentId) => {
      savedKeys.push([value, agentId]);
    },
    readSpaceId: () => "space-test",
    buildFromSettings:
      options.buildFromSettings ??
      (async (request) => {
        builds.push(request);
        return options.buildReceipt ?? "Build started (incremental).";
      }),
    runCalibration: async () => options.calibration ?? CALIBRATION,
  };
  return {
    deps,
    writes,
    savedKeys,
    builds,
    settings: () => current,
    buildBackend: () => createEmbeddingCommandBackend({}, deps),
  };
}

describe("production backend", () => {
  test("status maps runtime space, build projection and settings to D1", async () => {
    const h = backendHarness({
      runtime: {
        readStatus: async () =>
          runtimeStatus({ buildSnapshot: BUILD_SNAPSHOT, egress: true }),
      },
    });
    const result = await h.buildBackend().status(AGENT);
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected a configured status");

    expect(result.status.enabled).toBe(true);
    expect(result.status.ready).toBe(true);
    expect(result.status.egress).toBe(true);
    expect(result.status.failure).toBeNull();
    // Settings are wire spelling, never the credential.
    expect(result.status.settings).toEqual({
      enabled: true,
      backend: "builtin",
      model: MODEL_ID,
      endpoint: null,
      weight: 0.5,
      candidate_depth: 50,
      chunk_target: 200,
      chunk_max: 256,
      chunk_overlap: 32,
      max_chunks_per_message: 1_024,
      threads: 0,
      gpu: "auto",
      quantization: "float32",
      keep_spaces: 2,
    });
    // D1 requires `bytes`; it is the committed vector payload estimate.
    expect(result.status.space).toEqual({
      space_id: "space-test",
      model: MODEL_ID,
      dimensions: DIMENSIONS,
      quantization: "float32",
      coverage: 0.5,
      conversations: 2,
      chunks: 100,
      bytes: 100 * (DIMENSIONS * 4 + 4),
      built_at: "2026-11-03T00:00:00.000Z",
    });
    expect(result.status.build).toEqual({
      build_id: "build-7",
      mode: "incremental",
      state: "running",
      started_at: new Date(NOW - 1_000).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      progress: 0.25,
      processed_chunks: 25,
      total_chunks: 100,
      eta_ms: 3_000,
    });
  });

  test("status maps a stored calibration snapshot from settings", async () => {
    const h = backendHarness({
      settings: {
        calibration: {
          fingerprint: "fp-test",
          measuredAt: CALIBRATION.measured_at,
          queryLatencyP50Ms: CALIBRATION.query_latency_p50_ms,
          queryLatencyP90Ms: CALIBRATION.query_latency_p90_ms,
          batchThroughputPerSec: CALIBRATION.batch_throughput_per_s,
          gpuRole: CALIBRATION.gpu_role,
          threads: CALIBRATION.threads,
          quantization: CALIBRATION.quantization,
        },
      },
    });
    const result = await h.buildBackend().status(AGENT);
    if (!result.configured) throw new Error("expected a configured status");
    expect(result.status.calibration).toEqual(CALIBRATION);
  });

  test("status is not configured when the runtime cannot read it", async () => {
    const missing = backendHarness({
      runtime: { readStatus: async () => null },
    });
    expect(await missing.buildBackend().status(AGENT)).toEqual({
      configured: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });

    const unwired = backendHarness({ runtime: {} });
    expect(await unwired.buildBackend().status(AGENT)).toEqual({
      configured: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });
  });

  test("configure maps the wire patch into D3 and reports a required rebuild", async () => {
    const h = backendHarness();
    const result = await h.buildBackend().connect(AGENT, {
      model: "bge-m3",
      weight: 0.7,
      candidate_depth: 80,
      chunk_target: 300,
      chunk_max: 400,
      chunk_overlap: 40,
      max_chunks_per_message: 512,
      threads: 2,
      gpu: "index-only",
      quantization: "int8",
      keep_spaces: 3,
      endpoint: {
        kind: "openai",
        base_url: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        dimensions: 1_024,
        timeout_ms: 5_000,
      },
    });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ requiresRebuild: true }),
    });
    expect(h.writes).toEqual([
      {
        model: "bge-m3",
        weight: 0.7,
        candidateDepth: 80,
        chunkTarget: 300,
        chunkMax: 400,
        chunkOverlap: 40,
        maxChunksPerMessage: 512,
        threads: 2,
        gpu: "index-only",
        quantization: "int8",
        keepSpaces: 3,
        endpoint: {
          kind: "openai",
          baseUrl: "https://api.example.com/v1",
          model: "text-embedding-3-small",
          dimensions: 1_024,
          timeoutMs: 5_000,
        },
      },
    ]);
    if (!result.ok) throw new Error("expected the patch to be accepted");
    expect(result.value.settings.endpoint).toEqual({
      kind: "openai",
      base_url: "https://api.example.com/v1",
      model: "text-embedding-3-small",
      dimensions: 1_024,
      timeout_ms: 5_000,
    });
  });

  test("configure stores the write-only key without echoing it", async () => {
    const h = backendHarness();
    const result = await h.buildBackend().connect(AGENT, {
      api_key: "sk-listener-test",
      weight: 0.4,
    });
    expect(h.savedKeys).toEqual([["sk-listener-test", AGENT]]);
    expect(h.writes).toEqual([{ weight: 0.4 }]);
    if (!result.ok) throw new Error("expected the patch to be accepted");
    expect(JSON.stringify(result)).not.toContain("sk-listener-test");
  });

  test("configure refuses an invalid patch before anything writes", async () => {
    const h = backendHarness();
    const result = await h.buildBackend().connect(AGENT, {
      chunk_target: 300,
      chunk_max: 200,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("chunk max");
    expect(h.writes).toEqual([]);
  });

  test("configure accepts the endpoint backend when an endpoint is already stored", async () => {
    // The wire patch is partial: a client may configure the endpoint first and
    // select the backend in a later command. Judging `backend:"endpoint"`
    // against the patch alone would reject that legitimate two-step flow.
    const h = backendHarness({
      settings: { endpoint: STORED_ENDPOINT },
    });
    const result = await h.buildBackend().connect(AGENT, {
      backend: "endpoint",
    });
    expect(result).toEqual({ ok: true, value: expect.anything() });
    expect(h.writes).toEqual([{ backend: "endpoint" }]);
    expect(h.settings().backend).toBe("endpoint");
    expect(h.settings().endpoint).toEqual(STORED_ENDPOINT);
  });

  test("configure refuses an endpoint backend with no endpoint anywhere", async () => {
    const h = backendHarness();
    const result = await h.buildBackend().connect(AGENT, {
      backend: "endpoint",
      api_key: "sk-unusable",
    });
    expect(result).toEqual({
      ok: false,
      error: EMBEDDING_ENDPOINT_CONFIG_REQUIRED,
    });
    // Refused before the key store and the settings writer are touched.
    expect(h.writes).toEqual([]);
    expect(h.savedKeys).toEqual([]);
  });

  test("configure refuses clearing the endpoint while the endpoint backend is active", async () => {
    const h = backendHarness({
      settings: { backend: "endpoint", endpoint: STORED_ENDPOINT },
    });
    const result = await h.buildBackend().connect(AGENT, { endpoint: null });
    expect(result).toEqual({
      ok: false,
      error: EMBEDDING_ENDPOINT_CONFIG_REQUIRED,
    });
    expect(h.writes).toEqual([]);
  });

  test("configure surfaces the settings writer's refusal", async () => {
    const h = backendHarness({
      writeSettings: () => {
        throw new EmbeddingSettingsError("settings manager is not initialized");
      },
    });
    expect(await h.buildBackend().connect(AGENT, { weight: 0.3 })).toEqual({
      ok: false,
      error: "settings manager is not initialized",
    });
  });

  test("enable starts the first build when the space is empty", async () => {
    const seenStatus: unknown[] = [];
    const h = backendHarness({
      runtime: {
        readStatus: async (scope) => {
          seenStatus.push(scope);
          return runtimeStatus({ space: null, ready: false });
        },
      },
    });
    const result = await h.buildBackend().enable(AGENT);
    expect(result).toEqual({
      ok: true,
      value: { enabled: true, buildStarted: true },
    });
    expect(h.writes).toEqual([{ enabled: true }]);
    expect(h.builds).toEqual([
      {
        agentId: AGENT,
        mode: "incremental",
        keepAfterExit: false,
        lifecycle: "websocket",
      },
    ]);
    expect(seenStatus).toEqual([{ agentId: AGENT, conversationId: null }]);
  });

  test("enable does not rebuild an agent that already has a space", async () => {
    const h = backendHarness();
    const result = await h.buildBackend().enable(AGENT);
    expect(result).toEqual({
      ok: true,
      value: { enabled: true, buildStarted: false },
    });
    expect(h.builds).toEqual([]);
  });

  test("enable keeps the switch on when the first build is refused", async () => {
    const h = backendHarness({
      runtime: { readStatus: async () => runtimeStatus({ space: null }) },
      buildReceipt:
        "Built-in embedding is not ready: missing model. Run /recall embedding connect first.",
    });
    expect(await h.buildBackend().enable(AGENT)).toEqual({
      ok: true,
      value: {
        enabled: true,
        buildStarted: false,
        // The launcher's first line explains why nothing started; without it
        // the client cannot tell "already built" from "cannot build yet".
        reason:
          "Built-in embedding is not ready: missing model. Run /recall embedding connect first.",
      },
    });
    expect(h.settings().enabled).toBe(true);
  });

  test("enable reports a thrown first-build failure as a reason, not a failed enable", async () => {
    const h = backendHarness({
      runtime: { readStatus: async () => runtimeStatus({ space: null }) },
      buildFromSettings: async () => {
        throw new Error("The embedding worker entry is missing.");
      },
    });
    expect(await h.buildBackend().enable(AGENT)).toEqual({
      ok: true,
      value: {
        enabled: true,
        buildStarted: false,
        reason: "The embedding worker entry is missing.",
      },
    });
    expect(h.settings().enabled).toBe(true);
  });

  test("disable writes the switch off", async () => {
    const h = backendHarness();
    expect(await h.buildBackend().disable(AGENT)).toEqual({
      ok: true,
      value: { enabled: false },
    });
    expect(h.writes).toEqual([{ enabled: false }]);
  });

  test("build passes mode, keepAfterExit and the websocket lifecycle", async () => {
    const calls: unknown[][] = [];
    const h = backendHarness({
      runtime: {
        build: async (...args) => {
          calls.push(args);
          return "Build started (full).";
        },
      },
    });
    const result = await h.buildBackend().build(AGENT, {
      mode: "full",
      keepAfterExit: true,
    });
    expect(result).toEqual({ ok: true, value: { started: true } });
    expect(calls).toEqual([
      [
        { agentId: AGENT, conversationId: null },
        "full",
        { keepAfterExit: true, lifecycle: "websocket" },
      ],
    ]);
  });

  test("a build refusal is success with a reason", async () => {
    const h = backendHarness({
      runtime: {
        build: async () => "Another embedding build owns this index space.",
      },
    });
    expect(
      await h.buildBackend().build(AGENT, {
        mode: "incremental",
        keepAfterExit: false,
      }),
    ).toEqual({
      ok: true,
      value: {
        started: false,
        reason: "Another embedding build owns this index space.",
      },
    });
  });

  test("cancel reports the receipt's outcome", async () => {
    const cancelled = backendHarness();
    expect(await cancelled.buildBackend().cancel(AGENT, undefined)).toEqual({
      ok: true,
      value: { cancelled: true },
    });
    const idle = backendHarness({
      runtime: {
        cancel: async () => "No embedding build is running in this process.",
      },
    });
    expect(await idle.buildBackend().cancel(AGENT, "build-9")).toEqual({
      ok: true,
      value: { cancelled: false },
    });
  });

  test("cancel only stops the build whose id the client named", async () => {
    const cancels: string[] = [];
    const matched = backendHarness({
      runtime: {
        readStatus: async () =>
          runtimeStatus({ buildSnapshot: BUILD_SNAPSHOT }),
        cancel: async () => {
          cancels.push("matched");
          return "Cancelled the embedding build; committed chunks stay.";
        },
      },
    });
    expect(await matched.buildBackend().cancel(AGENT, "build-7")).toEqual({
      ok: true,
      value: { cancelled: true },
    });

    const mismatched = backendHarness({
      runtime: {
        readStatus: async () =>
          runtimeStatus({ buildSnapshot: BUILD_SNAPSHOT }),
        cancel: async () => {
          cancels.push("mismatched");
          return "Cancelled the embedding build; committed chunks stay.";
        },
      },
    });
    expect(await mismatched.buildBackend().cancel(AGENT, "build-8")).toEqual({
      ok: true,
      value: { cancelled: false },
    });
    // A stale id must not cancel the live build as a side effect.
    expect(cancels).toEqual(["matched"]);
  });

  test("cancel treats an unreadable live build as no match, not as licence to cancel", async () => {
    const h = backendHarness({
      runtime: {
        readStatus: async () => {
          throw new Error("state.json is unreadable");
        },
        cancel: async () =>
          "Cancelled the embedding build; committed chunks stay.",
      },
    });
    expect(await h.buildBackend().cancel(AGENT, "build-7")).toEqual({
      ok: true,
      value: { cancelled: false },
    });
  });

  test("profileDelete maps current/all onto A2's targets and parses the receipt", async () => {
    const scopes: unknown[] = [];
    const h = backendHarness({
      runtime: {
        reset: async (_scope, target) => {
          scopes.push(target);
          return "Deleted 2 vector spaces (every stored vector space).";
        },
      },
    });
    expect(
      await h.buildBackend().profileDelete(AGENT, {
        scope: "all",
        confirm: true,
      }),
    ).toEqual({
      ok: true,
      value: { removedSpaces: 2, requiresRebuild: true },
    });
    expect(
      await h.buildBackend().profileDelete(AGENT, {
        scope: "current",
        confirm: true,
      }),
    ).toEqual({
      ok: true,
      value: { removedSpaces: 2, requiresRebuild: true },
    });
    expect(scopes).toEqual([{ kind: "all" }, { kind: "current" }]);

    const unconfirmed = backendHarness();
    expect(
      await unconfirmed.buildBackend().profileDelete(AGENT, {
        scope: "all",
        confirm: false,
      }),
    ).toEqual({
      ok: true,
      value: {
        removedSpaces: 0,
        requiresRebuild: false,
        requiresConfirmation: true,
        preview: "all stored vector spaces for this agent",
      },
    });

    const empty = backendHarness({
      runtime: {
        reset: async () =>
          "No matching vector space found; nothing was deleted.",
      },
    });
    expect(
      await empty.buildBackend().profileDelete(AGENT, {
        scope: "current",
        confirm: true,
      }),
    ).toEqual({
      ok: true,
      value: { removedSpaces: 0, requiresRebuild: false },
    });
  });

  test("deviceTest returns the measured snapshot without writing", async () => {
    const h = backendHarness();
    const result = await h.buildBackend().deviceTest(AGENT);
    expect(result).toEqual({ ok: true, value: { calibration: CALIBRATION } });
    expect(h.writes).toEqual([]);
  });

  test("deviceTest refuses endpoint mode and asset failures without throwing", async () => {
    const endpoint = backendHarness({
      settings: {
        backend: "endpoint",
        endpoint: {
          kind: "openai",
          baseUrl: "https://api.example.com/v1",
          model: "text-embedding-3-small",
          dimensions: 1_024,
        },
      },
    });
    expect(await endpoint.buildBackend().deviceTest(AGENT)).toEqual({
      ok: false,
      error: "device_test_requires_builtin_backend",
    });

    const missing = backendHarness();
    missing.deps.runCalibration = async () => {
      throw new Error("Built-in embedding assets are not installed");
    };
    const failed = await missing.buildBackend().deviceTest(AGENT);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("expected a refusal");
    expect(failed.error).toContain("not installed");
    expect(missing.writes).toEqual([]);
  });

  test("an unwired runtime declines every runtime command", async () => {
    const h = backendHarness({ runtime: {} });
    const backend = h.buildBackend();
    expect(
      await backend.build(AGENT, { mode: "incremental", keepAfterExit: false }),
    ).toEqual({
      ok: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });
    expect(await backend.cancel(AGENT, undefined)).toEqual({
      ok: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });
    expect(
      await backend.profileDelete(AGENT, { scope: "current", confirm: true }),
    ).toEqual({
      ok: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });
  });
});
