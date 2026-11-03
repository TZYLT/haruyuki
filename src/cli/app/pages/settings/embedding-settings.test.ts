import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDING_SETTING_DEFAULTS,
  EMBEDDING_SETTING_KEYS,
  readEmbeddingSettings,
} from "@/recall-settings";
import { type Settings, settingsManager } from "@/settings-manager";
import {
  EmbeddingSettingsError,
  type EmbeddingSettingsPatch,
  embeddingPatchInvalidatesSpace,
  previewEmbeddingSettings,
  updateEmbeddingSettings,
  validateEmbeddingSettingsPatch,
} from "./embedding-settings";

/**
 * Feature ③'s writer: the defaults land as stored settings, an unusable patch is
 * refused with an actionable message and writes nothing, and nothing outside the
 * `recallEmbedding*` key family is touched (the existing recall knobs keep their
 * meaning — 48-1 §8.1's "only add keys").
 */

const originalHome = process.env.HOME;
let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "haruyuki-embedding-settings-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

const FULL_PATCH: EmbeddingSettingsPatch = {
  enabled: true,
  backend: "endpoint",
  model: "bge-m3",
  endpoint: {
    kind: "openai",
    baseUrl: "https://api.example.com/v1",
    model: "text-embedding-3-small",
    dimensions: 1536,
    timeoutMs: 12_000,
  },
  weight: 0.4,
  candidateDepth: 25,
  chunkTarget: 128,
  chunkMax: 256,
  chunkOverlap: 16,
  maxChunksPerMessage: 512,
  threads: 4,
  gpu: "off",
  quantization: "int8",
  calibration: {
    fingerprint: "win32-x64-16-8",
    measuredAt: "2026-11-03T12:00:00.000Z",
    queryLatencyP50Ms: 1.7,
    queryLatencyP90Ms: 5.2,
    batchThroughputPerSec: 8800,
    gpuRole: "off",
    threads: 4,
    quantization: "int8",
  },
  keepSpaces: 3,
};

describe("the embedding settings defaults", () => {
  test("are the requirement's values", () => {
    expect(readEmbeddingSettings()).toEqual(EMBEDDING_SETTING_DEFAULTS);
    expect(EMBEDDING_SETTING_DEFAULTS).toMatchObject({
      enabled: false,
      backend: "builtin",
      model: "bge-small-zh-v1.5",
      weight: 0.5,
      candidateDepth: 50,
      chunkTarget: 200,
      chunkMax: 256,
      chunkOverlap: 32,
      maxChunksPerMessage: 1024,
      threads: 0,
      gpu: "auto",
      quantization: "float32",
      keepSpaces: 2,
    });
  });

  test("survive an unavailable settings manager", async () => {
    await settingsManager.reset();
    expect(readEmbeddingSettings()).toEqual(EMBEDDING_SETTING_DEFAULTS);
  });
});

describe("updateEmbeddingSettings", () => {
  test("persists every key under its stored name", () => {
    updateEmbeddingSettings(FULL_PATCH);
    for (const key of EMBEDDING_SETTING_KEYS) {
      expect(settingsManager.getSetting(key)).not.toBeUndefined();
    }
    expect(settingsManager.getSetting("recallEmbeddingEnabled")).toBe(true);
    expect(settingsManager.getSetting("recallEmbeddingChunkTarget")).toBe(128);
  });

  test("returns the settings as stored", () => {
    const stored = updateEmbeddingSettings(FULL_PATCH);
    expect(stored.enabled).toBe(true);
    expect(stored.backend).toBe("endpoint");
    expect(stored.endpoint).toEqual(FULL_PATCH.endpoint ?? null);
    expect(stored.chunkTarget).toBe(128);
    expect(stored.calibration?.fingerprint).toBe("win32-x64-16-8");
  });

  test("leaves keys outside the patch alone", () => {
    updateEmbeddingSettings({ weight: 0.3 });
    updateEmbeddingSettings({ gpu: "off" });
    expect(readEmbeddingSettings().weight).toBe(0.3);
    expect(readEmbeddingSettings().gpu).toBe("off");
    expect(readEmbeddingSettings().candidateDepth).toBe(
      EMBEDDING_SETTING_DEFAULTS.candidateDepth,
    );
  });

  test("does not touch feature ②'s recall keys", () => {
    settingsManager.updateSettings({ recallLimit: 250, recallEnabled: false });
    updateEmbeddingSettings({ enabled: true, weight: 0.6 });
    expect(settingsManager.getSetting("recallLimit")).toBe(250);
    expect(settingsManager.getSetting("recallEnabled")).toBe(false);
  });

  test("a null endpoint and calibration are real values", () => {
    updateEmbeddingSettings(FULL_PATCH);
    updateEmbeddingSettings({ endpoint: null, calibration: null });
    expect(readEmbeddingSettings().endpoint).toBeNull();
    expect(readEmbeddingSettings().calibration).toBeNull();
  });

  test("an unusable patch throws and writes nothing", () => {
    expect(() => updateEmbeddingSettings({ weight: 1.5 })).toThrow(
      EmbeddingSettingsError,
    );
    expect(settingsManager.getSetting("recallEmbeddingWeight")).toBeUndefined();
  });
});

describe("validation", () => {
  const invalid: ReadonlyArray<readonly [EmbeddingSettingsPatch, string]> = [
    [{ weight: 1.5 }, "weight must be between 0 and 1"],
    [{ weight: -0.1 }, "weight must be between 0 and 1"],
    [{ weight: Number.NaN }, "weight must be between 0 and 1"],
    [{ candidateDepth: 0 }, "candidate depth must be between 1 and 1000"],
    [{ threads: -1 }, "threads must be between 0 and 256"],
    [
      { maxChunksPerMessage: 5_000 },
      "max chunks per message must be between 1 and 1024",
    ],
    [{ keepSpaces: 0 }, "keep spaces must be between 1 and 16"],
    [{ chunkMax: 100 }, "chunk max must be at least the chunk target"],
    [
      { chunkOverlap: 200 },
      "chunk overlap must be smaller than the chunk target",
    ],
    [{ model: "" }, "needs a model id"],
    [{ model: "has space" }, "use letters, digits, '.', '_', ':', '/' or '-'"],
    [
      { gpu: "cuda" } as unknown as EmbeddingSettingsPatch,
      "gpu must be auto, off or index-only",
    ],
    [
      { backend: "remote" } as unknown as EmbeddingSettingsPatch,
      "backend must be builtin or endpoint",
    ],
    [
      { quantization: "int4" } as unknown as EmbeddingSettingsPatch,
      "quantization must be float32 or int8",
    ],
    [
      {
        endpoint: {
          kind: "openai",
          baseUrl: "http://example.com/v1",
          model: "m",
          dimensions: 1536,
        },
      },
      "plain http is only allowed for a loopback endpoint",
    ],
    [
      {
        endpoint: {
          kind: "openai",
          baseUrl: "https://user:pass@example.com/v1",
          model: "m",
          dimensions: 1536,
        },
      },
      "must not embed credentials; the API key is stored separately",
    ],
    [
      {
        endpoint: {
          kind: "openai",
          baseUrl: "https://example.com/v1",
          model: "m",
          dimensions: 0,
        },
      },
      "endpoint dimensions must be between 1 and 65536",
    ],
    [
      {
        calibration: {
          fingerprint: "",
          measuredAt: "2026-11-03T12:00:00.000Z",
          queryLatencyP50Ms: 1,
          queryLatencyP90Ms: 2,
          batchThroughputPerSec: 3,
          gpuRole: "auto",
          threads: 0,
          quantization: "float32",
        },
      },
      "calibration needs a fingerprint",
    ],
  ];

  for (const [patch, message] of invalid) {
    test(`refuses ${JSON.stringify(patch)}`, () => {
      expect(validateEmbeddingSettingsPatch(patch)).toBe(message);
    });
  }

  test("accepts a runnable chunk plan", () => {
    expect(
      validateEmbeddingSettingsPatch({ chunkTarget: 128, chunkMax: 256 }),
    ).toBeNull();
    expect(validateEmbeddingSettingsPatch({ chunkOverlap: 0 })).toBeNull();
  });

  test("accepts a loopback http endpoint", () => {
    expect(
      validateEmbeddingSettingsPatch({
        endpoint: {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "bge-m3",
          dimensions: 1024,
        },
      }),
    ).toBeNull();
  });
});

describe("previewEmbeddingSettings", () => {
  test("shows the next settings without writing them", () => {
    const preview = previewEmbeddingSettings({ weight: 0.9 });
    expect(preview.weight).toBe(0.9);
    expect(readEmbeddingSettings().weight).toBe(
      EMBEDDING_SETTING_DEFAULTS.weight,
    );
  });
});

describe("embeddingPatchInvalidatesSpace", () => {
  test("space-shaping keys invalidate, tuning keys do not", () => {
    for (const patch of [
      { backend: "endpoint" as const },
      { model: "bge-m3" },
      { quantization: "int8" as const },
      { chunkTarget: 128 },
      { chunkMax: 512 },
      { chunkOverlap: 8 },
    ] satisfies EmbeddingSettingsPatch[]) {
      expect(embeddingPatchInvalidatesSpace(patch)).toBe(true);
    }
    for (const patch of [
      { weight: 0.4 },
      { candidateDepth: 20 },
      { threads: 4 },
      { gpu: "off" as const },
      { keepSpaces: 3 },
      { maxChunksPerMessage: 512 },
      { enabled: true },
    ] satisfies EmbeddingSettingsPatch[]) {
      expect(embeddingPatchInvalidatesSpace(patch)).toBe(false);
    }
  });
});

describe("reading stored garbage", () => {
  test("falls back to defaults instead of publishing an impossible state", () => {
    settingsManager.updateSettings({
      recallEmbeddingWeight: 9,
      recallEmbeddingChunkTarget: 400,
      recallEmbeddingChunkMax: 100,
      recallEmbeddingGpu: "cuda",
      recallEmbeddingKeepSpaces: 0,
      recallEmbeddingEndpoint: { kind: "openai" },
    } as unknown as Partial<Settings>);
    const settings = readEmbeddingSettings();
    expect(settings.weight).toBe(EMBEDDING_SETTING_DEFAULTS.weight);
    expect(settings.chunkTarget).toBe(EMBEDDING_SETTING_DEFAULTS.chunkTarget);
    expect(settings.chunkMax).toBe(EMBEDDING_SETTING_DEFAULTS.chunkMax);
    expect(settings.gpu).toBe(EMBEDDING_SETTING_DEFAULTS.gpu);
    expect(settings.keepSpaces).toBe(EMBEDDING_SETTING_DEFAULTS.keepSpaces);
    expect(settings.endpoint).toBeNull();
  });
});
