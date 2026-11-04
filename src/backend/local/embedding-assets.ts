/**
 * Built-in embedding assets: where the model files and the ONNX runtime live,
 * and whether they are installed (feature 48, rework A1).
 *
 * Three questions the wiring needs to answer without starting a worker:
 *
 * 1. **Where are the absolute paths?** {@link resolveEmbeddingBuiltinAssets}
 *    combines the model manifest's declared file list with the call-time cache
 *    resolvers, so `HARUYUKI_HOME` / `--models-dir` overrides move the paths and
 *    no literal harness path is frozen in a constant.
 * 2. **Is this machine ready?** {@link checkEmbeddingBuiltinAssets} reuses the
 *    downloader's own install checks (`isEmbeddingModelInstalled`,
 *    `readEmbeddingRuntimeManifest`) instead of re-deriving "installed": a
 *    second definition would drift the moment the downloader changes.
 * 3. **What should we tell the user?** {@link formatEmbeddingAssetsMissing}
 *    produces the actionable line that points at `/recall embedding setup`.
 *
 * This module performs no download, no spawn and no network access. It reads
 * only stat/JSON metadata through the downloader helpers.
 *
 * Layer: `backend/local/embedding*`. Imports sibling embedding modules only.
 */

import {
  isEmbeddingModelInstalled,
  resolveEmbeddingModelPaths,
} from "@/backend/local/embedding/model-download-install";
import {
  type EmbeddingModelManifest,
  getBuiltinModelManifest,
} from "@/backend/local/embedding/model-manifest";
import {
  DEFAULT_EMBEDDING_RUNTIME_VERSION,
  readEmbeddingRuntimeManifest,
} from "@/backend/local/embedding/runtime-fetch";
import { getEmbeddingRuntimeDir } from "@/backend/local/embedding/secrets";

/** The two assets a built-in encode needs; either can be absent. */
export type EmbeddingMissingAsset = "model" | "runtime";

/** Absolute paths and manifest for one built-in model. */
export interface EmbeddingBuiltinAssets {
  readonly modelId: string;
  /** `<models root>/<modelId>`. */
  readonly modelDir: string;
  /** Absolute ONNX weights path (`onnx/model_quantized.onnx` for the defaults). */
  readonly modelPath: string;
  /** Absolute `tokenizer.json` path. */
  readonly tokenizerPath: string;
  /** Absolute `config.json` path declared by the manifest. */
  readonly configPath: string;
  /** `<cache root>/embedding/runtime/<runtimeVersion>`. */
  readonly runtimeDir: string;
  readonly runtimeVersion: string;
  readonly manifest: EmbeddingModelManifest;
}

/** Options shared by resolution and the install check. */
export interface EmbeddingBuiltinAssetsOptions {
  /** Override the models root; defaults to the call-time cache resolver. */
  readonly modelsDir?: string;
  /** Override the pinned runtime version; defaults to the build's pin. */
  readonly runtimeVersion?: string;
}

/** Why asset path resolution failed. */
export class EmbeddingAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingAssetError";
  }
}

/**
 * Resolve every absolute path a built-in worker needs.
 *
 * Throws {@link EmbeddingAssetError} when the manifest does not declare the
 * files a loader cannot work without (ONNX weights, `tokenizer.json`,
 * `config.json`) or when the build does not know the model id. Unknown-model
 * errors from the manifest are re-thrown unchanged: their message already lists
 * the ids this build supports.
 */
export function resolveEmbeddingBuiltinAssets(
  modelId: string,
  options: EmbeddingBuiltinAssetsOptions = {},
): EmbeddingBuiltinAssets {
  const manifest = getBuiltinModelManifest(modelId);
  const resolved = resolveEmbeddingModelPaths({
    modelId: manifest.id,
    ...(options.modelsDir === undefined
      ? {}
      : { modelsDir: options.modelsDir }),
  });
  if (resolved.modelPath.length === 0) {
    throw new EmbeddingAssetError(
      `Model ${manifest.id} declares no ONNX weights file; the built-in encoder cannot start.`,
    );
  }
  if (resolved.tokenizerPath.length === 0) {
    throw new EmbeddingAssetError(
      `Model ${manifest.id} declares no tokenizer.json; the built-in encoder cannot start.`,
    );
  }
  const configFile = resolved.files.find(
    (file) => file.path === "config.json" || file.path.endsWith("/config.json"),
  );
  if (configFile === undefined) {
    throw new EmbeddingAssetError(
      `Model ${manifest.id} declares no config.json; the built-in encoder cannot start.`,
    );
  }
  const runtimeVersion =
    options.runtimeVersion ?? DEFAULT_EMBEDDING_RUNTIME_VERSION;
  return {
    modelId: manifest.id,
    modelDir: resolved.modelDir,
    modelPath: resolved.modelPath,
    tokenizerPath: resolved.tokenizerPath,
    configPath: configFile.absolutePath,
    runtimeDir: getEmbeddingRuntimeDir(runtimeVersion),
    runtimeVersion,
    manifest,
  };
}

/** Install state plus the resolved paths, so callers format from one object. */
export interface EmbeddingAssetsCheck {
  /** True only when both the model and the runtime are installed. */
  readonly installed: boolean;
  readonly modelInstalled: boolean;
  readonly runtimeInstalled: boolean;
  /** Paths are resolved even when nothing is installed (for display). */
  readonly assets: EmbeddingBuiltinAssets;
  /** Which side is missing, in stable order (`model`, then `runtime`). */
  readonly missing: readonly EmbeddingMissingAsset[];
}

/**
 * Check the built-in model directory and runtime directory without loading
 * either. The model check reuses the installer's marker validation (cheap: no
 * re-hash of the weights) and the runtime check reuses the fetch manifest read.
 */
export async function checkEmbeddingBuiltinAssets(
  modelId: string,
  options: EmbeddingBuiltinAssetsOptions = {},
): Promise<EmbeddingAssetsCheck> {
  const assets = resolveEmbeddingBuiltinAssets(modelId, options);
  const modelInstalled = await isEmbeddingModelInstalled({
    modelId: assets.modelId,
    ...(options.modelsDir === undefined
      ? {}
      : { modelsDir: options.modelsDir }),
  });
  const runtimeManifest = await readEmbeddingRuntimeManifest(
    assets.runtimeVersion,
  );
  const runtimeInstalled = runtimeManifest !== null;
  const missing: EmbeddingMissingAsset[] = [];
  if (!modelInstalled) missing.push("model");
  if (!runtimeInstalled) missing.push("runtime");
  return {
    installed: missing.length === 0,
    modelInstalled,
    runtimeInstalled,
    assets,
    missing,
  };
}

/**
 * One actionable sentence for the setup surface.
 *
 * Names what is missing and where it belongs, then the command that fetches it.
 * Empty string when nothing is missing, so a caller can concatenate it without
 * branching.
 */
export function formatEmbeddingAssetsMissing(
  check: EmbeddingAssetsCheck,
): string {
  if (check.installed) return "";
  const parts: string[] = [];
  if (!check.modelInstalled) {
    parts.push(
      `the ${check.assets.modelId} weights (${check.assets.modelDir})`,
    );
  }
  if (!check.runtimeInstalled) {
    parts.push(
      `the ONNX runtime ${check.assets.runtimeVersion} (${check.assets.runtimeDir})`,
    );
  }
  return `Built-in embedding is not ready: missing ${parts.join(" and ")}. Run /recall embedding setup to download ${check.missing.length === 1 ? "it" : "them"}.`;
}
