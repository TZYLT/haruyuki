import { afterEach, describe, expect, test } from "bun:test";
import {
  embeddingWizardSetupOpener,
  openEmbeddingWizard,
} from "@/cli/app/embedding-wizard-overlay";
import type { EmbeddingSettingsPatch } from "@/cli/app/pages/settings/embedding-settings";
import {
  EmbeddingWizard,
  embeddingWizardCompletedText,
  embeddingWizardStepCount,
} from "@/cli/components/EmbeddingWizard";
import type {
  EmbeddingWizardBuildRequest,
  EmbeddingWizardCalibration,
  EmbeddingWizardDeps,
  EmbeddingWizardEndpointProbeRequest,
} from "@/cli/helpers/embedding-wizard-state";
import { EMBEDDING_SETTING_DEFAULTS } from "@/recall-settings";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The first-run vector-recall wizard, judged on the frame (48-2 §4.9 D5).
 *
 * The state machine test pins the transitions and the writes; this file pins
 * what a user actually sees at each step: the GPU role screen, the cached-install
 * check that skips the download, the two-size download confirmation, the masked
 * endpoint key, the calibration screen's "not measured" wording, the step-4
 * selectable rows (highlight, Space/Enter toggles, the Start build action row)
 * and the finish receipt.
 */

const ENTER = String.fromCharCode(13);
const ESCAPE = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const DOWN = "\u001B[B";

const MODEL_ID = "bge-small-zh-v1.5";
const RUNTIME_DIR = "/tmp/runtime/1.31.1";

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

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

interface Harness {
  tty: ReturnType<typeof mountInkTty>;
  saves: EmbeddingSettingsPatch[];
  builds: EmbeddingWizardBuildRequest[];
  keys: string[];
  probes: EmbeddingWizardEndpointProbeRequest[];
  modelDownloads: string[];
  runtimeDownloads: number[];
  order: string[];
  closes: () => number;
  completions: () => string[];
}

function mount(
  options: {
    deps?: Partial<EmbeddingWizardDeps>;
    columns?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Harness {
  const saves: EmbeddingSettingsPatch[] = [];
  const builds: EmbeddingWizardBuildRequest[] = [];
  const keys: string[] = [];
  const probes: Harness["probes"] = [];
  const modelDownloads: string[] = [];
  const runtimeDownloads: number[] = [];
  const order: string[] = [];
  const completions: string[] = [];
  let closes = 0;
  const tty = mountInkTty(
    <EmbeddingWizard
      agentId="agent-embedding"
      initialSettings={EMBEDDING_SETTING_DEFAULTS}
      env={options.env ?? {}}
      deps={{
        downloadModel: async (request) => {
          modelDownloads.push(request.modelId);
          order.push("model");
          return {
            modelId: request.modelId,
            modelDir: `/tmp/models/${request.modelId}`,
            alreadyInstalled: false,
            runtimeDir: RUNTIME_DIR,
          };
        },
        isModelInstalled: async () => false,
        isRuntimeInstalled: async () => false,
        downloadRuntime: async () => {
          runtimeDownloads.push(1);
          order.push("runtime");
          return { runtimeDir: RUNTIME_DIR, alreadyInstalled: false };
        },
        probeEndpoint: async (request) => {
          probes.push(request);
          return {
            kind: request.kind,
            model: request.model,
            dimensions: 768,
            norm: 1,
            latencyMs: 12,
          };
        },
        calibrate: async () => fakeCalibration(),
        saveSettings: (patch) => {
          saves.push(patch);
        },
        saveApiKey: async (value) => {
          keys.push(value);
        },
        startBuild: (request) => {
          builds.push(request);
          return "build started";
        },
        readEnv: () => undefined,
        ...options.deps,
      }}
      onClose={() => {
        closes += 1;
      }}
      onCompleted={(receipt) => {
        completions.push(receipt ?? "");
      }}
    />,
    { columns: options.columns ?? 90, rows: 34 },
  );
  return {
    tty,
    saves,
    builds,
    keys,
    probes,
    modelDownloads,
    runtimeDownloads,
    order,
    closes: () => closes,
    completions: () => completions,
  };
}

async function painted(tty: ReturnType<typeof mountInkTty>): Promise<string> {
  await settle();
  return (await tty.rows()).join("\\n");
}

/**
 * Backend (built-in) → GPU role (Auto) → model picker → cached-install check →
 * the download confirmation (the fake cache reports "nothing installed").
 */
async function toBuiltinDownload(
  tty: ReturnType<typeof mountInkTty>,
): Promise<void> {
  await tty.press(ENTER, ENTER, ENTER);
  await settle();
  await settle();
}

/** … and through the runtime + model install and automatic calibration. */
async function toFinish(tty: ReturnType<typeof mountInkTty>): Promise<string> {
  await toBuiltinDownload(tty);
  await tty.press(ENTER);
  await settle();
  await settle();
  await settle();
  await tty.press(ENTER);
  return painted(tty);
}

/** Step 4's action row is the fourth row: three Downs then Enter. */
async function startBuildFromFinish(
  tty: ReturnType<typeof mountInkTty>,
): Promise<void> {
  await tty.press(DOWN, DOWN, DOWN, ENTER);
  await settle();
}

/** Backend (endpoint row) → GPU → protocol (OpenAI) → URL screen. */
async function toEndpointUrl(
  tty: ReturnType<typeof mountInkTty>,
): Promise<void> {
  await tty.press("j", ENTER);
  await settle();
  await tty.press(ENTER);
  await settle();
  await tty.press(ENTER);
  await settle();
}

/** Walk to the masked-key screen; leaves the key typed but not submitted. */
async function toEndpointKey(
  tty: ReturnType<typeof mountInkTty>,
): Promise<void> {
  await toEndpointUrl(tty);
  await tty.press("https://api.example.com/v1");
  await tty.press(ENTER);
  await tty.press("text-embedding-3-small");
  await tty.press(ENTER);
  await tty.press(ENTER); // empty key-variable name
  await tty.press("sk-live-secret");
  await settle();
}

afterEach(() => {
  resetInkTtyState();
});

describe("the embedding setup wizard", () => {
  test("opens on the backend choice with four numbered steps", async () => {
    expect(embeddingWizardStepCount()).toBe(4);
    const { tty } = mount();
    try {
      const frame = await painted(tty);
      expect(frame).toContain("> /recall embedding setup");
      expect(frame).toContain("1/4 Backend");
      expect(frame).toContain("Built-in model");
      expect(frame).toContain("External endpoint");
      expect(frame).toContain("Not now");
      expect(frame).toContain("Esc cancel");
    } finally {
      tty.stop();
    }
  });

  test("the built-in path asks the GPU role, discloses both downloads, then calibrates and finishes", async () => {
    const { tty, saves, builds, completions } = mount();
    try {
      await painted(tty);
      await tty.press(ENTER);
      const gpuFrame = await painted(tty);
      expect(gpuFrame).toContain("2/4 GPU");
      expect(gpuFrame).toContain("Auto (default)");
      expect(gpuFrame).toContain("CPU only");
      if (process.platform === "win32") {
        expect(gpuFrame).toContain("Index build only");
      } else {
        expect(gpuFrame).toContain(
          "CPU only (this platform cannot build the index on a GPU)",
        );
      }

      await tty.press(ENTER);
      const modelFrame = await painted(tty);
      expect(modelFrame).toContain("2/4 Built-in model");
      expect(modelFrame).toContain(MODEL_ID);
      expect(modelFrame).toContain("512d");
      expect(modelFrame).toContain("MIT");

      await tty.press(ENTER);
      await settle();
      await settle();
      const downloadFrame = await painted(tty);
      expect(downloadFrame).toContain("2/4 Download");
      expect(downloadFrame).toContain("Download now");
      expect(downloadFrame).toContain("Model download: ~24.5 MB");
      expect(downloadFrame).toContain("Runtime download: ~115 MB");
      expect(downloadFrame).toContain("License: MIT");
      expect(downloadFrame).toContain("sha256 not recorded");
      expect(saves).toEqual([]);

      await tty.press(ENTER);
      await settle();
      await settle();
      await settle();
      const calibrationFrame = await painted(tty);
      expect(calibrationFrame).toContain("3/4 Calibration");
      expect(calibrationFrame).toContain("p50 42ms");
      expect(calibrationFrame).toContain("p90 55ms");
      expect(calibrationFrame).toContain("query +100ms");
      expect(calibrationFrame).toContain("Tier: small (calibrated)");
      expect(calibrationFrame).toContain("GPU: auto");

      await tty.press(ENTER);
      const finishFrame = await painted(tty);
      expect(finishFrame).toContain("4/4 Finish");
      expect(finishFrame).toContain("[ ] Keep building after you exit");
      expect(finishFrame).toContain("[x] Build mode: incremental");
      expect(finishFrame).toContain("Start build");
      expect(finishFrame).toContain("↑↓ move");
      expect(finishFrame).toContain("Space/Enter toggle");
      expect(saves).toEqual([]);

      await startBuildFromFinish(tty);
      expect(saves).toEqual([
        {
          enabled: true,
          backend: "builtin",
          model: MODEL_ID,
          gpu: "auto",
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
      expect(builds).toEqual([
        {
          backend: "builtin",
          model: MODEL_ID,
          keepAfterExit: false,
          mode: "incremental",
        },
      ]);
      expect(completions()).toEqual(["build started"]);
    } finally {
      tty.stop();
    }
  });

  test("an installed model and runtime skip the download screen and say they are cached", async () => {
    const { tty, saves, modelDownloads, runtimeDownloads } = mount({
      deps: {
        isModelInstalled: async () => true,
        isRuntimeInstalled: async () => true,
      },
    });
    try {
      await painted(tty);
      await tty.press(ENTER, ENTER, ENTER);
      await settle();
      await settle();
      const frame = await painted(tty);
      expect(frame).toContain("3/4 Calibration");
      expect(frame).toContain("already installed");
      expect(frame).not.toContain("2/4 Download");
      expect(modelDownloads).toHaveLength(0);
      expect(runtimeDownloads).toHaveLength(0);
      expect(saves).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("a missing runtime still shows the download screen and installs the runtime first", async () => {
    const { tty, modelDownloads, runtimeDownloads, order } = mount({
      deps: {
        isModelInstalled: async () => true,
        isRuntimeInstalled: async () => false,
      },
    });
    try {
      await painted(tty);
      await tty.press(ENTER, ENTER, ENTER);
      await settle();
      await settle();
      expect(await painted(tty)).toContain("2/4 Download");
      await tty.press(ENTER);
      await settle();
      await settle();
      expect(order).toEqual(["runtime", "model"]);
      expect(runtimeDownloads).toHaveLength(1);
      expect(modelDownloads).toEqual([MODEL_ID]);
    } finally {
      tty.stop();
    }
  });

  test("a runtime download failure keeps the download screen with its own error", async () => {
    const { tty } = mount({
      deps: {
        downloadRuntime: async () => {
          throw new Error("npm registry unreachable");
        },
      },
    });
    try {
      await toBuiltinDownload(tty);
      await tty.press(ENTER);
      await settle();
      await settle();
      const frame = await painted(tty);
      expect(frame).toContain("2/4 Download");
      expect(frame).toContain(
        "Runtime install failed: npm registry unreachable",
      );
      expect(frame).toContain("Enter retry");
    } finally {
      tty.stop();
    }
  });

  test("step 4's rows take the cursor, Space/Enter toggles them and Start build runs", async () => {
    const { tty, builds, saves } = mount();
    try {
      await toFinish(tty);
      // Row 0: Enter toggles the keep switch.
      await tty.press(ENTER);
      let frame = await painted(tty);
      expect(frame).toContain("[x] Keep building after you exit");
      expect(frame).toContain("[x] Build mode: incremental");

      // Row 1: Space selects incremental (already on) — a no-op this time.
      await tty.press(DOWN, " ");
      frame = await painted(tty);
      expect(frame).toContain("[x] Build mode: incremental");
      expect(frame).toContain("[ ] Build mode: full");

      // Row 2: Space selects the full build mode.
      await tty.press(DOWN, " ");
      frame = await painted(tty);
      expect(frame).toContain("[ ] Build mode: incremental");
      expect(frame).toContain("[x] Build mode: full");
      expect(saves).toEqual([]);

      // Row 3: the action row.
      await tty.press(DOWN, ENTER);
      await settle();
      expect(builds).toHaveLength(1);
      expect(builds[0]?.keepAfterExit).toBe(true);
      expect(builds[0]?.mode).toBe("full");
    } finally {
      tty.stop();
    }
  });

  test("the t shortcut still toggles keep-after-exit and the row shows it", async () => {
    const { tty, builds } = mount();
    try {
      await toFinish(tty);
      await tty.press("t");
      const toggled = await painted(tty);
      expect(toggled).toContain("[x] Keep building after you exit");
      expect(toggled).toContain("runs detached; survives exit");
      await startBuildFromFinish(tty);
      expect(builds[0]?.keepAfterExit).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("Start build still runs right after skipping a calibration that is still measuring", async () => {
    let releaseCalibration: (result: EmbeddingWizardCalibration) => void = () =>
      undefined;
    const measuring = new Promise<EmbeddingWizardCalibration>((resolve) => {
      releaseCalibration = resolve;
    });
    const { tty, builds, saves, completions } = mount({
      deps: {
        isModelInstalled: async () => true,
        isRuntimeInstalled: async () => true,
        calibrate: () => measuring,
      },
    });
    try {
      await painted(tty);
      await tty.press(ENTER, ENTER, ENTER);
      await settle();
      await settle();
      expect(await painted(tty)).toContain("3/4 Calibration");

      // "s" walks to step 4 while the measurement is still in flight. The only
      // write path must not be swallowed by that stale action.
      await tty.press("s");
      await settle();
      await tty.press(DOWN, DOWN, DOWN, ENTER);
      await settle();
      expect(builds).toHaveLength(1);
      expect(saves).toHaveLength(1);

      // The late measurement is dropped: it neither rewinds step 4 nor writes a
      // second time.
      releaseCalibration(fakeCalibration());
      await settle();
      expect(completions()).toHaveLength(1);
      expect(builds).toHaveLength(1);
      expect(saves).toHaveLength(1);
    } finally {
      tty.stop();
    }
  });

  test("An unmeasured calibration never paints a zero latency", async () => {
    const { tty } = mount({
      deps: {
        calibrate: async () =>
          fakeCalibration({
            calibrated: false,
            p50Ms: 0,
            p90Ms: 0,
            throughputPerSec: 0,
            reason: "calibration probe is not wired in this build",
            tier: "documented",
            queryBudgetMs: 150,
          }),
      },
    });
    try {
      await toBuiltinDownload(tty);
      await tty.press(ENTER);
      await settle();
      await settle();
      const frame = await painted(tty);
      expect(frame).toContain("3/4 Calibration");
      expect(frame).toContain(
        "not measured / not applicable (default budget used)",
      );
      expect(frame).not.toContain("p50 0ms");
      expect(frame).toContain("query +150ms");
    } finally {
      tty.stop();
    }
  });

  test("the endpoint path masks the key, tests it and writes the verified form", async () => {
    const { tty, saves, builds, keys, probes } = mount();
    try {
      await toEndpointKey(tty);
      const masked = await painted(tty);
      expect(masked).toContain("2/4 Endpoint key");
      expect(masked).toContain("•");
      expect(masked).not.toContain("sk-live-secret");

      await tty.press(ENTER);
      const testFrame = await painted(tty);
      expect(testFrame).toContain("2/4 Endpoint test");
      expect(testFrame).toContain("768d");
      expect(testFrame).toContain("norm 1.000");
      expect(testFrame).toContain("12ms");
      expect(testFrame).toContain("Egress");
      expect(probes[0]).toEqual({
        kind: "openai",
        baseUrl: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        apiKey: "sk-live-secret",
      });

      await tty.press(ENTER); // continue to calibration
      await settle();
      await settle();
      await tty.press(ENTER); // continue to finish
      await settle();
      await startBuildFromFinish(tty);
      expect(keys).toEqual(["sk-live-secret"]);
      expect(saves[0]).toEqual({
        enabled: true,
        backend: "endpoint",
        endpoint: {
          kind: "openai",
          baseUrl: "https://api.example.com/v1",
          model: "text-embedding-3-small",
          dimensions: 768,
        },
        gpu: "auto",
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
      });
      expect(builds[0]?.backend).toBe("endpoint");
      expect(builds[0]?.model).toBe("text-embedding-3-small");
    } finally {
      tty.stop();
    }
  });

  test("a failed test embedding says why and stays on the endpoint test step", async () => {
    const { tty } = mount({
      deps: {
        probeEndpoint: async () => {
          throw new Error("connection refused");
        },
      },
    });
    try {
      await toEndpointKey(tty);
      await tty.press(ENTER);
      const frame = await painted(tty);
      expect(frame).toContain("2/4 Endpoint test");
      expect(frame).toContain("Test embedding failed: connection refused");
      expect(frame).toContain("Enter test");
    } finally {
      tty.stop();
    }
  });

  test("a failed download keeps the step, shows the hint, and Enter retries", async () => {
    let attempts = 0;
    const { tty } = mount({
      deps: {
        downloadModel: async (request) => {
          attempts += 1;
          if (attempts === 1) throw new Error("offline");
          return {
            modelId: request.modelId,
            modelDir: `/tmp/models/${request.modelId}`,
            alreadyInstalled: false,
            runtimeDir: RUNTIME_DIR,
          };
        },
      },
    });
    try {
      await toBuiltinDownload(tty);
      await tty.press(ENTER);
      await settle();
      await settle();
      const failed = await painted(tty);
      expect(failed).toContain("2/4 Download");
      expect(failed).toContain("Download failed: offline");
      expect(failed).toContain("import a copy");

      await tty.press(ENTER);
      await settle();
      await settle();
      expect(await painted(tty)).toContain("3/4 Calibration");
    } finally {
      tty.stop();
    }
  });

  test("Escape walks back one step and cancel at the root writes nothing", async () => {
    const { tty, saves, closes } = mount();
    try {
      await painted(tty);
      await tty.press(ENTER);
      expect(await painted(tty)).toContain("2/4 GPU");
      await tty.press(ESCAPE);
      expect(await painted(tty)).toContain("1/4 Backend");
      expect(closes()).toBe(0);
      await tty.press(ESCAPE);
      await settle();
      expect(closes()).toBe(1);
      expect(saves).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("ctrl+c cancels from a form step without writing", async () => {
    const { tty, saves, closes } = mount();
    try {
      await toEndpointUrl(tty);
      expect(await painted(tty)).toContain("2/4 Endpoint URL");
      await tty.press(CTRL_C);
      await settle();
      expect(closes()).toBe(1);
      expect(saves).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("a narrow terminal still paints the numbered step and its action", async () => {
    const { tty } = mount({ columns: 40 });
    try {
      const frame = await painted(tty);
      expect(frame).toContain("1/4 Backend");
      await tty.press(ENTER, ENTER, ENTER);
      await settle();
      await settle();
      const download = await painted(tty);
      expect(download).toContain("2/4 Download");
      expect(download).toContain("Model download: ~24.5 MB");
      expect(download).toContain("Model: bge-small-zh-v1.5");
    } finally {
      tty.stop();
    }
  });

  test("the TUI seam raises the wizard overlay and reports completion text", () => {
    const calls: Array<[string, string, string, string]> = [];
    const opener = embeddingWizardSetupOpener(
      (overlay, input, opening, dismiss) => {
        calls.push([overlay, input, opening, dismiss]);
      },
    );
    expect(opener("/recall embedding setup")).toBe(true);
    expect(calls).toEqual([
      [
        "embedding-wizard",
        "/recall embedding setup",
        "Opening the embedding setup wizard...",
        "Embedding setup closed",
      ],
    ]);

    let opened = "";
    expect(
      openEmbeddingWizard((overlay) => {
        opened = overlay;
      }),
    ).toBe(true);
    expect(opened).toBe("embedding-wizard");
    expect(embeddingWizardCompletedText()).toContain("Vector recall");
  });
});
