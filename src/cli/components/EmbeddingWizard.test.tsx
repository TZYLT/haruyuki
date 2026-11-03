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
 * what a user actually sees at each step: the four numbered screens, the
 * download / licence disclosure before any transfer, the masked endpoint key,
 * the test-embedding result and error text, the "keep building after exit"
 * switch (off by default) and the finish receipt. It also proves the flow keeps
 * its earlier screen when a dependency fails, which a frame assertion is the
 * only way to see.
 */

const ENTER = String.fromCharCode(13);
const ESCAPE = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

const MODEL_ID = "bge-small-zh-v1.5";

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const completions: string[] = [];
  let closes = 0;
  const tty = mountInkTty(
    <EmbeddingWizard
      agentId="agent-embedding"
      initialSettings={EMBEDDING_SETTING_DEFAULTS}
      env={options.env ?? {}}
      deps={{
        downloadModel: async (request) => ({
          modelId: request.modelId,
          modelDir: `/tmp/models/${request.modelId}`,
          alreadyInstalled: false,
        }),
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
    closes: () => closes,
    completions: () => completions,
  };
}

async function painted(tty: ReturnType<typeof mountInkTty>): Promise<string> {
  await settle();
  return (await tty.rows()).join("\n");
}

/** Backend (built-in, the default cursor) → model picker → download confirmation. */
async function toBuiltinDownload(
  tty: ReturnType<typeof mountInkTty>,
): Promise<void> {
  await tty.press(ENTER, ENTER);
  await settle();
}

/** … and through the download + automatic calibration to the finish step. */
async function toFinish(tty: ReturnType<typeof mountInkTty>): Promise<string> {
  await toBuiltinDownload(tty);
  await tty.press(ENTER);
  await settle();
  await settle();
  await tty.press(ENTER);
  return painted(tty);
}

/** Backend (endpoint row) → protocol (OpenAI) → URL screen. */
async function toEndpointUrl(
  tty: ReturnType<typeof mountInkTty>,
): Promise<void> {
  await tty.press("j", ENTER);
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

  test("the built-in path discloses the download, then calibrates and finishes", async () => {
    const { tty, saves, builds, completions } = mount();
    try {
      await painted(tty);
      await tty.press(ENTER);
      const modelFrame = await painted(tty);
      expect(modelFrame).toContain("2/4 Built-in model");
      expect(modelFrame).toContain(MODEL_ID);
      expect(modelFrame).toContain("512d");
      expect(modelFrame).toContain("MIT");

      await tty.press(ENTER);
      const downloadFrame = await painted(tty);
      expect(downloadFrame).toContain("2/4 Download");
      expect(downloadFrame).toContain("Download now");
      expect(downloadFrame).toContain("Size: 24.5 MB");
      expect(downloadFrame).toContain("License: MIT");
      expect(downloadFrame).toContain("sha256 not recorded");
      expect(saves).toEqual([]);

      await tty.press(ENTER);
      await settle();
      await settle();
      const calibrationFrame = await painted(tty);
      expect(calibrationFrame).toContain("3/4 Calibration");
      expect(calibrationFrame).toContain("p50 42ms");
      expect(calibrationFrame).toContain("p90 55ms");
      expect(calibrationFrame).toContain("query +100ms");
      expect(calibrationFrame).toContain("Tier: small (calibrated)");

      await tty.press(ENTER);
      const finishFrame = await painted(tty);
      expect(finishFrame).toContain("4/4 Finish");
      expect(finishFrame).toContain("[ ] Keep building after you exit");
      expect(finishFrame).toContain("closing Haruyuki stops it");
      expect(finishFrame).toContain("Enter finish");
      expect(saves).toEqual([]);

      await tty.press(ENTER);
      await settle();
      expect(saves).toEqual([
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
      expect(builds).toEqual([
        { backend: "builtin", model: MODEL_ID, keepAfterExit: false },
      ]);
      expect(completions()).toEqual(["build started"]);
    } finally {
      tty.stop();
    }
  });

  test("the keep-after-exit switch defaults off and toggles on", async () => {
    const { tty, builds } = mount();
    try {
      await toFinish(tty);
      await tty.press("t");
      const toggled = await painted(tty);
      expect(toggled).toContain("[x] Keep building after you exit");
      expect(toggled).toContain("survives closing Haruyuki");
      await tty.press(ENTER);
      await settle();
      expect(builds[0]?.keepAfterExit).toBe(true);
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
      await tty.press(ENTER); // finish
      await settle();
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
          };
        },
      },
    });
    try {
      await toBuiltinDownload(tty);
      await tty.press(ENTER);
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
      expect(await painted(tty)).toContain("2/4 Built-in model");
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
      await tty.press(ENTER, ENTER);
      const download = await painted(tty);
      expect(download).toContain("2/4 Download");
      expect(download).toContain("Size: 24.5 MB");
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
