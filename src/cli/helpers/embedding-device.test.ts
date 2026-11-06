import { describe, expect, test } from "bun:test";
import type { EmbeddingBuildEmbed } from "@/backend/local/embedding-build-embed";
import type { EmbeddingBuildDeviceSnapshot } from "@/backend/local/embedding-build-state";
import { runEmbeddingDeviceTest } from "@/cli/helpers/embedding-device";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";

const DEVICE: EmbeddingBuildDeviceSnapshot = {
  backend: "builtin",
  requested: ["cpu"],
  initialized: ["cpu"],
  gpu: false,
  degraded: false,
  threads: 2,
  warmupMs: 12,
  measuredAt: "2026-11-05T00:00:00.000Z",
};

const SETTINGS: ResolvedEmbeddingSettings = {
  ...EMBEDDING_SETTING_DEFAULTS,
  enabled: true,
};

function fakeEmbed(
  overrides: Partial<EmbeddingBuildEmbed> = {},
): EmbeddingBuildEmbed {
  return {
    embed: async (texts) => texts.map(() => new Float32Array([1, 2, 3])),
    dispose: async () => {},
    degradedReason: null,
    device: DEVICE,
    ...overrides,
  };
}

describe("device --test", () => {
  test("reports the accepted providers and one measured throughput line", async () => {
    const output = await runEmbeddingDeviceTest(SETTINGS, {
      createEmbed: async () => fakeEmbed(),
    });
    expect(output).toContain("Device test (read-only");
    expect(output).toContain("Providers: requested cpu · initialized cpu");
    expect(output).toContain("Throughput: 3/3 texts in");
  });

  test("an encode failure is reported instead of thrown", async () => {
    const output = await runEmbeddingDeviceTest(SETTINGS, {
      createEmbed: async () =>
        fakeEmbed({
          embed: async () => {
            throw new Error("worker went away");
          },
        }),
    });
    expect(output).toContain("Throughput: not measured (worker went away)");
  });

  test("an init failure keeps the actionable message", async () => {
    const output = await runEmbeddingDeviceTest(SETTINGS, {
      createEmbed: async () => {
        throw new Error("model missing");
      },
    });
    expect(output).toContain("Could not initialise");
    expect(output).toContain("model missing");
  });
});
