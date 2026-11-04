/**
 * The headless half of `--recall-embedding*` (48-1 §7.1 R-12, 48-2 §3.4 D6).
 *
 * D4 pins the flag writer; this file pins what headless does *after* it: one
 * incremental build when the flags turned the switch on, nothing when they did
 * not, and copy (never a throw) when the build is refused or has no agent.
 */
import { describe, expect, test } from "bun:test";
import {
  applyEmbeddingHeadlessBuild,
  EMBEDDING_HEADLESS_NO_AGENT,
  type EmbeddingHeadlessDeps,
} from "@/cli/helpers/embedding-headless";
import type { BuildEmbeddingFromSettingsRequest } from "@/cli/helpers/embedding-runtime";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";

const AGENT = "agent-headless";

function settings(
  overrides: Partial<ResolvedEmbeddingSettings> = {},
): ResolvedEmbeddingSettings {
  return { ...EMBEDDING_SETTING_DEFAULTS, enabled: true, ...overrides };
}

interface Harness {
  deps: EmbeddingHeadlessDeps;
  builds: BuildEmbeddingFromSettingsRequest[];
}

function harness(
  options: {
    settings?: ResolvedEmbeddingSettings;
    receipt?: string;
    fail?: Error;
    build?: EmbeddingHeadlessDeps["build"];
  } = {},
): Harness {
  const builds: BuildEmbeddingFromSettingsRequest[] = [];
  const build: EmbeddingHeadlessDeps["build"] =
    options.build ??
    (async (request) => {
      builds.push(request);
      if (options.fail !== undefined) throw options.fail;
      return options.receipt ?? "Build completed: 3 chunk(s) embedded.";
    });
  return {
    builds,
    deps: {
      readSettings: () => options.settings ?? settings(),
      build,
    },
  };
}

describe("applyEmbeddingHeadlessBuild", () => {
  test("no embedding flag means no build and no output", async () => {
    const h = harness();
    expect(
      await applyEmbeddingHeadlessBuild({}, { agentId: AGENT }, h.deps),
    ).toBe("");
    expect(h.builds).toHaveLength(0);
  });

  test("--recall-embedding off never builds, even when the feature was on", async () => {
    const h = harness({ settings: settings({ enabled: true }) });
    expect(
      await applyEmbeddingHeadlessBuild(
        { "recall-embedding": "off" },
        { agentId: AGENT },
        h.deps,
      ),
    ).toBe("");
    expect(h.builds).toHaveLength(0);
  });

  test("a first run that wrote nothing does not build", async () => {
    // `--recall-embedding on` without a backend choice prints the setup hint and
    // leaves the switch off, so there is nothing to build from.
    const h = harness({ settings: settings({ enabled: false }) });
    expect(
      await applyEmbeddingHeadlessBuild(
        { "recall-embedding": "on" },
        { agentId: AGENT },
        h.deps,
      ),
    ).toBe("");
    expect(h.builds).toHaveLength(0);
  });

  test("enable builds once with the headless lifecycle and returns the receipt", async () => {
    const h = harness({ receipt: "Build completed: 9 chunk(s) embedded." });
    const receipt = await applyEmbeddingHeadlessBuild(
      { "recall-embedding": "on" },
      { agentId: AGENT },
      h.deps,
    );
    expect(receipt).toBe("Build completed: 9 chunk(s) embedded.");
    expect(h.builds).toEqual([
      {
        agentId: AGENT,
        mode: "incremental",
        keepAfterExit: false,
        lifecycle: "headless",
      },
    ]);
  });

  test("enabling through a configured backend also builds", async () => {
    const h = harness();
    const receipt = await applyEmbeddingHeadlessBuild(
      {
        "recall-embedding": "on",
        "recall-embedding-backend": "builtin",
        "recall-embedding-model": "bge-small-zh-v1.5",
      },
      { agentId: AGENT },
      h.deps,
    );
    expect(receipt.length).toBeGreaterThan(0);
    expect(h.builds).toHaveLength(1);
    expect(h.builds[0]?.agentId).toBe(AGENT);
  });

  test("no agent id is a readable hint, not a throw and not a build", async () => {
    const h = harness();
    const output = await applyEmbeddingHeadlessBuild(
      { "recall-embedding": "on" },
      { agentId: null },
      h.deps,
    );
    expect(output).toBe(EMBEDDING_HEADLESS_NO_AGENT);
    expect(output).toContain("no agent id");
    expect(h.builds).toHaveLength(0);
  });

  test("a throwing build becomes a sentence instead of failing startup", async () => {
    const h = harness({
      fail: new Error("settings manager is not initialized"),
    });
    const output = await applyEmbeddingHeadlessBuild(
      { "recall-embedding": "on" },
      { agentId: AGENT },
      h.deps,
    );
    expect(output).toContain("Could not start the embedding build");
    expect(output).toContain("settings manager is not initialized");
    expect(output).toContain("Nothing is running");
  });

  test("a malformed flag combination is left to the caller's own refusal", async () => {
    // The value never reaches the parser as a valid on/off word; the flag module
    // already reported it, so this helper stays silent.
    const h = harness();
    expect(
      await applyEmbeddingHeadlessBuild(
        { "recall-embedding": "maybe" } as never,
        { agentId: AGENT },
        h.deps,
      ),
    ).toBe("");
    expect(h.builds).toHaveLength(0);
  });
});
