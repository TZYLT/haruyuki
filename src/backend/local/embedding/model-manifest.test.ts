import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertSafeModelRelativePath,
  BGE_M3_LICENSE,
  BGE_ZH_LICENSE,
  BUILTIN_EMBEDDING_MODELS,
  buildModelFileUrl,
  defaultModelId,
  EMBEDDING_MODEL_SOURCES,
  type EmbeddingModelManifest,
  EmbeddingModelManifestError,
  getBuiltinModelManifest,
  getModelIntegrityStatus,
  getModelLicenseInfo,
  listBuiltinModelIds,
  QWEN3_EMBEDDING_LICENSE,
  resolveModelFileAt,
  resolveModelFiles,
  validateModelManifest,
} from "./model-manifest";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function digest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/**
 * A fully pinned manifest used to exercise the resolver and the validators
 * without depending on the built-in table's not-yet-pinned JSON digests.
 */
function pinnedManifest(
  overrides: Partial<EmbeddingModelManifest> = {},
): EmbeddingModelManifest {
  return {
    id: "test-small",
    displayName: "test small",
    repository: "acme/test-small",
    dimensions: 384,
    maxTokens: 256,
    inputNames: ["input_ids", "attention_mask"],
    pooling: "mean",
    normalize: true,
    queryInstruction: null,
    documentInstruction: null,
    license: BGE_ZH_LICENSE,
    files: [
      {
        path: "tokenizer.json",
        bytes: 11,
        sha256: digest("tokenizer"),
      },
      {
        path: "onnx/model.onnx",
        bytes: 22,
        sha256: digest("weights"),
      },
    ],
    sources: [EMBEDDING_MODEL_SOURCES.hfMirror],
    quantization: "fp32",
    integrityPinned: true,
    ...overrides,
  };
}

describe("built-in model table", () => {
  test("defaultModelId is the first entry and the table lists all three models", () => {
    expect(defaultModelId).toBe("bge-small-zh-v1.5");
    expect(listBuiltinModelIds()).toEqual([
      defaultModelId,
      "bge-m3",
      "qwen3-embedding-0.6b",
    ]);
    expect(BUILTIN_EMBEDDING_MODELS.map((entry) => entry.id)).toEqual(
      listBuiltinModelIds(),
    );
  });

  test("bge-small-zh-v1.5 describes a 512-dim q8 BERT encoder", () => {
    const manifest = getBuiltinModelManifest();
    expect(manifest.repository).toBe("Xenova/bge-small-zh-v1.5");
    expect(manifest.dimensions).toBe(512);
    expect(manifest.maxTokens).toBe(512);
    expect(manifest.quantization).toBe("q8");
    expect(manifest.inputNames).toEqual([
      "input_ids",
      "attention_mask",
      "token_type_ids",
    ]);
    // bge v1.5 wants the Chinese retrieval instruction on the query side only.
    expect(manifest.queryInstruction).toContain("检索");
    expect(manifest.documentInstruction).toBeNull();
  });

  test("records the four files, the measured sizes and the q8 sha256", () => {
    const manifest = getBuiltinModelManifest();
    const byPath = new Map(manifest.files.map((file) => [file.path, file]));
    expect([...byPath.keys()]).toEqual([
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model_quantized.onnx",
    ]);
    expect(byPath.get("config.json")?.bytes).toBe(716);
    expect(byPath.get("tokenizer.json")?.bytes).toBe(439_125);
    expect(byPath.get("tokenizer_config.json")?.bytes).toBe(367);
    expect(byPath.get("onnx/model_quantized.onnx")?.bytes).toBe(24_010_842);
    expect(byPath.get("onnx/model_quantized.onnx")?.sha256).toBe(
      "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
    );
    // Non-LFS JSON files: HF publishes no sha256 for them, so they stay null.
    for (const path of [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
    ]) {
      expect(byPath.get(path)?.sha256).toBeNull();
      expect(byPath.get(path)?.sourceUrl).toStartWith(
        "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/",
      );
    }
  });

  test("reports itself as unpinned until every required digest exists", () => {
    const manifest = getBuiltinModelManifest();
    expect(manifest.integrityPinned).toBe(false);
    expect(getModelIntegrityStatus(manifest)).toEqual({
      integrity: "unverified",
      missingSha256: ["config.json", "tokenizer.json", "tokenizer_config.json"],
      missingBytes: [],
    });
  });

  test("source order is hf-mirror, huggingface, modelscope", () => {
    const manifest = getBuiltinModelManifest();
    expect(manifest.sources.map((source) => source.id)).toEqual([
      "hf-mirror",
      "huggingface",
      "modelscope",
    ]);
    for (const source of manifest.sources) {
      expect(source.kind).toBe("hf");
    }
  });

  test("MIT licence metadata and text are embedded, not fetched", () => {
    expect(BGE_ZH_LICENSE.id).toBe("MIT");
    expect(BGE_ZH_LICENSE.url).toBe("https://opensource.org/licenses/MIT");
    expect(BGE_ZH_LICENSE.redistributable).toBe(true);
    expect(BGE_ZH_LICENSE.notice).toContain("BAAI/bge-small-zh-v1.5");
    expect(BGE_ZH_LICENSE.text).toContain("Permission is hereby granted");
    expect(BGE_ZH_LICENSE.text).toContain("THE SOFTWARE IS PROVIDED");
    const info = getModelLicenseInfo();
    expect(info.modelId).toBe(defaultModelId);
    expect(info.displayName).toBe("bge-small-zh-v1.5 (q8)");
    expect(info.text).toBe(BGE_ZH_LICENSE.text);
  });

  test("unknown model ids fail with the known ids in the message", () => {
    try {
      getBuiltinModelManifest("not-a-model");
      throw new Error("expected getBuiltinModelManifest to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingModelManifestError);
      const manifestError = error as EmbeddingModelManifestError;
      expect(manifestError.kind).toBe("unknown-model");
      expect(manifestError.message).toContain("bge-small-zh-v1.5");
    }
  });
});

describe("built-in model table: C8 additions", () => {
  test("bge-m3 declares a 1024-dim CLS encoder with no instruction prefix", () => {
    const manifest = getBuiltinModelManifest("bge-m3");
    expect(manifest.repository).toBe("Xenova/bge-m3");
    expect(manifest.dimensions).toBe(1_024);
    expect(manifest.maxTokens).toBe(8_192);
    expect(manifest.inputNames).toEqual(["input_ids", "attention_mask"]);
    expect(manifest.pooling).toBe("cls");
    expect(manifest.queryInstruction).toBeNull();
    expect(manifest.documentInstruction).toBeNull();
    expect(manifest.quantization).toBe("q8");
    expect(manifest.variants).toEqual(["q8"]);
    expect(manifest.integrityPinned).toBe(false);
    expect(manifest.license.id).toBe("MIT");
    expect(manifest.license.notice).toContain("BAAI/bge-m3");
    expect(manifest.notes?.join(" ")).toContain("O-17");
  });

  test("Qwen3-Embedding is 1024-dim, last-token pooled and instruct-prefixed", () => {
    const manifest = getBuiltinModelManifest("qwen3-embedding-0.6b");
    expect(manifest.repository).toBe(
      "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    );
    expect(manifest.dimensions).toBe(1_024);
    expect(manifest.maxTokens).toBe(32_768);
    expect(manifest.inputNames).toEqual(["input_ids", "attention_mask"]);
    expect(manifest.pooling).toBe("last");
    expect(manifest.queryInstruction).toContain("Instruct:");
    expect(manifest.queryInstruction).toContain("Query:");
    expect(manifest.documentInstruction).toBeNull();
    expect(manifest.quantization).toBe("q8");
    expect(manifest.variants).toEqual(["q8"]);
    expect(manifest.integrityPinned).toBe(false);
    expect(manifest.license.id).toBe("Apache-2.0");
    expect(manifest.license.text).toBeNull();
    expect(manifest.notes?.join(" ")).toContain("O-17");
  });

  test("unpinned models never invent a size or digest and still validate", () => {
    for (const modelId of ["bge-m3", "qwen3-embedding-0.6b"]) {
      const manifest = getBuiltinModelManifest(modelId);
      expect(manifest.integrityPinned).toBe(false);
      for (const file of manifest.files) {
        expect(file.bytes).toBeNull();
        expect(file.sha256).toBeNull();
        expect(file.sourceUrl).toStartWith(
          `https://hf-mirror.com/${manifest.repository}/`,
        );
      }
      const status = getModelIntegrityStatus(manifest);
      expect(status.integrity).toBe("unverified");
      expect(status.missingSha256).toEqual(
        manifest.files.map((file) => file.path),
      );
      expect(status.missingBytes).toEqual(status.missingSha256);
      // Declared data is still well-formed and resolvable without any download.
      expect(validateModelManifest(manifest)).toBe(manifest);
      const resolved = resolveModelFiles(modelId, {
        modelDir: makeTempDir("hryk-model-c8-"),
      });
      expect(resolved.modelPath.endsWith(".onnx")).toBe(true);
      expect(resolved.tokenizerPath.endsWith("tokenizer.json")).toBe(true);
    }
  });

  test("licences come from the locked 48-1 table, not the network", () => {
    expect(getModelLicenseInfo("bge-m3").id).toBe("MIT");
    expect(BGE_M3_LICENSE.redistributable).toBe(true);
    expect(BGE_M3_LICENSE.text).toBe(BGE_ZH_LICENSE.text);
    expect(getModelLicenseInfo("qwen3-embedding-0.6b").id).toBe("Apache-2.0");
    expect(QWEN3_EMBEDDING_LICENSE.url).toBe(
      "https://www.apache.org/licenses/LICENSE-2.0",
    );
    expect(QWEN3_EMBEDDING_LICENSE.notice).toContain(
      "Qwen/Qwen3-Embedding-0.6B",
    );
  });

  test("validates pooling strategies and quant variants", () => {
    validateModelManifest(pinnedManifest({ pooling: "cls" }));
    validateModelManifest(pinnedManifest({ pooling: "last" }));
    expect(() =>
      validateModelManifest(pinnedManifest({ pooling: "average" as never })),
    ).toThrow(/pooling/);
    validateModelManifest(pinnedManifest({ variants: ["fp32"] }));
    expect(() =>
      validateModelManifest(pinnedManifest({ variants: [] })),
    ).toThrow(/variants/);
    expect(() =>
      validateModelManifest(pinnedManifest({ variants: ["q8"] })),
    ).toThrow(/variants/);
    expect(() =>
      validateModelManifest(pinnedManifest({ variants: ["fp32", "fp32"] })),
    ).toThrow(/variants/);
  });
});

describe("source URL templates", () => {
  test("builds the same file path per source with the right revision", () => {
    const manifest = getBuiltinModelManifest();
    const file = "onnx/model_quantized.onnx";
    expect(
      buildModelFileUrl(EMBEDDING_MODEL_SOURCES.hfMirror, manifest, file),
    ).toBe(
      "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
    );
    expect(
      buildModelFileUrl(EMBEDDING_MODEL_SOURCES.huggingface, manifest, file),
    ).toBe(
      "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
    );
    expect(
      buildModelFileUrl(EMBEDDING_MODEL_SOURCES.modelscope, manifest, file),
    ).toBe(
      "https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/onnx/model_quantized.onnx",
    );
  });

  test("npm template substitutes package and version", () => {
    const manifest = pinnedManifest();
    const url = buildModelFileUrl(
      {
        id: "npm",
        kind: "npm",
        urlTemplate: EMBEDDING_MODEL_SOURCES.npm.urlTemplate,
        packageName: "@acme/model",
        packageVersion: "1.2.3",
      },
      manifest,
      "onnx/model.onnx",
    );
    expect(url).toBe("https://unpkg.com/@acme/model@1.2.3/onnx/model.onnx");
  });

  test("rejects insecure remote, embedded credentials and unknown placeholders", () => {
    const manifest = pinnedManifest();
    expect(() =>
      buildModelFileUrl(
        {
          id: "insecure",
          kind: "hf",
          urlTemplate: "http://example.com/{repo}/{path}",
        },
        manifest,
        "tokenizer.json",
      ),
    ).toThrow(EmbeddingModelManifestError);
    expect(() =>
      buildModelFileUrl(
        {
          id: "creds",
          kind: "hf",
          urlTemplate: "https://user:pass@example.com/{repo}/{path}",
        },
        manifest,
        "tokenizer.json",
      ),
    ).toThrow(EmbeddingModelManifestError);
    expect(() =>
      buildModelFileUrl(
        {
          id: "unknown-placeholder",
          kind: "hf",
          urlTemplate: "https://example.com/{nope}/{path}",
        },
        manifest,
        "tokenizer.json",
      ),
    ).toThrow(EmbeddingModelManifestError);
  });

  test("allows http only on a loopback host", () => {
    const manifest = pinnedManifest();
    expect(
      buildModelFileUrl(
        {
          id: "local-mirror",
          kind: "hf",
          urlTemplate: "http://127.0.0.1:8080/{repo}/{path}",
        },
        manifest,
        "tokenizer.json",
      ),
    ).toBe("http://127.0.0.1:8080/acme/test-small/tokenizer.json");
    expect(
      buildModelFileUrl(
        {
          id: "local-mirror",
          kind: "hf",
          urlTemplate: "http://localhost:8080/{repo}/{path}",
        },
        manifest,
        "tokenizer.json",
      ),
    ).toStartWith("http://localhost:8080/");
  });
});

describe("resolveModelFiles", () => {
  test("resolves files below an injected model directory", () => {
    const root = makeTempDir("hryk-model-manifest-");
    const resolved = resolveModelFiles("test-small", {
      manifest: pinnedManifest(),
      modelDir: root,
    });
    expect(resolved.modelDir).toBe(resolve(root));
    expect(resolved.files.map((file) => file.path)).toEqual([
      "tokenizer.json",
      "onnx/model.onnx",
    ]);
    expect(resolved.tokenizerPath).toBe(join(root, "tokenizer.json"));
    expect(resolved.modelPath).toBe(join(root, "onnx", "model.onnx"));
    for (const file of resolved.files) {
      expect(file.absolutePath.startsWith(resolve(root))).toBe(true);
    }
  });

  test("defaults the directory through the call-time cache resolver", () => {
    const home = makeTempDir("hryk-model-home-");
    const previous = process.env.HARUYUKI_HOME;
    process.env.HARUYUKI_HOME = home;
    try {
      const resolved = resolveModelFiles();
      expect(resolved.modelDir).toBe(
        join(home, "cache", "embedding", "models", defaultModelId),
      );
      expect(resolved.tokenizerPath).toBe(
        join(resolved.modelDir, "tokenizer.json"),
      );
      expect(resolved.modelPath).toBe(
        join(resolved.modelDir, "onnx", "model_quantized.onnx"),
      );
    } finally {
      if (previous === undefined) delete process.env.HARUYUKI_HOME;
      else process.env.HARUYUKI_HOME = previous;
    }
  });

  test("rejects a path that would escape the model directory", () => {
    const root = makeTempDir("hryk-model-manifest-");
    const manifest = pinnedManifest({
      files: [
        { path: "../tokenizer.json", bytes: 1, sha256: null },
        { path: "onnx/model.onnx", bytes: 2, sha256: null },
      ],
    });
    expect(() =>
      resolveModelFiles("test-small", { manifest, modelDir: root }),
    ).toThrow(EmbeddingModelManifestError);
  });

  test("resolveModelFileAt rejects traversal and absolute paths", () => {
    expect(resolveModelFileAt("/tmp/model", { path: "onnx/model.onnx" })).toBe(
      join("/tmp/model", "onnx", "model.onnx"),
    );
    expect(() =>
      resolveModelFileAt("/tmp/model", { path: "../escape.bin" }),
    ).toThrow(EmbeddingModelManifestError);
    expect(() =>
      resolveModelFileAt("/tmp/model", { path: "/abs.bin" }),
    ).toThrow(EmbeddingModelManifestError);
    expect(() =>
      resolveModelFileAt("/tmp/model", { path: "C:\\abs.bin" }),
    ).toThrow(EmbeddingModelManifestError);
  });
});

describe("assertSafeModelRelativePath", () => {
  test("accepts nested POSIX paths and normalises separators", () => {
    expect(assertSafeModelRelativePath("onnx/model_q8.onnx")).toBe(
      "onnx/model_q8.onnx",
    );
    expect(assertSafeModelRelativePath("tokenizer.json")).toBe(
      "tokenizer.json",
    );
  });

  test("rejects absolute, drive, UNC, backslash and dot-dot paths", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "C:\\model.onnx",
      "\\\\server\\share\\model.onnx",
      "onnx\\model.onnx",
      "../model.onnx",
      "onnx/../../model.onnx",
      "onnx//model.onnx",
      "./model.onnx",
    ]) {
      expect(() => assertSafeModelRelativePath(path)).toThrow(
        EmbeddingModelManifestError,
      );
    }
  });
});

describe("validateModelManifest", () => {
  test("accepts a well-formed pinned manifest", () => {
    expect(validateModelManifest(pinnedManifest())).toBeInstanceOf(Object);
  });

  test("rejects inconsistent integrityPinned", () => {
    const manifest = pinnedManifest({
      files: [
        { path: "tokenizer.json", bytes: 1, sha256: null },
        { path: "onnx/model.onnx", bytes: 2, sha256: digest("w") },
      ],
    });
    expect(() => validateModelManifest(manifest)).toThrow(
      /integrityPinned=true disagrees/,
    );
    expect(() => validateModelManifest(pinnedManifest())).not.toThrow();
  });

  test("rejects duplicate files, duplicated sources and malformed digests", () => {
    const duplicateFiles = pinnedManifest({
      files: [
        { path: "tokenizer.json", bytes: 1, sha256: digest("a") },
        { path: "tokenizer.json", bytes: 2, sha256: digest("b") },
        { path: "onnx/model.onnx", bytes: 3, sha256: digest("c") },
      ],
    });
    expect(() => validateModelManifest(duplicateFiles)).toThrow(
      /more than once/,
    );

    const duplicateSources = pinnedManifest({
      sources: [
        EMBEDDING_MODEL_SOURCES.hfMirror,
        EMBEDDING_MODEL_SOURCES.hfMirror,
      ],
    });
    expect(() => validateModelManifest(duplicateSources)).toThrow(
      EmbeddingModelManifestError,
    );

    const badDigest = pinnedManifest({
      files: [
        { path: "tokenizer.json", bytes: 1, sha256: "not-a-digest" },
        { path: "onnx/model.onnx", bytes: 2, sha256: digest("c") },
      ],
    });
    expect(() => validateModelManifest(badDigest)).toThrow(/malformed sha256/);
  });

  test("rejects manifests without exactly one onnx file and one tokenizer", () => {
    const noTokenizer = pinnedManifest({
      files: [{ path: "onnx/model.onnx", bytes: 2, sha256: digest("c") }],
    });
    expect(() => validateModelManifest(noTokenizer)).toThrow(/tokenizer\.json/);

    const twoOnnx = pinnedManifest({
      files: [
        { path: "tokenizer.json", bytes: 1, sha256: digest("a") },
        { path: "onnx/a.onnx", bytes: 2, sha256: digest("b") },
        { path: "onnx/b.onnx", bytes: 3, sha256: digest("c") },
      ],
    });
    expect(() => validateModelManifest(twoOnnx)).toThrow(/exactly one \.onnx/);
  });

  test("rejects a non-https licence URL and unsafe ids", () => {
    const badLicence = pinnedManifest({
      license: {
        ...BGE_ZH_LICENSE,
        url: "http://example.com/licence",
      },
    });
    expect(() => validateModelManifest(badLicence)).toThrow(/must use https/);

    const badId = pinnedManifest({ id: "../escape" });
    expect(() => validateModelManifest(badId)).toThrow(/safe cache directory/);
  });

  test("rejects an npm source without package name/version", () => {
    const manifest = pinnedManifest({
      sources: [
        {
          id: "npm",
          kind: "npm",
          urlTemplate: EMBEDDING_MODEL_SOURCES.npm.urlTemplate,
        },
      ],
    });
    expect(() => validateModelManifest(manifest)).toThrow(/packageName/);
  });

  test("rejects a template without {path}", () => {
    const manifest = pinnedManifest({
      sources: [
        {
          id: "bad-template",
          kind: "hf",
          urlTemplate: "https://example.com/{repo}/latest",
        },
      ],
    });
    expect(() => validateModelManifest(manifest)).toThrow(
      /must contain \{path\}/,
    );
  });

  test("supports adding a future model without touching the resolver", () => {
    const future = pinnedManifest({
      id: "future-model",
      displayName: "future",
      dimensions: 1_024,
      quantization: "q8",
    });
    validateModelManifest(future);
    const resolved = resolveModelFiles("future-model", {
      manifest: future,
      modelDir: makeTempDir("hryk-model-future-"),
    });
    expect(resolved.manifest.id).toBe("future-model");
    expect(resolved.files).toHaveLength(2);
  });
});
