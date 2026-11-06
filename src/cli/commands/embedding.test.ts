/**
 * `/recall embedding` coverage (48-1 §7.1, 48-2 §4.9 D4).
 *
 * The parser and the effects are split the same way `/recall` and `/dream` split
 * them, so the accepted spellings, the refusals and the copy are asserted
 * without a runtime. The narrow `EmbeddingRuntimePort` is what lets status,
 * build, cancel and reset be tested with a fake while the real A2/A3/A4 data
 * stays an integration step.
 *
 * Two seams are checked against D3 rather than a stub: a real settings-manager
 * round trip proves the command writes only through `updateEmbeddingSettings`
 * (and surfaces its validator's message), and the completion table is swept
 * against the parser in both directions (G-2).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EmbeddingSettingsPatch,
  previewEmbeddingSettings,
  updateEmbeddingSettings,
} from "@/cli/app/pages/settings/embedding-settings";
import {
  applyEmbeddingCliFlags,
  EMBEDDING_COMMAND_USAGE,
  type EmbeddingCommandDeps,
  type EmbeddingRuntimePort,
  type EmbeddingRuntimeStatus,
  formatEmbeddingFirstRunHint,
  handleEmbeddingCommand,
  isEmbeddingConfigured,
  parseEmbeddingCommand,
} from "@/cli/commands/embedding";
import { EMBEDDING_CONFIG_KEYS } from "@/cli/commands/embedding-command-parser";
import { handleRecallCommand, parseRecallCommand } from "@/cli/commands/recall";
import { RECALL_CONFIG_KEYS } from "@/cli/commands/recall-config-keys";
import {
  EMBEDDING_COMMAND_SPECS,
  RECALL_COMMAND_SPECS,
  type SubcommandSpecRow,
  walkSubcommandSpecs,
} from "@/cli/commands/subcommand-specs";
import { resolveCommandCompletion } from "@/cli/helpers/command-completion";
import { embeddingSetCommand } from "@/cli/helpers/settings-deep-link";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import { settingsManager } from "@/settings-manager";

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

/** Injected deps with a recording writer; the real D3 writer is tested below. */
function harness(
  overrides: Partial<EmbeddingCommandDeps> = {},
  start: ResolvedEmbeddingSettings = EMBEDDING_SETTING_DEFAULTS,
): Harness {
  let settings = { ...start };
  const writes: EmbeddingSettingsPatch[] = [];
  const deps: EmbeddingCommandDeps = {
    readSettings: () => settings,
    writeSettings: (patch) => {
      writes.push(patch);
      settings = previewEmbeddingSettings(patch, settings);
      return settings;
    },
    readRawSettings: () => CONFIGURED_RAW,
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

function fakeRuntime(
  overrides: Partial<EmbeddingRuntimePort> = {},
): EmbeddingRuntimePort {
  return {
    readStatus: async () => runtimeStatus(),
    build: async () => "Build started (full).",
    cancel: async () => "Build cancelled.",
    reset: async () => "Deleted 1 vector space.",
    ...overrides,
  };
}

// ── Parser ──────────────────────────────────────────────────────────

describe("parsing /recall embedding", () => {
  test("a bare invocation asks for status; help prints the usage", () => {
    expect(parseEmbeddingCommand([])).toEqual({ kind: "status" });
    for (const args of [["help"], ["--help"], ["-h"]]) {
      expect(parseEmbeddingCommand(args)).toEqual({ kind: "usage" });
    }
  });

  test("accepts every documented entrance", () => {
    expect(parseEmbeddingCommand(["status"])).toEqual({ kind: "status" });
    expect(parseEmbeddingCommand(["on"])).toEqual({ kind: "on" });
    expect(parseEmbeddingCommand(["off"])).toEqual({ kind: "off" });
    expect(parseEmbeddingCommand(["connect"])).toEqual({ kind: "connect" });
    expect(parseEmbeddingCommand(["model"])).toEqual({
      kind: "model",
      action: "list",
      json: false,
      confirmed: false,
    });
    expect(parseEmbeddingCommand(["build"])).toEqual({
      kind: "build",
      mode: "incremental",
      keepAfterExit: false,
      cancel: false,
    });
    expect(parseEmbeddingCommand(["build", "--full"])).toEqual({
      kind: "build",
      mode: "full",
      keepAfterExit: false,
      cancel: false,
    });
    expect(
      parseEmbeddingCommand(["build", "--keep-after-exit", "--full"]),
    ).toEqual({
      kind: "build",
      mode: "full",
      keepAfterExit: true,
      cancel: false,
    });
    expect(parseEmbeddingCommand(["build", "--cancel"])).toEqual({
      kind: "build",
      mode: "incremental",
      keepAfterExit: false,
      cancel: true,
    });
  });

  test("model takes select/delete/pin/unpin plus --confirm and --json", () => {
    expect(parseEmbeddingCommand(["model", "--select", "2"])).toEqual({
      kind: "model",
      action: "select",
      index: 2,
      json: false,
      confirmed: false,
    });
    expect(
      parseEmbeddingCommand(["model", "--delete", "3", "--confirm"]),
    ).toEqual({
      kind: "model",
      action: "delete",
      index: 3,
      json: false,
      confirmed: true,
    });
    expect(parseEmbeddingCommand(["model", "--pin", "1"])).toMatchObject({
      action: "pin",
      index: 1,
    });
    expect(parseEmbeddingCommand(["model", "--json"])).toMatchObject({
      action: "list",
      json: true,
    });
  });

  test("config carries the six build keys and gpu accepts auto/off", () => {
    expect(parseEmbeddingCommand(["config"])).toEqual({ kind: "config" });
    expect(parseEmbeddingCommand(["config", "threads"])).toEqual({
      kind: "config",
      key: "threads",
    });
    expect(
      parseEmbeddingCommand(["config", "chunk-target", "200"]),
    ).toMatchObject({ updates: { chunkTarget: 200 } });
    expect(parseEmbeddingCommand(["config", "chunk-max", "256"])).toMatchObject(
      {
        updates: { chunkMax: 256 },
      },
    );
    expect(
      parseEmbeddingCommand(["config", "chunk-overlap", "32"]),
    ).toMatchObject({ updates: { chunkOverlap: 32 } });
    expect(
      parseEmbeddingCommand(["config", "max-chunks", "512"]),
    ).toMatchObject({ updates: { maxChunksPerMessage: 512 } });
    expect(parseEmbeddingCommand(["config", "threads", "4"])).toMatchObject({
      updates: { threads: 4 },
    });
    expect(parseEmbeddingCommand(["config", "gpu", "off"])).toMatchObject({
      updates: { gpu: "off" },
    });
  });

  test("device takes at most --test", () => {
    expect(parseEmbeddingCommand(["device"])).toEqual({
      kind: "device",
      test: false,
    });
    expect(parseEmbeddingCommand(["device", "--test"])).toEqual({
      kind: "device",
      test: true,
    });
  });

  test("refuses a value it cannot use instead of guessing", () => {
    const refusals: string[][] = [
      ["nonsense"],
      ["status", "extra"],
      ["on", "extra"],
      ["off", "extra"],
      ["connect", "extra"],
      ["build", "--incremental"],
      ["build", "--full", "extra"],
      ["build", "--cancel", "--full"],
      ["model", "--select"],
      ["model", "--select", "0"],
      ["model", "--delete", "2", "--select", "1"],
      ["model", "--nonsense"],
      ["config", "nonsense"],
      ["config", "nonsense", "1"],
      ["config", "threads", "many"],
      ["config", "gpu", "index-only"],
      ["config", "chunk-target", "1.5"],
      ["device", "--everything"],
      ["help", "extra"],
    ];
    for (const args of refusals) {
      expect({ args, kind: parseEmbeddingCommand(args).kind }).toEqual({
        args,
        kind: "error",
      });
    }
  });

  test("the usage text names every entrance and config key", () => {
    for (const word of [
      "status",
      "on",
      "off",
      "connect",
      "model",
      "build",
      "config",
      "device",
      "chunk-target",
      "chunk-max",
      "chunk-overlap",
      "max-chunks",
      "threads",
      "gpu",
    ]) {
      expect(EMBEDDING_COMMAND_USAGE).toContain(word);
    }
  });
});

// ── Handler ─────────────────────────────────────────────────────────

describe("the /recall embedding handler", () => {
  test("first enable without a setup choice writes nothing and prints the commands", async () => {
    const h = harness({ readRawSettings: () => ({}) });
    const output = await handleEmbeddingCommand(["on"], SCOPE, h.deps);
    expect(output).toContain("not configured yet");
    expect(output).toContain("--recall-embedding-backend builtin");
    expect(output).toContain("--recall-embedding-api-key-env");
    expect(h.writes).toHaveLength(0);
  });

  test("first enable with a wizard drops into connect instead of writing", async () => {
    const opened: string[] = [];
    const h = harness({
      readRawSettings: () => ({}),
      openSetup: (input) => {
        opened.push(input);
        return true;
      },
    });
    const output = await handleEmbeddingCommand(["on"], SCOPE, h.deps);
    expect(output).toContain("Opening the embedding connect wizard");
    expect(opened).toEqual(["/recall embedding connect"]);
    expect(h.writes).toHaveLength(0);
  });

  test("a configured agent is enabled, and off writes the other value", async () => {
    const h = harness();
    const on = await handleEmbeddingCommand(["on"], SCOPE, h.deps);
    expect(on).toContain("Vector recall is on.");
    expect(h.writes).toEqual([{ enabled: true }]);
    expect(h.settings().enabled).toBe(true);

    const off = await handleEmbeddingCommand(["off"], SCOPE, h.deps);
    expect(off).toContain("Vector recall is off.");
    expect(off).toContain("/recall embedding model");
    expect(h.settings().enabled).toBe(false);
  });

  test("status reports settings when no runtime is wired", async () => {
    const start: ResolvedEmbeddingSettings = {
      ...EMBEDDING_SETTING_DEFAULTS,
      enabled: true,
    };
    const h = harness({}, start);
    const output = await handleEmbeddingCommand(["status"], SCOPE, h.deps);
    expect(output).toContain("Vector recall: on");
    expect(output).toContain("Backend: builtin · bge-small-zh-v1.5");
    expect(output).toContain("Weight: 0.5");
    expect(output).toContain("Chunks: target 200 / max 256 / overlap 32");
    expect(output).toContain("not available in this process");
  });

  test("status paints the runtime snapshot, and flags egress for an endpoint", async () => {
    const start: ResolvedEmbeddingSettings = {
      ...EMBEDDING_SETTING_DEFAULTS,
      enabled: true,
      backend: "endpoint",
      endpoint: {
        kind: "openai",
        baseUrl: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        dimensions: 1_024,
      },
    };
    const h = harness(
      {
        runtime: fakeRuntime({
          readStatus: async () =>
            runtimeStatus({
              egress: true,
              build: {
                state: "running",
                progress: 0.34,
                processedChunks: 1_200,
                totalChunks: 3_600,
                etaMs: 480_000,
              },
              calibration: {
                measuredAt: "2026-11-03T09:00:00Z",
                queryLatencyP50Ms: 2,
                queryLatencyP90Ms: 6,
                throughputPerSecond: 12_600,
                gpuRole: "off",
                threads: 8,
                quantization: "float32",
              },
            }),
        }),
      },
      start,
    );
    const output = await handleEmbeddingCommand(["status"], SCOPE, h.deps);
    expect(output).toContain("query text leaves this machine");
    expect(output).toContain("Space: bge-small-zh-v1.5 · 512d · 1200 chunks");
    expect(output).toContain("Build: running 34% (1200/3600 chunks");
    expect(output).toContain("Calibration:");
    expect(output).toContain("Ready: yes");
    // The key is a reference, never part of any status line.
    expect(output).not.toContain("apiKey");
  });

  test("status never paints a defaults-based calibration as zero latency", async () => {
    const h = harness({
      runtime: fakeRuntime({
        readStatus: async () =>
          runtimeStatus({
            calibration: {
              measuredAt: "2026-11-04T09:00:00Z",
              queryLatencyP50Ms: 0,
              queryLatencyP90Ms: 0,
              throughputPerSecond: 0,
              gpuRole: "auto",
              threads: 0,
              quantization: "float32",
            },
          }),
      }),
    });
    const output = await handleEmbeddingCommand(["status"], SCOPE, h.deps);
    expect(output).toContain("Calibration: not measured");
    expect(output).not.toContain("p50 0ms");
    expect(output).not.toContain("0/s");
  });

  test("status counts conversations and memory files separately", async () => {
    const h = harness({
      runtime: fakeRuntime({
        readStatus: async () =>
          runtimeStatus({
            space: {
              model: "bge-small-zh-v1.5",
              dimensions: 512,
              chunks: 1_200,
              conversations: 12,
              memoryFiles: 3,
              coverage: 0.92,
              builtAt: "2026-11-03T10:00:00Z",
            },
          }),
      }),
    });
    const output = await handleEmbeddingCommand(["status"], SCOPE, h.deps);
    expect(output).toContain("12 conversations · 3 memory files");
    // The memory units are not conversations; the total must not be folded in.
    expect(output).not.toContain("15 conversations");
  });

  test("status without an agent names how to scope the runtime read", async () => {
    const h = harness({ runtime: fakeRuntime() });
    const output = await handleEmbeddingCommand(
      ["status"],
      { agentId: "", conversationId: null },
      h.deps,
    );
    expect(output).toContain("--agent <id>");
  });

  test("build passes --full through and names a missing runtime", async () => {
    const modes: string[] = [];
    const h = harness({
      runtime: fakeRuntime({
        build: async (_scope, mode) => {
          modes.push(mode);
          return "Build started (full).";
        },
      }),
    });
    const output = await handleEmbeddingCommand(
      ["build", "--full"],
      SCOPE,
      h.deps,
    );
    expect(modes).toEqual(["full"]);
    expect(output).toContain("Build started (full).");

    const noRuntime = harness();
    const refused = await handleEmbeddingCommand(
      ["build"],
      SCOPE,
      noRuntime.deps,
    );
    expect(refused).toContain("background runner");
  });

  test("build flags that recall is off, without refusing the work", async () => {
    const h = harness({ runtime: fakeRuntime() });
    const output = await handleEmbeddingCommand(["build"], SCOPE, h.deps);
    expect(output).toContain("Build started (full).");
    expect(output).toContain("vector recall is off");
  });

  test("build --cancel requires a runtime and an agent", async () => {
    const h = harness({ runtime: fakeRuntime() });
    expect(
      await handleEmbeddingCommand(["build", "--cancel"], SCOPE, h.deps),
    ).toContain("Build cancelled.");

    const noRuntime = harness();
    expect(
      await handleEmbeddingCommand(
        ["build", "--cancel"],
        SCOPE,
        noRuntime.deps,
      ),
    ).toContain("nothing to cancel");
    expect(
      await handleEmbeddingCommand(
        ["build", "--cancel"],
        undefined,
        noRuntime.deps,
      ),
    ).toContain("needs an active agent");
  });

  test("config prints the six build keys and one key on request", async () => {
    const h = harness();
    const table = await handleEmbeddingCommand(["config"], SCOPE, h.deps);
    expect(table).toContain("Embedding config");
    for (const key of [
      "chunk-target",
      "chunk-max",
      "chunk-overlap",
      "max-chunks",
      "threads",
      "gpu",
    ]) {
      expect(table).toContain(key);
    }
    const one = await handleEmbeddingCommand(["config", "gpu"], SCOPE, h.deps);
    expect(one).toContain("gpu:");
  });

  test("a config write asks for a rebuild when the space moves", async () => {
    const h = harness();
    const threads = await handleEmbeddingCommand(
      ["config", "threads", "4"],
      SCOPE,
      h.deps,
    );
    expect(threads).toContain("Updated threads.");
    expect(h.writes).toEqual([{ threads: 4 }]);
    expect(threads).not.toContain("changes the vector space");

    const chunk = await handleEmbeddingCommand(
      ["config", "chunk-target", "100"],
      SCOPE,
      h.deps,
    );
    expect(chunk).toContain("changes the vector space");
    expect(chunk).toContain("build --full");
  });

  test("connect opens the wizard, or prints the commands when there is none", async () => {
    const h = harness({ openSetup: () => true });
    expect(await handleEmbeddingCommand(["connect"], SCOPE, h.deps)).toContain(
      "Opening the embedding connect wizard",
    );

    const headless = harness();
    expect(
      await handleEmbeddingCommand(["connect"], SCOPE, headless.deps),
    ).toBe(formatEmbeddingFirstRunHint());
  });

  test("a bad argument comes back with the usage", async () => {
    const h = harness();
    const output = await handleEmbeddingCommand(["wander"], SCOPE, h.deps);
    expect(output).toContain("Unknown embedding command: wander");
    expect(output.endsWith(EMBEDDING_COMMAND_USAGE)).toBe(true);
  });

  test("handleRecallCommand routes the embedding branch before the backend gate", async () => {
    const h = harness();
    const output = await handleRecallCommand(["embedding", "status"], SCOPE, {
      embedding: h.deps,
    });
    expect(output).toContain("Vector recall:");

    expect(parseRecallCommand(["embedding", "on"])).toEqual({
      kind: "embedding",
      args: ["on"],
    });
  });
});

// ── The real settings writer (D3 alignment) ─────────────────────────

describe("the command writes through the D3 settings writer", () => {
  const originalHome = process.env.HOME;
  const originalHaruyukiHome = process.env.HARUYUKI_HOME;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), "haru-embedding-command-"));
    process.env.HOME = testHome;
    process.env.HARUYUKI_HOME = join(testHome, "haruyuki");
    await settingsManager.reset();
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
    else process.env.HARUYUKI_HOME = originalHaruyukiHome;
  });

  test("a diagnostic value is persisted and read back by the resolver", async () => {
    const output = await handleEmbeddingCommand(["config", "threads", "3"]);
    expect(output).toContain("Updated threads.");
    expect(readEmbeddingSettings().threads).toBe(3);
  });

  test("the writer's refusal is surfaced verbatim and writes nothing", async () => {
    // The value parses (a whole number) but is outside the writer's range, so
    // the refusal has to come from D3 rather than a second range copy here.
    const output = await handleEmbeddingCommand([
      "config",
      "chunk-target",
      "0",
    ]);
    expect(output).toBe("Not saved: chunk target must be between 1 and 4096");
    expect(readEmbeddingSettings().chunkTarget).toBe(
      EMBEDDING_SETTING_DEFAULTS.chunkTarget,
    );
  });

  test("cross-field validation comes from the one writer, not a copy here", async () => {
    const output = await handleEmbeddingCommand([
      "config",
      "chunk-target",
      "300",
    ]);
    expect(output).toBe(
      "Not saved: chunk max must be at least the chunk target",
    );
    expect(readEmbeddingSettings().chunkTarget).toBe(
      EMBEDDING_SETTING_DEFAULTS.chunkTarget,
    );
  });

  test("on is gated on an explicitly chosen backend", async () => {
    const refused = await handleEmbeddingCommand(["on"]);
    expect(refused).toContain("not configured yet");
    expect(readEmbeddingSettings().enabled).toBe(false);

    updateEmbeddingSettings({ backend: "builtin", model: "bge-small-zh-v1.5" });
    const enabled = await handleEmbeddingCommand(["on"]);
    expect(enabled).toContain("Vector recall is on.");
    expect(readEmbeddingSettings().enabled).toBe(true);
  });

  test("isEmbeddingConfigured reads keys, not resolved defaults", () => {
    expect(isEmbeddingConfigured(() => ({}))).toBe(false);
    expect(isEmbeddingConfigured(() => CONFIGURED_RAW)).toBe(true);
    expect(
      isEmbeddingConfigured(() => ({
        recallEmbeddingEndpoint: {
          kind: "openai",
          baseUrl: "https://api.example.com/v1",
          model: "m",
          dimensions: 8,
        },
      })),
    ).toBe(true);
    expect(
      isEmbeddingConfigured(() => {
        throw new Error("settings not loaded");
      }),
    ).toBe(false);
  });

  test("every D3 settings fallback names a word this command implements", () => {
    // D3's deep-link table prints `/recall embedding <knob> <value>` for the
    // settings rows (48-3 §4: "回退命令表待 D4 对齐"). A word it prints that the
    // parser does not accept would teach a command that fails.
    const words = new Set<string>(
      EMBEDDING_COMMAND_SPECS.map((spec) => spec.name),
    );
    const fallbackItems = [
      "recallEmbeddingEnabled",
      "recallEmbeddingBackend",
      "recallEmbeddingModel",
      "recallEmbeddingEndpoint",
      "recallEmbeddingApiKey",
      "recallEmbeddingWeight",
      "recallEmbeddingCandidateDepth",
      "recallEmbeddingChunkTarget",
      "recallEmbeddingChunkMax",
      "recallEmbeddingChunkOverlap",
      "recallEmbeddingMaxChunksPerMessage",
      "recallEmbeddingThreads",
      "recallEmbeddingGpu",
      "recallEmbeddingQuantization",
      "recallEmbeddingKeepSpaces",
    ];
    for (const item of fallbackItems) {
      const command = embeddingSetCommand(item, "legacy");
      const inRecallConfig = command.startsWith("/recall config ");
      const prefix = inRecallConfig ? "/recall config " : "/recall embedding ";
      expect({ item, command }).toMatchObject({
        item,
        command: expect.stringMatching(
          inRecallConfig ? /^\/recall config / : /^\/recall embedding /,
        ),
      });
      const word = command.slice(prefix.length).split(/[ |]/)[0] ?? "";
      if (inRecallConfig) {
        // 48-4 D-05 moved the fusion knobs to `/recall config`.
        expect({
          item,
          word,
          allowed: ["weight", "depth"].includes(word),
        }).toEqual({
          item,
          word,
          allowed: true,
        });
        continue;
      }
      if (word === "on" || word === "off") continue;
      expect({ item, word, offered: words.has(word) }).toEqual({
        item,
        word,
        offered: true,
      });
    }
    // The group fallback with no item is the bare status spelling.
    expect(embeddingSetCommand(undefined, "headless")).toBe(
      "haruyuki recall embedding status",
    );
  });
});

// ── Non-interactive flags ───────────────────────────────────────────

describe("applying --recall-embedding* flags", () => {
  test("no flag means no work and no output", async () => {
    const h = harness();
    expect(await applyEmbeddingCliFlags({}, SCOPE, h.deps)).toBe("");
    expect(h.writes).toHaveLength(0);
  });

  test("a builtin first run writes the patch and explains the next step", async () => {
    const h = harness();
    const output = await applyEmbeddingCliFlags(
      { enabled: true, backend: "builtin", model: "bge-small-zh-v1.5" },
      SCOPE,
      h.deps,
    );
    expect(output).toContain("Embedding settings saved.");
    expect(h.writes).toEqual([
      {
        enabled: true,
        backend: "builtin",
        model: "bge-small-zh-v1.5",
      },
    ]);
  });

  test("enabling with no backend choice prints the copyable commands", async () => {
    const h = harness({ readRawSettings: () => ({}) });
    const output = await applyEmbeddingCliFlags(
      { enabled: true },
      SCOPE,
      h.deps,
    );
    expect(output).toContain("not configured yet");
    expect(h.writes).toHaveLength(0);
  });

  test("an endpoint without a probe writes nothing and says so", async () => {
    const h = harness();
    const output = await applyEmbeddingCliFlags(
      {
        enabled: true,
        backend: "endpoint",
        endpoint: "https://api.example.com/v1",
        apiKeyEnv: "MY_EMBEDDING_KEY",
      },
      SCOPE,
      h.deps,
    );
    expect(output).toContain("Nothing was written");
    expect(h.writes).toHaveLength(0);
  });

  test("an endpoint probe writes the resolved form and stores the key separately", async () => {
    const probeInputs: Array<Record<string, unknown>> = [];
    const savedKeys: Array<[string, string | null]> = [];
    const h = harness({
      env: { MY_EMBEDDING_KEY: "sk-test-value" },
      saveApiKey: async (value, agentId) => {
        savedKeys.push([value, agentId]);
      },
      runtime: fakeRuntime({
        configureEndpoint: async (input) => {
          probeInputs.push({ ...input });
          return {
            kind: "openai",
            model: "text-embedding-3-small",
            dimensions: 1_024,
            timeoutMs: 5_000,
          };
        },
      }),
    });

    const output = await applyEmbeddingCliFlags(
      {
        enabled: true,
        backend: "endpoint",
        endpoint: "https://api.example.com/v1",
        apiKeyEnv: "MY_EMBEDDING_KEY",
      },
      SCOPE,
      h.deps,
    );

    expect(probeInputs).toEqual([
      {
        agentId: SCOPE.agentId,
        baseUrl: "https://api.example.com/v1",
        model: null,
        apiKey: "sk-test-value",
      },
    ]);
    expect(savedKeys).toEqual([["sk-test-value", SCOPE.agentId]]);
    expect(h.writes).toEqual([
      {
        enabled: true,
        backend: "endpoint",
        endpoint: {
          kind: "openai",
          baseUrl: "https://api.example.com/v1",
          model: "text-embedding-3-small",
          dimensions: 1_024,
          timeoutMs: 5_000,
        },
      },
    ]);
    // The receipt names the model space, never the credential.
    expect(output).toContain("Embedding settings saved.");
    expect(output).not.toContain("sk-test-value");
  });

  test("an empty key variable is refused before the probe or the write", async () => {
    let probed = false;
    const h = harness({
      env: { MY_EMBEDDING_KEY: "  " },
      runtime: fakeRuntime({
        configureEndpoint: async () => {
          probed = true;
          return { kind: "openai", dimensions: 8 };
        },
      }),
    });
    const output = await applyEmbeddingCliFlags(
      {
        enabled: true,
        backend: "endpoint",
        endpoint: "https://api.example.com/v1",
        apiKeyEnv: "MY_EMBEDDING_KEY",
      },
      SCOPE,
      h.deps,
    );
    expect(output).toContain("MY_EMBEDDING_KEY is empty");
    expect(probed).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  test("endpoint backend without an endpoint is refused before writing", async () => {
    const h = harness();
    const output = await applyEmbeddingCliFlags(
      { enabled: true, backend: "endpoint" },
      SCOPE,
      h.deps,
    );
    expect(output).toContain("needs an endpoint");
    expect(h.writes).toHaveLength(0);
  });

  test("the writer's refusal reaches the operator", async () => {
    const h = harness({
      writeSettings: () => {
        throw new Error("settings manager is not initialized");
      },
    });
    await expect(
      applyEmbeddingCliFlags(
        { enabled: true, backend: "builtin", model: "m" },
        SCOPE,
        h.deps,
      ),
    ).rejects.toThrow("settings manager is not initialized");
  });
});

// ── Completion (O-04 full table, G-2 drift) ─────────────────────────

const LEVEL_ONE = [{ cmd: "/recall", desc: "Configure passive recall" }];

function completionLabels(input: string): string[] {
  return resolveCommandCompletion(input, LEVEL_ONE).candidates.map(
    (candidate) => candidate.label,
  );
}

function fillerFor(row: SubcommandSpecRow): string[] {
  if (row.path.length === 1 && row.path[0] === "embedding") return [];
  if (row.path[0] === "embedding") {
    switch (row.spec.name) {
      case "build":
      case "connect":
      case "device":
      case "off":
      case "on":
      case "status":
        return [];
      case "model":
        return ["--json"];
      case "config":
        return [];
      default:
        return [];
    }
  }
  switch (row.spec.name) {
    case "now":
      return ["ledger"];
    case "config":
      return [];
    default:
      return [];
  }
}

describe("/recall completion", () => {
  test("the whole table is offered at level 2", () => {
    expect(completionLabels("/recall ")).toEqual(
      RECALL_COMMAND_SPECS.map((spec) => spec.name),
    );
    expect(RECALL_COMMAND_SPECS).toHaveLength(7);
  });

  test("embedding offers its second level", () => {
    expect(completionLabels("/recall emb")).toEqual(["embedding"]);
    expect(completionLabels("/recall embedding ")).toEqual(
      EMBEDDING_COMMAND_SPECS.map((spec) => spec.name),
    );
    expect(EMBEDDING_COMMAND_SPECS).toHaveLength(8);
  });

  test("prefixes still narrow the entrances and the config keys", () => {
    expect(completionLabels("/recall embedding o")).toEqual(["on", "off"]);
    expect(completionLabels("/recall embedding conn")).toEqual(["connect"]);
    // 48-4 D-05/D-16: the one level under `config` is the key list, read from
    // the parsers' own vocabulary rather than a second table.
    expect(completionLabels("/recall config ")).toEqual([
      ...RECALL_CONFIG_KEYS,
    ]);
    expect(completionLabels("/recall embedding config ")).toEqual([
      ...EMBEDDING_CONFIG_KEYS,
    ]);
    expect(completionLabels("/recall config de")).toEqual(["dedup", "depth"]);
  });

  test("every row the popup offers is accepted by the parser (G-2)", () => {
    for (const row of walkSubcommandSpecs(RECALL_COMMAND_SPECS)) {
      const filler = fillerFor(row);
      const parsed =
        row.path[0] === "embedding"
          ? parseEmbeddingCommand([...row.path.slice(1), ...filler])
          : parseRecallCommand([...row.path, ...filler]);
      expect({ row: row.path.join(" "), kind: parsed.kind }).not.toMatchObject({
        kind: "error",
      });
    }
  });

  test("the build row advertises every flag its parser accepts", () => {
    // The row's `args` string is the only hint a user sees before typing, so a
    // flag the parser accepts but the row omits is a silent drift.
    const build = EMBEDDING_COMMAND_SPECS.find((row) => row.name === "build");
    expect(build?.args).toContain("--full");
    expect(build?.args).toContain("--keep-after-exit");
    expect(build?.args).toContain("--cancel");
    expect(
      parseEmbeddingCommand(["build", "--full", "--keep-after-exit"]),
    ).toEqual({
      kind: "build",
      mode: "full",
      keepAfterExit: true,
      cancel: false,
    });
  });
});
