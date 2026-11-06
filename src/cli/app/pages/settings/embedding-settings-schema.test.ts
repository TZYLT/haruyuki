import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDING_SETTING_DEFAULTS,
  EMBEDDING_SETTING_KEYS,
  readEmbeddingSettings,
} from "@/recall-settings";
import { settingsManager } from "@/settings-manager";
import { __testResetEmbeddingApiKeyPresence } from "./embedding-secrets";
import {
  EmbeddingSettingsError,
  embeddingPatchInvalidatesSpace,
} from "./embedding-settings";
import {
  EMBEDDING_SETTINGS_GROUP,
  EMBEDDING_SETTINGS_GROUPS,
  EMBEDDING_SETTINGS_ITEMS,
} from "./embedding-settings-schema";
import type { SettingsContext, SettingsItem } from "./settings-model";
import { validateValue } from "./settings-model";

/**
 * The embedding settings section as data: the rows exist, the defaults the
 * requirement names are what they paint, and every write goes through the one
 * writer (so an invalid row is refused rather than persisted).
 */

const CTX: SettingsContext = {
  agentId: "agent-embedding-settings",
  conversationId: "conv-embedding-settings",
  projectDirectory: "/tmp/does-not-matter",
};

function item(id: string): SettingsItem {
  const found = EMBEDDING_SETTINGS_ITEMS.find((entry) => entry.id === id);
  if (!found) throw new Error(`${id} is not a settings row`);
  return found;
}

function write(id: string, value: string): void | Promise<void> {
  const row = item(id);
  if (!row.write) throw new Error(`${id} has no writer`);
  return row.write(CTX, value);
}

const originalHome = process.env.HOME;
let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "haruyuki-embedding-schema-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
  __testResetEmbeddingApiKeyPresence();
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe("the embedding settings section", () => {
  test("is one group in the memory section", () => {
    expect(EMBEDDING_SETTINGS_GROUP).toEqual({
      id: "embedding",
      section: "memory",
      label: "Vector recall (embedding)",
    });
    expect(EMBEDDING_SETTINGS_GROUPS).toEqual([EMBEDDING_SETTINGS_GROUP]);
  });

  test("every row belongs to the group and the section", () => {
    for (const row of EMBEDDING_SETTINGS_ITEMS) {
      expect(row.section).toBe("memory");
      expect(row.group).toBe("embedding");
      expect(row.scope).toBe("global");
    }
  });

  test("every stored key has a row, plus the write-only API key", () => {
    const ids = EMBEDDING_SETTINGS_ITEMS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const key of EMBEDDING_SETTING_KEYS) {
      expect(ids).toContain(key);
    }
    expect(ids).toContain("recallEmbeddingApiKey");
  });

  test("the API key is the one secret row", () => {
    const secrets = EMBEDDING_SETTINGS_ITEMS.filter(
      (row) => row.kind === "secret",
    );
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.id).toBe("recallEmbeddingApiKey");
    expect(secrets[0]?.label).toBe("Endpoint API key");
  });

  test("only the endpoint and calibration rows are read-only", () => {
    const readOnly = EMBEDDING_SETTINGS_ITEMS.filter((row) => !row.editable);
    expect(readOnly.map((row) => row.id).sort()).toEqual([
      "recallEmbeddingCalibration",
      "recallEmbeddingEndpoint",
    ]);
    for (const row of readOnly) {
      expect(row.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("every editable row has a writer", () => {
    for (const row of EMBEDDING_SETTINGS_ITEMS) {
      if (row.editable) expect(row.write).toBeDefined();
    }
  });
});

describe("the embedding rows read the requirement's defaults", () => {
  const defaults: ReadonlyArray<readonly [string, string]> = [
    ["recallEmbeddingEnabled", "false"],
    ["recallEmbeddingBackend", "builtin"],
    ["recallEmbeddingModel", "bge-small-zh-v1.5"],
    ["recallEmbeddingEndpoint", "not configured"],
    ["recallEmbeddingWeight", "0.5"],
    ["recallEmbeddingCandidateDepth", "50"],
    ["recallEmbeddingChunkTarget", "200"],
    ["recallEmbeddingChunkMax", "256"],
    ["recallEmbeddingChunkOverlap", "32"],
    ["recallEmbeddingMaxChunksPerMessage", "1024"],
    ["recallEmbeddingThreads", "0"],
    ["recallEmbeddingGpu", "auto"],
    ["recallEmbeddingQuantization", "float32"],
    ["recallEmbeddingKeepSpaces", "2"],
    ["recallEmbeddingCalibration", "not calibrated yet"],
  ];

  for (const [id, value] of defaults) {
    test(`${id} paints ${value}`, () => {
      expect(item(id).read(CTX)).toBe(value);
    });
  }

  test("the write-only key shows a presence word, never a value", () => {
    expect(item("recallEmbeddingApiKey").read(CTX)).toBe("hidden (write-only)");
  });

  test("the defaults match the resolver's own", () => {
    const settings = readEmbeddingSettings();
    expect(settings.enabled).toBe(EMBEDDING_SETTING_DEFAULTS.enabled);
    expect(settings.chunkTarget).toBe(EMBEDDING_SETTING_DEFAULTS.chunkTarget);
    expect(settings.keepSpaces).toBe(EMBEDDING_SETTING_DEFAULTS.keepSpaces);
  });
});

describe("the embedding rows write through the single writer", () => {
  test("a toggle write flips and persists", () => {
    write("recallEmbeddingEnabled", "true");
    expect(readEmbeddingSettings().enabled).toBe(true);
    expect(settingsManager.getSetting("recallEmbeddingEnabled")).toBe(true);
    expect(item("recallEmbeddingEnabled").read(CTX)).toBe("true");
  });

  test("a select write persists the stored key and the row reads it normalized", () => {
    write("recallEmbeddingGpu", "index-only");
    expect(settingsManager.getSetting("recallEmbeddingGpu")).toBe("index-only");
    // D-01: the UI only offers auto | off, and the resolver maps the legacy
    // `index-only` role to `auto`. The stored value is kept (first assertion);
    // the row shows what the resolver actually uses.
    expect(item("recallEmbeddingGpu").read(CTX)).toBe("auto");
  });

  test("a number write persists the number, not the text", () => {
    write("recallEmbeddingWeight", "0.7");
    expect(settingsManager.getSetting("recallEmbeddingWeight")).toBe(0.7);
    expect(readEmbeddingSettings().weight).toBe(0.7);
  });

  test("a model write is trimmed", () => {
    write("recallEmbeddingModel", "  bge-m3  ");
    expect(settingsManager.getSetting("recallEmbeddingModel")).toBe("bge-m3");
  });

  test("an empty model is refused before it is written", () => {
    expect(validateValue(item("recallEmbeddingModel"), "")).toBe(
      "needs a model id",
    );
    expect(settingsManager.getSetting("recallEmbeddingModel")).toBeUndefined();
  });

  test("a chunk plan the chunker cannot run is refused by the writer", () => {
    expect(() => write("recallEmbeddingChunkMax", "64")).toThrow(
      EmbeddingSettingsError,
    );
    expect(readEmbeddingSettings().chunkMax).toBe(
      EMBEDDING_SETTING_DEFAULTS.chunkMax,
    );
  });

  test("a number row refuses an out-of-bounds value in the editor", () => {
    expect(validateValue(item("recallEmbeddingWeight"), "1.5")).toBe(
      "must be at most 1",
    );
  });

  test("changing a chunk row is reported as a space rebuild", () => {
    expect(embeddingPatchInvalidatesSpace({ chunkTarget: 128 })).toBe(true);
    expect(embeddingPatchInvalidatesSpace({ weight: 0.4 })).toBe(false);
  });
});
