import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_CHUNK_DEFAULTS } from "@/backend/local/embedding-chunk";
import { EMBEDDING_INDEX_CHUNKER_VERSION } from "@/backend/local/embedding-format";
import {
  EmbeddingSpacePathError,
  listEmbeddingSpaceDirs,
  resolveEmbeddingSpace,
  resolveEmbeddingSpaceId,
} from "@/backend/local/embedding-space";
import {
  type EmbeddingSettingKey,
  type ResolvedEmbeddingSettings,
  resolveEmbeddingSettings,
} from "@/recall-settings";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";

let dirs: EmbeddingFixtureDirs;
let previousHome: string | undefined;
let previousLocalBackend: string | undefined;

function embeddingSettings(
  overrides: Partial<Record<EmbeddingSettingKey, unknown>> = {},
): ResolvedEmbeddingSettings {
  return resolveEmbeddingSettings(overrides);
}

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs("haru-embedding-space-");
  previousHome = process.env.HARUYUKI_HOME;
  previousLocalBackend = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = dirs.homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = dirs.localBackendDir;
});

afterEach(() => {
  restoreEnv("HARUYUKI_HOME", previousHome);
  restoreEnv("LETTA_LOCAL_BACKEND_DIR", previousLocalBackend);
  dirs.cleanup();
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const BASE_SPACE_ID_INPUT = {
  modelId: "bge-small-zh-v1.5",
  dimensions: 512,
  quantization: "float32" as const,
};

describe("resolveEmbeddingSpaceId", () => {
  test("is a stable 20-hex digest", () => {
    const id = resolveEmbeddingSpaceId(BASE_SPACE_ID_INPUT);
    expect(id).toMatch(/^[0-9a-f]{20}$/);
    expect(resolveEmbeddingSpaceId(BASE_SPACE_ID_INPUT)).toBe(id);
  });

  test("treats explicit chunker defaults like omitted parameters", () => {
    const withDefaults = resolveEmbeddingSpaceId({
      ...BASE_SPACE_ID_INPUT,
      chunkerVersion: EMBEDDING_INDEX_CHUNKER_VERSION,
      chunkTarget: EMBEDDING_CHUNK_DEFAULTS.targetTokens,
      chunkMax: EMBEDDING_CHUNK_DEFAULTS.maxTokens,
      chunkOverlap: EMBEDDING_CHUNK_DEFAULTS.overlapTokens,
    });
    expect(withDefaults).toBe(resolveEmbeddingSpaceId(BASE_SPACE_ID_INPUT));
  });

  test("changes when the model changes", () => {
    const base = resolveEmbeddingSpaceId(BASE_SPACE_ID_INPUT);
    expect(
      resolveEmbeddingSpaceId({ ...BASE_SPACE_ID_INPUT, modelId: "bge-m3" }),
    ).not.toBe(base);
  });

  test("changes when the dimension changes", () => {
    const base = resolveEmbeddingSpaceId(BASE_SPACE_ID_INPUT);
    expect(
      resolveEmbeddingSpaceId({ ...BASE_SPACE_ID_INPUT, dimensions: 1024 }),
    ).not.toBe(base);
  });

  test("changes when the quantization changes", () => {
    const base = resolveEmbeddingSpaceId(BASE_SPACE_ID_INPUT);
    expect(
      resolveEmbeddingSpaceId({ ...BASE_SPACE_ID_INPUT, quantization: "int8" }),
    ).not.toBe(base);
  });

  test("changes when any chunking parameter changes (48-1 §6.3)", () => {
    const base = resolveEmbeddingSpaceId(BASE_SPACE_ID_INPUT);
    const variants = [
      { chunkerVersion: EMBEDDING_INDEX_CHUNKER_VERSION + 1 },
      { chunkTarget: EMBEDDING_CHUNK_DEFAULTS.targetTokens + 1 },
      { chunkMax: EMBEDDING_CHUNK_DEFAULTS.maxTokens + 1 },
      { chunkOverlap: EMBEDDING_CHUNK_DEFAULTS.overlapTokens + 1 },
    ];
    for (const variant of variants) {
      expect(
        resolveEmbeddingSpaceId({ ...BASE_SPACE_ID_INPUT, ...variant }),
      ).not.toBe(base);
    }
  });

  test("rejects impossible inputs instead of hashing them", () => {
    expect(() =>
      resolveEmbeddingSpaceId({ ...BASE_SPACE_ID_INPUT, dimensions: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      resolveEmbeddingSpaceId({ ...BASE_SPACE_ID_INPUT, chunkOverlap: -1 }),
    ).toThrow(TypeError);
    expect(() =>
      resolveEmbeddingSpaceId({
        ...BASE_SPACE_ID_INPUT,
        quantization: "float64" as never,
      }),
    ).toThrow(TypeError);
  });
});

describe("resolveEmbeddingSpace", () => {
  test("uses the built-in manifest width and a call-time root", () => {
    const space = resolveEmbeddingSpace("agent-a", embeddingSettings());
    expect(space.agentId).toBe("agent-a");
    expect(space.modelId).toBe("bge-small-zh-v1.5");
    expect(space.dimensions).toBe(512);
    expect(space.quantization).toBe("f32");
    expect(space.root).toBe(join(dirs.homeDir, "recall-vectors"));
    expect(space.spaceDir).toBe(join(space.root, "agent-a", space.spaceId));
    expect(space.spaceId).toBe(
      resolveEmbeddingSpaceId({
        modelId: "bge-small-zh-v1.5",
        dimensions: 512,
        quantization: "float32",
        chunkTarget: EMBEDDING_CHUNK_DEFAULTS.targetTokens,
        chunkMax: EMBEDDING_CHUNK_DEFAULTS.maxTokens,
        chunkOverlap: EMBEDDING_CHUNK_DEFAULTS.overlapTokens,
      }),
    );
  });

  test("honours an explicit root override", () => {
    const root = join(dirs.root, "custom-vectors");
    const space = resolveEmbeddingSpace("agent-a", embeddingSettings(), {
      root,
    });
    expect(space.root).toBe(root);
    expect(space.spaceDir).toBe(join(root, "agent-a", space.spaceId));
  });

  test("maps int8 settings to the on-disk quant and a different space", () => {
    const floatSpace = resolveEmbeddingSpace(
      "agent-a",
      embeddingSettings({ recallEmbeddingQuantization: "float32" }),
    );
    const intSpace = resolveEmbeddingSpace(
      "agent-a",
      embeddingSettings({ recallEmbeddingQuantization: "int8" }),
    );
    expect(intSpace.quantization).toBe("int8");
    expect(intSpace.spaceId).not.toBe(floatSpace.spaceId);
  });

  test("uses the endpoint's declared model and width", () => {
    const space = resolveEmbeddingSpace(
      "agent-b",
      embeddingSettings({
        recallEmbeddingBackend: "endpoint",
        recallEmbeddingEndpoint: {
          kind: "openai",
          baseUrl: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          dimensions: 1536,
        },
      }),
    );
    expect(space.modelId).toBe("text-embedding-3-small");
    expect(space.dimensions).toBe(1536);
    expect(space.quantization).toBe("f32");
  });

  test("throws a clear error when endpoint mode has no endpoint", () => {
    expect(() =>
      resolveEmbeddingSpace(
        "agent-b",
        embeddingSettings({ recallEmbeddingBackend: "endpoint" }),
      ),
    ).toThrow(/no endpoint is configured/i);
  });

  test("rejects an agent id that is not a safe path component", () => {
    expect(() =>
      resolveEmbeddingSpace("../escape", embeddingSettings()),
    ).toThrow(EmbeddingSpacePathError);
  });
});

describe("listEmbeddingSpaceDirs", () => {
  test("returns [] when the agent directory does not exist", () => {
    expect(listEmbeddingSpaceDirs("agent-missing")).toEqual([]);
  });

  test("lists only real, safely named space directories, newest first", () => {
    const agentDir = join(dirs.homeDir, "recall-vectors", "agent-a");
    mkdirSync(join(agentDir, "space-old"), { recursive: true });
    mkdirSync(join(agentDir, "space-new"), { recursive: true });
    mkdirSync(join(agentDir, ".hidden"), { recursive: true });
    mkdirSync(join(agentDir, "bad name"), { recursive: true });
    writeFileSync(join(agentDir, "not-a-directory"), "x", "utf8");
    utimesSync(join(agentDir, "space-old"), 1_000_000_000, 1_000_000_000);
    utimesSync(join(agentDir, "space-new"), 1_000_100_000, 1_000_100_000);

    const spaces = listEmbeddingSpaceDirs("agent-a");
    expect(spaces.map((space) => space.spaceId)).toEqual([
      "space-new",
      "space-old",
    ]);
    expect(spaces[0]?.spaceDir).toBe(join(agentDir, "space-new"));
    expect(spaces[0]?.updatedAtMs).not.toBeNull();
    expect(spaces[0]?.updatedAtMs ?? 0).toBeGreaterThan(
      spaces[1]?.updatedAtMs ?? 0,
    );
  });

  test("honours a root override", () => {
    const root = join(dirs.root, "other-vectors");
    mkdirSync(join(root, "agent-a", "space-x"), { recursive: true });
    expect(
      listEmbeddingSpaceDirs("agent-a", { root }).map((space) => space.spaceId),
    ).toEqual(["space-x"]);
  });

  test("rejects an unsafe agent id", () => {
    expect(() => listEmbeddingSpaceDirs("..")).toThrow(EmbeddingSpacePathError);
  });
});
