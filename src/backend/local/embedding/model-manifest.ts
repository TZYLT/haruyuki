/**
 * Built-in embedding model manifests (48-2 §3.3 C4, 48-1 §6.4/R-23/R-35).
 *
 * **What this module is.** The weights are never bundled with the npm package
 * (48-1 R-11); they are downloaded on first enable into
 * `<harness cache>/embedding/models/<modelId>/` and loaded from there by the
 * child process. This module is the static half of that contract: which model
 * ids exist, which files each one needs, how large each file is, what sha256
 * locks it, which licence applies, and how a file's URL is built per source.
 * It performs no I/O and never reads the network — everything a download or a
 * wizard needs to display (size, source, licence) is a plain value here.
 *
 * **Source order.** 48-2 O-16 fixes `hf-mirror → HF official → ModelScope`
 * with one sha256 shared by all three (the ONNX weights are content-addressed,
 * so the mirror and ModelScope return the same LFS object). The URL template is
 * a field, not a hard-coded URL builder, so an npm-hosted copy can be appended
 * later without touching the downloader; `buildModelFileUrl` already understands
 * the `npm` kind. What is *not* guessed is data: sources and digests are listed
 * only when they were verified during the 48-2 reconnaissance.
 *
 * **Why sha256 may be `null`.** A manifest entry whose digest is not available
 * carries `sha256: null` together with `integrityPinned: false`; the manifest
 * never invents a digest. `model-download.ts` refuses to fetch an unpinned model
 * unless the caller explicitly accepts size-only verification (48-1 §6.4).
 *
 * **C8 additions.** `bge-m3` and `Qwen3-Embedding-0.6B` (48-1 R-23) are declared
 * below; no per-file size or sha256 was verified for either, so those fields stay
 * `null`, `integrityPinned` is `false`, and the default fetch path refuses them.
 *
 * **Where the built-in numbers come from (2026-11-04).** The sizes and the q8
 * weights' sha256 were read from the Hugging Face model-file metadata JSON for
 * `Xenova/bge-small-zh-v1.5` (the transformers.js ONNX conversion of
 * `BAAI/bge-small-zh-v1.5`), served by the hf-mirror deployment:
 *
 *   https://hf-mirror.com/api/models/Xenova/bge-small-zh-v1.5?blobs=true
 *
 * The three JSON files are stored as ordinary git blobs, not LFS objects, so
 * that API reports no sha256 for them; their digests stay `null` until a trusted
 * source supplies them (ModelScope's repo-files API does list a `Sha256`, and a
 * manual import records the hash it computed). No weights were downloaded to
 * produce this table; only the metadata JSON above was read.
 *
 * Layer: `backend/local/`. Imports only the sibling cache-path resolver
 * (`./secrets`) and `node:path`; no higher-layer or domain imports.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getEmbeddingModelDir } from "./secrets";

/**
 * Model id selected by the D3 settings default (`recallEmbeddingModel`) and by
 * 48-1 §5.2 for the low/standard tiers. The id doubles as the cache directory
 * name, so it must satisfy {@link MODEL_ID_PATTERN}.
 */
export const defaultModelId = "bge-small-zh-v1.5";

/** Highest embedding dimension any built-in model currently produces. */
export const EMBEDDING_MODEL_MAX_DIMENSIONS = 1_024;

/** Quantisation of one shipped ONNX graph. */
export type EmbeddingModelQuantization = "q8" | "fp32";

/**
 * Token pooling strategy: mask-weighted mean (bge-small, C3 parity), CLS
 * (bge-m3 dense retrieval) or the last unmasked token (Qwen3-Embedding).
 */
export type EmbeddingModelPooling = "mean" | "cls" | "last";

/** Pattern for a model id: one safe path segment (it becomes a directory). */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A sha256 digest is 64 lowercase hex characters. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Pooling strategies a manifest may declare; see {@link EmbeddingModelPooling}. */
const POOLING_STRATEGIES: ReadonlySet<string> = new Set([
  "mean",
  "cls",
  "last",
]);

/** Quantisations a manifest may declare; see {@link EmbeddingModelQuantization}. */
const QUANTIZATIONS: ReadonlySet<string> = new Set(["q8", "fp32"]);

/** Placeholders understood by a source URL template. */
const URL_TEMPLATE_PLACEHOLDER = /\{(repo|path|file|package|version)\}/g;

/**
 * How the weight files are fetched: `hf` is a Hugging Face-style resolve URL
 * (hf-mirror, huggingface.co, ModelScope); `npm` is an unpkg-style package URL.
 */
export type EmbeddingModelSourceKind = "hf" | "npm";

/** One fetchable source for a model's files, in priority order. */
export interface EmbeddingModelSource {
  /** Short id recorded in install manifests, warnings and errors. */
  readonly id: string;
  readonly kind: EmbeddingModelSourceKind;
  /**
   * URL template with `{repo}`, `{path}`, `{file}`, `{package}` and `{version}`
   * placeholders; `{path}` is mandatory and the result must be https (or http
   * on a loopback host).
   */
  readonly urlTemplate: string;
  /** npm package name; required when `kind` is `"npm"`. */
  readonly packageName?: string;
  /** npm package version; required when `kind` is `"npm"`. */
  readonly packageVersion?: string;
}

/** One file a model install needs, relative to the model directory. */
export interface EmbeddingModelFile {
  /**
   * POSIX-style path inside the model directory (`onnx/model_quantized.onnx`).
   * Validated by {@link assertSafeModelRelativePath}: no absolute paths, no
   * `..` segments, no backslashes.
   */
  readonly path: string;
  /** Exact byte size when known; `null` when not pinned by reconnaissance. */
  readonly bytes: number | null;
  /** Lowercase hex sha256 when known; `null` when not pinned. */
  readonly sha256: string | null;
  /**
   * The download URL the size/hash were recorded from, when a value is pinned
   * (documentation only; `buildModelFileUrl` derives the per-source URL).
   */
  readonly sourceUrl?: string;
  /** Optional files may be missing without failing the install. */
  readonly optional?: boolean;
}

/** Licence metadata shown by the wizard before a download (48-1 §6.4). */
export interface EmbeddingModelLicense {
  /** SPDX identifier (`MIT`, `Apache-2.0`). */
  readonly id: string;
  readonly name: string;
  /** Canonical licence URL (https). */
  readonly url: string;
  /** Whether the weights may be redistributed; true only for permissive terms. */
  readonly redistributable: boolean;
  /** One-line disclosure surfaced next to the download confirmation. */
  readonly notice: string;
  /** Full licence text when it is short enough to embed (`MIT`). */
  readonly text: string | null;
}

/** Everything the downloader and the UI need to know about one model. */
export interface EmbeddingModelManifest {
  /** Stable model id; also the cache directory name. */
  readonly id: string;
  readonly displayName: string;
  /** Hugging Face repository id (`org/name`). */
  readonly repository: string;
  /** Embedding dimension the model produces (space id input). */
  readonly dimensions: number;
  /** Maximum token count the model was trained for (`512` for bge-small). */
  readonly maxTokens: number;
  /** ONNX input names in the order the featurizer feeds them. */
  readonly inputNames: readonly string[];
  /** Pooling strategy the model's embedding head expects (48-1 §6.4). */
  readonly pooling: EmbeddingModelPooling;
  /** Vectors are L2-normalised and compared by inner product. */
  readonly normalize: true;
  /** Query-side instruction, appended to the query text only (O-07). */
  readonly queryInstruction: string | null;
  /** Document-side instruction; `null` for the bge retrieval models. */
  readonly documentInstruction: string | null;
  readonly license: EmbeddingModelLicense;
  readonly files: readonly EmbeddingModelFile[];
  /** Sources in fallback order (§6.4: hf-mirror → HF → ModelScope). */
  readonly sources: readonly EmbeddingModelSource[];
  /** Quantisation of the shipped ONNX graph. */
  readonly quantization: EmbeddingModelQuantization;
  /**
   * Quantisation variants the manifest knows exist for this model; the file set
   * declared above is the {@link quantization} one, and the list must include it.
   */
  readonly variants?: readonly EmbeddingModelQuantization[];
  /**
   * True only when every required file carries a sha256; a `false` manifest is
   * still usable with an explicit size-only opt-in but the default path refuses.
   */
  readonly integrityPinned: boolean;
  /** Free-form notes surfaced in status output / the deviation record. */
  readonly notes?: readonly string[];
}

/** A resolved file plus its absolute destination. */
export interface ResolvedEmbeddingModelFile extends EmbeddingModelFile {
  /** Absolute path below the model directory. */
  readonly absolutePath: string;
}

/** Result of {@link resolveModelFiles}. */
export interface ResolvedEmbeddingModelFiles {
  readonly manifest: EmbeddingModelManifest;
  readonly modelDir: string;
  readonly files: readonly ResolvedEmbeddingModelFile[];
  /** Absolute ONNX weights path (the one `.onnx` file). */
  readonly modelPath: string;
  /** Absolute tokenizer JSON path. */
  readonly tokenizerPath: string;
}

/** Why a manifest operation failed. */
export type EmbeddingModelManifestErrorKind =
  | "duplicate-file"
  | "duplicate-source"
  | "invalid-field"
  | "invalid-path"
  | "invalid-template"
  | "missing-file"
  | "unknown-model";

/** Typed manifest failure; `field` points at the offending value when known. */
export class EmbeddingModelManifestError extends Error {
  readonly kind: EmbeddingModelManifestErrorKind;
  readonly modelId: string | undefined;
  readonly field: string | undefined;

  constructor(
    kind: EmbeddingModelManifestErrorKind,
    message: string,
    options: { modelId?: string; field?: string } = {},
  ) {
    super(message);
    this.name = "EmbeddingModelManifestError";
    this.kind = kind;
    this.modelId = options.modelId;
    this.field = options.field;
  }
}

/** How well a manifest's files are locked by sha256. */
export interface EmbeddingModelIntegrityStatus {
  /** `"sha256"` only when every required file has a digest. */
  readonly integrity: "sha256" | "unverified";
  /** Required file paths whose `sha256` is not pinned. */
  readonly missingSha256: readonly string[];
  /** Required file paths whose exact `bytes` are not pinned. */
  readonly missingBytes: readonly string[];
}

/**
 * The MIT licence under which `BAAI/bge-small-zh-v1.5` is published. The ONNX
 * conversion (`Xenova/*`) is a derivative of those weights and keeps the same
 * terms; the notice names the upstream authors, not the converter.
 */
export const BGE_ZH_LICENSE: EmbeddingModelLicense = {
  id: "MIT",
  name: "MIT License",
  url: "https://opensource.org/licenses/MIT",
  redistributable: true,
  notice:
    "MIT. Weights are downloaded, never shipped in the npm package; attribution: BAAI/bge-small-zh-v1.5.",
  text: `MIT License

Copyright (c) 2023 Beijing Academy of Artificial Intelligence (BAAI)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
};

/** MIT terms for `BAAI/bge-m3`; the Xenova ONNX conversion keeps them. */
export const BGE_M3_LICENSE: EmbeddingModelLicense = {
  ...BGE_ZH_LICENSE,
  notice:
    "MIT. Weights are downloaded, never shipped in the npm package; attribution: BAAI/bge-m3.",
};

/** Apache-2.0 terms of `Qwen/Qwen3-Embedding-0.6B` (48-1 §5.2/§6.4). */
export const QWEN3_EMBEDDING_LICENSE: EmbeddingModelLicense = {
  id: "Apache-2.0",
  name: "Apache License 2.0",
  url: "https://www.apache.org/licenses/LICENSE-2.0",
  redistributable: true,
  notice:
    "Apache-2.0. Weights are downloaded, never shipped in the npm package; attribution: Qwen/Qwen3-Embedding-0.6B.",
  text: null,
};

/**
 * Source templates. Kept as named values so a manifest and a test refer to the
 * same template instead of duplicating URL syntax. The npm template is present
 * for an npm-hosted copy of the weights; no built-in model uses it yet because
 * no such package was confirmed during reconnaissance.
 */
export const EMBEDDING_MODEL_SOURCES = {
  hfMirror: {
    id: "hf-mirror",
    kind: "hf",
    urlTemplate: "https://hf-mirror.com/{repo}/resolve/main/{path}",
  },
  huggingface: {
    id: "huggingface",
    kind: "hf",
    urlTemplate: "https://huggingface.co/{repo}/resolve/main/{path}",
  },
  modelscope: {
    id: "modelscope",
    kind: "hf",
    urlTemplate: "https://modelscope.cn/models/{repo}/resolve/master/{path}",
  },
  npm: {
    id: "npm",
    kind: "npm",
    urlTemplate: "https://unpkg.com/{package}@{version}/{path}",
  },
} as const satisfies Record<string, EmbeddingModelSource>;

/** Fallback order every built-in model declares (§6.4: mirror first). */
const BUILTIN_MODEL_SOURCES: readonly EmbeddingModelSource[] = [
  EMBEDDING_MODEL_SOURCES.hfMirror,
  EMBEDDING_MODEL_SOURCES.huggingface,
  EMBEDDING_MODEL_SOURCES.modelscope,
];

/**
 * One required file plus its hf-mirror provenance URL; `null` bytes/sha256 mean
 * never verified (48-2 O-17), which forces `integrityPinned: false`.
 */
function modelFile(
  path: string,
  repository: string,
  bytes: number | null,
  sha256: string | null,
): EmbeddingModelFile {
  return {
    path,
    bytes,
    sha256,
    sourceUrl: `https://hf-mirror.com/${repository}/resolve/main/${path}`,
  };
}

/**
 * `bge-small-zh-v1.5` (512d, MIT). The ONNX repository is the `Xenova/…`
 * conversion the 48-2 reconnaissance measured; sizes and the q8 sha256 are the
 * 2026-11-04 hf-mirror metadata values and the three JSON files stay `null`.
 */
const BGE_SMALL_ZH_REPOSITORY = "Xenova/bge-small-zh-v1.5";

const BGE_SMALL_ZH_MANIFEST: EmbeddingModelManifest = {
  id: defaultModelId,
  displayName: "bge-small-zh-v1.5 (q8)",
  repository: BGE_SMALL_ZH_REPOSITORY,
  dimensions: 512,
  maxTokens: 512,
  inputNames: ["input_ids", "attention_mask", "token_type_ids"],
  pooling: "mean",
  normalize: true,
  queryInstruction: "为这个句子生成表示以用于检索相关文章：",
  documentInstruction: null,
  license: BGE_ZH_LICENSE,
  files: [
    modelFile("config.json", BGE_SMALL_ZH_REPOSITORY, 716, null),
    modelFile("tokenizer.json", BGE_SMALL_ZH_REPOSITORY, 439_125, null),
    modelFile("tokenizer_config.json", BGE_SMALL_ZH_REPOSITORY, 367, null),
    modelFile(
      "onnx/model_quantized.onnx",
      BGE_SMALL_ZH_REPOSITORY,
      24_010_842,
      "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
    ),
  ],
  sources: BUILTIN_MODEL_SOURCES,
  quantization: "q8",
  variants: ["q8", "fp32"],
  integrityPinned: false,
  notes: [
    "Sizes and the q8 sha256 read from https://hf-mirror.com/api/models/Xenova/bge-small-zh-v1.5?blobs=true on 2026-11-04; no weights were downloaded.",
    "config.json/tokenizer.json/tokenizer_config.json are non-LFS blobs, so that API exposes no sha256; they stay null until pinned (ModelScope lists a Sha256, or record a manual import's computed hash).",
    "ModelScope mirrors this repo; hf-mirror and ModelScope serve the same LFS object for onnx/model_quantized.onnx.",
  ],
};

/** The four-file set every built-in ONNX conversion installs (48-2 §4.4). */
const MODEL_FILE_PATHS = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
] as const;

/** `bge-m3` (1024d, MIT): `Xenova/bge-m3` ONNX conversion (XLM-R inputs only),
 * CLS pooling; the 48-2 reconnaissance read no per-file size or digest. */
const BGE_M3_MANIFEST: EmbeddingModelManifest = {
  id: "bge-m3",
  displayName: "bge-m3 (q8)",
  repository: "Xenova/bge-m3",
  dimensions: 1_024,
  maxTokens: 8_192,
  inputNames: ["input_ids", "attention_mask"],
  pooling: "cls",
  normalize: true,
  queryInstruction: null,
  documentInstruction: null,
  license: BGE_M3_LICENSE,
  files: MODEL_FILE_PATHS.map((path) =>
    modelFile(path, "Xenova/bge-m3", null, null),
  ),
  sources: BUILTIN_MODEL_SOURCES,
  quantization: "q8",
  variants: ["q8"],
  integrityPinned: false,
  notes: [
    "C8 reconnaissance loaded Xenova/bge-m3 (1024d, XLM-R, ~560MB cache) but read no per-file bytes or sha256, so every pinned field is null (48-2 O-17); G17 external `.onnx_data` weights must be part of the pinned set.",
  ],
};

/**
 * `Qwen3-Embedding-0.6B` (1024d, Apache-2.0; experimental/manual in 48-1 §5.2:
 * 613MB weights plus ~2.09GB external data). The `onnx-community` conversion and
 * its file set are unverified (O-17), so the entry is unpinned. Queries use the
 * model card's instruct prefix, documents none, pooling is the last token.
 */
const QWEN3_EMBEDDING_MANIFEST: EmbeddingModelManifest = {
  id: "qwen3-embedding-0.6b",
  displayName: "Qwen3-Embedding-0.6B (q8, experimental)",
  repository: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
  dimensions: 1_024,
  maxTokens: 32_768,
  inputNames: ["input_ids", "attention_mask"],
  pooling: "last",
  normalize: true,
  queryInstruction:
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
  documentInstruction: null,
  license: QWEN3_EMBEDDING_LICENSE,
  files: MODEL_FILE_PATHS.map((path) =>
    modelFile(path, "onnx-community/Qwen3-Embedding-0.6B-ONNX", null, null),
  ),
  sources: BUILTIN_MODEL_SOURCES,
  quantization: "q8",
  variants: ["q8"],
  integrityPinned: false,
  notes: [
    "O-17 left the Qwen3 ONNX conversion repository and file set unverified; the upstream card is Qwen/Qwen3-Embedding-0.6B (Apache-2.0) and the 2.09GB `.onnx_data` sidecar (G17) must join the pinned set before enabling.",
  ],
};

/**
 * Every model this build knows about. `bge-m3` and `Qwen3-Embedding-0.6B`
 * (48-1 R-23) are C8's manifests; the table is append-only so adding them does
 * not touch the downloader.
 */
export const BUILTIN_EMBEDDING_MODELS: readonly EmbeddingModelManifest[] = [
  BGE_SMALL_ZH_MANIFEST,
  BGE_M3_MANIFEST,
  QWEN3_EMBEDDING_MANIFEST,
];
/** Model ids available in this build. */
export function listBuiltinModelIds(): string[] {
  return BUILTIN_EMBEDDING_MODELS.map((manifest) => manifest.id);
}

/**
 * Look up a built-in manifest. An unknown id lists the ids this build knows so
 * a settings typo produces an actionable message.
 */
export function getBuiltinModelManifest(
  modelId: string = defaultModelId,
): EmbeddingModelManifest {
  const found = BUILTIN_EMBEDDING_MODELS.find(
    (manifest) => manifest.id === modelId,
  );
  if (found === undefined) {
    throw new EmbeddingModelManifestError(
      "unknown-model",
      `Unknown embedding model ${JSON.stringify(modelId)}; this build knows ${listBuiltinModelIds().join(", ")}.`,
      { modelId },
    );
  }
  return found;
}

/**
 * Validate a manifest (built-in or injected) and return it unchanged. Download
 * and import both run this before using a manifest, so a hand-written test or a
 * C8 manifest cannot smuggle a traversing path, a duplicated file or an
 * unusable source into the fetch path.
 */
export function validateModelManifest(
  manifest: EmbeddingModelManifest,
): EmbeddingModelManifest {
  if (typeof manifest.id !== "string" || !MODEL_ID_PATTERN.test(manifest.id)) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model id ${JSON.stringify(manifest.id)} is not a safe cache directory name.`,
      { field: "id" },
    );
  }
  if (
    typeof manifest.repository !== "string" ||
    manifest.repository.length === 0
  ) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      "Model manifest has no repository.",
      { modelId: manifest.id, field: "repository" },
    );
  }
  assertPositiveInteger(manifest.dimensions, "dimensions", manifest.id);
  if (manifest.dimensions > EMBEDDING_MODEL_MAX_DIMENSIONS) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${manifest.id} declares ${manifest.dimensions} dimensions, above the supported maximum of ${EMBEDDING_MODEL_MAX_DIMENSIONS}.`,
      { modelId: manifest.id, field: "dimensions" },
    );
  }
  assertPositiveInteger(manifest.maxTokens, "maxTokens", manifest.id);
  if (!Array.isArray(manifest.inputNames) || manifest.inputNames.length === 0) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${manifest.id} must declare at least one ONNX input name.`,
      { modelId: manifest.id, field: "inputNames" },
    );
  }
  if (
    !POOLING_STRATEGIES.has(manifest.pooling) ||
    manifest.normalize !== true
  ) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${manifest.id} declares an unsupported pooling strategy or does not normalise (48-1 §6.4).`,
      { modelId: manifest.id, field: "pooling" },
    );
  }
  const variants = manifest.variants ?? [manifest.quantization];
  if (
    !QUANTIZATIONS.has(manifest.quantization) ||
    variants.length === 0 ||
    new Set(variants).size !== variants.length ||
    variants.some((variant) => !QUANTIZATIONS.has(variant)) ||
    !variants.includes(manifest.quantization)
  ) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${manifest.id} must declare a known quantization and a duplicate-free variants list that includes it.`,
      { modelId: manifest.id, field: "variants" },
    );
  }
  validateLicense(manifest.license, manifest.id);
  validateFiles(manifest);
  validateSources(manifest);
  const status = computeIntegrityStatus(manifest);
  if (manifest.integrityPinned !== (status.integrity === "sha256")) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${manifest.id} integrityPinned=${String(manifest.integrityPinned)} disagrees with its files (${status.integrity}); flip the flag when the digests are pinned.`,
      { modelId: manifest.id, field: "integrityPinned" },
    );
  }
  return manifest;
}

function validateLicense(
  license: EmbeddingModelLicense,
  modelId: string,
): void {
  if (
    typeof license.id !== "string" ||
    license.id.length === 0 ||
    typeof license.name !== "string" ||
    typeof license.notice !== "string" ||
    license.notice.length === 0
  ) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${modelId} must carry a licence id, name and notice for the download confirmation.`,
      { modelId, field: "license" },
    );
  }
  assertHttpsUrl(license.url, modelId, "license.url");
}

function validateFiles(manifest: EmbeddingModelManifest): void {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${manifest.id} declares no files.`,
      { modelId: manifest.id, field: "files" },
    );
  }
  const seen = new Set<string>();
  let onnxFiles = 0;
  let tokenizerFiles = 0;
  for (const file of manifest.files) {
    assertSafeModelRelativePath(file.path, manifest.id);
    if (seen.has(file.path)) {
      throw new EmbeddingModelManifestError(
        "duplicate-file",
        `Model ${manifest.id} lists ${file.path} more than once.`,
        { modelId: manifest.id, field: "files" },
      );
    }
    seen.add(file.path);
    if (file.bytes !== null) {
      assertPositiveInteger(
        file.bytes,
        `files.${file.path}.bytes`,
        manifest.id,
      );
    }
    if (file.sha256 !== null && !SHA256_PATTERN.test(file.sha256)) {
      throw new EmbeddingModelManifestError(
        "invalid-field",
        `Model ${manifest.id} file ${file.path} has a malformed sha256 (expected 64 lowercase hex characters).`,
        { modelId: manifest.id, field: "files.sha256" },
      );
    }
    if (file.sourceUrl !== undefined) {
      assertHttpsUrl(
        file.sourceUrl,
        manifest.id,
        `files.${file.path}.sourceUrl`,
      );
    }
    if (/\.onnx$/i.test(file.path)) onnxFiles += 1;
    if (
      file.path === "tokenizer.json" ||
      file.path.endsWith("/tokenizer.json")
    ) {
      tokenizerFiles += 1;
    }
  }
  if (onnxFiles !== 1) {
    throw new EmbeddingModelManifestError(
      "missing-file",
      `Model ${manifest.id} must declare exactly one .onnx weights file (found ${onnxFiles}).`,
      { modelId: manifest.id, field: "files" },
    );
  }
  if (tokenizerFiles !== 1) {
    throw new EmbeddingModelManifestError(
      "missing-file",
      `Model ${manifest.id} must declare exactly one tokenizer.json (found ${tokenizerFiles}).`,
      { modelId: manifest.id, field: "files" },
    );
  }
}

function validateSources(manifest: EmbeddingModelManifest): void {
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${manifest.id} declares no download sources.`,
      { modelId: manifest.id, field: "sources" },
    );
  }
  const seen = new Set<string>();
  for (const source of manifest.sources) {
    if (typeof source.id !== "string" || source.id.length === 0) {
      throw new EmbeddingModelManifestError(
        "invalid-field",
        `Model ${manifest.id} has a source without an id.`,
        { modelId: manifest.id, field: "sources" },
      );
    }
    if (seen.has(source.id)) {
      throw new EmbeddingModelManifestError(
        "duplicate-source",
        `Model ${manifest.id} lists source ${source.id} more than once.`,
        { modelId: manifest.id, field: "sources" },
      );
    }
    seen.add(source.id);
    if (source.kind !== "hf" && source.kind !== "npm") {
      throw new EmbeddingModelManifestError(
        "invalid-field",
        `Model ${manifest.id} source ${source.id} has an unknown kind.`,
        { modelId: manifest.id, field: "sources.kind" },
      );
    }
    if (!source.urlTemplate.includes("{path}")) {
      throw new EmbeddingModelManifestError(
        "invalid-template",
        `Model ${manifest.id} source ${source.id} URL template must contain {path}.`,
        { modelId: manifest.id, field: "sources.urlTemplate" },
      );
    }
    if (
      source.kind === "npm" &&
      (typeof source.packageName !== "string" ||
        typeof source.packageVersion !== "string")
    ) {
      throw new EmbeddingModelManifestError(
        "invalid-template",
        `Model ${manifest.id} source ${source.id} is an npm source without packageName/packageVersion.`,
        { modelId: manifest.id, field: "sources" },
      );
    }
    // Build once so a template that cannot form a safe URL fails here, not at
    // download time on the user's machine.
    buildModelFileUrl(source, manifest, manifest.files[0]?.path ?? "unused");
  }
}

/**
 * Validate one relative path inside a model directory and return it normalised
 * to POSIX separators. Rejects absolute paths, drive letters, UNC prefixes and
 * any `..` segment — the destination is joined below a cache directory, so a
 * manifest is as untrusted as downloaded metadata (48-2 §4.4).
 */
export function assertSafeModelRelativePath(
  filePath: string,
  modelId?: string,
): string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new EmbeddingModelManifestError(
      "invalid-path",
      "A model file path must be a non-empty string.",
      { modelId, field: "files.path" },
    );
  }
  if (
    filePath.includes("\\") ||
    isAbsolute(filePath) ||
    /^[A-Za-z]:/.test(filePath) ||
    filePath.startsWith("//") ||
    filePath.startsWith("/")
  ) {
    throw new EmbeddingModelManifestError(
      "invalid-path",
      `Model file path ${JSON.stringify(filePath)} must be relative and use forward slashes.`,
      { modelId, field: "files.path" },
    );
  }
  const segments = filePath.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new EmbeddingModelManifestError(
        "invalid-path",
        `Model file path ${JSON.stringify(filePath)} contains an unsafe segment.`,
        { modelId, field: "files.path" },
      );
    }
    if (segment.includes(":")) {
      throw new EmbeddingModelManifestError(
        "invalid-path",
        `Model file path ${JSON.stringify(filePath)} contains a drive/stream separator.`,
        { modelId, field: "files.path" },
      );
    }
  }
  return segments.join("/");
}

/**
 * Build the absolute URL for one file on one source. `{repo}`, `{path}`,
 * `{file}`, `{package}` and `{version}` are substituted; the result must be
 * https, or http on a loopback host so a local mirror works. Credentials in the
 * URL and non-http(s) schemes are refused (a model manifest is static data, and
 * an embedded token would leak through every error message).
 */
export function buildModelFileUrl(
  source: EmbeddingModelSource,
  manifest: EmbeddingModelManifest,
  filePath: string,
): string {
  const placeholderValues: Record<string, string> = {
    repo: manifest.repository,
    path: filePath,
    file: filePath.split("/").pop() ?? filePath,
    package: source.packageName ?? "",
    version: source.packageVersion ?? "",
  };
  const replaced = source.urlTemplate.replace(
    URL_TEMPLATE_PLACEHOLDER,
    (match, name: string) => {
      const value = placeholderValues[name];
      if (value === undefined) return match;
      return value;
    },
  );
  if (replaced.includes("{") || replaced.includes("}")) {
    throw new EmbeddingModelManifestError(
      "invalid-template",
      `Model ${manifest.id} source ${source.id} has an unsupported placeholder in ${JSON.stringify(source.urlTemplate)}.`,
      { modelId: manifest.id, field: "sources.urlTemplate" },
    );
  }
  let url: URL;
  try {
    url = new URL(replaced);
  } catch {
    throw new EmbeddingModelManifestError(
      "invalid-template",
      `Model ${manifest.id} source ${source.id} produced an invalid URL.`,
      { modelId: manifest.id, field: "sources.urlTemplate" },
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new EmbeddingModelManifestError(
      "invalid-template",
      `Model ${manifest.id} source ${source.id} URL must not embed credentials.`,
      { modelId: manifest.id, field: "sources.urlTemplate" },
    );
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return url.toString();
  }
  throw new EmbeddingModelManifestError(
    "invalid-template",
    `Model ${manifest.id} source ${source.id} URL must use https (or http on loopback).`,
    { modelId: manifest.id, field: "sources.urlTemplate" },
  );
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Whether every required file is locked by a sha256, and which files are still
 * missing a digest or a pinned size. The downloader uses this to refuse network
 * access it could not verify; the wizard uses it for the "checksum not pinned"
 * disclosure.
 */
export function getModelIntegrityStatus(
  manifest: EmbeddingModelManifest = getBuiltinModelManifest(),
): EmbeddingModelIntegrityStatus {
  return computeIntegrityStatus(manifest);
}

function computeIntegrityStatus(
  manifest: EmbeddingModelManifest,
): EmbeddingModelIntegrityStatus {
  const missingSha256: string[] = [];
  const missingBytes: string[] = [];
  for (const file of manifest.files) {
    if (file.optional === true) continue;
    if (file.sha256 === null) missingSha256.push(file.path);
    if (file.bytes === null) missingBytes.push(file.path);
  }
  return {
    integrity: missingSha256.length === 0 ? "sha256" : "unverified",
    missingSha256,
    missingBytes,
  };
}

/**
 * Resolve a model's files and the model directory. `modelDir` defaults to
 * `<embedding models dir>/<modelId>` through the call-time cache resolver in
 * `./secrets` (so `HARUYUKI_HOME` moves it); tests and callers that manage
 * their own root can pass an explicit directory. Only paths are computed here —
 * nothing is read or written.
 */
export function resolveModelFiles(
  modelId: string = defaultModelId,
  options: {
    readonly modelDir?: string;
    readonly manifest?: EmbeddingModelManifest;
  } = {},
): ResolvedEmbeddingModelFiles {
  const manifest =
    options.manifest === undefined
      ? getBuiltinModelManifest(modelId)
      : validateModelManifest(options.manifest);
  if (options.manifest === undefined && manifest.id !== modelId) {
    throw new EmbeddingModelManifestError(
      "unknown-model",
      `Resolved manifest ${manifest.id} does not match the requested model ${modelId}.`,
      { modelId },
    );
  }
  const modelDir = options.modelDir ?? getEmbeddingModelDir(manifest.id);
  const resolvedDir = resolve(modelDir);
  const files: ResolvedEmbeddingModelFile[] = manifest.files.map((file) => {
    const relativePath = assertSafeModelRelativePath(file.path, manifest.id);
    const absolutePath = resolve(resolvedDir, ...relativePath.split("/"));
    if (!isInside(resolvedDir, absolutePath)) {
      throw new EmbeddingModelManifestError(
        "invalid-path",
        `Model ${manifest.id} file ${file.path} escapes the model directory.`,
        { modelId: manifest.id, field: "files.path" },
      );
    }
    return { ...file, absolutePath };
  });
  const onnxFiles = files.filter((file) => /\.onnx$/i.test(file.path));
  const tokenizerFiles = files.filter(
    (file) =>
      file.path === "tokenizer.json" || file.path.endsWith("/tokenizer.json"),
  );
  const modelFile = onnxFiles[0];
  const tokenizerFile = tokenizerFiles[0];
  if (modelFile === undefined || tokenizerFile === undefined) {
    throw new EmbeddingModelManifestError(
      "missing-file",
      `Model ${manifest.id} is missing its ONNX weights or tokenizer.json.`,
      { modelId: manifest.id },
    );
  }
  return {
    manifest,
    modelDir: resolvedDir,
    files,
    modelPath: modelFile.absolutePath,
    tokenizerPath: tokenizerFile.absolutePath,
  };
}

/** The licence record plus the licence text when the manifest embeds it. */
export interface EmbeddingModelLicenseInfo extends EmbeddingModelLicense {
  readonly modelId: string;
  readonly displayName: string;
}

/**
 * Licence display data for the download confirmation and status output. The
 * text is embedded for short licences (MIT) and `null` when the manifest only
 * carries a URL, so nothing here touches the network.
 */
export function getModelLicenseInfo(
  modelId: string = defaultModelId,
): EmbeddingModelLicenseInfo {
  const manifest = getBuiltinModelManifest(modelId);
  return {
    ...manifest.license,
    modelId: manifest.id,
    displayName: manifest.displayName,
  };
}

function assertPositiveInteger(
  value: number,
  field: string,
  modelId: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${modelId} field ${field} must be a positive integer (received ${String(value)}).`,
      { modelId, field },
    );
  }
}

function assertHttpsUrl(value: string, modelId: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${modelId} field ${field} is not a valid URL.`,
      { modelId, field },
    );
  }
  if (url.protocol !== "https:") {
    throw new EmbeddingModelManifestError(
      "invalid-field",
      `Model ${modelId} field ${field} must use https.`,
      { modelId, field },
    );
  }
}

function isInside(root: string, candidate: string): boolean {
  const nested = relative(resolve(root), resolve(candidate));
  return (
    nested === "" ||
    (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

/** Join a resolved file to an arbitrary root (used by download staging). */
export function resolveModelFileAt(
  rootDir: string,
  file: Pick<EmbeddingModelFile, "path">,
  modelId?: string,
): string {
  const relativePath = assertSafeModelRelativePath(file.path, modelId);
  return join(rootDir, ...relativePath.split("/"));
}
