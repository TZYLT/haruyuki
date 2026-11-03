/**
 * Built-in embedding model download (48-2 §3.3 C4, 48-1 §6.4/R-11/O-16).
 *
 * **What this module owns.** Fetching the weights described by
 * `model-manifest.ts` into `<harness cache>/embedding/models/<modelId>/`, with
 * the behaviour the requirement fixes:
 *
 * 1. **Three-source fallback.** Sources are tried in the manifest's order
 *    (hf-mirror → huggingface.co → ModelScope). A source that fails moves the
 *    file to the next one; a checksum mismatch deletes the partial file and
 *    moves on, so a corrupted mirror can never poison an install.
 * 2. **Resumable downloads.** The body is streamed by C1's `downloadToFile`
 *    into a `.part` file below a *stable* staging directory
 *    (`<models>/.<modelId>.download`), with a tiny sidecar recording which
 *    source produced the partial bytes. A later run resumes with `Range` when
 *    the source is unchanged; switching sources discards the partial (bytes
 *    from two mirrors must never be concatenated). Cancellation keeps the
 *    partial so the next attempt resumes.
 * 3. **All-or-nothing commit.** Downloading, size checking and sha256
 *    verification happen entirely inside the staging directory. Only after
 *    every file verifies is the install manifest written and the directory
 *    renamed into place in one operation; a failed or cancelled run leaves the
 *    previously installed model untouched and never creates a half-installed
 *    target directory.
 * 4. **Integrity policy.** A manifest that does not pin every required file's
 *    sha256 is refused before any network access unless the caller opts into
 *    size-only verification (`allowUnpinnedIntegrity`); that opt-in is reported
 *    back in the result and recorded in the install manifest. There is no
 *    silent downgrade.
 * 5. **Negative cache with TTL.** A deterministic source failure (404, 401,
 *    checksum mismatch, a malformed URL) is remembered for one hour and that
 *    source is skipped until then; transient failures (DNS, timeout, refused,
 *    TLS, 5xx, 429) are remembered for five minutes. Timeouts are never cached
 *    permanently, and the cache is a local JSON file whose location is
 *    injectable.
 * 6. **Manual import.** `importModelFromDirectory` (in
 *    `model-download-import.ts`) applies the same manifest, size and sha256
 *    checks to an offline directory and commits with the same single rename.
 *
 * **Injection.** `download`, `diskFreeBytes`, `now`, the model directory and
 * the negative-cache file are injectable, so tests never touch the public
 * network and never depend on a clock. The default `download` is C1's
 * `downloadToFile`, so Range, proxy, retry and failure classification are
 * shared with the runtime fetcher rather than re-implemented.
 *
 * **Single process.** A same-process single-flight map serialises concurrent
 * fetches of one model. The cache layout (stable staging + atomic rename)
 * makes a second *process* either resume or observe the finished install; the
 * download path itself is expected to run in the main process (48-2 §4.4).
 *
 * **File split.** The contract lives in `model-download-types.ts`, the cache and
 * filesystem helpers in `model-download-state.ts`, the install marker/commit in
 * `model-download-install.ts`, and the offline import in
 * `model-download-import.ts` — each well under the repository's 1,000-line
 * ceiling. This module is the fetch flow and the family entry point; it
 * re-exports the sibling API the way `download-http.ts` re-exports its types.
 *
 * Layer: `backend/local/`. Imports only the sibling C1/C4 modules and `node:`
 * builtins; no higher-layer or domain imports.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { downloadToFile } from "./download-http";
import {
  buildInstallManifest,
  clearCommittedStaging,
  commitStaging,
  defaultDownloadStagingDir,
  integrityLabel,
  isInstallUsable,
  partMetaPathFor,
  partPathFor,
  readInstallManifestFromDirectory,
  resolveEmbeddingModelPaths,
  type StagedFile,
} from "./model-download-install";
import {
  classifySourceFailure,
  defaultDiskFreeBytes,
  describeError,
  fileSha256,
  formatBytes,
  isAbortError,
  lookupNegativeCache,
  persistNegativeCache,
  readNegativeCache,
  readPartMeta,
  recordNegativeCache,
  removeFile,
  throwIfAborted,
  writePartMeta,
} from "./model-download-state";
import {
  DEFAULT_DETERMINISTIC_FAILURE_TTL_MS,
  DEFAULT_MODEL_DISK_HEADROOM_BYTES,
  DEFAULT_TRANSIENT_FAILURE_TTL_MS,
  EmbeddingModelDownloadError,
  type EmbeddingModelDownloadWarning,
  type EmbeddingModelNegativeCacheEntry,
  type FetchEmbeddingModelOptions,
  type FetchEmbeddingModelResult,
  MODEL_DOWNLOAD_STATE_FILE_NAME,
  MODEL_INSTALL_MANIFEST_FILE_NAME,
  MODEL_INSTALL_MANIFEST_VERSION,
} from "./model-download-types";
import {
  buildModelFileUrl,
  type EmbeddingModelFile,
  type EmbeddingModelManifest,
  getModelIntegrityStatus,
  resolveModelFileAt,
  type resolveModelFiles,
  validateModelManifest,
} from "./model-manifest";
import { resolveEmbeddingCachePath } from "./secrets";

export type {
  EmbeddingModelDiskProbe,
  EmbeddingModelDownloadErrorKind,
  EmbeddingModelDownloader,
  EmbeddingModelDownloadPhase,
  EmbeddingModelDownloadProgress,
  EmbeddingModelDownloadWarning,
  EmbeddingModelInstalledFile,
  EmbeddingModelInstallManifest,
  ImportEmbeddingModelOptions,
  ImportEmbeddingModelResult,
} from "./model-download-types";
export type {
  EmbeddingModelNegativeCacheEntry,
  FetchEmbeddingModelOptions,
  FetchEmbeddingModelResult,
};
export {
  DEFAULT_TRANSIENT_FAILURE_TTL_MS,
  DEFAULT_DETERMINISTIC_FAILURE_TTL_MS,
  MODEL_DOWNLOAD_STATE_FILE_NAME,
  MODEL_INSTALL_MANIFEST_FILE_NAME,
  MODEL_INSTALL_MANIFEST_VERSION,
};
export { EmbeddingModelDownloadError };
export { importModelFromDirectory } from "./model-download-import";
export {
  defaultDownloadStagingDir,
  isEmbeddingModelInstalled,
  readEmbeddingModelInstallManifest,
  resolveEmbeddingModelPaths,
  uninstallEmbeddingModel,
} from "./model-download-install";

interface RunContext {
  readonly resolved: ReturnType<typeof resolveModelFiles>;
  readonly options: FetchEmbeddingModelOptions;
  readonly now: () => number;
  readonly download: NonNullable<FetchEmbeddingModelOptions["download"]>;
  readonly stateFile: string;
  readonly stagingDir: string;
  readonly warnings: EmbeddingModelDownloadWarning[];
  cache: Map<string, EmbeddingModelNegativeCacheEntry>;
}

/** In-process single-flight: one fetch per model directory per process. */
const inflight = new Map<string, Promise<FetchEmbeddingModelResult>>();

/**
 * Download (or resume downloading) one model into the cache.
 *
 * Idempotent: a matching `model-install.json` whose files still exist with the
 * recorded sizes returns immediately. Concurrent same-process calls for the
 * same model directory share one promise.
 */
export function fetchEmbeddingModel(
  options: FetchEmbeddingModelOptions = {},
): Promise<FetchEmbeddingModelResult> {
  let resolved: ReturnType<typeof resolveModelFiles>;
  try {
    resolved = resolveEmbeddingModelPaths(options);
    validateModelManifest(resolved.manifest);
  } catch (error) {
    return Promise.reject(toDownloadError(error, options));
  }
  const key = resolved.modelDir;
  const running = inflight.get(key);
  if (running !== undefined) return running;
  const promise = runFetchModel(resolved, options).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/**
 * Absolute path of the negative-cache file this module writes by default
 * (`<cache>/embedding/state/model-download-state.json`).
 */
export function getEmbeddingModelDownloadStatePath(): string {
  return resolveEmbeddingCachePath("state", MODEL_DOWNLOAD_STATE_FILE_NAME);
}

/** Read the negative cache (never throws; a corrupt file reads as empty). */
export async function readEmbeddingModelNegativeCache(
  stateFile: string = getEmbeddingModelDownloadStatePath(),
  now: () => number = Date.now,
): Promise<Record<string, EmbeddingModelNegativeCacheEntry>> {
  const cache = await readNegativeCache(stateFile, now);
  return Object.fromEntries(cache);
}

async function runFetchModel(
  resolved: ReturnType<typeof resolveModelFiles>,
  options: FetchEmbeddingModelOptions,
): Promise<FetchEmbeddingModelResult> {
  const manifest = resolved.manifest;
  const modelId = manifest.id;
  const now = options.now ?? Date.now;
  const stateFile =
    options.stateFile ??
    resolveEmbeddingCachePath("state", MODEL_DOWNLOAD_STATE_FILE_NAME);
  const stagingDir =
    options.stagingDir ?? defaultDownloadStagingDir(resolved.modelDir);
  const context: RunContext = {
    resolved,
    options,
    now,
    download: options.download ?? downloadToFile,
    stateFile,
    stagingDir,
    warnings: [],
    cache: new Map(),
  };

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
      downloadedFiles: 0,
      resumedFiles: 0,
      skippedFiles: 0,
      integrity: integrityLabel(existing, manifest),
      warnings: [],
    };
  }

  const integrity = getModelIntegrityStatus(manifest);
  if (integrity.integrity !== "sha256") {
    if (options.allowUnpinnedIntegrity !== true) {
      throw new EmbeddingModelDownloadError(
        "unverified",
        `Model ${modelId} has no pinned sha256 for ${integrity.missingSha256.join(", ") || "(unknown files)"}; refusing to download unverifiable weights. Pin the digests in the model manifest or pass allowUnpinnedIntegrity to accept size-only verification.`,
        { modelId, failures: integrity.missingSha256 },
      );
    }
    const warning: EmbeddingModelDownloadWarning = {
      code: "integrity-unpinned",
      message:
        integrity.missingSha256.length > 0
          ? `sha256 is not pinned for ${integrity.missingSha256.join(", ")}; verifying size only and recording the computed digest.`
          : `sha256 is not pinned for model ${modelId}; verifying size only.`,
      files: integrity.missingSha256,
    };
    context.warnings.push(warning);
    options.onWarning?.(warning);
  }

  await precheckDisk(context);
  context.cache = options.ignoreNegativeCache
    ? new Map()
    : await readNegativeCache(stateFile, now);
  const staged = new Map<string, StagedFile>();
  let downloadedFiles = 0;
  let resumedFiles = 0;
  let skippedFiles = 0;
  let filesCompleted = 0;

  try {
    await clearCommittedStaging(stagingDir);
    await mkdir(stagingDir, { recursive: true });
    for (const file of manifest.files) {
      throwIfAborted(options.signal, modelId);
      const result = await stageFile(context, file);
      if (result === null) {
        skippedFiles += 1;
        continue;
      }
      if (result.reused || result.resumed) resumedFiles += 1;
      else downloadedFiles += 1;
      staged.set(file.path, result.staged);
      filesCompleted += 1;
      options.onProgress?.({
        phase: "verify",
        modelId,
        file: file.path,
        source: result.staged.source,
        bytesWritten: result.staged.bytes,
        totalBytes: result.staged.bytes,
        filesCompleted,
        filesTotal: manifest.files.length,
      });
    }
    throwIfAborted(options.signal, modelId);

    // Full staging verification: every required file must be present at its
    // recorded size before it is promoted to its final name.
    for (const file of manifest.files) {
      if (file.optional === true && !staged.has(file.path)) continue;
      const entry = staged.get(file.path);
      if (entry === undefined) {
        throw new EmbeddingModelDownloadError(
          "io",
          `Staging for model ${modelId} is missing ${file.path}.`,
          { modelId, filePath: file.path },
        );
      }
      const partPath = partPathFor(stagingDir, file, modelId);
      const info = await stat(partPath);
      if (info.size !== entry.bytes) {
        throw new EmbeddingModelDownloadError(
          "checksum",
          `Staged file ${file.path} changed size before commit (expected ${entry.bytes}, found ${info.size}).`,
          { modelId, filePath: file.path },
        );
      }
      const finalPath = resolveModelFileAt(stagingDir, file, modelId);
      await mkdir(dirname(finalPath), { recursive: true });
      await rename(partPath, finalPath);
    }

    const installManifest = buildInstallManifest(
      manifest,
      [...staged.values()],
      integrity,
      "download",
      now,
    );
    await writeFile(
      join(stagingDir, MODEL_INSTALL_MANIFEST_FILE_NAME),
      `${JSON.stringify(installManifest, null, 2)}\n`,
      "utf8",
    );

    throwIfAborted(options.signal, modelId);
    options.onProgress?.({ phase: "commit", modelId, finished: true });
    const committed = await commitStaging(resolved, stagingDir);

    if (committed !== null) {
      return {
        modelDir: resolved.modelDir,
        manifest,
        installManifest: committed,
        alreadyInstalled: true,
        downloadedFiles: 0,
        resumedFiles: 0,
        skippedFiles,
        integrity: integrityLabel(committed, manifest),
        warnings: context.warnings,
      };
    }
    return {
      modelDir: resolved.modelDir,
      manifest,
      installManifest,
      alreadyInstalled: false,
      downloadedFiles,
      resumedFiles,
      skippedFiles,
      integrity: integrityLabel(installManifest, manifest),
      warnings: context.warnings,
    };
  } catch (error) {
    throw normalizeFetchFailure(error, modelId);
  } finally {
    if (context.cache.size > 0) {
      await persistNegativeCache(stateFile, context.cache, now).catch(
        () => undefined,
      );
    }
  }
}

async function stageFile(
  context: RunContext,
  file: EmbeddingModelFile,
): Promise<{ staged: StagedFile; reused: boolean; resumed: boolean } | null> {
  const { resolved, options, stagingDir } = context;
  const manifest = resolved.manifest;
  const modelId = manifest.id;
  const required = file.optional !== true;
  const partPath = partPathFor(stagingDir, file, modelId);
  const metaPath = partMetaPathFor(partPath);
  await mkdir(dirname(partPath), { recursive: true });

  // A complete `.part` from an earlier cancelled run: verify and promote
  // without touching the network.
  const complete = await takeCompletePart(partPath, metaPath, file);
  if (complete !== null) {
    return { staged: complete, reused: true, resumed: true };
  }

  const failures: string[] = [];
  let lastFailure: unknown = null;
  let checksumFailures = 0;
  let otherFailures = false;
  for (const source of manifest.sources) {
    throwIfAborted(options.signal, modelId);
    const cacheKey = negativeCacheKeyFor(modelId, source.id, file.path);
    const cached = lookupNegativeCache(context.cache, cacheKey, context.now);
    if (cached !== null) {
      failures.push(`${source.id}: skipped (${cached.kind} cached)`);
      otherFailures = true;
      continue;
    }

    let resumeFrom = 0;
    if (existsSync(partPath)) {
      const meta = await readPartMeta(metaPath);
      if (meta === null || meta.sourceId !== source.id) {
        // Bytes from two mirrors must never be concatenated.
        await removeFile(partPath);
        await removeFile(metaPath);
      } else {
        const partInfo = await stat(partPath);
        if (file.bytes !== null && partInfo.size > file.bytes) {
          await removeFile(partPath);
          await removeFile(metaPath);
        } else {
          resumeFrom = partInfo.size;
        }
      }
    }

    let url: string;
    try {
      url = buildModelDownloadUrl(manifest, source.id, file.path);
    } catch (error) {
      failures.push(`${source.id}: ${describeError(error)}`);
      lastFailure = error;
      otherFailures = true;
      continue;
    }

    await writePartMeta(metaPath, source.id);
    options.onProgress?.({
      phase: "download",
      modelId,
      file: file.path,
      source: source.id,
      bytesWritten: resumeFrom,
      totalBytes: file.bytes,
    });
    try {
      await context.download({
        url,
        outputPath: partPath,
        resumeFrom,
        signal: options.signal,
        env: options.env,
        onProgress: (progress) => {
          options.onProgress?.({
            phase: "download",
            modelId,
            file: file.path,
            source: source.id,
            bytesWritten: progress.bytesWritten,
            totalBytes: progress.totalBytes ?? file.bytes,
          });
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new EmbeddingModelDownloadError(
          "aborted",
          `Model download was cancelled while fetching ${file.path}; the partial file was kept so the next attempt can resume.`,
          { cause: error, modelId, filePath: file.path },
        );
      }
      const classification = classifySourceFailure(error);
      if (classification !== null) {
        recordNegativeCache(
          context.cache,
          cacheKey,
          classification,
          options,
          context.now,
        );
      }
      failures.push(`${source.id}: ${describeError(error)}`);
      lastFailure = error;
      otherFailures = true;
      continue;
    }

    const partInfo = await stat(partPath);
    if (file.bytes !== null && partInfo.size !== file.bytes) {
      await removeFile(partPath);
      await removeFile(metaPath);
      const failure = new EmbeddingModelDownloadError(
        "checksum",
        `Size mismatch for ${file.path} from ${source.id}: expected ${file.bytes} bytes, received ${partInfo.size}.`,
        { modelId, filePath: file.path },
      );
      recordNegativeCache(
        context.cache,
        cacheKey,
        { deterministic: true },
        options,
        context.now,
      );
      failures.push(`${source.id}: ${describeError(failure)}`);
      lastFailure = failure;
      checksumFailures += 1;
      continue;
    }

    const digest = await fileSha256(partPath);
    if (file.sha256 !== null && digest !== file.sha256) {
      await removeFile(partPath);
      await removeFile(metaPath);
      const failure = new EmbeddingModelDownloadError(
        "checksum",
        `sha256 mismatch for ${file.path} from ${source.id}: expected ${file.sha256}, computed ${digest}.`,
        { modelId, filePath: file.path },
      );
      recordNegativeCache(
        context.cache,
        cacheKey,
        { deterministic: true },
        options,
        context.now,
      );
      failures.push(`${source.id}: ${describeError(failure)}`);
      lastFailure = failure;
      checksumFailures += 1;
      continue;
    }

    await removeFile(metaPath);
    return {
      staged: { file, bytes: partInfo.size, digest, source: source.id },
      reused: false,
      resumed: resumeFrom > 0,
    };
  }

  if (!required) {
    const warning: EmbeddingModelDownloadWarning = {
      code: "optional-file-missing",
      message: `Optional model file ${file.path} was not available from any source (${failures.join("; ")}).`,
      files: [file.path],
    };
    context.warnings.push(warning);
    options.onWarning?.(warning);
    return null;
  }
  // Every attempted source delivered corrupt bytes: report `checksum` rather
  // than a generic network failure so the caller can say what happened.
  const failureKind =
    otherFailures === false && checksumFailures > 0 ? "checksum" : "download";
  throw new EmbeddingModelDownloadError(
    failureKind,
    `Could not download ${file.path} for model ${modelId}: ${failures.join("; ") || "no sources are configured"}.`,
    {
      modelId,
      filePath: file.path,
      failures,
      ...(lastFailure === null ? {} : { cause: lastFailure }),
    },
  );
}

/**
 * If a previous run left a complete, verified `.part`, return it (and clear the
 * sidecar). A part whose size or digest does not match is discarded so this run
 * downloads it again.
 */
async function takeCompletePart(
  partPath: string,
  metaPath: string,
  file: EmbeddingModelFile,
): Promise<StagedFile | null> {
  if (!existsSync(partPath) || file.bytes === null) return null;
  const info = await stat(partPath);
  if (info.size !== file.bytes) return null;
  let digest: string;
  try {
    digest = await fileSha256(partPath);
  } catch {
    return null;
  }
  if (file.sha256 !== null && digest !== file.sha256) {
    await removeFile(partPath);
    await removeFile(metaPath);
    return null;
  }
  const meta = await readPartMeta(metaPath);
  await removeFile(metaPath);
  return {
    file,
    bytes: info.size,
    digest,
    source: meta?.sourceId ?? "resumed",
  };
}

async function precheckDisk(context: RunContext): Promise<void> {
  const { resolved, options } = context;
  if (options.diskFreeBytes === false) return;
  let knownBytes = 0;
  for (const file of resolved.manifest.files) {
    if (file.optional === true) continue;
    knownBytes += file.bytes ?? 0;
  }
  if (knownBytes <= 0) return;
  options.onProgress?.({
    phase: "precheck",
    modelId: resolved.manifest.id,
    totalBytes: knownBytes,
  });
  const probe = options.diskFreeBytes ?? defaultDiskFreeBytes;
  let free: number | null;
  try {
    free = await probe(dirname(resolved.modelDir));
  } catch {
    free = null;
  }
  if (free === null) return;
  const needed = knownBytes + DEFAULT_MODEL_DISK_HEADROOM_BYTES;
  if (free < needed) {
    throw new EmbeddingModelDownloadError(
      "disk",
      `Not enough free disk space for model ${resolved.manifest.id}: ${formatBytes(free)} available, ${formatBytes(needed)} needed (${formatBytes(knownBytes)} model + ${formatBytes(DEFAULT_MODEL_DISK_HEADROOM_BYTES)} headroom) below ${dirname(resolved.modelDir)}.`,
      { modelId: resolved.manifest.id },
    );
  }
}

function buildModelDownloadUrl(
  manifest: EmbeddingModelManifest,
  sourceId: string,
  filePath: string,
): string {
  const source = manifest.sources.find(
    (candidate) => candidate.id === sourceId,
  );
  if (source === undefined) {
    throw new EmbeddingModelDownloadError(
      "manifest",
      `Model ${manifest.id} has no source ${sourceId}.`,
      { modelId: manifest.id, filePath },
    );
  }
  try {
    return buildModelFileUrl(source, manifest, filePath);
  } catch (error) {
    throw new EmbeddingModelDownloadError("manifest", describeError(error), {
      cause: error,
      modelId: manifest.id,
      filePath,
    });
  }
}

function negativeCacheKeyFor(
  modelId: string,
  sourceId: string,
  filePath: string,
): string {
  return `${modelId}\u0000${sourceId}\u0000${filePath}`;
}

function toDownloadError(
  error: unknown,
  options: { modelId?: string },
): EmbeddingModelDownloadError {
  if (error instanceof EmbeddingModelDownloadError) return error;
  return new EmbeddingModelDownloadError("manifest", describeError(error), {
    cause: error,
    modelId: options.modelId,
  });
}

function normalizeFetchFailure(
  error: unknown,
  modelId: string,
): EmbeddingModelDownloadError {
  if (error instanceof EmbeddingModelDownloadError) return error;
  if (isAbortError(error)) {
    return new EmbeddingModelDownloadError(
      "aborted",
      `Model download for ${modelId} was cancelled; the staging directory was kept so the next attempt can resume.`,
      { cause: error, modelId },
    );
  }
  return new EmbeddingModelDownloadError(
    "io",
    `Model ${modelId} download failed: ${describeError(error)}`,
    { cause: error, modelId },
  );
}
