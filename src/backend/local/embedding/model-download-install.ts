/**
 * Install-marker and commit half of the C4 model downloader.
 *
 * A model install is all-or-nothing: every file is staged below a sibling
 * `.download`/`.import-*` directory, verified against the manifest, and only
 * then is `model-install.json` written and the directory renamed into place.
 * This module owns that marker (build/read/validate), the "is this install
 * usable" check used for idempotent fetches, and the single rename that commits
 * a staging directory. Both the download flow and the offline import flow share
 * it, so the commit rules cannot drift apart.
 *
 * Layer: `backend/local/`. Imports the sibling manifest, cache-path resolver and
 * shared contract; no higher-layer imports.
 */

import { existsSync } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describeError } from "./model-download-state";
import {
  EmbeddingModelDownloadError,
  type EmbeddingModelInstalledFile,
  type EmbeddingModelInstallManifest,
  MODEL_INSTALL_MANIFEST_FILE_NAME,
  MODEL_INSTALL_MANIFEST_VERSION,
  PART_META_SUFFIX,
  PART_SUFFIX,
} from "./model-download-types";
import {
  type EmbeddingModelFile,
  type EmbeddingModelIntegrityStatus,
  type EmbeddingModelManifest,
  getBuiltinModelManifest,
  resolveModelFileAt,
  resolveModelFiles,
} from "./model-manifest";
import { getEmbeddingModelDir } from "./secrets";

/** One verified file waiting to be moved from staging into the model root. */
export interface StagedFile {
  readonly file: EmbeddingModelFile;
  readonly digest: string;
  readonly bytes: number;
  readonly source: string;
}

/** Path resolution options shared by the fetch, import and status entries. */
export interface ResolveEmbeddingModelPathsOptions {
  readonly modelId?: string;
  readonly manifest?: EmbeddingModelManifest;
  readonly modelsDir?: string;
  readonly modelDir?: string;
}

/**
 * Resolve a model's manifest and destination paths without touching the disk.
 * Exported because the status surface and future C8 models need the same
 * resolution rules without starting a download.
 */
export function resolveEmbeddingModelPaths(
  options: ResolveEmbeddingModelPathsOptions = {},
): ReturnType<typeof resolveModelFiles> {
  const modelId =
    options.modelId ?? options.manifest?.id ?? getBuiltinModelManifest().id;
  if (options.modelDir !== undefined) {
    return resolveModelFiles(modelId, {
      modelDir: options.modelDir,
      ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
    });
  }
  if (options.modelsDir !== undefined) {
    const manifest = options.manifest ?? getBuiltinModelManifest(modelId);
    return resolveModelFiles(manifest.id, {
      modelDir: join(options.modelsDir, manifest.id),
      manifest,
    });
  }
  return resolveModelFiles(
    modelId,
    options.manifest === undefined ? {} : { manifest: options.manifest },
  );
}

/** Default staging directory for a download (`<models>/.<modelId>.download`). */
export function defaultDownloadStagingDir(modelDir: string): string {
  return join(dirname(modelDir), `.${basename(modelDir)}.download`);
}

/** `.part` path for one file inside a staging directory. */
export function partPathFor(
  stagingDir: string,
  file: Pick<EmbeddingModelFile, "path">,
  modelId: string,
): string {
  return `${resolveModelFileAt(stagingDir, file, modelId)}${PART_SUFFIX}`;
}

/** Sidecar path for one `.part` file. */
export function partMetaPathFor(partPath: string): string {
  return `${partPath}${PART_META_SUFFIX}`;
}

/** Build the install marker from verified staged files. */
export function buildInstallManifest(
  manifest: EmbeddingModelManifest,
  staged: readonly StagedFile[],
  integrity: EmbeddingModelIntegrityStatus,
  source: "download" | "manual",
  now: () => number,
): EmbeddingModelInstallManifest {
  const files: EmbeddingModelInstalledFile[] = staged.map((entry) => ({
    path: entry.file.path,
    bytes: entry.bytes,
    sha256: entry.digest,
    source: entry.source,
  }));
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  return {
    manifestVersion: MODEL_INSTALL_MANIFEST_VERSION,
    modelId: manifest.id,
    dimensions: manifest.dimensions,
    licenseId: manifest.license.id,
    installedAt: new Date(now()).toISOString(),
    source,
    integrity: integrity.integrity === "sha256" ? "sha256" : "size-only",
    files,
    totalBytes,
  };
}

/** The integrity label a caller should report for an installed model. */
export function integrityLabel(
  install: EmbeddingModelInstallManifest,
  manifest: EmbeddingModelManifest,
): "sha256" | "size-only" {
  const pinnedEveryFile = manifest.files.every(
    (file) => file.optional === true || file.sha256 !== null,
  );
  if (pinnedEveryFile) return "sha256";
  return install.integrity === "sha256" ? "size-only" : install.integrity;
}

/** Read `model-install.json` from a model directory. `null` when absent/invalid. */
export async function readInstallManifestFromDirectory(
  modelDir: string,
): Promise<EmbeddingModelInstallManifest | null> {
  let raw: string;
  try {
    raw = await readFile(
      join(modelDir, MODEL_INSTALL_MANIFEST_FILE_NAME),
      "utf8",
    );
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isInstallManifest(parsed) ? parsed : null;
}

/**
 * Read the install marker for a model id (or an explicit directory). Returns
 * `null` when the model is not installed or the marker is unreadable.
 */
export async function readEmbeddingModelInstallManifest(
  modelId: string = getBuiltinModelManifest().id,
  options: { readonly modelDir?: string; readonly modelsDir?: string } = {},
): Promise<EmbeddingModelInstallManifest | null> {
  const modelDir =
    options.modelDir ??
    (options.modelsDir === undefined
      ? getEmbeddingModelDir(modelId)
      : join(options.modelsDir, modelId));
  return readInstallManifestFromDirectory(modelDir);
}

/**
 * Whether a model is installed and still matches its marker: every required
 * manifest file is recorded, the recorded size/digest agree with the manifest's
 * pins, and the file exists at the recorded size. Deliberately no re-hash of the
 * weights — this is the cheap idempotence check, not a verification pass.
 */
export async function isInstallUsable(
  install: EmbeddingModelInstallManifest,
  resolved: ReturnType<typeof resolveModelFiles>,
): Promise<boolean> {
  const manifest = resolved.manifest;
  if (
    install.manifestVersion !== MODEL_INSTALL_MANIFEST_VERSION ||
    install.modelId !== manifest.id ||
    install.dimensions !== manifest.dimensions
  ) {
    return false;
  }
  const installed = new Map(
    install.files.map((file) => [file.path, file] as const),
  );
  for (const file of manifest.files) {
    if (file.optional === true) continue;
    const entry = installed.get(file.path);
    if (entry === undefined) return false;
    if (file.sha256 !== null && entry.sha256 !== file.sha256) return false;
    if (file.bytes !== null && entry.bytes !== file.bytes) return false;
    const absolutePath = resolveModelFileAt(
      resolved.modelDir,
      file,
      manifest.id,
    );
    try {
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size !== entry.bytes) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Whether a model is installed and still matches its install marker. Cheap: no
 * weights are re-hashed.
 */
export async function isEmbeddingModelInstalled(
  options: ResolveEmbeddingModelPathsOptions = {},
): Promise<boolean> {
  const resolved = resolveEmbeddingModelPaths(options);
  const install = await readInstallManifestFromDirectory(resolved.modelDir);
  if (install === null) return false;
  return isInstallUsable(install, resolved);
}

/**
 * Rename a fully staged model directory into place. Returns the existing
 * install marker when a usable install already won the race (another process),
 * otherwise `null` after this run's rename succeeds.
 *
 * A stale, unusable target is removed first; a usable one is never overwritten.
 */
export async function commitStaging(
  resolved: ReturnType<typeof resolveModelFiles>,
  stagingDir: string,
): Promise<EmbeddingModelInstallManifest | null> {
  const modelDir = resolved.modelDir;
  if (existsSync(modelDir)) {
    const existing = await readInstallManifestFromDirectory(modelDir);
    if (existing !== null && (await isInstallUsable(existing, resolved))) {
      await rm(stagingDir, { force: true, recursive: true });
      return existing;
    }
    await rm(modelDir, { force: true, recursive: true });
  }
  try {
    await rename(stagingDir, modelDir);
  } catch (error) {
    // A competing process may have committed first; prefer its install.
    const existing = await readInstallManifestFromDirectory(modelDir);
    if (existing !== null && (await isInstallUsable(existing, resolved))) {
      await rm(stagingDir, { force: true, recursive: true });
      return existing;
    }
    throw new EmbeddingModelDownloadError(
      "io",
      `Could not commit model ${resolved.manifest.id} into ${modelDir}: ${describeError(error)}`,
      { cause: error, modelId: resolved.manifest.id },
    );
  }
  const installed = await readInstallManifestFromDirectory(modelDir);
  if (installed === null) {
    throw new EmbeddingModelDownloadError(
      "io",
      `Model ${resolved.manifest.id} was committed but its install marker could not be read back.`,
      { modelId: resolved.manifest.id },
    );
  }
  return null;
}

/**
 * Drop a staging directory that already carries an install marker: that state
 * only exists after a previous run finished verifying every file and died
 * between writing the marker and the commit rename. Resuming from it would let
 * stale files join the next install, so it is discarded (the model itself is
 * still absent, so no installed data is touched).
 */
export async function clearCommittedStaging(stagingDir: string): Promise<void> {
  if (!existsSync(join(stagingDir, MODEL_INSTALL_MANIFEST_FILE_NAME))) return;
  await rm(stagingDir, { force: true, recursive: true });
}

/**
 * Remove an installed model directory and any staging directory. Returns
 * whether an install existed.
 */
export async function uninstallEmbeddingModel(
  modelId: string = getBuiltinModelManifest().id,
  options: {
    readonly modelDir?: string;
    readonly stagingDir?: string;
    readonly modelsDir?: string;
    /** Required when `modelDir` points at a model id this build does not know. */
    readonly manifest?: EmbeddingModelManifest;
  } = {},
): Promise<boolean> {
  const resolved = resolveEmbeddingModelPaths({
    modelId,
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
    ...(options.modelDir === undefined ? {} : { modelDir: options.modelDir }),
    ...(options.modelsDir === undefined
      ? {}
      : { modelsDir: options.modelsDir }),
  });
  const stagingDir =
    options.stagingDir ?? defaultDownloadStagingDir(resolved.modelDir);
  const existed = existsSync(resolved.modelDir);
  await rm(resolved.modelDir, { force: true, recursive: true });
  await rm(stagingDir, { force: true, recursive: true });
  return existed;
}

function isInstallManifest(
  value: unknown,
): value is EmbeddingModelInstallManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.manifestVersion !== MODEL_INSTALL_MANIFEST_VERSION) return false;
  if (
    typeof record.modelId !== "string" ||
    typeof record.dimensions !== "number" ||
    typeof record.licenseId !== "string" ||
    typeof record.installedAt !== "string" ||
    (record.source !== "download" && record.source !== "manual") ||
    (record.integrity !== "sha256" && record.integrity !== "size-only") ||
    !Array.isArray(record.files)
  ) {
    return false;
  }
  return record.files.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const file = entry as Record<string, unknown>;
    return (
      typeof file.path === "string" &&
      typeof file.bytes === "number" &&
      typeof file.sha256 === "string" &&
      typeof file.source === "string"
    );
  });
}
