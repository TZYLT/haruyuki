/**
 * The TUI submit seam for `/recall embedding …` (48-2 §3.4 D6).
 *
 * The helper is what the pinned submit handler calls, so this file pins the two
 * things the handler cannot: the argument split (`/recall embedding   reset
 * --all` must mean `["reset", "--all"]`) and the receipt lifecycle (one
 * `start`, then exactly one `finish` or `fail`).
 */
import { describe, expect, test } from "bun:test";
import { previewEmbeddingSettings } from "@/cli/app/pages/settings/embedding-settings";
import type { EmbeddingCommandDeps } from "@/cli/commands/embedding";
import {
  type EmbeddingSubmitRunner,
  embeddingSubmitArgs,
  runEmbeddingSubmitCommand,
} from "@/cli/commands/embedding-submit";
import { resetUiV2Resolution } from "@/experiments/ui-v2";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";

const SCOPE = { agentId: "agent-embedding", conversationId: "conv-1" };
const CONFIGURED_RAW = { recallEmbeddingBackend: "builtin" };

interface FakeRunner extends EmbeddingSubmitRunner {
  started: string[];
  outputs: Array<{ output: string; success: boolean | undefined }>;
  failures: string[];
}

function fakeRunner(): FakeRunner {
  const started: string[] = [];
  const outputs: Array<{ output: string; success: boolean | undefined }> = [];
  const failures: string[] = [];
  return {
    started,
    outputs,
    failures,
    start(input) {
      started.push(input);
      return {
        finish(output, success) {
          outputs.push({ output, success });
        },
        fail(output) {
          failures.push(output);
        },
      };
    },
  };
}

function deps(
  overrides: Partial<EmbeddingCommandDeps> = {},
  start: ResolvedEmbeddingSettings = EMBEDDING_SETTING_DEFAULTS,
): EmbeddingCommandDeps {
  let settings = { ...start };
  return {
    readSettings: () => settings,
    writeSettings: (patch) => {
      settings = previewEmbeddingSettings(patch, settings);
      return settings;
    },
    readRawSettings: () => CONFIGURED_RAW,
    ...overrides,
  };
}

describe("embeddingSubmitArgs", () => {
  test("strips the command, collapses spaces and keeps flags", () => {
    expect(embeddingSubmitArgs("/recall embedding")).toEqual([]);
    expect(embeddingSubmitArgs("/recall embedding status")).toEqual(["status"]);
    expect(embeddingSubmitArgs("/recall embedding   reset  --all")).toEqual([
      "reset",
      "--all",
    ]);
    expect(embeddingSubmitArgs("/recall embedding build --full")).toEqual([
      "build",
      "--full",
    ]);
  });
});

describe("runEmbeddingSubmitCommand", () => {
  test("runs the status receipt through one command row", async () => {
    const runner = fakeRunner();
    const output = await runEmbeddingSubmitCommand(
      "/recall embedding status",
      SCOPE,
      runner,
      deps(),
    );
    expect(runner.started).toEqual(["/recall embedding status"]);
    expect(runner.outputs).toHaveLength(1);
    expect(runner.outputs[0]?.success).toBe(true);
    expect(output).toContain("Vector recall:");
    expect(output).toContain("Arms:");
  });

  test("first enable with a wizard gets the setup copy, zero writes", async () => {
    const runner = fakeRunner();
    const writes: unknown[] = [];
    const output = await runEmbeddingSubmitCommand(
      "/recall embedding on",
      SCOPE,
      runner,
      deps({
        readRawSettings: () => ({}),
        openSetup: () => true,
        writeSettings: (patch) => {
          writes.push(patch);
          return previewEmbeddingSettings(patch, EMBEDDING_SETTING_DEFAULTS);
        },
      }),
    );
    expect(output).toContain("Opening the embedding connect wizard");
    expect(writes).toHaveLength(0);
    expect(runner.outputs).toHaveLength(1);
  });

  test("without a full-screen shell the fallback is D4's copy-paste hint", async () => {
    const runner = fakeRunner();
    // The shell decision is cache-once and env-overridable; pin the append shell
    // so this file does not inherit a caller's full-screen setting.
    const previous = process.env.HARUYUKI_UI_V2;
    process.env.HARUYUKI_UI_V2 = "0";
    resetUiV2Resolution();
    try {
      const output = await runEmbeddingSubmitCommand(
        "/recall embedding on",
        SCOPE,
        runner,
        deps({ readRawSettings: () => ({}) }),
      );
      // `resolveUiV2Once` answers false in the append shell, which is exactly
      // the legacy path D4 words as the setup hint.
      expect(output).toContain("not configured yet");
    } finally {
      if (previous === undefined) delete process.env.HARUYUKI_UI_V2;
      else process.env.HARUYUKI_UI_V2 = previous;
      resetUiV2Resolution();
    }
  });

  test("the full-screen shell routes first-run setup to the settings page", async () => {
    const runner = fakeRunner();
    const previous = process.env.HARUYUKI_UI_V2;
    delete process.env.HARUYUKI_UI_V2; // ui_v2 is on by default
    resetUiV2Resolution();
    try {
      const output = await runEmbeddingSubmitCommand(
        "/recall embedding connect",
        SCOPE,
        runner,
        deps({ readRawSettings: () => ({}) }),
      );
      expect(output).toContain("Opening the embedding connect wizard");
    } finally {
      if (previous === undefined) delete process.env.HARUYUKI_UI_V2;
      else process.env.HARUYUKI_UI_V2 = previous;
      resetUiV2Resolution();
    }
  });

  test("a throwing handler fails the row and still throws to the caller", async () => {
    const runner = fakeRunner();
    const exploding = deps({
      readSettings: () => {
        throw new Error("settings manager exploded");
      },
    });
    await expect(
      runEmbeddingSubmitCommand(
        "/recall embedding status",
        SCOPE,
        runner,
        exploding,
      ),
    ).rejects.toThrow("settings manager exploded");
    expect(runner.failures).toHaveLength(1);
    expect(runner.failures[0]).toContain("Vector recall failed");
    expect(runner.outputs).toHaveLength(0);
  });
});
