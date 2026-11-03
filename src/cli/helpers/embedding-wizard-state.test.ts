import { describe, expect, test } from "bun:test";
import type { EmbeddingSettingsPatch } from "@/cli/app/pages/settings/embedding-settings";
import {
  embeddingWizardCalibrationFromResult,
  embeddingWizardManualImportHint,
  embeddingWizardModelDir,
  embeddingWizardSettingsPatch,
  runEmbeddingWizardCalibration,
  runEmbeddingWizardDownload,
  runEmbeddingWizardEndpointTest,
  runEmbeddingWizardFinish,
} from "@/cli/helpers/embedding-wizard-actions";
import {
  applyEmbeddingWizardEvent,
  createEmbeddingWizardState,
  EMBEDDING_WIZARD_COMMAND,
  EMBEDDING_WIZARD_STEP_COUNT,
  type EmbeddingWizardBuildRequest,
  type EmbeddingWizardCalibration,
  type EmbeddingWizardCalibrationRequest,
  type EmbeddingWizardDeps,
  type EmbeddingWizardEndpointProbeRequest,
  type EmbeddingWizardState,
  embeddingWizardBackStep,
  embeddingWizardModelOptions,
  embeddingWizardStepTitle,
  formatEmbeddingWizardBytes,
  isEmbeddingWizardBusy,
  resolveEmbeddingWizardApiKey,
} from "@/cli/helpers/embedding-wizard-state";

/**
 * The wizard's state machine and its injected side effects, judged without a
 * terminal. The frame test (`components/EmbeddingWizard.test.tsx`) proves the
 * screens exist; this file proves the transitions, the writes and the failure
 * behaviour the frames are supposed to show.
 */

const MODEL_ID = "bge-small-zh-v1.5";

function start(): EmbeddingWizardState {
  return createEmbeddingWizardState();
}

function chooseBuiltin(
  state: EmbeddingWizardState = start(),
): EmbeddingWizardState {
  return applyEmbeddingWizardEvent(state, {
    type: "choose-backend",
    backend: "builtin",
  });
}

function atBuiltinDownload(): EmbeddingWizardState {
  let state = chooseBuiltin();
  state = applyEmbeddingWizardEvent(state, {
    type: "choose-model",
    modelId: state.builtin.modelId,
  });
  return state;
}

/** Walk the endpoint form to the masked-key screen (no key typed yet). */
function atEndpointKey(): EmbeddingWizardState {
  let state = applyEmbeddingWizardEvent(start(), {
    type: "choose-backend",
    backend: "endpoint",
  });
  state = applyEmbeddingWizardEvent(state, {
    type: "choose-endpoint-kind",
    kind: "openai",
  });
  state = applyEmbeddingWizardEvent(state, {
    type: "update-endpoint",
    field: "baseUrl",
    value: "https://api.example.com/v1",
  });
  state = applyEmbeddingWizardEvent(state, { type: "next" });
  state = applyEmbeddingWizardEvent(state, {
    type: "update-endpoint",
    field: "model",
    value: "text-embedding-3-small",
  });
  state = applyEmbeddingWizardEvent(state, { type: "next" });
  state = applyEmbeddingWizardEvent(state, { type: "next" });
  return state;
}

function atEndpointTest(): EmbeddingWizardState {
  let state = atEndpointKey();
  state = applyEmbeddingWizardEvent(state, {
    type: "update-endpoint",
    field: "apiKey",
    value: "sk-test-123",
  });
  return applyEmbeddingWizardEvent(state, { type: "next" });
}

function fakeCalibration(
  overrides: Partial<EmbeddingWizardCalibration> = {},
): EmbeddingWizardCalibration {
  return {
    fingerprint: "fp-1",
    measuredAt: "2026-11-04T00:00:00.000Z",
    p50Ms: 42,
    p90Ms: 55,
    throughputPerSec: 128,
    gpuRole: "off",
    threads: 4,
    quantization: "float32",
    calibrated: true,
    reason: null,
    tier: "small",
    queryBudgetMs: 100,
    rssBytes: 240 * 1024 * 1024,
    diskFreeBytes: 10 * 1024 ** 3,
    diskHeadroomOk: true,
    ...overrides,
  };
}

interface Calls {
  downloads: string[];
  probes: EmbeddingWizardEndpointProbeRequest[];
  calibrations: EmbeddingWizardCalibrationRequest[];
  saved: EmbeddingSettingsPatch[];
  keys: string[];
  builds: EmbeddingWizardBuildRequest[];
}

interface FakeDeps {
  deps: EmbeddingWizardDeps;
  calls: Calls;
}

function fakeDeps(overrides: Partial<EmbeddingWizardDeps> = {}): FakeDeps {
  const calls: Calls = {
    downloads: [],
    probes: [],
    calibrations: [],
    saved: [],
    keys: [],
    builds: [],
  };
  const deps: EmbeddingWizardDeps = {
    downloadModel: async (request) => {
      calls.downloads.push(request.modelId);
      request.onProgress?.(0.5);
      return {
        modelId: request.modelId,
        modelDir: `/tmp/models/${request.modelId}`,
        alreadyInstalled: false,
      };
    },
    probeEndpoint: async (request) => {
      calls.probes.push(request);
      return {
        kind: request.kind,
        model: request.model,
        dimensions: 768,
        norm: 1,
        latencyMs: 12,
      };
    },
    calibrate: async (request) => {
      calls.calibrations.push(request);
      return fakeCalibration();
    },
    saveSettings: (patch) => {
      calls.saved.push(patch);
    },
    saveApiKey: async (value) => {
      calls.keys.push(value);
    },
    startBuild: (request) => {
      calls.builds.push(request);
      return "build started";
    },
    readEnv: () => undefined,
    ...overrides,
  };
  return { deps, calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const apply = applyEmbeddingWizardEvent;

describe("the embedding wizard state machine", () => {
  test("opens on the backend choice with four numbered steps", () => {
    expect(EMBEDDING_WIZARD_STEP_COUNT).toBe(4);
    expect(EMBEDDING_WIZARD_COMMAND).toBe("/recall embedding setup");
    const state = start();
    expect(state.step).toBe("backend");
    expect(state.outcome).toBe("active");
    expect(embeddingWizardStepTitle("backend")).toBe("1/4 Backend");
    expect(embeddingWizardStepTitle("builtin-download")).toBe("2/4 Download");
    expect(embeddingWizardStepTitle("endpoint-test")).toBe("2/4 Endpoint test");
    expect(embeddingWizardStepTitle("calibrate")).toBe("3/4 Calibration");
    expect(embeddingWizardStepTitle("finish")).toBe("4/4 Finish");

    const models = embeddingWizardModelOptions();
    expect(models[0]?.id).toBe(MODEL_ID);
    expect(models[0]?.dimensions).toBe(512);
    expect(models[0]?.licenseId).toBe("MIT");
    expect(models[0]?.totalBytes).toBeGreaterThan(0);
    expect(formatEmbeddingWizardBytes(24_451_050)).toBe("24.5 MB");
  });

  test("a re-entered setup pre-fills the current backend and model", () => {
    const state = createEmbeddingWizardState({
      settings: {
        enabled: true,
        backend: "endpoint",
        model: MODEL_ID,
        endpoint: {
          kind: "ollama",
          baseUrl: "http://localhost:11434",
          model: "nomic-embed-text",
          dimensions: 768,
        },
        weight: 0.5,
        candidateDepth: 50,
        chunkTarget: 200,
        chunkMax: 256,
        chunkOverlap: 32,
        maxChunksPerMessage: 1024,
        threads: 0,
        gpu: "auto",
        quantization: "float32",
        calibration: null,
        keepSpaces: 2,
      },
    });
    expect(state.backend).toBe("endpoint");
    expect(state.endpoint.kind).toBe("ollama");
    expect(state.endpoint.baseUrl).toBe("http://localhost:11434");
    expect(state.endpoint.model).toBe("nomic-embed-text");
    // An existing endpoint form is pre-filled but never trusted as verified.
    expect(state.endpoint.verified).toBeNull();
  });

  test("cancel and 'not now' write nothing and leave the wizard", () => {
    expect(
      apply(start(), { type: "choose-backend", backend: "later" }).outcome,
    ).toBe("cancelled");
    const atRoot = apply(start(), { type: "back" });
    expect(atRoot.outcome).toBe("cancelled");
    let deeper = chooseBuiltin();
    deeper = apply(deeper, {
      type: "choose-model",
      modelId: deeper.builtin.modelId,
    });
    expect(apply(deeper, { type: "cancel" }).outcome).toBe("cancelled");
    expect(apply(deeper, { type: "back" }).step).toBe("builtin-model");
    expect(embeddingWizardBackStep(deeper)).toBe("builtin-model");
    expect(embeddingWizardBackStep(atEndpointTest())).toBe("endpoint-key");
  });

  test("the built-in branch reaches the download confirmation without downloading", () => {
    let state = chooseBuiltin();
    expect(state.step).toBe("builtin-model");
    state = apply(state, { type: "choose-model", modelId: MODEL_ID });
    expect(state.step).toBe("builtin-download");
    expect(state.builtin.download.phase).toBe("idle");
  });

  test("the download runner downloads once, reports progress and lands on calibration", async () => {
    const { deps, calls } = fakeDeps();
    const progress: number[] = [];
    const final = await runEmbeddingWizardDownload(
      atBuiltinDownload(),
      deps,
      (next) => {
        if (next.builtin.download.phase === "running") {
          progress.push(next.builtin.download.progress);
        }
      },
    );
    expect(calls.downloads).toEqual([MODEL_ID]);
    expect(progress).toContain(0.5);
    expect(final.step).toBe("calibrate");
    expect(final.builtin.download.phase).toBe("done");
    expect(final.builtin.download.progress).toBe(1);
    expect(final.builtin.download.modelDir).toBe(`/tmp/models/${MODEL_ID}`);
    expect(final.calibration.phase).toBe("idle");
  });

  test("a failed download keeps its step with the offline-import hint", async () => {
    const { deps } = fakeDeps({
      downloadModel: async () => {
        throw new Error("network is down");
      },
    });
    const final = await runEmbeddingWizardDownload(atBuiltinDownload(), deps);
    expect(final.step).toBe("builtin-download");
    expect(final.builtin.download.phase).toBe("failed");
    expect(final.builtin.download.error).toBe("network is down");
    expect(final.builtin.download.hint).toContain("import a copy");
    expect(embeddingWizardManualImportHint(MODEL_ID)).toContain(MODEL_ID);
    expect(embeddingWizardModelDir(MODEL_ID)).toContain(MODEL_ID);
  });

  test("stale outcomes are ignored once their step is no longer current", () => {
    const atDownload = atBuiltinDownload();
    // Not running: a success that arrives before the runner started is dropped.
    const earlySuccess = apply(atDownload, {
      type: "download-succeeded",
      result: {
        modelId: MODEL_ID,
        modelDir: "/tmp/x",
        alreadyInstalled: false,
      },
    });
    expect(earlySuccess).toBe(atDownload);

    // The endpoint result belongs to the endpoint screen only.
    const atBackend = apply(start(), {
      type: "endpoint-test-succeeded",
      result: {
        kind: "openai",
        model: "m",
        dimensions: 8,
        norm: 1,
        latencyMs: 2,
      },
    });
    expect(atBackend.step).toBe("backend");
    expect(atBackend.endpoint.test.phase).toBe("idle");

    // A calibration result cannot rewind the screen from finish.
    const atFinish = apply(
      {
        ...atBuiltinDownload(),
        step: "calibrate",
        calibration: { phase: "idle", result: null, error: null },
      },
      { type: "calibration-skip" },
    );
    expect(atFinish.step).toBe("finish");
    const late = apply(atFinish, {
      type: "calibration-succeeded",
      result: fakeCalibration(),
    });
    expect(late).toBe(atFinish);
  });

  test("the endpoint form validates URL, model, key variable and key", () => {
    let state = apply(start(), { type: "choose-backend", backend: "endpoint" });
    expect(state.step).toBe("endpoint-kind");
    state = apply(state, { type: "choose-endpoint-kind", kind: "openai" });
    expect(state.step).toBe("endpoint-url");

    // Empty URL.
    const empty = apply(state, { type: "next" });
    expect(empty.step).toBe("endpoint-url");
    expect(empty.error).toContain("must not be empty");

    // Plain http to a remote host is refused by C6's allow-list.
    state = apply(state, {
      type: "update-endpoint",
      field: "baseUrl",
      value: "http://example.com/v1",
    });
    const remoteHttp = apply(state, { type: "next" });
    expect(remoteHttp.error).toContain("loopback");

    state = apply(state, {
      type: "update-endpoint",
      field: "baseUrl",
      value: "https://api.example.com/v1",
    });
    state = apply(state, { type: "next" });
    expect(state.step).toBe("endpoint-model");
    expect(state.endpoint.baseUrl).toBe("https://api.example.com/v1");

    const emptyModel = apply(state, { type: "next" });
    expect(emptyModel.error).toBe("needs a model id");

    state = apply(state, {
      type: "update-endpoint",
      field: "model",
      value: "text-embedding-3-small",
    });
    state = apply(state, { type: "next" });
    expect(state.step).toBe("endpoint-key-env");

    const badEnv = apply(
      apply(state, {
        type: "update-endpoint",
        field: "apiKeyEnv",
        value: "not a name",
      }),
      { type: "next" },
    );
    expect(badEnv.error).toContain("not an environment variable name");

    state = apply(state, {
      type: "update-endpoint",
      field: "apiKeyEnv",
      value: "",
    });
    state = apply(state, { type: "next" });
    expect(state.step).toBe("endpoint-key");
    const noKey = apply(state, { type: "next" });
    expect(noKey.step).toBe("endpoint-key");
    expect(noKey.error).toContain("needs an API key");
  });

  test("the key is resolved from an env var or the masked field, never echoed", () => {
    let state = atEndpointKey();
    state = apply(state, {
      type: "update-endpoint",
      field: "apiKeyEnv",
      value: "HARUYUKI_EMBEDDING_API_KEY",
    });
    const envResolved = resolveEmbeddingWizardApiKey(state, (name) =>
      name === "HARUYUKI_EMBEDDING_API_KEY" ? "sk-env-secret" : undefined,
    );
    expect(envResolved.apiKey).toBe("sk-env-secret");
    expect(envResolved.source).toBe("env");
    expect(envResolved.error).toBeNull();

    const missing = resolveEmbeddingWizardApiKey(state, () => undefined);
    expect(missing.apiKey).toBeNull();
    expect(missing.error).toContain("HARUYUKI_EMBEDDING_API_KEY");
    // The message names the variable, never a value.
    expect(missing.error).not.toContain("sk-env-secret");

    const typed = apply(atEndpointTest(), {
      type: "update-endpoint",
      field: "apiKey",
      value: "sk-typed",
    });
    const typedResolved = resolveEmbeddingWizardApiKey(typed);
    expect(typedResolved.apiKey).toBe("sk-typed");
    expect(typedResolved.source).toBe("typed");
  });

  test("a passing test embedding records the dimension and advances", async () => {
    const { deps, calls } = fakeDeps();
    let state = atEndpointTest();
    const tested = await runEmbeddingWizardEndpointTest(state, deps);
    expect(calls.probes).toHaveLength(1);
    expect(calls.probes[0]).toEqual({
      kind: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-test-123",
    });
    expect(tested.endpoint.test.phase).toBe("passed");
    expect(tested.endpoint.test.dimensions).toBe(768);
    expect(tested.endpoint.verified).toEqual({
      kind: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "text-embedding-3-small",
      dimensions: 768,
    });
    state = apply(tested, { type: "next" });
    expect(state.step).toBe("calibrate");
  });

  test("a failed test embedding stays on its step with the error", async () => {
    const { deps } = fakeDeps({
      probeEndpoint: async () => {
        throw new Error("401 unauthorized");
      },
    });
    const final = await runEmbeddingWizardEndpointTest(atEndpointTest(), deps);
    expect(final.step).toBe("endpoint-test");
    expect(final.endpoint.test.phase).toBe("failed");
    expect(final.endpoint.test.error).toBe("401 unauthorized");
    expect(final.endpoint.verified).toBeNull();
    expect(apply(final, { type: "next" }).step).toBe("endpoint-test");
  });

  test("a missing key variable fails the test before the network is reached", async () => {
    const { deps, calls } = fakeDeps({ readEnv: () => undefined });
    let state = atEndpointKey();
    state = apply(state, {
      type: "update-endpoint",
      field: "apiKeyEnv",
      value: "HARUYUKI_EMBEDDING_API_KEY",
    });
    state = apply(state, { type: "next" });
    const final = await runEmbeddingWizardEndpointTest(state, deps);
    expect(calls.probes).toHaveLength(0);
    expect(final.endpoint.test.error).toContain("empty or unset");
  });

  test("calibration runs, can be skipped, and a failure can continue", async () => {
    const { deps, calls } = fakeDeps();
    const calibrated = await runEmbeddingWizardCalibration(
      { ...atBuiltinDownload(), step: "calibrate" },
      deps,
    );
    expect(calls.calibrations[0]).toEqual({
      backend: "builtin",
      modelId: MODEL_ID,
      endpoint: null,
    });
    expect(calibrated.calibration.phase).toBe("done");
    expect(calibrated.calibration.result?.p50Ms).toBe(42);
    expect(apply(calibrated, { type: "next" }).step).toBe("finish");

    const skipped = apply(
      { ...atBuiltinDownload(), step: "calibrate" },
      { type: "calibration-skip" },
    );
    expect(skipped.step).toBe("finish");
    expect(skipped.calibration.phase).toBe("skipped");
    expect(embeddingWizardSettingsPatch(skipped).patch).toEqual({
      enabled: true,
      backend: "builtin",
      model: MODEL_ID,
    });

    const { deps: failing } = fakeDeps({
      calibrate: async () => {
        throw new Error("measurement exploded");
      },
    });
    const failed = await runEmbeddingWizardCalibration(
      { ...atBuiltinDownload(), step: "calibrate" },
      failing,
    );
    expect(failed.calibration.phase).toBe("failed");
    expect(failed.calibration.error).toBe("measurement exploded");
    expect(apply(failed, { type: "next" }).step).toBe("finish");
    expect(apply(failed, { type: "calibration-reset" }).calibration.phase).toBe(
      "idle",
    );
  });

  test("skipping while a measurement is in flight drops the late result", async () => {
    const gate = deferred<EmbeddingWizardCalibration>();
    const { deps } = fakeDeps({ calibrate: () => gate.promise });
    const state = { ...atBuiltinDownload(), step: "calibrate" as const };
    let current: EmbeddingWizardState = state;
    const run = runEmbeddingWizardCalibration(
      state,
      deps,
      (next) => {
        current = next;
      },
      () => current,
    );
    await Promise.resolve();
    expect(current.calibration.phase).toBe("running");
    current = apply(current, { type: "calibration-skip" });
    expect(current.step).toBe("finish");
    gate.resolve(fakeCalibration());
    const final = await run;
    expect(final.step).toBe("finish");
    expect(final.calibration.phase).toBe("skipped");
  });

  test("the built-in finish writes the D3 patch and passes the lifecycle switch", async () => {
    const { deps, calls } = fakeDeps();
    const state = apply(
      {
        ...atBuiltinDownload(),
        step: "calibrate",
        calibration: { phase: "done", result: fakeCalibration(), error: null },
      },
      { type: "next" },
    );
    expect(state.step).toBe("finish");
    expect(state.finish.keepAfterExit).toBe(false);

    const defaultFinish = await runEmbeddingWizardFinish(state, deps);
    expect(calls.saved).toEqual([
      {
        enabled: true,
        backend: "builtin",
        model: MODEL_ID,
        calibration: {
          fingerprint: "fp-1",
          measuredAt: "2026-11-04T00:00:00.000Z",
          queryLatencyP50Ms: 42,
          queryLatencyP90Ms: 55,
          batchThroughputPerSec: 128,
          gpuRole: "off",
          threads: 4,
          quantization: "float32",
        },
      },
    ]);
    expect(calls.builds).toEqual([
      { backend: "builtin", model: MODEL_ID, keepAfterExit: false },
    ]);
    expect(defaultFinish.outcome).toBe("completed");
    expect(defaultFinish.finish.buildReceipt).toBe("build started");

    // The one switch defaults off and toggles on.
    const toggled = apply(state, { type: "toggle-keep-after-exit" });
    expect(toggled.finish.keepAfterExit).toBe(true);
    const { deps: depsOn, calls: callsOn } = fakeDeps();
    const withKeep = await runEmbeddingWizardFinish(toggled, depsOn);
    expect(withKeep.outcome).toBe("completed");
    expect(callsOn.builds[0]?.keepAfterExit).toBe(true);
  });

  test("the endpoint finish stores the key before the settings and the build start", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps();
    const { deps: ordered } = fakeDeps({
      saveApiKey: async (value) => {
        order.push(`key:${value}`);
      },
      saveSettings: (patch) => {
        order.push("settings");
        expect(patch.backend).toBe("endpoint");
        expect(patch.endpoint).toEqual({
          kind: "openai",
          baseUrl: "https://api.example.com/v1",
          model: "text-embedding-3-small",
          dimensions: 768,
        });
      },
      startBuild: () => {
        order.push("build");
        return "build started";
      },
    });
    let state = await runEmbeddingWizardEndpointTest(atEndpointTest(), deps);
    state = apply(state, { type: "next" });
    state = await runEmbeddingWizardCalibration(state, deps);
    state = apply(state, { type: "next" });
    expect(state.step).toBe("finish");
    const final = await runEmbeddingWizardFinish(state, ordered);
    expect(order).toEqual(["key:sk-test-123", "settings", "build"]);
    expect(final.outcome).toBe("completed");
  });

  test("an unverified endpoint cannot be finished and writes nothing", async () => {
    const { deps, calls } = fakeDeps();
    const state = apply(
      {
        ...atBuiltinDownload(),
        backend: "endpoint",
        step: "finish",
        finish: {
          keepAfterExit: false,
          phase: "ready",
          error: null,
          buildReceipt: null,
        },
        endpoint: {
          ...atEndpointKey().endpoint,
          test: {
            phase: "idle",
            model: null,
            dimensions: null,
            norm: null,
            latencyMs: null,
            error: null,
          },
          verified: null,
        },
      },
      { type: "toggle-keep-after-exit", value: false },
    );
    const final = await runEmbeddingWizardFinish(state, deps);
    expect(final.finish.phase).toBe("failed");
    expect(final.finish.error).toContain("Test the endpoint");
    expect(final.outcome).toBe("active");
    expect(calls.saved).toHaveLength(0);
    expect(calls.builds).toHaveLength(0);
  });

  test("a failed settings write keeps the finish step and skips the build start", async () => {
    const { calls } = fakeDeps();
    const { deps } = fakeDeps({
      saveSettings: () => {
        throw new Error("settings file is busy");
      },
    });
    const state = apply(
      {
        ...atBuiltinDownload(),
        step: "calibrate",
        calibration: {
          phase: "done",
          result: fakeCalibration(),
          error: null,
        },
      },
      { type: "next" },
    );
    const final = await runEmbeddingWizardFinish(state, deps);
    expect(final.step).toBe("finish");
    expect(final.finish.phase).toBe("failed");
    expect(final.finish.error).toContain("settings file is busy");
    expect(final.outcome).toBe("active");
    expect(calls.builds).toHaveLength(0);
  });

  test("busy steps consume back/cancel so the only write path cannot race", () => {
    const busy = {
      ...atBuiltinDownload(),
      builtin: {
        ...atBuiltinDownload().builtin,
        download: {
          ...atBuiltinDownload().builtin.download,
          phase: "running" as const,
        },
      },
    };
    expect(isEmbeddingWizardBusy(busy)).toBe(true);
    expect(apply(busy, { type: "cancel" }).outcome).toBe("active");
    expect(apply(busy, { type: "back" }).step).toBe("builtin-download");
  });

  test("C5's result maps onto the wizard's display and settings shapes", () => {
    const mapped = embeddingWizardCalibrationFromResult({
      snapshot: {
        fingerprint: "fp-2",
        measured_at: "2026-11-04T01:00:00.000Z",
        query_latency_p50_ms: 12.5,
        query_latency_p90_ms: 18.25,
        batch_throughput_per_s: 64,
        gpu_role: "index-only",
        threads: 2,
        quantization: "int8",
      },
      budget: {
        tier: "m3",
        calibrated: true,
        queryBudgetMs: 300,
        rssBytes: 1_024,
        diskFreeBytes: 2_048,
        diskHeadroomOk: false,
      },
    });
    expect(mapped.p50Ms).toBe(12.5);
    expect(mapped.p90Ms).toBe(18.25);
    expect(mapped.gpuRole).toBe("index-only");
    expect(mapped.diskHeadroomOk).toBe(false);
    expect(mapped.reason).toBeNull();
  });
});
