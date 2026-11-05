import { describe, expect, test } from "bun:test";
import type { EmbeddingSettingsPatch } from "@/cli/app/pages/settings/embedding-settings";
import {
  embeddingWizardCalibrationFromResult,
  embeddingWizardCalibrationLatencyLine,
  embeddingWizardCalibrationMeasured,
  embeddingWizardManualImportHint,
  embeddingWizardModelDir,
  embeddingWizardSettingsPatch,
  resolveEmbeddingWizardApiKey,
  runEmbeddingWizardCalibration,
  runEmbeddingWizardDownload,
  runEmbeddingWizardEndpointTest,
  runEmbeddingWizardFinish,
  runEmbeddingWizardInstallCheck,
} from "@/cli/helpers/embedding-wizard-actions";
import {
  EMBEDDING_WIZARD_COMMAND,
  EMBEDDING_WIZARD_STEP_COUNT,
  embeddingWizardGpuMismatch,
  embeddingWizardGpuRoleOptions,
  embeddingWizardModelOptions,
  embeddingWizardStepTitle,
  formatEmbeddingWizardBytes,
} from "@/cli/helpers/embedding-wizard-facts";
import {
  applyEmbeddingWizardEvent,
  builtinInstalled,
  createEmbeddingWizardState,
  type EmbeddingWizardBuildRequest,
  type EmbeddingWizardCalibration,
  type EmbeddingWizardCalibrationRequest,
  type EmbeddingWizardDeps,
  type EmbeddingWizardEndpointProbeRequest,
  type EmbeddingWizardRuntimeDownloadRequest,
  type EmbeddingWizardState,
  embeddingWizardBackStep,
  isEmbeddingWizardBusy,
} from "@/cli/helpers/embedding-wizard-state";

/**
 * The wizard's state machine and its injected side effects, judged without a
 * terminal. The frame test (`components/EmbeddingWizard.test.tsx`) proves the
 * screens exist; this file proves the transitions, the writes and the failure
 * behaviour the frames are supposed to show.
 */

const MODEL_ID = "bge-small-zh-v1.5";
const RUNTIME_DIR = "/tmp/runtime/1.31.1";

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

function atGpuRole(): EmbeddingWizardState {
  return chooseBuiltin();
}

function atBuiltinModel(
  state: EmbeddingWizardState = atGpuRole(),
): EmbeddingWizardState {
  return applyEmbeddingWizardEvent(
    applyEmbeddingWizardEvent(state, { type: "choose-gpu", role: "auto" }),
    { type: "choose-precision", precision: "float32" },
  );
}

function checkSucceeded(
  state: EmbeddingWizardState,
  result: {
    modelInstalled: boolean;
    runtimeInstalled: boolean;
    modelDir: string | null;
    runtimeDir: string | null;
  },
): EmbeddingWizardState {
  return applyEmbeddingWizardEvent(
    applyEmbeddingWizardEvent(state, { type: "install-check-started" }),
    { type: "install-check-succeeded", result },
  );
}

/** The check reports "nothing cached": the confirmation screen is next. */
function atBuiltinDownload(): EmbeddingWizardState {
  let state = applyEmbeddingWizardEvent(atBuiltinModel(), {
    type: "choose-model",
    modelId: MODEL_ID,
  });
  state = checkSucceeded(state, {
    modelInstalled: false,
    runtimeInstalled: false,
    modelDir: null,
    runtimeDir: null,
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
    type: "choose-gpu",
    role: "auto",
  });
  state = applyEmbeddingWizardEvent(state, {
    type: "choose-precision",
    precision: "float32",
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

/** The defaults path C5 returns when no measurement ran: zeros, not measured. */
function unmeasuredCalibration(): EmbeddingWizardCalibration {
  return fakeCalibration({
    calibrated: false,
    p50Ms: 0,
    p90Ms: 0,
    throughputPerSec: 0,
    reason: "calibration probe is not wired in this build",
    tier: "documented",
    queryBudgetMs: 150,
  });
}

interface Calls {
  downloads: string[];
  runtimes: EmbeddingWizardRuntimeDownloadRequest[];
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
    runtimes: [],
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
        runtimeDir: RUNTIME_DIR,
      };
    },
    isModelInstalled: async () => false,
    isRuntimeInstalled: async () => false,
    downloadRuntime: async (request) => {
      calls.runtimes.push(request);
      request.onProgress?.(0.5);
      return { runtimeDir: RUNTIME_DIR, alreadyInstalled: false };
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
    expect(EMBEDDING_WIZARD_COMMAND).toBe("/recall embedding connect");
    const state = start();
    expect(state.step).toBe("backend");
    expect(state.outcome).toBe("active");
    expect(state.gpu).toBe("auto");
    expect(state.finish.buildMode).toBe("incremental");
    expect(embeddingWizardStepTitle("backend")).toBe("1/4 Backend");
    expect(embeddingWizardStepTitle("gpu-role")).toBe("2/4 GPU");
    expect(embeddingWizardStepTitle("builtin-check")).toBe("2/4 Model check");
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

  test("a re-entered setup pre-fills the current backend, model and GPU role", () => {
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
        gpu: "index-only",
        quantization: "float32",
        calibration: null,
        keepSpaces: 2,
      },
    });
    expect(state.backend).toBe("endpoint");
    // 48-4 D-01: an old stored `index-only` is read as `auto`.
    expect(state.gpu).toBe("auto");
    expect(state.precision).toBe("float32");
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
    const deeper = atBuiltinDownload();
    expect(apply(deeper, { type: "cancel" }).outcome).toBe("cancelled");
    expect(apply(deeper, { type: "back" }).step).toBe("builtin-model");
    expect(embeddingWizardBackStep(deeper)).toBe("builtin-model");
    expect(embeddingWizardBackStep(atEndpointTest())).toBe("endpoint-key");
    // A cancel mid-check or mid-download is refused while the action is busy.
    const busyCheck: EmbeddingWizardState = {
      ...atBuiltinModel(),
      step: "builtin-check",
      builtin: {
        ...atBuiltinModel().builtin,
        installCheck: {
          phase: "checking",
          error: null,
          modelInstalled: false,
          runtimeInstalled: false,
          modelDir: null,
          runtimeDir: null,
        },
      },
    };
    expect(isEmbeddingWizardBusy(busyCheck)).toBe(true);
    expect(apply(busyCheck, { type: "cancel" }).outcome).toBe("active");
  });

  test("the built-in branch asks for a GPU role and precision before the model", () => {
    let state = chooseBuiltin();
    expect(state.step).toBe("gpu-role");
    state = apply(state, { type: "choose-gpu", role: "off" });
    expect(state.step).toBe("precision");
    expect(state.gpu).toBe("off");
    state = apply(state, { type: "choose-precision", precision: "int8" });
    expect(state.step).toBe("builtin-model");
    expect(state.precision).toBe("int8");
    state = apply(state, { type: "choose-model", modelId: MODEL_ID });
    expect(state.step).toBe("builtin-check");
    expect(state.builtin.installCheck.phase).toBe("idle");
    expect(state.builtin.download.phase).toBe("idle");
    expect(embeddingWizardBackStep(state)).toBe("builtin-model");
  });

  test("an installed model and runtime skip the download screen entirely", async () => {
    const { deps, calls } = fakeDeps({
      isModelInstalled: async () => true,
      isRuntimeInstalled: async () => true,
    });
    let state = apply(atBuiltinModel(), {
      type: "choose-model",
      modelId: MODEL_ID,
    });
    const settled = await runEmbeddingWizardInstallCheck(state, deps);
    expect(calls.downloads).toHaveLength(0);
    expect(settled.step).toBe("calibrate");
    expect(settled.builtin.download.phase).toBe("done");
    expect(settled.builtin.installCheck).toEqual({
      phase: "done",
      error: null,
      modelInstalled: true,
      runtimeInstalled: true,
      modelDir: expect.stringContaining(MODEL_ID),
      runtimeDir: expect.stringContaining("runtime"),
    });
    expect(builtinInstalled(settled)).toBe(true);
    state = settled;
    expect(state.calibration.phase).toBe("idle");
  });

  test("a missing runtime still shows the download screen with the runtime pending", async () => {
    const { deps } = fakeDeps({
      isModelInstalled: async () => true,
      isRuntimeInstalled: async () => false,
    });
    const settled = await runEmbeddingWizardInstallCheck(
      apply(atBuiltinModel(), { type: "choose-model", modelId: MODEL_ID }),
      deps,
    );
    expect(settled.step).toBe("builtin-download");
    expect(settled.builtin.download.runtimeDone).toBe(false);
    expect(settled.builtin.download.modelDone).toBe(true);
    expect(settled.builtin.installCheck.modelInstalled).toBe(true);
    expect(settled.builtin.installCheck.runtimeInstalled).toBe(false);
  });

  test("a failed install check keeps the check screen with an actionable error", async () => {
    const { deps } = fakeDeps({
      isModelInstalled: async () => {
        throw new Error("cache unreadable");
      },
    });
    const before = apply(atBuiltinModel(), {
      type: "choose-model",
      modelId: MODEL_ID,
    });
    const failed = await runEmbeddingWizardInstallCheck(before, deps);
    expect(failed.step).toBe("builtin-check");
    expect(failed.builtin.installCheck.phase).toBe("failed");
    expect(failed.builtin.installCheck.error).toBe("cache unreadable");
    // Enter retries: the reset returns to idle so the effect runs the check.
    const retried = apply(failed, { type: "next" });
    expect(retried.step).toBe("builtin-check");
    expect(retried.builtin.installCheck.phase).toBe("idle");
  });

  test("the download runner installs the runtime before the model and lands on calibration", async () => {
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
    expect(calls.runtimes).toHaveLength(1);
    expect(calls.downloads).toEqual([MODEL_ID]);
    expect(calls.runtimes[0]?.onProgress).toBeDefined();
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBeLessThanOrEqual(1);
    expect(final.step).toBe("calibrate");
    expect(final.builtin.download.phase).toBe("done");
    expect(final.builtin.download.progress).toBe(1);
    expect(final.builtin.download.modelDir).toBe(`/tmp/models/${MODEL_ID}`);
    expect(final.builtin.download.runtimeDir).toBe(RUNTIME_DIR);
    expect(final.builtin.download.runtimeDone).toBe(true);
    expect(final.builtin.download.modelDone).toBe(true);
    expect(final.calibration.phase).toBe("idle");
  });

  test("a runtime download that fails keeps the step and says which transfer failed", async () => {
    const { deps, calls } = fakeDeps({
      downloadRuntime: async () => {
        throw new Error("npm registry unreachable");
      },
    });
    const final = await runEmbeddingWizardDownload(atBuiltinDownload(), deps);
    expect(final.step).toBe("builtin-download");
    expect(final.builtin.download.phase).toBe("failed");
    expect(final.builtin.download.error).toContain("Runtime install failed");
    expect(final.builtin.download.error).toContain("npm registry unreachable");
    expect(final.builtin.download.hint).toContain("npm registry");
    expect(calls.downloads).toHaveLength(0);
  });

  test("a failed model download keeps its step with the offline-import hint", async () => {
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
    // The runtime already landed; a retry would only resume the model.
    expect(final.builtin.download.runtimeDone).toBe(true);
  });

  test("stale outcomes are ignored once their step is no longer current", () => {
    const atDownload = atBuiltinDownload();
    const earlySuccess = apply(atDownload, {
      type: "download-succeeded",
      result: {
        modelId: MODEL_ID,
        modelDir: "/tmp/x",
        alreadyInstalled: false,
        runtimeDir: RUNTIME_DIR,
      },
    });
    expect(earlySuccess).toBe(atDownload);

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
    expect(state.step).toBe("gpu-role");
    state = apply(state, { type: "choose-gpu", role: "auto" });
    expect(state.step).toBe("precision");
    state = apply(state, { type: "choose-precision", precision: "float32" });
    expect(state.step).toBe("endpoint-kind");
    state = apply(state, { type: "choose-endpoint-kind", kind: "openai" });
    expect(state.step).toBe("endpoint-url");

    const empty = apply(state, { type: "next" });
    expect(empty.step).toBe("endpoint-url");
    expect(empty.error).toContain("must not be empty");

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

  test("calibration runs with the chosen GPU role, can be skipped, and a failure can continue", async () => {
    const { deps, calls } = fakeDeps();
    const calibrated = await runEmbeddingWizardCalibration(
      { ...atBuiltinDownload(), gpu: "off", step: "calibrate" },
      deps,
    );
    expect(calls.calibrations[0]).toEqual({
      backend: "builtin",
      modelId: MODEL_ID,
      endpoint: null,
      gpuRole: "off",
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
      gpu: "auto",
      quantization: "float32",
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

  test("the built-in finish writes the D3 patch (gpu included) and passes the build mode", async () => {
    const { deps, calls } = fakeDeps();
    let state = apply(
      {
        ...atBuiltinDownload(),
        gpu: "index-only",
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
        gpu: "index-only",
        quantization: "float32",
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
      {
        backend: "builtin",
        model: MODEL_ID,
        keepAfterExit: false,
        mode: "incremental",
      },
    ]);
    expect(defaultFinish.outcome).toBe("completed");
    expect(defaultFinish.finish.buildReceipt).toBe("build started");

    // The keep switch and the build mode are step-4 answers, not settings keys.
    state = apply(state, { type: "toggle-keep-after-exit" });
    state = apply(state, { type: "choose-build-mode", mode: "full" });
    expect(state.finish.keepAfterExit).toBe(true);
    expect(state.finish.buildMode).toBe("full");
    const { deps: depsOn, calls: callsOn } = fakeDeps();
    const withKeep = await runEmbeddingWizardFinish(state, depsOn);
    expect(withKeep.outcome).toBe("completed");
    expect(callsOn.builds[0]?.keepAfterExit).toBe(true);
    expect(callsOn.builds[0]?.mode).toBe("full");
    expect(callsOn.saved[0]?.gpu).toBe("index-only");
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
        expect(patch.gpu).toBe("auto");
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
          buildMode: "incremental",
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

  test("zero-valued calibration results are never painted as measurements", () => {
    const unmeasured = unmeasuredCalibration();
    expect(embeddingWizardCalibrationMeasured(unmeasured)).toBe(false);
    expect(embeddingWizardCalibrationLatencyLine(unmeasured)).toContain(
      "not measured",
    );
    expect(embeddingWizardCalibrationLatencyLine(unmeasured)).not.toContain(
      "p50 0ms",
    );
    // A calibrated result with a zero latency is still not a measurement.
    expect(
      embeddingWizardCalibrationMeasured(
        fakeCalibration({ p50Ms: 0, throughputPerSec: 0 }),
      ),
    ).toBe(false);
    const measured = fakeCalibration();
    expect(embeddingWizardCalibrationMeasured(measured)).toBe(true);
    expect(embeddingWizardCalibrationLatencyLine(measured)).toContain(
      "p50 42ms",
    );
    expect(embeddingWizardCalibrationLatencyLine(measured)).toContain("128/s");
  });

  test("the GPU picker offers auto and off only (48-4 D-01)", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const options = embeddingWizardGpuRoleOptions(platform);
      expect(options.map((row) => row.role)).toEqual(["auto", "off"]);
      expect(options.every((row) => !row.disabled)).toBe(true);
    }
  });

  test("a calibration measured under another GPU role is reported honestly", () => {
    const measured = fakeCalibration({ gpuRole: "off" });
    expect(embeddingWizardGpuMismatch(measured, "auto")).toContain(
      'measured with GPU role "off"',
    );
    expect(embeddingWizardGpuMismatch(measured, "off")).toBeNull();
    // Defaults-based results say nothing about the hardware.
    expect(
      embeddingWizardGpuMismatch(unmeasuredCalibration(), "index-only"),
    ).toBeNull();
  });
});
