/**
 * The non-interactive embedding flag seam the headless entry point calls
 * (48-1 §7.1 R-12, 48-2 §3.4 D6).
 *
 * D4 already covers the writer in `embedding.test.ts`; this file pins the
 * assembly the startup path relies on: validation happens before any write,
 * "enable without a choice" is a setup hint (zero writes), and a valid
 * combination reaches the D3 writer exactly once.
 */
import { describe, expect, test } from "bun:test";
import {
  type EmbeddingSettingsPatch,
  previewEmbeddingSettings,
} from "@/cli/app/pages/settings/embedding-settings";
import type { EmbeddingCommandDeps } from "@/cli/commands/embedding";
import { applyEmbeddingSetupFlags } from "@/cli/commands/embedding-flags";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";

const CONFIGURED_RAW = { recallEmbeddingBackend: "builtin" };

interface Harness {
  deps: EmbeddingCommandDeps;
  writes: EmbeddingSettingsPatch[];
  settings: () => ResolvedEmbeddingSettings;
}

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

describe("applyEmbeddingSetupFlags", () => {
  test("no embedding flag is a successful no-op", async () => {
    const h = harness();
    const outcome = await applyEmbeddingSetupFlags({}, undefined, h.deps);
    expect(outcome).toEqual({ ok: true, receipt: "" });
    expect(h.writes).toHaveLength(0);
  });

  test("a mistyped cross-field combination fails before anything writes", async () => {
    const h = harness();
    const outcome = await applyEmbeddingSetupFlags(
      { "recall-embedding-api-key-env": "HARUYUKI_EMBEDDING_API_KEY" },
      { agentId: "agent-1" },
      h.deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.error).toContain("--recall-embedding-api-key-env");
    expect(h.writes).toHaveLength(0);
  });

  test("enable without a backend choice prints the copy-paste hint, zero writes", async () => {
    const h = harness({ readRawSettings: () => ({}) });
    const outcome = await applyEmbeddingSetupFlags(
      { "recall-embedding": "on" },
      { agentId: "agent-1", conversationId: null },
      h.deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a receipt");
    expect(outcome.receipt).toContain("not configured yet");
    expect(outcome.receipt).toContain("--recall-embedding-backend builtin");
    expect(h.writes).toHaveLength(0);
  });

  test("a configured agent is written once with backend + model", async () => {
    const h = harness();
    const outcome = await applyEmbeddingSetupFlags(
      {
        "recall-embedding": "on",
        "recall-embedding-backend": "builtin",
        "recall-embedding-model": "bge-small-zh-v1.5",
      },
      { agentId: "agent-1", conversationId: null },
      h.deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a receipt");
    expect(outcome.receipt).toContain("Embedding settings saved.");
    expect(h.writes).toEqual([
      { enabled: true, backend: "builtin", model: "bge-small-zh-v1.5" },
    ]);
    expect(h.settings().enabled).toBe(true);
  });

  test("enabling through a backend the runtime cannot probe writes nothing", async () => {
    const h = harness();
    const outcome = await applyEmbeddingSetupFlags(
      {
        "recall-embedding": "on",
        "recall-embedding-backend": "endpoint",
        "recall-embedding-endpoint": "https://api.example.com/v1",
      },
      { agentId: "agent-1", conversationId: null },
      h.deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a receipt");
    expect(outcome.receipt).toContain(
      "Testing an endpoint needs the embedding runtime",
    );
    expect(h.writes).toHaveLength(0);
  });

  test("off disables the feature through the same writer", async () => {
    const h = harness({}, { ...EMBEDDING_SETTING_DEFAULTS, enabled: true });
    const outcome = await applyEmbeddingSetupFlags(
      { "recall-embedding": "off" },
      undefined,
      h.deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a receipt");
    expect(outcome.receipt).toContain("Embedding settings saved.");
    expect(h.writes).toEqual([{ enabled: false }]);
    expect(h.settings().enabled).toBe(false);
  });
});
