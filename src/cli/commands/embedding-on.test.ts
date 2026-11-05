/**
 * Turning vector recall on (48-1 §6.10, R-26).
 *
 * `on` used to write the flag and stop, leaving a stale index to a user who had
 * no reason to know it was behind. These cases pin the catch-up contract: a
 * measured gap starts one incremental build in the background, a running build
 * is not duplicated, an aligned index starts nothing, and the CLI subcommand
 * (headless) still does not start long work from a flag write.
 *
 * A separate file from `embedding.test.ts` because that one is at its size
 * ceiling; the harness here is the same recording writer.
 */
import { describe, expect, test } from "bun:test";
import {
  type EmbeddingSettingsPatch,
  previewEmbeddingSettings,
} from "@/cli/app/pages/settings/embedding-settings";
import {
  type EmbeddingCommandDeps,
  type EmbeddingRuntimeStatus,
  handleEmbeddingCommand,
} from "@/cli/commands/embedding";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";

const SCOPE = { agentId: "agent-embedding", conversationId: "conv-1" };

/** A stored record with an explicitly chosen backend (the "configured" state). */
const CONFIGURED_RAW = {
  recallEmbeddingBackend: "builtin",
  recallEmbeddingModel: "bge-small-zh-v1.5",
};

interface Harness {
  deps: EmbeddingCommandDeps;
  writes: EmbeddingSettingsPatch[];
  settings: () => ResolvedEmbeddingSettings;
}

function harness(overrides: Partial<EmbeddingCommandDeps> = {}): Harness {
  let settings = { ...EMBEDDING_SETTING_DEFAULTS };
  const writes: EmbeddingSettingsPatch[] = [];
  const deps: EmbeddingCommandDeps = {
    readSettings: () => settings,
    writeSettings: (patch) => {
      writes.push(patch);
      settings = previewEmbeddingSettings(patch, settings);
      return settings;
    },
    readRawSettings: () => CONFIGURED_RAW,
    readMetrics: () => null,
    ...overrides,
  };
  return { deps, writes, settings: () => settings };
}

function runtimeStatus(
  overrides: Partial<EmbeddingRuntimeStatus> = {},
): EmbeddingRuntimeStatus {
  return {
    ready: true,
    space: {
      model: "bge-small-zh-v1.5",
      dimensions: 512,
      chunks: 1_200,
      conversations: 12,
      coverage: 0.92,
      builtAt: "2026-11-03T10:00:00Z",
    },
    build: null,
    calibration: null,
    egress: false,
    failure: null,
    ...overrides,
  };
}

describe("/recall embedding on catches the index up", () => {
  test("starts an incremental build when the index is behind", async () => {
    const calls: Array<{ mode: string; lifecycle?: string }> = [];
    const h = harness({
      lifecycle: "tui",
      runtime: {
        readStatus: async () =>
          runtimeStatus({
            space: {
              model: "bge-small-zh-v1.5",
              dimensions: 512,
              chunks: 1_200,
              conversations: 12,
              coverage: 0.8,
              builtAt: null,
            },
          }),
        build: async (_scope, mode, options) => {
          calls.push({
            mode,
            ...(options?.lifecycle === undefined
              ? {}
              : { lifecycle: options.lifecycle }),
          });
          return "Build started (incremental).";
        },
      },
    });
    const output = await handleEmbeddingCommand(["on"], SCOPE, h.deps);
    expect(output).toContain("Vector recall is on.");
    expect(output).toContain("Build started (incremental).");
    expect(calls).toEqual([{ mode: "incremental", lifecycle: "tui" }]);
  });

  test("does not duplicate a running build or rebuild an aligned index", async () => {
    const calls: string[] = [];
    const running = harness({
      lifecycle: "tui",
      runtime: {
        readStatus: async () =>
          runtimeStatus({
            build: {
              state: "running",
              progress: 0.3,
              processedChunks: 300,
              totalChunks: 1_000,
              etaMs: 60_000,
            },
          }),
        build: async () => {
          calls.push("build");
          return "unexpected";
        },
      },
    });
    expect(await handleEmbeddingCommand(["on"], SCOPE, running.deps)).toContain(
      "already being built",
    );

    const aligned = harness({
      lifecycle: "tui",
      runtime: {
        readStatus: async () =>
          runtimeStatus({
            space: {
              model: "bge-small-zh-v1.5",
              dimensions: 512,
              chunks: 1_200,
              conversations: 12,
              coverage: 1,
              builtAt: null,
            },
          }),
        build: async () => {
          calls.push("build");
          return "unexpected";
        },
      },
    });
    await handleEmbeddingCommand(["on"], SCOPE, aligned.deps);
    expect(calls).toEqual([]);
  });

  test("the CLI (headless) enables without starting long work", async () => {
    let built = 0;
    const h = harness({
      lifecycle: "headless",
      runtime: {
        readStatus: async () => runtimeStatus(),
        build: async () => {
          built += 1;
          return "unexpected";
        },
      },
    });
    const output = await handleEmbeddingCommand(["on"], SCOPE, h.deps);
    expect(output).toContain("Vector recall is on.");
    expect(built).toBe(0);
  });
});
