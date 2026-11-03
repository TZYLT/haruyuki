/**
 * Embedding runtime fetcher (48-2 §3.3 C2): npm metadata → tarball download →
 * sha512 verification → platform-trimmed extraction → atomic install.
 *
 * **What "runtime" means here.** The built-in embedding runtime is never
 * bundled (48-1 §5.4/§6.4). It is a small closure of npm packages —
 * `onnxruntime-node`, `onnxruntime-common`, `@huggingface/tokenizers` — that is
 * downloaded on first enable into `<harness cache>/embedding/runtime/<version>/`
 * and loaded from there by a child process. This module owns the download and
 * install half; the worker owns loading (C3).
 *
 * **Source order.** npm metadata is resolved from npmmirror first and npmjs
 * second (48-1 R-35). npm publishes the same `dist.integrity` for both, so one
 * sha512 verifies a tarball from either registry and a mirror failure is a
 * transparent fallback rather than a second trust domain. The tarball URL comes
 * from the winning registry's metadata, restricted to https (or http on a
 * loopback address, so a local mirror/test server works without weakening the
 * remote case).
 *
 * **Verification.** The downloaded tarball's sha512 must equal `dist.integrity`
 * before a single byte is extracted. A registry that advertises no sha512 is
 * treated as a failed source and the next registry is tried — "download but
 * cannot verify" is not an acceptable state for a file that will later be
 * `dlopen`ed. Extraction goes into `<runtimeDir>.tmp-<uuid>`; only after every
 * package is downloaded, verified, extracted, and the manifest is written does
 * the staging directory get renamed into place. A failure at any step removes
 * the staging directory and leaves the previously installed runtime untouched.
 *
 * **Platform trimming.** The `onnxruntime-node` tarball carries every platform
 * binary (~307 MB unpacked, ~65 MB for win32-x64). Entries under
 * `<os>/<arch>/` directories for other targets are filtered out *before* they
 * are written, which is both the disk-budget answer (48-2 §4.4) and the reason
 * an Intel Mac can be rejected up front: darwin-x64 has no binary at all.
 *
 * **Injection.** `fetchMetadata`/`download`/`platform`/`arch` are injectable so
 * tests never touch the public network: they synthesize a tar.gz with
 * `node:zlib` and fake npm metadata (see `runtime-fetch.test.ts`).
 *
 * Layer: `backend/local/`. Imports only `@/`-free relative siblings in this
 * directory (`download-http`, `secrets`, `tar`) and `node:` builtins.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  type DownloadFileOptions,
  type DownloadFileResult,
  downloadToFile,
  requestDownloadHttp,
} from "./download-http";
import { getEmbeddingRuntimeDir } from "./secrets";
import { type ExtractTarGzResult, extractTarGz } from "./tar";

/** Manifest filename inside an installed runtime directory. */
export const RUNTIME_MANIFEST_FILE_NAME = "runtime-manifest.json";

/** Version of the manifest shape written by this module. */
export const RUNTIME_MANIFEST_VERSION = 1;

/** Runtime version directory name (the pinned onnxruntime-node version). */
export const DEFAULT_EMBEDDING_RUNTIME_VERSION = "1.31.1";

/**
 * The minimal runtime closure for the built-in embedding backend (48-1 R-35).
 * `onnxruntime-common` is pinned to the version `onnxruntime-node@1.31.1`
 * declares; `@huggingface/tokenizers` is pure JS and fingerprint-stable.
 */
export const DEFAULT_EMBEDDING_RUNTIME_PACKAGES: readonly string[] = [
  "onnxruntime-node@1.31.1",
  "onnxruntime-common@1.30.0",
  "@huggingface/tokenizers@0.2.0",
];

/** One npm registry that can serve package metadata and tarballs. */
export interface NpmRegistrySource {
  /** Short id recorded in the manifest and reported in errors. */
  readonly id: string;
  /** Registry origin, without a trailing slash. */
  readonly metadataBaseUrl: string;
}

/** Registry order mandated by 48-1 R-35: the domestic mirror first. */
export const DEFAULT_NPM_REGISTRIES: readonly NpmRegistrySource[] = [
  { id: "npmmirror", metadataBaseUrl: "https://registry.npmmirror.com" },
  { id: "npmjs", metadataBaseUrl: "https://registry.npmjs.org" },
];

/** A pinned npm package coordinate (`onnxruntime-node@1.31.1`). */
export interface RuntimePackageSpec {
  readonly name: string;
  readonly version: string;
}

/** The subset of an npm version document this fetcher needs. */
export interface NpmPackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly tarballUrl: string;
  readonly integrity: string | null;
}

/** Options handed to a metadata fetcher. */
export interface MetadataFetchOptions {
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

/** Injectable metadata fetch; defaults to {@link fetchNpmPackageMetadata}. */
export type RuntimeMetadataFetcher = (
  metadataUrl: string,
  options: MetadataFetchOptions,
) => Promise<NpmPackageMetadata>;

/** Injectable tarball download; defaults to C1's `downloadToFile`. */
export type RuntimeDownloader = (
  options: DownloadFileOptions,
) => Promise<DownloadFileResult>;

/** Where a package resolved from, and what must be verified. */
export interface ResolvedRuntimePackage extends RuntimePackageSpec {
  readonly registry: string;
  readonly metadataUrl: string;
  readonly tarballUrl: string;
  readonly integrity: string;
}

/** Why a runtime fetch failed. Callers map these to status/degradation text. */
export type EmbeddingRuntimeFetchErrorKind =
  | "download"
  | "extract"
  | "integrity"
  | "io"
  | "metadata"
  | "platform";

/** Typed runtime fetch failure; `cause` keeps the underlying classified error. */
export class EmbeddingRuntimeFetchError extends Error {
  readonly kind: EmbeddingRuntimeFetchErrorKind;
  readonly packageName: string | undefined;
  readonly registry: string | undefined;

  constructor(
    kind: EmbeddingRuntimeFetchErrorKind,
    message: string,
    options: {
      cause?: unknown;
      packageName?: string;
      registry?: string;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EmbeddingRuntimeFetchError";
    this.kind = kind;
    this.packageName = options.packageName;
    this.registry = options.registry;
  }
}

/** Phase of {@link fetchEmbeddingRuntime}, for progress UI. */
export type RuntimeFetchPhase =
  | "metadata"
  | "download"
  | "verify"
  | "extract"
  | "commit";

/** One progress tick; download ticks carry byte counts. */
export interface RuntimeFetchProgress {
  readonly phase: RuntimeFetchPhase;
  readonly packageName?: string;
  readonly registry?: string;
  readonly bytesWritten?: number;
  readonly totalBytes?: number | null;
}

/** One package recorded in the installed manifest. */
export interface InstalledRuntimePackage {
  readonly name: string;
  readonly version: string;
  readonly registry: string;
  readonly integrity: string;
  readonly tarballBytes: number;
  readonly unpackedBytes: number;
  readonly files: number;
  readonly skippedEntries: number;
}

/** Written to `<runtimeDir>/runtime-manifest.json` after a successful install. */
export interface EmbeddingRuntimeManifest {
  readonly manifestVersion: number;
  readonly runtimeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly createdAt: string;
  readonly packages: readonly InstalledRuntimePackage[];
  readonly tarballBytes: number;
  readonly unpackedBytes: number;
  readonly files: number;
  readonly skippedEntries: number;
}

/** Injected seams; production leaves every field unset. */
export interface RuntimeFetchDependencies {
  readonly fetchMetadata?: RuntimeMetadataFetcher;
  readonly download?: RuntimeDownloader;
  readonly registries?: readonly NpmRegistrySource[];
  /** Override `process.platform` (tests, platform-matrix assertions). */
  readonly platform?: string;
  /** Override `process.arch`. */
  readonly arch?: string;
}

/** Options for {@link fetchEmbeddingRuntime}. */
export interface FetchEmbeddingRuntimeOptions {
  /** Runtime cache directory name. Defaults to the pinned ORT version. */
  readonly runtimeVersion?: string;
  /** Pinned package closure. Defaults to {@link DEFAULT_EMBEDDING_RUNTIME_PACKAGES}. */
  readonly packages?: readonly (string | RuntimePackageSpec)[];
  /** Explicit install directory; defaults to `getEmbeddingRuntimeDir(version)`. */
  readonly runtimeDir?: string;
  /** Reinstall even when a matching manifest is present. */
  readonly force?: boolean;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (progress: RuntimeFetchProgress) => void;
  readonly deps?: RuntimeFetchDependencies;
  /** Skip the platform gate; only for tooling that inspects archives. */
  readonly allowUnsupportedPlatform?: boolean;
}

/** Result of {@link fetchEmbeddingRuntime}. */
export interface FetchEmbeddingRuntimeResult {
  readonly runtimeDir: string;
  readonly manifest: EmbeddingRuntimeManifest;
  /** True when a matching install already existed and nothing was fetched. */
  readonly alreadyInstalled: boolean;
}

/** Platforms with a prebuilt `onnxruntime-node` binary in the 1.31.1 closure. */
const SUPPORTED_RUNTIME_TARGETS: ReadonlySet<string> = new Set([
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

/** OS directory names used by the onnxruntime npm packages. */
const KNOWN_PLATFORM_DIRECTORIES: ReadonlySet<string> = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "wasm",
  "win32",
]);

/** CPU directory names used by the onnxruntime npm packages. */
const KNOWN_ARCH_DIRECTORIES: ReadonlySet<string> = new Set([
  "arm",
  "arm64",
  "ia32",
  "mips",
  "mipsel",
  "ppc64",
  "riscv64",
  "s390x",
  "x64",
]);

const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const DEFAULT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Whether the pinned ORT closure ships a binary for this platform/arch. */
export function isEmbeddingRuntimePlatformSupported(
  platform: string,
  arch: string,
): boolean {
  return SUPPORTED_RUNTIME_TARGETS.has(`${platform}-${arch}`);
}

/**
 * Parse `name@version` (or accept an already-split coordinate). Only exact
 * versions are allowed: a range would let a later install silently change the
 * binary under the same cache directory.
 */
export function parseRuntimePackageSpec(
  spec: string | RuntimePackageSpec,
): RuntimePackageSpec {
  if (typeof spec !== "string") {
    return parseRuntimePackageSpec(`${spec.name}@${spec.version}`);
  }
  const separator = spec.lastIndexOf("@");
  if (separator <= 0) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      `Runtime package spec ${JSON.stringify(spec)} must be name@exact-version.`,
    );
  }
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      `Runtime package name ${JSON.stringify(name)} is not a valid npm package name.`,
    );
  }
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      `Runtime package version ${JSON.stringify(version)} is not an exact version.`,
    );
  }
  return { name, version };
}

/** URL of one package's version document on a registry. */
export function buildPackageMetadataUrl(
  registry: NpmRegistrySource,
  spec: RuntimePackageSpec,
): string {
  const base = registry.metadataBaseUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(spec.name)}/${encodeURIComponent(spec.version)}`;
}

/**
 * Fetch and project one npm version document through C1's HTTP client (so
 * proxy, timeout and retry behaviour matches every other download).
 */
export async function fetchNpmPackageMetadata(
  metadataUrl: string,
  options: MetadataFetchOptions = {},
): Promise<NpmPackageMetadata> {
  const response = await requestDownloadHttp({
    url: metadataUrl,
    headers: { accept: "application/json" },
    timeoutMs: 10_000,
    maxRetries: 1,
    env: options.env,
    signal: options.signal,
  });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.stream) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > MAX_METADATA_BYTES) {
        throw new EmbeddingRuntimeFetchError(
          "metadata",
          `Registry metadata response exceeds ${MAX_METADATA_BYTES} bytes.`,
        );
      }
      chunks.push(bytes);
    }
  } finally {
    response.stream.destroy();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      "Registry metadata response is not valid JSON.",
      { cause: error },
    );
  }
  return parseNpmMetadata(parsed);
}

/**
 * Resolve one pinned package, trying each registry in order. Every failure
 * (network, malformed document, missing sha512, unusable tarball URL) moves on
 * to the next registry; the combined reason is reported if all fail.
 */
export async function resolveRuntimePackage(
  spec: string | RuntimePackageSpec,
  options: {
    readonly registries?: readonly NpmRegistrySource[];
    readonly fetchMetadata?: RuntimeMetadataFetcher;
    readonly signal?: AbortSignal;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ResolvedRuntimePackage> {
  const parsed = parseRuntimePackageSpec(spec);
  const registries = options.registries ?? DEFAULT_NPM_REGISTRIES;
  const fetchMetadata = options.fetchMetadata ?? fetchNpmPackageMetadata;
  const failures: string[] = [];

  for (const registry of registries) {
    assertNotAborted(options.signal);
    const metadataUrl = buildPackageMetadataUrl(registry, parsed);
    try {
      const metadata = await fetchMetadata(metadataUrl, {
        signal: options.signal,
        env: options.env,
      });
      const integrity = requireSha512Integrity(metadata.integrity);
      assertMetadataMatches(metadata, parsed, registry);
      return {
        name: metadata.name,
        version: metadata.version,
        registry: registry.id,
        metadataUrl,
        tarballUrl: assertAllowedTarballUrl(metadata.tarballUrl, metadataUrl),
        integrity,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      failures.push(`${registry.id}: ${describeError(error)}`);
    }
  }

  throw new EmbeddingRuntimeFetchError(
    "metadata",
    `Could not resolve ${parsed.name}@${parsed.version} from any registry (${failures.join("; ")}).`,
  );
}

/**
 * Download, verify, extract and install the pinned runtime closure.
 *
 * Idempotent: a matching `runtime-manifest.json` for the same version,
 * platform, arch and package pins returns immediately. Otherwise the install is
 * staged in a sibling temporary directory and renamed into place only after all
 * steps succeed.
 */
export async function fetchEmbeddingRuntime(
  options: FetchEmbeddingRuntimeOptions = {},
): Promise<FetchEmbeddingRuntimeResult> {
  const deps = options.deps ?? {};
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const runtimeVersion =
    options.runtimeVersion ?? DEFAULT_EMBEDDING_RUNTIME_VERSION;
  const runtimeDir =
    options.runtimeDir ?? getEmbeddingRuntimeDir(runtimeVersion);
  const specs = (options.packages ?? DEFAULT_EMBEDDING_RUNTIME_PACKAGES).map(
    (spec) => parseRuntimePackageSpec(spec),
  );
  if (specs.length === 0) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      "The embedding runtime package closure is empty.",
    );
  }
  if (
    !options.allowUnsupportedPlatform &&
    !isEmbeddingRuntimePlatformSupported(platform, arch)
  ) {
    throw new EmbeddingRuntimeFetchError(
      "platform",
      `The embedding runtime has no prebuilt binary for ${platform}-${arch}.`,
    );
  }

  if (!options.force) {
    const existing = await readRuntimeManifest(runtimeDir);
    if (
      existing !== null &&
      isManifestUsable(existing, runtimeVersion, platform, arch, specs)
    ) {
      return { runtimeDir, manifest: existing, alreadyInstalled: true };
    }
  }

  const fetchMetadata = deps.fetchMetadata ?? fetchNpmPackageMetadata;
  const download = deps.download ?? downloadToFile;
  const registries = deps.registries ?? DEFAULT_NPM_REGISTRIES;
  const stagingDir = `${runtimeDir}.tmp-${randomUUID()}`;
  const tarballDir = join(stagingDir, ".tarballs");

  try {
    await mkdir(tarballDir, { recursive: true });
    const installed: InstalledRuntimePackage[] = [];
    for (const spec of specs) {
      assertNotAborted(options.signal);
      options.onProgress?.({ phase: "metadata", packageName: spec.name });
      const resolved = await resolveRuntimePackage(spec, {
        fetchMetadata,
        registries,
        signal: options.signal,
        env: options.env,
      });

      options.onProgress?.({
        phase: "download",
        packageName: spec.name,
        registry: resolved.registry,
      });
      const tarballPath = join(
        tarballDir,
        `${sanitizeFileSegment(spec.name)}-${spec.version}.tgz`,
      );
      let downloaded: DownloadFileResult;
      try {
        downloaded = await download({
          url: resolved.tarballUrl,
          outputPath: tarballPath,
          signal: options.signal,
          env: options.env,
          onProgress: (progress) => {
            options.onProgress?.({
              phase: "download",
              packageName: spec.name,
              registry: resolved.registry,
              bytesWritten: progress.bytesWritten,
              totalBytes: progress.totalBytes,
            });
          },
        });
      } catch (error) {
        throw new EmbeddingRuntimeFetchError(
          "download",
          `Failed to download ${spec.name}@${spec.version} from ${resolved.registry}: ${describeError(error)}`,
          {
            cause: error,
            packageName: spec.name,
            registry: resolved.registry,
          },
        );
      }

      options.onProgress?.({
        phase: "verify",
        packageName: spec.name,
        registry: resolved.registry,
      });
      await verifySha512Integrity(tarballPath, resolved.integrity, spec);

      options.onProgress?.({
        phase: "extract",
        packageName: spec.name,
        registry: resolved.registry,
      });
      let extraction: ExtractTarGzResult;
      try {
        extraction = await extractTarGz(tarballPath, {
          destinationDir: join(stagingDir, "node_modules", spec.name),
          signal: options.signal,
          includeEntry: (entry) =>
            shouldExtractEntryForPlatform(entry.name, platform, arch),
        });
      } catch (error) {
        throw new EmbeddingRuntimeFetchError(
          "extract",
          `Failed to extract ${spec.name}@${spec.version}: ${describeError(error)}`,
          {
            cause: error,
            packageName: spec.name,
            registry: resolved.registry,
          },
        );
      }

      installed.push({
        name: spec.name,
        version: spec.version,
        registry: resolved.registry,
        integrity: resolved.integrity,
        tarballBytes: downloaded.totalBytes ?? downloaded.bytesWritten,
        unpackedBytes: extraction.bytesWritten,
        files: extraction.files.length,
        skippedEntries: extraction.skippedEntries,
      });
    }

    await rm(tarballDir, { force: true, recursive: true });
    const manifest = buildManifest(runtimeVersion, platform, arch, installed);
    await writeFile(
      join(stagingDir, RUNTIME_MANIFEST_FILE_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    options.onProgress?.({ phase: "commit" });
    try {
      if (existsSync(runtimeDir)) {
        await rm(runtimeDir, { force: true, recursive: true });
      }
      await rename(stagingDir, runtimeDir);
    } catch (error) {
      throw new EmbeddingRuntimeFetchError(
        "io",
        `Could not install the embedding runtime into ${runtimeDir}: ${describeError(error)}`,
        { cause: error },
      );
    }

    return { runtimeDir, manifest, alreadyInstalled: false };
  } catch (error) {
    await removeQuietly(stagingDir);
    if (error instanceof EmbeddingRuntimeFetchError) throw error;
    if (isAbortError(error)) throw error;
    throw new EmbeddingRuntimeFetchError(
      "io",
      `Embedding runtime fetch failed: ${describeError(error)}`,
      { cause: error },
    );
  }
}

/** Read the installed manifest for a version directory. `null` when absent. */
export async function readEmbeddingRuntimeManifest(
  runtimeVersion: string = DEFAULT_EMBEDDING_RUNTIME_VERSION,
): Promise<EmbeddingRuntimeManifest | null> {
  return readRuntimeManifest(getEmbeddingRuntimeDir(runtimeVersion));
}

/**
 * Remove an installed runtime directory. Returns whether it existed; other
 * runtime versions are untouched.
 */
export async function uninstallEmbeddingRuntime(
  runtimeVersion: string = DEFAULT_EMBEDDING_RUNTIME_VERSION,
): Promise<boolean> {
  const runtimeDir = getEmbeddingRuntimeDir(runtimeVersion);
  if (!existsSync(runtimeDir)) return false;
  await rm(runtimeDir, { force: true, recursive: true });
  return true;
}

/**
 * Remove orphaned staging directories left behind by a crashed/killed install.
 * Staging names are `<runtimeDir>.tmp-<uuid>` siblings of the version
 * directories; only names matching that shape and older than `maxAgeMs` are
 * removed. Best effort: returns the paths that were removed.
 */
export async function cleanupEmbeddingRuntimeStagingDirs(
  options: {
    readonly runtimeVersion?: string;
    readonly maxAgeMs?: number;
    readonly now?: number;
  } = {},
): Promise<string[]> {
  const runtimeVersion =
    options.runtimeVersion ?? DEFAULT_EMBEDDING_RUNTIME_VERSION;
  const runtimeRoot = dirname(getEmbeddingRuntimeDir(runtimeVersion));
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STAGING_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(runtimeRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!/\.tmp-[0-9a-f-]{36}$/.test(name)) continue;
    const candidate = join(runtimeRoot, name);
    try {
      const info = await stat(candidate);
      if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
      await rm(candidate, { force: true, recursive: true });
      removed.push(candidate);
    } catch {
      // Best effort: another process may have cleaned it up already.
    }
  }
  return removed;
}

/**
 * Whether an entry should be written for the current platform. Entries under
 * any `<known-os>/<known-arch>/` pair are kept only when that pair is the
 * target; everything else (JS sources, package.json, maps) is kept.
 */
export function shouldExtractEntryForPlatform(
  entryName: string,
  platform: string,
  arch: string,
): boolean {
  const segments = entryName.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    const os = segments[index];
    const cpu = segments[index + 1];
    if (
      os !== undefined &&
      cpu !== undefined &&
      KNOWN_PLATFORM_DIRECTORIES.has(os) &&
      KNOWN_ARCH_DIRECTORIES.has(cpu)
    ) {
      return os === platform && cpu === arch;
    }
  }
  return true;
}

/**
 * Base64 sha512 digest from an SRI integrity string. npm publishes
 * `sha512-<base64>`; multiple space-separated tokens are allowed and the sha512
 * one is selected. No sha512 token is a hard failure.
 */
export function parseSha512Integrity(integrity: string): string {
  return requireSha512Integrity(integrity);
}

function requireSha512Integrity(integrity: string | null): string {
  if (typeof integrity !== "string" || integrity.trim().length === 0) {
    throw new EmbeddingRuntimeFetchError(
      "integrity",
      "npm metadata did not provide a sha512 integrity value.",
    );
  }
  for (const token of integrity.trim().split(/\s+/)) {
    if (!token.startsWith("sha512-")) continue;
    const encoded = token.slice("sha512-".length);
    const digest = Buffer.from(encoded, "base64");
    if (digest.length !== 64) {
      throw new EmbeddingRuntimeFetchError(
        "integrity",
        "npm metadata sha512 integrity value is not a 64-byte digest.",
      );
    }
    return token;
  }
  throw new EmbeddingRuntimeFetchError(
    "integrity",
    "npm metadata did not provide a sha512 integrity value.",
  );
}

async function verifySha512Integrity(
  tarballPath: string,
  integrity: string,
  spec: RuntimePackageSpec,
): Promise<void> {
  const token = requireSha512Integrity(integrity);
  const expected = Buffer.from(token.slice("sha512-".length), "base64");
  const hash = createHash("sha512");
  await pipeline(createReadStream(tarballPath), hash);
  const actual = hash.digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new EmbeddingRuntimeFetchError(
      "integrity",
      `sha512 mismatch for ${spec.name}@${spec.version}: the downloaded tarball does not match dist.integrity.`,
      { packageName: spec.name },
    );
  }
}

function parseNpmMetadata(value: unknown): NpmPackageMetadata {
  if (typeof value !== "object" || value === null) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      "npm metadata response is not an object.",
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      "npm metadata response has no package name.",
    );
  }
  if (typeof record.version !== "string" || record.version.length === 0) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      "npm metadata response has no package version.",
    );
  }
  const dist =
    typeof record.dist === "object" && record.dist !== null
      ? (record.dist as Record<string, unknown>)
      : null;
  const tarball =
    dist !== null && typeof dist.tarball === "string" ? dist.tarball : null;
  if (tarball === null) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      "npm metadata response has no dist.tarball.",
    );
  }
  const integrity =
    dist !== null && typeof dist.integrity === "string" ? dist.integrity : null;
  return {
    name: record.name,
    version: record.version,
    tarballUrl: tarball,
    integrity,
  };
}

function assertMetadataMatches(
  metadata: NpmPackageMetadata,
  spec: RuntimePackageSpec,
  registry: NpmRegistrySource,
): void {
  if (metadata.name.toLowerCase() !== spec.name.toLowerCase()) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      `Registry ${registry.id} returned metadata for ${JSON.stringify(metadata.name)} instead of ${JSON.stringify(spec.name)}.`,
    );
  }
  if (metadata.version !== spec.version) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      `Registry ${registry.id} returned version ${JSON.stringify(metadata.version)} instead of ${JSON.stringify(spec.version)}.`,
    );
  }
}

/**
 * npm tarball URLs are absolute in both registries, but a mirror could return a
 * relative path (resolved against the metadata URL) or an insecure origin.
 * Remote downloads must be https; http is allowed only for a loopback mirror so
 * local tests and a local registry work without weakening the public path.
 */
function assertAllowedTarballUrl(raw: string, metadataUrl: string): string {
  let url: URL;
  try {
    url = new URL(raw, metadataUrl);
  } catch (error) {
    throw new EmbeddingRuntimeFetchError(
      "metadata",
      `Tarball URL ${JSON.stringify(raw)} is not a valid URL.`,
      { cause: error },
    );
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return url.toString();
  }
  throw new EmbeddingRuntimeFetchError(
    "metadata",
    `Tarball URL must use https (or http on loopback): ${url.protocol}//${url.host}/…`,
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

function buildManifest(
  runtimeVersion: string,
  platform: string,
  arch: string,
  packages: readonly InstalledRuntimePackage[],
): EmbeddingRuntimeManifest {
  let tarballBytes = 0;
  let unpackedBytes = 0;
  let files = 0;
  let skippedEntries = 0;
  for (const pkg of packages) {
    tarballBytes += pkg.tarballBytes;
    unpackedBytes += pkg.unpackedBytes;
    files += pkg.files;
    skippedEntries += pkg.skippedEntries;
  }
  return {
    manifestVersion: RUNTIME_MANIFEST_VERSION,
    runtimeVersion,
    platform,
    arch,
    createdAt: new Date().toISOString(),
    packages,
    tarballBytes,
    unpackedBytes,
    files,
    skippedEntries,
  };
}

async function readRuntimeManifest(
  runtimeDir: string,
): Promise<EmbeddingRuntimeManifest | null> {
  let raw: string;
  try {
    raw = await readFile(join(runtimeDir, RUNTIME_MANIFEST_FILE_NAME), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRuntimeManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRuntimeManifest(value: unknown): value is EmbeddingRuntimeManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.manifestVersion !== RUNTIME_MANIFEST_VERSION) return false;
  if (
    typeof record.runtimeVersion !== "string" ||
    typeof record.platform !== "string" ||
    typeof record.arch !== "string" ||
    !Array.isArray(record.packages)
  ) {
    return false;
  }
  return record.packages.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const pkg = entry as Record<string, unknown>;
    return typeof pkg.name === "string" && typeof pkg.version === "string";
  });
}

function isManifestUsable(
  manifest: EmbeddingRuntimeManifest,
  runtimeVersion: string,
  platform: string,
  arch: string,
  specs: readonly RuntimePackageSpec[],
): boolean {
  if (
    manifest.runtimeVersion !== runtimeVersion ||
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.packages.length !== specs.length
  ) {
    return false;
  }
  const expected = new Map(
    specs.map((spec) => [spec.name, spec.version] as const),
  );
  return manifest.packages.every(
    (pkg) => expected.get(pkg.name) === pkg.version,
  );
}

function sanitizeFileSegment(name: string): string {
  return name.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // Staging cleanup is best effort; never mask the original failure.
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Embedding runtime fetch aborted.");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const kind = (error as unknown as { kind?: unknown }).kind;
  return kind === "aborted";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
