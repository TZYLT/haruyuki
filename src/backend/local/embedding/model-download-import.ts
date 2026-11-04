/**
 * Offline model import for the C4 downloader (48-1 §5.5: "全部失败 → 手动导入
 * 指引"). The user already has the weights (an air-gapped machine, a company
 * mirror, a copied model directory); this path applies exactly the same manifest
 * checks as a download — file set, exact size, sha256, integrity policy — then
 * copies into a staging directory, verifies the copy's size, writes the install
 * marker and commits with the same single rename.
 *
 * It never renames or deletes the user's source directory. Extra files in the
 * source are ignored; missing required files fail with the expected path.
 *
 * Layer: `backend/local/`. Imports sibling C4 modules only.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildInstallManifest,
  clearCommittedStaging,
  commitStaging,
  integrityLabel,
  isInstallUsable,
  readInstallManifestFromDirectory,
  resolveEmbeddingModelPaths,
  type StagedFile,
} from "./model-download-install";
import {
  describeError,
  fileSha256,
  isAbortError,
  throwIfAborted,
} from "./model-download-state";
import {
  EmbeddingModelDownloadError,
  type EmbeddingModelDownloadWarning,
  type ImportEmbeddingModelOptions,
  type ImportEmbeddingModelResult,
  MODEL_INSTALL_MANIFEST_FILE_NAME,
} from "./model-download-types";
import {
  type EmbeddingModelManifest,
  getModelIntegrityStatus,
  resolveModelFileAt,
  type resolveModelFiles,
  validateModelManifest,
} from "./model-manifest";

/**
 * Import a model from a directory the user already has. Every file is matched
 * against the manifest by name, exact size and sha256 before anything is copied;
 * the copy then goes through the same staging → rename commit as a download, so
 * a bad source directory cannot leave a half-installed model.
 */
export function importModelFromDirectory(
  sourceDir: string,
  options: ImportEmbeddingModelOptions = {},
): Promise<ImportEmbeddingModelResult> {
  let resolved: ReturnType<typeof resolveModelFiles>;
  try {
    resolved = resolveEmbeddingModelPaths(options);
    validateModelManifest(resolved.manifest);
  } catch (error) {
    return Promise.reject(
      error instanceof EmbeddingModelDownloadError
        ? error
        : new EmbeddingModelDownloadError("manifest", describeError(error), {
            cause: error,
            modelId: options.modelId,
          }),
    );
  }
  return runImportModel(sourceDir, resolved, options);
}

async function runImportModel(
  sourceDir: string,
  resolved: ReturnType<typeof resolveModelFiles>,
  options: ImportEmbeddingModelOptions,
): Promise<ImportEmbeddingModelResult> {
  const manifest: EmbeddingModelManifest = resolved.manifest;
  const modelId = manifest.id;
  const now = options.now ?? Date.now;
  throwIfAborted(options.signal, modelId);

  const existing = await readInstallManifestFromDirectory(resolved.modelDir);
  if (
    options.force !== true &&
    existing !== null &&
    (await isInstallUsable(existing, resolved))
  ) {
    return {
      modelDir: resolved.modelDir,
      manifest,
      installManifest: existing,
      alreadyInstalled: true,
      importedFiles: 0,
      skippedFiles: 0,
      integrity: integrityLabel(existing, manifest),
      warnings: [],
    };
  }

  const integrity = getModelIntegrityStatus(manifest);
  const warnings: EmbeddingModelDownloadWarning[] = [];
  if (integrity.integrity !== "sha256") {
    if (options.allowUnpinnedIntegrity !== true) {
      throw new EmbeddingModelDownloadError(
        "unverified",
        `Model ${modelId} has no pinned sha256 for ${integrity.missingSha256.join(", ") || "(unknown files)"}; refusing to import unverifiable weights. Pin the digests in the model manifest or pass allowUnpinnedIntegrity.`,
        { modelId, failures: integrity.missingSha256 },
      );
    }
    const warning: EmbeddingModelDownloadWarning = {
      code: "integrity-unpinned",
      message: `sha256 is not pinned for ${integrity.missingSha256.join(", ") || modelId}; importing with size-only verification.`,
      files: integrity.missingSha256,
    };
    warnings.push(warning);
    options.onWarning?.(warning);
  }

  const sourceRoot = resolve(sourceDir);
  if (sourceRoot === resolve(resolved.modelDir)) {
    throw new EmbeddingModelDownloadError(
      "io",
      `Cannot import model ${modelId} from its own install directory; point at the directory containing ${manifest.files.map((file) => file.path).join(", ")}.`,
      { modelId },
    );
  }
  if (!existsSync(sourceRoot)) {
    throw new EmbeddingModelDownloadError(
      "io",
      `Model source directory does not exist: ${sourceRoot}.`,
      { modelId },
    );
  }

  const stagingDir =
    options.stagingDir ??
    join(
      dirname(resolved.modelDir),
      `.${basename(resolved.modelDir)}.import-${randomUUID()}`,
    );
  const staged: StagedFile[] = [];
  let skippedFiles = 0;
  try {
    await clearCommittedStaging(stagingDir);
    await mkdir(stagingDir, { recursive: true });
    for (const file of manifest.files) {
      throwIfAborted(options.signal, modelId);
      const sourcePath = resolveModelFileAt(sourceRoot, file, modelId);
      if (!existsSync(sourcePath)) {
        if (file.optional === true) {
          skippedFiles += 1;
          continue;
        }
        throw new EmbeddingModelDownloadError(
          "io",
          `Import is missing ${file.path} (expected at ${sourcePath}).`,
          { modelId, filePath: file.path },
        );
      }
      const info = await stat(sourcePath);
      if (!info.isFile()) {
        throw new EmbeddingModelDownloadError(
          "io",
          `Import path for ${file.path} is not a regular file: ${sourcePath}.`,
          { modelId, filePath: file.path },
        );
      }
      if (file.bytes !== null && info.size !== file.bytes) {
        throw new EmbeddingModelDownloadError(
          "checksum",
          `Size mismatch for ${file.path}: expected ${file.bytes} bytes, found ${info.size} in ${sourceRoot}.`,
          { modelId, filePath: file.path },
        );
      }
      const digest = await fileSha256(sourcePath);
      if (file.sha256 !== null && digest !== file.sha256) {
        throw new EmbeddingModelDownloadError(
          "checksum",
          `sha256 mismatch for ${file.path}: expected ${file.sha256}, computed ${digest} in ${sourceRoot}.`,
          { modelId, filePath: file.path },
        );
      }
      const targetPath = resolveModelFileAt(stagingDir, file, modelId);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      const copied = await stat(targetPath);
      if (copied.size !== info.size) {
        throw new EmbeddingModelDownloadError(
          "io",
          `Copy of ${file.path} is incomplete (expected ${info.size} bytes, copied ${copied.size}).`,
          { modelId, filePath: file.path },
        );
      }
      staged.push({ file, bytes: copied.size, digest, source: "manual" });
      options.onProgress?.({
        phase: "verify",
        modelId,
        file: file.path,
        source: "manual",
        bytesWritten: copied.size,
        totalBytes: copied.size,
        filesCompleted: staged.length,
        filesTotal: manifest.files.length,
      });
    }
    throwIfAborted(options.signal, modelId);

    const installManifest = buildInstallManifest(
      manifest,
      staged,
      integrity,
      "manual",
      now,
    );
    await writeFile(
      join(stagingDir, MODEL_INSTALL_MANIFEST_FILE_NAME),
      `${JSON.stringify(installManifest, null, 2)}\n`,
      "utf8",
    );
    options.onProgress?.({ phase: "commit", modelId, finished: true });
    const committed = await commitStaging(resolved, stagingDir);
    if (committed !== null) {
      return {
        modelDir: resolved.modelDir,
        manifest,
        installManifest: committed,
        alreadyInstalled: true,
        importedFiles: 0,
        skippedFiles,
        integrity: integrityLabel(committed, manifest),
        warnings,
      };
    }
    return {
      modelDir: resolved.modelDir,
      manifest,
      installManifest,
      alreadyInstalled: false,
      importedFiles: staged.length,
      skippedFiles,
      integrity: integrityLabel(installManifest, manifest),
      warnings,
    };
  } catch (error) {
    // Unlike a download, an import has no resumable state: the staging path is
    // a random per-run sibling, so leaving it behind can only leak a full copy
    // of the weights. Drop it (best effort) before reporting the failure; the
    // user's source directory is never touched.
    await rm(stagingDir, { force: true, recursive: true }).catch(
      () => undefined,
    );
    if (isAbortError(error)) {
      throw new EmbeddingModelDownloadError(
        "aborted",
        "Model import was cancelled; the partial staging copy was discarded.",
        { cause: error, modelId },
      );
    }
    if (error instanceof EmbeddingModelDownloadError) throw error;
    throw new EmbeddingModelDownloadError(
      "io",
      `Model ${modelId} import failed: ${describeError(error)}`,
      { cause: error, modelId },
    );
  }
}
