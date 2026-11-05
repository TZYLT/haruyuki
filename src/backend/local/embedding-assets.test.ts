import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MODEL_INSTALL_MANIFEST_FILE_NAME,
  MODEL_INSTALL_MANIFEST_VERSION,
} from "@/backend/local/embedding/model-download-types";
import { getBuiltinModelManifest } from "@/backend/local/embedding/model-manifest";
import {
  DEFAULT_EMBEDDING_RUNTIME_VERSION,
  RUNTIME_MANIFEST_FILE_NAME,
  RUNTIME_MANIFEST_VERSION,
} from "@/backend/local/embedding/runtime-fetch";
import { getEmbeddingRuntimeDir } from "@/backend/local/embedding/secrets";
import {
  checkEmbeddingBuiltinAssets,
  formatEmbeddingAssetsMissing,
  resolveEmbeddingBuiltinAssets,
} from "@/backend/local/embedding-assets";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";

let dirs: EmbeddingFixtureDirs;
let previousHome: string | undefined;

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs("haru-embedding-assets-");
  previousHome = process.env.HARUYUKI_HOME;
  process.env.HARUYUKI_HOME = dirs.homeDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  dirs.cleanup();
});

function modelsRoot(name: string): string {
  return join(dirs.root, name);
}

/**
 * Write a model directory the downloader's own marker check accepts, without a
 * download: every file gets its manifest-declared size (sparse for the weights)
 * and the marker records the pinned digest. `isInstallUsable` deliberately does
 * not re-hash the weights, so a sparse file is a valid fixture.
 */
function writeInstalledModel(modelsDir: string, modelId: string): string {
  const manifest = getBuiltinModelManifest(modelId);
  const modelDir = join(modelsDir, manifest.id);
  const files = manifest.files.map((file) => {
    const target = join(modelDir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(0));
    const bytes = file.bytes ?? 0;
    truncateSync(target, bytes);
    return {
      path: file.path,
      bytes,
      sha256: file.sha256 ?? sha256OfEmptyFile(),
      source: "manual",
    };
  });
  const install = {
    manifestVersion: MODEL_INSTALL_MANIFEST_VERSION,
    modelId: manifest.id,
    dimensions: manifest.dimensions,
    licenseId: manifest.license.id,
    installedAt: "2026-01-01T00:00:00.000Z",
    source: "manual",
    integrity: "size-only",
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
  writeFileSync(
    join(modelDir, MODEL_INSTALL_MANIFEST_FILE_NAME),
    `${JSON.stringify(install)}\n`,
    "utf8",
  );
  return modelDir;
}

function sha256OfEmptyFile(): string {
  return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
}

function writeRuntimeManifest(runtimeVersion: string): string {
  const runtimeDir = getEmbeddingRuntimeDir(runtimeVersion);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, RUNTIME_MANIFEST_FILE_NAME),
    `${JSON.stringify({
      manifestVersion: RUNTIME_MANIFEST_VERSION,
      runtimeVersion,
      platform: process.platform,
      arch: process.arch,
      packages: [],
    })}\n`,
    "utf8",
  );
  return runtimeDir;
}

describe("resolveEmbeddingBuiltinAssets", () => {
  test("resolves every absolute path from the manifest and cache root", () => {
    const modelsDir = modelsRoot("models");
    const assets = resolveEmbeddingBuiltinAssets("bge-small-zh-v1.5", {
      modelsDir,
    });
    expect(assets.modelId).toBe("bge-small-zh-v1.5");
    expect(assets.manifest.dimensions).toBe(512);
    expect(assets.modelDir).toBe(join(modelsDir, "bge-small-zh-v1.5"));
    expect(assets.modelPath).toBe(
      join(modelsDir, "bge-small-zh-v1.5", "onnx", "model_quantized.onnx"),
    );
    expect(assets.tokenizerPath).toBe(
      join(modelsDir, "bge-small-zh-v1.5", "tokenizer.json"),
    );
    expect(assets.configPath).toBe(
      join(modelsDir, "bge-small-zh-v1.5", "config.json"),
    );
    expect(assets.runtimeVersion).toBe(DEFAULT_EMBEDDING_RUNTIME_VERSION);
    expect(assets.runtimeDir).toBe(
      join(
        dirs.homeDir,
        "cache",
        "embedding",
        "runtime",
        DEFAULT_EMBEDDING_RUNTIME_VERSION,
      ),
    );
  });

  test("defaults the models dir to the call-time harness cache", () => {
    const assets = resolveEmbeddingBuiltinAssets("bge-small-zh-v1.5");
    expect(assets.modelDir).toBe(
      join(dirs.homeDir, "cache", "embedding", "models", "bge-small-zh-v1.5"),
    );
  });

  test("honours a runtime version override", () => {
    const assets = resolveEmbeddingBuiltinAssets("bge-small-zh-v1.5", {
      modelsDir: modelsRoot("models"),
      runtimeVersion: "9.9.9",
    });
    expect(assets.runtimeVersion).toBe("9.9.9");
    expect(assets.runtimeDir).toBe(
      join(dirs.homeDir, "cache", "embedding", "runtime", "9.9.9"),
    );
  });

  test("throws a clear error for a model this build does not know", () => {
    expect(() => resolveEmbeddingBuiltinAssets("not-a-model")).toThrow(
      /Unknown embedding model/,
    );
  });
});

describe("checkEmbeddingBuiltinAssets", () => {
  test("reports both assets missing on a fresh machine", async () => {
    const check = await checkEmbeddingBuiltinAssets("bge-small-zh-v1.5", {
      modelsDir: modelsRoot("models"),
    });
    expect(check.installed).toBe(false);
    expect(check.modelInstalled).toBe(false);
    expect(check.runtimeInstalled).toBe(false);
    expect(check.missing).toEqual(["model", "runtime"]);
    expect(check.assets.modelDir).toContain("bge-small-zh-v1.5");
  });

  test("reports only the model missing when the runtime is installed", async () => {
    writeRuntimeManifest(DEFAULT_EMBEDDING_RUNTIME_VERSION);
    const check = await checkEmbeddingBuiltinAssets("bge-small-zh-v1.5", {
      modelsDir: modelsRoot("models"),
    });
    expect(check.modelInstalled).toBe(false);
    expect(check.runtimeInstalled).toBe(true);
    expect(check.missing).toEqual(["model"]);
  });

  test("reports installed when the model marker and runtime manifest are valid", async () => {
    const modelsDir = modelsRoot("models");
    writeInstalledModel(modelsDir, "bge-small-zh-v1.5");
    writeRuntimeManifest(DEFAULT_EMBEDDING_RUNTIME_VERSION);
    const check = await checkEmbeddingBuiltinAssets("bge-small-zh-v1.5", {
      modelsDir,
    });
    expect(check.modelInstalled).toBe(true);
    expect(check.runtimeInstalled).toBe(true);
    expect(check.installed).toBe(true);
    expect(check.missing).toEqual([]);
  });

  test("treats an unreadable runtime manifest as not installed", async () => {
    const runtimeDir = getEmbeddingRuntimeDir(
      DEFAULT_EMBEDDING_RUNTIME_VERSION,
    );
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, RUNTIME_MANIFEST_FILE_NAME),
      "not json",
      "utf8",
    );
    const check = await checkEmbeddingBuiltinAssets("bge-small-zh-v1.5", {
      modelsDir: modelsRoot("models"),
    });
    expect(check.runtimeInstalled).toBe(false);
  });
});

describe("formatEmbeddingAssetsMissing", () => {
  test("names what is missing and points at setup", async () => {
    const check = await checkEmbeddingBuiltinAssets("bge-small-zh-v1.5", {
      modelsDir: modelsRoot("models"),
    });
    const message = formatEmbeddingAssetsMissing(check);
    expect(message).toContain("bge-small-zh-v1.5");
    expect(message).toContain("ONNX runtime");
    expect(message).toContain("/recall embedding connect");
  });

  test("is empty when nothing is missing", async () => {
    const modelsDir = modelsRoot("models");
    writeInstalledModel(modelsDir, "bge-small-zh-v1.5");
    writeRuntimeManifest(DEFAULT_EMBEDDING_RUNTIME_VERSION);
    const check = await checkEmbeddingBuiltinAssets("bge-small-zh-v1.5", {
      modelsDir,
    });
    expect(formatEmbeddingAssetsMissing(check)).toBe("");
  });
});
