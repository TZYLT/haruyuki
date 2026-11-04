/**
 * The production embedding runtime port (feature 48, rework A2).
 *
 * These cases pin the wiring the failing user report was about: `/recall
 * embedding build` must reach A4's host with a real identity, model, units and
 * encode path, and must refuse — never download — when the built-in assets are
 * missing. Everything is injected (host start, device adapter, unit scanner,
 * settings), so no worker is spawned, no GPU is touched and no real
 * `~/.haruyuki` is read; `scripts/test-home-preload.ts` still redirects the
 * harness root for every test in this repository. Every test gets its own temp
 * root, so a reset in one case cannot hide behind another case's spaces.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "@/backend";
import type {
  CreateEmbeddingDeviceAdapterOptions,
  EmbeddingDeviceAdapter,
} from "@/backend/local/embedding/gpu-build-path";
import { getBuiltinModelManifest } from "@/backend/local/embedding/model-manifest";
import type { EmbeddingBuiltinAssets } from "@/backend/local/embedding-assets";
import type { EmbeddingBuildStateSnapshot } from "@/backend/local/embedding-build-state";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  type EmbeddingVectorUnit,
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import type { EmbeddingRunResult } from "@/backend/local/embedding-runner";
import { resolveEmbeddingSpace } from "@/backend/local/embedding-space";
import type {
  EmbeddingRuntimePort,
  EmbeddingRuntimeScope,
} from "@/cli/commands/embedding";
import { handleRecallCommand } from "@/cli/commands/recall";
import type {
  EmbeddingBuildHostOptions,
  EmbeddingBuildHostOutcome,
} from "@/cli/helpers/embedding-build-host";
import {
  buildEmbeddingFromSettings,
  createEmbeddingRuntimePort,
  EMBEDDING_LOCAL_ONLY,
  type EmbeddingRuntimeDeps,
} from "@/cli/helpers/embedding-runtime";
import type { EmbeddingBuildStatusSnapshot } from "@/cli/hooks/use-embedding-build-status";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";

const AGENT_ID = "agent-runtime";
const OTHER_AGENT_ID = "agent-other";
const DIMENSIONS = 8;
const MODEL_ID = getBuiltinModelManifest().id;

const createdRoots: string[] = [];

function makeRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "haru-embedding-runtime-"));
  createdRoots.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of createdRoots) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function settings(
  overrides: Partial<ResolvedEmbeddingSettings> = {},
): ResolvedEmbeddingSettings {
  return {
    ...EMBEDDING_SETTING_DEFAULTS,
    enabled: true,
    model: MODEL_ID,
    ...overrides,
  };
}

function builtinAssets(root: string): EmbeddingBuiltinAssets {
  const manifest = getBuiltinModelManifest();
  const modelDir = join(root, "models", manifest.id);
  return {
    modelId: manifest.id,
    modelDir,
    modelPath: join(modelDir, "onnx", "model.onnx"),
    tokenizerPath: join(modelDir, "tokenizer.json"),
    configPath: join(modelDir, "config.json"),
    runtimeDir: join(root, "runtime", "1"),
    runtimeVersion: "1",
    manifest,
  };
}

function installedAssets(root: string) {
  return {
    installed: true,
    modelInstalled: true,
    runtimeInstalled: true,
    assets: builtinAssets(root),
    missing: [] as const,
  };
}

function missingAssets(root: string) {
  return {
    installed: false,
    modelInstalled: false,
    runtimeInstalled: true,
    assets: builtinAssets(root),
    missing: ["model"] as const,
  };
}

function unitVector(index: number): Float32Array {
  const value = new Float32Array(DIMENSIONS);
  value[index % DIMENSIONS] = 1;
  return value;
}

/** Write one real B2 generation into the space `spaceSettings` resolves to. */
function writeIndexedUnit(input: {
  root: string;
  agentId: string;
  spaceSettings: ResolvedEmbeddingSettings;
  conversationKey: string;
  modelId?: string;
}): string {
  const space = resolveEmbeddingSpace(input.agentId, input.spaceSettings, {
    root: input.root,
  });
  const unit: EmbeddingVectorUnit = {
    agentId: input.agentId,
    spaceId: space.spaceId,
    conversationKey: input.conversationKey,
  };
  const plan = buildEmbeddingChunkPlan(
    { parentId: "m-1", text: "财务系统的记账方式是每日对账。" },
    { targetTokens: 64, maxTokens: 96, overlapTokens: 0 },
  );
  const records = embeddingChunkRecordsFromPlan(plan);
  const unitDir = embeddingVectorUnitDir(unit, { root: input.root });
  mkdirSync(unitDir, { recursive: true });
  writeEmbeddingIndex({
    unitDir,
    unit,
    modelId: input.modelId ?? space.modelId,
    dimensions: DIMENSIONS,
    records,
    vectors: records.map((_, index) => unitVector(index)),
    coverage: plan.coverage,
  });
  return space.spaceDir;
}

// ---------------------------------------------------------------------------
// Build wiring
// ---------------------------------------------------------------------------

interface Capture {
  options: EmbeddingBuildHostOptions;
  adapters: CreateEmbeddingDeviceAdapterOptions[];
  disposed: number;
}

function newCapture(): Capture {
  return {
    options: null as unknown as EmbeddingBuildHostOptions,
    adapters: [],
    disposed: 0,
  };
}

function fakeAdapter(onDispose: () => void): EmbeddingDeviceAdapter {
  return {
    role: "cpu",
    executionProviders: ["cpu"],
    gpu: false,
    degraded: false,
    initialization: {
      dim: DIMENSIONS,
      runtime: "bun",
      maxTokens: 512,
      warmupMs: 1,
    },
    async embedTexts(texts) {
      return texts.map(() => unitVector(0));
    },
    async dispose() {
      onDispose();
    },
  };
}

function completedOutcome(
  result: Partial<EmbeddingRunResult> = {},
): EmbeddingBuildHostOutcome {
  return {
    status: "completed",
    error: null,
    progress: null,
    calibration: null,
    detachedPid: null,
    result: {
      status: "completed",
      aborted: false,
      buildId: "build-1",
      mode: "incremental",
      totalUnits: 2,
      completedUnits: 2,
      failedUnits: 0,
      reusedChunks: 1,
      embeddedChunks: 4,
      elapsedMs: 120,
      state: null,
      unitFailures: [],
      ...result,
    },
  };
}

/** A minimal A2 projection, enough for an `onProgress` assertion. */
function progressSnapshot(
  overrides: Partial<EmbeddingBuildStateSnapshot> = {},
): EmbeddingBuildStateSnapshot {
  return {
    schemaVersion: 1,
    agentId: AGENT_ID,
    spaceId: "space",
    buildId: "build-1",
    mode: "incremental",
    phase: "running",
    updatedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    finishedAt: null,
    progress: {
      embeddedChunks: 2,
      totalChunks: 4,
      processedConversations: 1,
      totalConversations: 2,
      remainingChunks: 2,
      fraction: 0.5,
    },
    coverage: { embeddedChars: 10, recallableChars: 20, ratio: 0.5 },
    rate: { chunksPerSecond: 1, windowMs: 2_000, sampleCount: 2 },
    eta: { remainingChunks: 2, remainingMs: 2_000 },
    failures: [],
    ...overrides,
  };
}

function runtimeDeps(input: {
  root: string;
  storageDir: string;
  capture: Capture;
  startBuild?: EmbeddingRuntimeDeps["startBuild"];
  runBuild?: EmbeddingRuntimeDeps["runBuild"];
  settingsOverrides?: Partial<ResolvedEmbeddingSettings>;
}): EmbeddingRuntimeDeps {
  const { capture } = input;
  return {
    storageDir: input.storageDir,
    root: input.root,
    readSettings: () => settings(input.settingsOverrides ?? {}),
    checkAssets: async () => installedAssets(input.root),
    scanUnits: () => [],
    ...(input.runBuild === undefined ? {} : { runBuild: input.runBuild }),
    startBuild:
      input.startBuild ??
      (async (hostOptions) => {
        capture.options = hostOptions;
        return {
          ok: true,
          phase: "running",
          buildId: null,
          detachedPid: null,
          outcome: Promise.resolve(completedOutcome()),
        };
      }),
    createDeviceAdapter: async (adapterOptions) => {
      capture.adapters.push(adapterOptions);
      return fakeAdapter(() => {
        capture.disposed += 1;
      });
    },
  };
}

describe("buildEmbeddingFromSettings", () => {
  test("refuses a missing model instead of downloading it", async () => {
    const root = makeRoot();
    const receipt = await buildEmbeddingFromSettings(
      { agentId: AGENT_ID, mode: "incremental", keepAfterExit: false },
      {
        storageDir: join(root, "local-backend"),
        root,
        readSettings: () => settings(),
        checkAssets: async () => missingAssets(root),
        startBuild: async () => {
          throw new Error("start must not be called");
        },
      },
    );
    expect(receipt).toContain("/recall embedding setup");
    expect(receipt).toContain("missing model");
    expect(receipt).not.toContain("start must not be called");
  });

  test("refuses a missing runtime with the same actionable remedy", async () => {
    const root = makeRoot();
    const receipt = await buildEmbeddingFromSettings(
      { agentId: AGENT_ID, mode: "incremental", keepAfterExit: false },
      {
        storageDir: join(root, "local-backend"),
        root,
        readSettings: () => settings(),
        checkAssets: async () => ({
          installed: false,
          modelInstalled: true,
          runtimeInstalled: false,
          assets: builtinAssets(root),
          missing: ["runtime"] as const,
        }),
        startBuild: async () => {
          throw new Error("start must not be called");
        },
      },
    );
    expect(receipt).toContain("missing runtime");
    expect(receipt).toContain("/recall embedding setup");
  });

  test("refuses a non-local backend with the local-only copy", async () => {
    const root = makeRoot();
    expect(
      await buildEmbeddingFromSettings(
        { agentId: AGENT_ID, mode: "incremental", keepAfterExit: false },
        {
          root,
          backend: {} as unknown as Backend,
          readSettings: () => settings(),
          startBuild: async () => {
            throw new Error("start must not be called");
          },
        },
      ),
    ).toBe(EMBEDDING_LOCAL_ONLY);
  });

  test("passes identity, model, units and the built-in embed path to A4", async () => {
    const root = makeRoot();
    const capture = newCapture();
    const progress: string[] = [];
    const runner: NonNullable<EmbeddingRuntimeDeps["runBuild"]> = async () => ({
      status: "completed",
      aborted: false,
      buildId: "runner-build",
      mode: "full",
      totalUnits: 0,
      completedUnits: 0,
      failedUnits: 0,
      reusedChunks: 0,
      embeddedChunks: 0,
      elapsedMs: 1,
      state: null,
      unitFailures: [],
    });
    const receipt = await buildEmbeddingFromSettings(
      {
        agentId: AGENT_ID,
        conversationId: "conv-1",
        mode: "full",
        keepAfterExit: false,
        lifecycle: "headless",
        onProgress: (snapshot) => progress.push(snapshot.phase),
      },
      runtimeDeps({
        root,
        storageDir: join(root, "local-backend"),
        capture,
        runBuild: runner,
      }),
    );

    expect(receipt).toContain("Build completed");
    const space = resolveEmbeddingSpace(AGENT_ID, settings(), { root });
    expect(capture.options).toMatchObject({
      lifecycle: "headless",
      identity: { agentId: AGENT_ID, spaceId: space.spaceId },
      modelId: space.modelId,
      backend: "builtin",
      mode: "full",
      dimensions: space.dimensions,
      root,
      keepAfterExit: false,
    });
    // The injected runner replaces A3's loop (no build is executed here).
    expect(capture.options.runBuild).toBe(runner);
    expect(typeof capture.options.units).toBe("function");
    const unitsSource = capture.options.units;
    const units =
      typeof unitsSource === "function" ? await unitsSource() : unitsSource;
    expect(Array.from(units ?? [])).toEqual([]);

    // The encode path reaches C8's device adapter, wired with the real assets.
    expect(capture.adapters).toHaveLength(1);
    expect(capture.adapters[0]?.init).toMatchObject({
      runtimeDir: builtinAssets(root).runtimeDir,
      modelPath: builtinAssets(root).modelPath,
    });
    const embedded = await capture.options.embed?.([
      { text: "chunk text" },
    ] as never);
    expect(embedded).toHaveLength(1);

    // Progress is forwarded to the caller, not just to A5.
    capture.options.onProgress?.(progressSnapshot({ phase: "running" }));
    expect(progress).toEqual(["running"]);

    // Headless awaits the outcome, then releases the worker.
    expect(capture.disposed).toBe(1);
  });

  test("headless reports the terminal counts", async () => {
    const root = makeRoot();
    const capture = newCapture();
    const deps = runtimeDeps({
      root,
      storageDir: join(root, "local-backend"),
      capture,
      startBuild: async (hostOptions) => {
        capture.options = hostOptions;
        return {
          ok: true,
          phase: "running",
          buildId: "b",
          detachedPid: null,
          outcome: Promise.resolve(
            completedOutcome({
              embeddedChunks: 7,
              reusedChunks: 3,
              failedUnits: 1,
            }),
          ),
        };
      },
    });
    const receipt = await buildEmbeddingFromSettings(
      {
        agentId: AGENT_ID,
        mode: "incremental",
        keepAfterExit: false,
        lifecycle: "headless",
      },
      deps,
    );
    expect(receipt).toContain("7 chunk(s) embedded");
    expect(receipt).toContain("3 reused");
    expect(receipt).toContain("1 unit(s) failed");
  });

  test("the TUI returns immediately and disposes once the run ends", async () => {
    const root = makeRoot();
    const capture = newCapture();
    let resolveOutcome: (outcome: EmbeddingBuildHostOutcome) => void = () => {};
    const deps = runtimeDeps({
      root,
      storageDir: join(root, "local-backend"),
      capture,
      startBuild: async (hostOptions) => {
        capture.options = hostOptions;
        return {
          ok: true,
          phase: "running",
          buildId: null,
          detachedPid: null,
          outcome: new Promise<EmbeddingBuildHostOutcome>((resolvePromise) => {
            resolveOutcome = resolvePromise;
          }),
        };
      },
    });
    const receipt = await buildEmbeddingFromSettings(
      { agentId: AGENT_ID, mode: "incremental", keepAfterExit: false },
      deps,
    );
    expect(receipt).toContain("Build started");
    expect(capture.disposed).toBe(0);
    resolveOutcome(completedOutcome());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(capture.disposed).toBe(1);
  });

  test("a refused start is reported with the host's action and cleaned up", async () => {
    const root = makeRoot();
    const capture = newCapture();
    const deps = runtimeDeps({
      root,
      storageDir: join(root, "local-backend"),
      capture,
      startBuild: async () => ({
        ok: false,
        error: {
          code: "lock_held",
          message: "Another embedding build owns this index space.",
          action: "Wait for it to finish, or cancel it first.",
        },
      }),
    });
    const receipt = await buildEmbeddingFromSettings(
      { agentId: AGENT_ID, mode: "incremental", keepAfterExit: false },
      deps,
    );
    expect(receipt).toContain("Another embedding build owns this index space.");
    expect(receipt).toContain("Wait for it to finish");
    expect(capture.disposed).toBe(1);
  });

  test("keepAfterExit hands A4 a detached command and starts no worker", async () => {
    const root = makeRoot();
    const capture = newCapture();
    const deps = runtimeDeps({
      root,
      storageDir: join(root, "local-backend"),
      capture,
      startBuild: async (hostOptions) => {
        capture.options = hostOptions;
        return {
          ok: true,
          phase: "detached",
          buildId: null,
          detachedPid: 4242,
          outcome: Promise.resolve({
            status: "detached",
            error: null,
            result: null,
            progress: null,
            calibration: null,
            detachedPid: 4242,
          } satisfies EmbeddingBuildHostOutcome),
        };
      },
    });
    const receipt = await buildEmbeddingFromSettings(
      { agentId: AGENT_ID, mode: "full", keepAfterExit: true },
      deps,
    );
    expect(receipt).toContain("pid 4242");
    expect(capture.adapters).toHaveLength(0);
    const detached = capture.options.detachedCommand;
    expect(detached?.command).toBe(process.execPath);
    expect(detached?.args?.slice(-4)).toEqual([
      "build",
      "--agent",
      AGENT_ID,
      "--full",
    ]);
    expect(detached?.env?.HARUYUKI_HOME).toBe(process.env.HARUYUKI_HOME);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function a5Snapshot(
  overrides: Partial<EmbeddingBuildStatusSnapshot> = {},
): EmbeddingBuildStatusSnapshot {
  return {
    enabled: true,
    backend: "builtin",
    model: MODEL_ID,
    build: {
      state: "completed",
      progress: 1,
      processedChunks: 4,
      totalChunks: 4,
      etaMs: 0,
    },
    coverage: 0.5,
    agentId: AGENT_ID,
    spaceId: "space",
    spaceDir: "/tmp/space",
    hostPhase: "completed",
    working: false,
    updatedAt: 1_700_000_000_000,
    failures: [],
    readStatus: "ok",
    ...overrides,
  };
}

const SCOPE: EmbeddingRuntimeScope = {
  agentId: AGENT_ID,
  conversationId: "conv-1",
};

describe("readStatus", () => {
  test("reports a real space, readiness and the A2 projection", async () => {
    const root = makeRoot();
    writeIndexedUnit({
      root,
      agentId: AGENT_ID,
      spaceSettings: settings(),
      conversationKey: "conv-status",
    });
    const port = createEmbeddingRuntimePort({
      root,
      readSettings: () => settings(),
      checkAssets: async () => installedAssets(root),
      readStatusSnapshot: () => a5Snapshot(),
      refreshStatus: async () => a5Snapshot(),
    });
    const status = await port.readStatus?.(SCOPE);
    expect(status).not.toBeNull();
    expect(status?.ready).toBe(true);
    expect(status?.space?.model).toBe(MODEL_ID);
    expect(status?.space?.dimensions).toBe(DIMENSIONS);
    expect(status?.space?.chunks).toBeGreaterThan(0);
    expect(status?.space?.conversations).toBeGreaterThanOrEqual(1);
    expect(status?.build?.state).toBe("completed");
    expect(status?.build?.processedChunks).toBe(4);
    // No state.json yet: the command prints "Build: idle" instead of a 0/0 line.
    expect(status?.buildSnapshot).toBeNull();
    expect(status?.calibration).toBeNull();
    expect(status?.egress).toBe(false);
    expect(status?.failure).toBeNull();
  });

  test("not ready without a usable space or installed assets", async () => {
    const root = makeRoot();
    const port = createEmbeddingRuntimePort({
      root,
      readSettings: () => settings(),
      checkAssets: async () => missingAssets(root),
      readStatusSnapshot: () => null,
      refreshStatus: async () => null,
    });
    const status = await port.readStatus?.(SCOPE);
    expect(status?.ready).toBe(false);
    expect(status?.space).toBeNull();
    expect(status?.build).toBeNull();
  });

  test("a running build is projected with its progress", async () => {
    const root = makeRoot();
    const port = createEmbeddingRuntimePort({
      root,
      readSettings: () => settings(),
      checkAssets: async () => installedAssets(root),
      readStatusSnapshot: () =>
        a5Snapshot({
          build: {
            state: "running",
            progress: 0.5,
            processedChunks: 2,
            totalChunks: 4,
            etaMs: 2_000,
          },
        }),
      refreshStatus: async () => null,
    });
    const status = await port.readStatus?.(SCOPE);
    expect(status?.build).toMatchObject({
      state: "running",
      progress: 0.5,
      processedChunks: 2,
      totalChunks: 4,
      etaMs: 2_000,
    });
    expect(status?.ready).toBe(false);
  });

  test("maps the stored calibration and the endpoint egress marker", async () => {
    const root = makeRoot();
    const port = createEmbeddingRuntimePort({
      root,
      readSettings: () =>
        settings({
          backend: "endpoint",
          endpoint: {
            kind: "openai",
            baseUrl: "https://api.example.com/v1",
            model: "remote-model",
            dimensions: 16,
          },
          calibration: {
            fingerprint: "f",
            measuredAt: "2026-11-03T00:00:00.000Z",
            queryLatencyP50Ms: 12,
            queryLatencyP90Ms: 20,
            batchThroughputPerSec: 30,
            gpuRole: "off",
            threads: 1,
            quantization: "float32",
          },
        }),
      readStatusSnapshot: () => null,
      refreshStatus: async () => null,
    });
    const status = await port.readStatus?.(SCOPE);
    expect(status?.egress).toBe(true);
    expect(status?.calibration).toMatchObject({
      throughputPerSecond: 30,
      queryLatencyP90Ms: 20,
    });
    // The endpoint space is resolved from the declared width, but no index was
    // written for it, so it is honestly "not built yet".
    expect(status?.space).toBeNull();
    expect(status?.ready).toBe(false);
  });

  test("a settings read failure degrades to null instead of throwing", async () => {
    const root = makeRoot();
    const port = createEmbeddingRuntimePort({
      root,
      readSettings: () => {
        throw new Error("settings not loaded");
      },
    });
    expect(await port.readStatus?.(SCOPE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  test("current deletes only the space the current settings resolve to", async () => {
    const root = makeRoot();
    const target = writeIndexedUnit({
      root,
      agentId: AGENT_ID,
      spaceSettings: settings({ quantization: "float32" }),
      conversationKey: "conv-current",
    });
    const sibling = writeIndexedUnit({
      root,
      agentId: AGENT_ID,
      spaceSettings: settings({ quantization: "int8" }),
      conversationKey: "conv-sibling",
    });
    const otherAgent = writeIndexedUnit({
      root,
      agentId: OTHER_AGENT_ID,
      spaceSettings: settings(),
      conversationKey: "conv-other",
    });

    const port = createEmbeddingRuntimePort({
      root,
      readSettings: () => settings({ quantization: "float32" }),
    });
    expect(await port.reset?.(SCOPE, { kind: "current" })).toContain(
      "Deleted 1 vector space",
    );
    expect(existsSync(target)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(otherAgent)).toBe(true);
  });

  test("model matches the model id recorded in the space's meta", async () => {
    const root = makeRoot();
    // Two *different* spaces (different precision), so each space has one model.
    const matching = writeIndexedUnit({
      root,
      agentId: AGENT_ID,
      spaceSettings: settings({ quantization: "int8" }),
      conversationKey: "conv-model-match",
      modelId: "other-model",
    });
    const untouched = writeIndexedUnit({
      root,
      agentId: AGENT_ID,
      spaceSettings: settings({ quantization: "float32" }),
      conversationKey: "conv-model-keep",
      modelId: MODEL_ID,
    });
    const port = createEmbeddingRuntimePort({
      root,
      readSettings: () => settings({ quantization: "int8" }),
    });
    expect(
      await port.reset?.(SCOPE, { kind: "model", model: "other-model" }),
    ).toContain("Deleted 1 vector space");
    expect(existsSync(matching)).toBe(false);
    expect(existsSync(untouched)).toBe(true);
  });

  test("all keeps other agents' spaces and says so when empty", async () => {
    const root = makeRoot();
    const agentSpace = writeIndexedUnit({
      root,
      agentId: AGENT_ID,
      spaceSettings: settings(),
      conversationKey: "conv-all",
    });
    const otherAgent = writeIndexedUnit({
      root,
      agentId: OTHER_AGENT_ID,
      spaceSettings: settings(),
      conversationKey: "conv-other-2",
    });
    const port = createEmbeddingRuntimePort({
      root,
      readSettings: () => settings(),
    });
    expect(await port.reset?.(SCOPE, { kind: "all" })).toContain(
      "Deleted 1 vector space",
    );
    expect(existsSync(agentSpace)).toBe(false);
    expect(existsSync(otherAgent)).toBe(true);
    expect(
      await port.reset?.(
        { agentId: "agent-without-spaces", conversationId: null },
        { kind: "all" },
      ),
    ).toContain("nothing was deleted");
  });
});

// ---------------------------------------------------------------------------
// Cancel / endpoint
// ---------------------------------------------------------------------------

describe("cancel and configureEndpoint", () => {
  test("cancel reports whether a run was in flight", async () => {
    const running = createEmbeddingRuntimePort({
      cancelBuild: async () => ({
        cancelled: true,
        settled: true,
        phase: "cancelled",
      }),
    });
    expect(await running.cancel?.(SCOPE)).toContain(
      "Cancelled the embedding build",
    );

    const idle = createEmbeddingRuntimePort({
      cancelBuild: async () => ({
        cancelled: false,
        settled: true,
        phase: "idle",
      }),
    });
    expect(await idle.cancel?.(SCOPE)).toContain(
      "No embedding build is running",
    );
  });

  test("configureEndpoint probes the broker and returns the resolved form", async () => {
    const probed: Array<Record<string, unknown>> = [];
    const port = createEmbeddingRuntimePort({
      testEndpoint: async (options) => {
        probed.push(options as unknown as Record<string, unknown>);
        return { model: options.model, dimensions: 12, norm: 1, latencyMs: 3 };
      },
    });
    expect(
      await port.configureEndpoint?.({
        agentId: null,
        baseUrl: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        apiKey: "sk-test",
      }),
    ).toEqual({
      kind: "openai",
      model: "text-embedding-3-small",
      dimensions: 12,
      timeoutMs: 10_000,
    });
    expect(probed[0]?.apiKey).toBe("sk-test");
  });
});

// ---------------------------------------------------------------------------
// Channel wiring
// ---------------------------------------------------------------------------

describe("handleRecallCommand embedding channel", () => {
  test("the CLI path (a backend is injected) waits with the headless lifecycle", async () => {
    const calls: Array<{ mode: string; options: unknown }> = [];
    const runtime: EmbeddingRuntimePort = {
      async build(_scope, mode, options) {
        calls.push({ mode, options });
        return "Build completed: 4 chunk(s) embedded.";
      },
    };
    const output = await handleRecallCommand(
      ["embedding", "build", "--full"],
      SCOPE,
      {
        backend: {} as unknown as Backend,
        embedding: {
          runtime,
          readSettings: () => settings(),
          readRawSettings: () => ({ recallEmbeddingBackend: "builtin" }),
        },
      },
    );
    expect(output).toContain("Build completed");
    expect(calls[0]?.mode).toBe("full");
    expect(calls[0]?.options).toEqual({
      keepAfterExit: false,
      lifecycle: "headless",
    });
  });

  test("the TUI path (no backend injected) returns an immediate receipt", async () => {
    const calls: Array<unknown> = [];
    const runtime: EmbeddingRuntimePort = {
      async build(_scope, _mode, options) {
        calls.push(options);
        return "Build started (incremental).";
      },
    };
    const output = await handleRecallCommand(["embedding", "build"], SCOPE, {
      embedding: {
        runtime,
        readSettings: () => settings(),
        readRawSettings: () => ({ recallEmbeddingBackend: "builtin" }),
      },
    });
    expect(output).toContain("Build started");
    expect(calls[0]).toEqual({ keepAfterExit: false, lifecycle: "tui" });
  });

  test("--keep-after-exit is forwarded from the parser", async () => {
    const calls: Array<unknown> = [];
    const runtime: EmbeddingRuntimePort = {
      async build(_scope, _mode, options) {
        calls.push(options);
        return "Build started in the background.";
      },
    };
    await handleRecallCommand(
      ["embedding", "build", "--keep-after-exit"],
      SCOPE,
      {
        backend: {} as unknown as Backend,
        embedding: {
          runtime,
          readSettings: () => settings(),
          readRawSettings: () => ({ recallEmbeddingBackend: "builtin" }),
        },
      },
    );
    expect(calls[0]).toEqual({ keepAfterExit: true, lifecycle: "headless" });
  });
});
