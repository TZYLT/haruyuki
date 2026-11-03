/**
 * Shared contract for the C4 model downloader: error taxonomy, progress and
 * result shapes, install-marker shape, and the injectable seams.
 *
 * Kept separate from the fetch flow (`model-download.ts`), the negative cache /
 * filesystem helpers (`model-download-state.ts`), the install commit
 * (`model-download-install.ts`) and the offline import
 * (`model-download-import.ts`) for the same reason `download-http-types.ts` is
 * separate from `download-http.ts`: the contract is read once, and each
 * implementation module stays under the repository's file-size ceiling.
 *
 * Nothing here touches the network or the filesystem.
 *
 * Layer: `backend/local/`. Imports only `node:` types via sibling modules.
 */

/** Install marker written inside a committed model directory. */
export const MODEL_INSTALL_MANIFEST_FILE_NAME = "model-install.json";

/** Version of the install-marker shape written by this module. */
export const MODEL_INSTALL_MANIFEST_VERSION = 1;

/** Negative-cache filename below `<cache>/embedding/state/`. */
export const MODEL_DOWNLOAD_STATE_FILE_NAME = "model-download-state.json";

/** Suffix appended to each in-flight file inside the staging directory. */
export const PART_SUFFIX = ".part";

/** Sidecar recording which source produced a `.part` file. */
export const PART_META_SUFFIX = ".part.meta.json";

/** Deterministic failures are cached for one hour (48-1 §6.4). */
export const DEFAULT_DETERMINISTIC_FAILURE_TTL_MS = 60 * 60 * 1000;

/**
 * Transient failures are cached for five minutes. They must never be cached
 * permanently: a machine that was briefly offline has to be able to retry.
 */
export const DEFAULT_TRANSIENT_FAILURE_TTL_MS = 5 * 60 * 1000;

/** Free-space margin required on top of the known model size before a fetch. */
export const DEFAULT_MODEL_DISK_HEADROOM_BYTES = 32 * 1024 * 1024;

/** Why a model download/import failed. */
export type EmbeddingModelDownloadErrorKind =
  | "aborted"
  | "checksum"
  | "disk"
  | "download"
  | "integrity-unpinned"
  | "io"
  | "manifest"
  | "unverified";

/** Typed download failure; per-source reasons are kept in `failures`. */
export class EmbeddingModelDownloadError extends Error {
  readonly kind: EmbeddingModelDownloadErrorKind;
  readonly modelId: string | undefined;
  readonly filePath: string | undefined;
  readonly failures: readonly string[];

  constructor(
    kind: EmbeddingModelDownloadErrorKind,
    message: string,
    options: {
      cause?: unknown;
      modelId?: string;
      filePath?: string;
      failures?: readonly string[];
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EmbeddingModelDownloadError";
    this.kind = kind;
    this.modelId = options.modelId;
    this.filePath = options.filePath;
    this.failures = options.failures ?? [];
  }
}

/** Phase of a download, for the wizard/status line. */
export type EmbeddingModelDownloadPhase =
  | "precheck"
  | "download"
  | "verify"
  | "commit";

/** One progress tick. Download ticks carry byte counts. */
export interface EmbeddingModelDownloadProgress {
  readonly phase: EmbeddingModelDownloadPhase;
  readonly modelId: string;
  readonly file?: string;
  readonly source?: string;
  readonly bytesWritten?: number;
  readonly totalBytes?: number | null;
  readonly filesCompleted?: number;
  readonly filesTotal?: number;
  readonly finished?: boolean;
}

/** A non-fatal disclosure the caller should surface (never swallowed). */
export interface EmbeddingModelDownloadWarning {
  readonly code: "integrity-unpinned" | "optional-file-missing";
  readonly message: string;
  readonly files: readonly string[];
}

/** One file recorded in the installed model marker. */
export interface EmbeddingModelInstalledFile {
  readonly path: string;
  readonly bytes: number;
  /** Digest computed from the installed bytes, pinned or not. */
  readonly sha256: string;
  /** Source id that produced the file (`manual` for an import). */
  readonly source: string;
}

/** Written to `<modelDir>/model-install.json` after a successful commit. */
export interface EmbeddingModelInstallManifest {
  readonly manifestVersion: number;
  readonly modelId: string;
  readonly dimensions: number;
  readonly licenseId: string;
  readonly installedAt: string;
  readonly source: "download" | "manual";
  readonly integrity: "sha256" | "size-only";
  readonly files: readonly EmbeddingModelInstalledFile[];
  readonly totalBytes: number;
}

/** Injectable download function; defaults to C1's `downloadToFile`. */
export type EmbeddingModelDownloader = (
  options: import("./download-http").DownloadFileOptions,
) => Promise<import("./download-http").DownloadFileResult>;

/** Free-bytes probe for the disk precheck; `null` means "unknown". */
export type EmbeddingModelDiskProbe = (
  directory: string,
) => number | null | Promise<number | null>;

/** One remembered source failure in the negative cache. */
export interface EmbeddingModelNegativeCacheEntry {
  /** Wall-clock time the failure was recorded (`now()` injection point). */
  readonly at: number;
  /** How long the entry stays valid; never infinite. */
  readonly ttlMs: number;
  readonly kind: string;
  readonly message: string;
}

/** Options for `fetchEmbeddingModel`. */
export interface FetchEmbeddingModelOptions {
  /** Model id; defaults to the D3 default (`bge-small-zh-v1.5`). */
  readonly modelId?: string;
  /** Injected manifest (tests, C8 models); defaults to the built-in table. */
  readonly manifest?: import("./model-manifest").EmbeddingModelManifest;
  /** Root that contains model directories; defaults to the cache resolver. */
  readonly modelsDir?: string;
  /** Explicit model directory; overrides `modelsDir`. */
  readonly modelDir?: string;
  /** Explicit staging directory; defaults to `<modelDir>`'s sibling. */
  readonly stagingDir?: string;
  /** Negative-cache file; defaults to `<cache>/embedding/state/…`. */
  readonly stateFile?: string;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (progress: EmbeddingModelDownloadProgress) => void;
  readonly onWarning?: (warning: EmbeddingModelDownloadWarning) => void;
  readonly download?: EmbeddingModelDownloader;
  /** Free-space probe; pass `false` to skip the precheck entirely. */
  readonly diskFreeBytes?: EmbeddingModelDiskProbe | false;
  readonly now?: () => number;
  /** Re-download even when a matching install is present. */
  readonly force?: boolean;
  /** Ignore the negative cache for this run (does not wipe healthy entries). */
  readonly ignoreNegativeCache?: boolean;
  /**
   * Accept files whose sha256 is not pinned, verifying size where known and
   * recording the computed digest. The result reports `"size-only"` integrity
   * and the caller receives an `integrity-unpinned` warning.
   */
  readonly allowUnpinnedIntegrity?: boolean;
  readonly deterministicTtlMs?: number;
  readonly transientTtlMs?: number;
}

/** Result of `fetchEmbeddingModel`. */
export interface FetchEmbeddingModelResult {
  readonly modelDir: string;
  readonly manifest: import("./model-manifest").EmbeddingModelManifest;
  readonly installManifest: EmbeddingModelInstallManifest;
  readonly alreadyInstalled: boolean;
  /** Files whose bytes were transferred or copied in this call. */
  readonly downloadedFiles: number;
  /** Complete `.part` files reused from an earlier cancelled run. */
  readonly resumedFiles: number;
  /** Optional files that no source could provide. */
  readonly skippedFiles: number;
  readonly integrity: "sha256" | "size-only";
  readonly warnings: readonly EmbeddingModelDownloadWarning[];
}

/** Options for `importModelFromDirectory`. */
export interface ImportEmbeddingModelOptions {
  readonly modelId?: string;
  readonly manifest?: import("./model-manifest").EmbeddingModelManifest;
  readonly modelsDir?: string;
  readonly modelDir?: string;
  readonly stagingDir?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: EmbeddingModelDownloadProgress) => void;
  readonly onWarning?: (warning: EmbeddingModelDownloadWarning) => void;
  readonly now?: () => number;
  readonly force?: boolean;
  readonly allowUnpinnedIntegrity?: boolean;
}

/** Result of `importModelFromDirectory`. */
export interface ImportEmbeddingModelResult {
  readonly modelDir: string;
  readonly manifest: import("./model-manifest").EmbeddingModelManifest;
  readonly installManifest: EmbeddingModelInstallManifest;
  readonly alreadyInstalled: boolean;
  readonly importedFiles: number;
  readonly skippedFiles: number;
  readonly integrity: "sha256" | "size-only";
  readonly warnings: readonly EmbeddingModelDownloadWarning[];
}
