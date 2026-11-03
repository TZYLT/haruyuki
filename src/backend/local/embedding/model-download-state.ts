/**
 * Small filesystem/state helpers for the C4 model downloader: the negative
 * cache, `.part` sidecar metadata, sha256 hashing, the disk-space probe and the
 * abort/error classification used by both the fetch and import flows.
 *
 * The negative cache is a single JSON file under
 * `<cache>/embedding/state/model-download-state.json`. Entries are keyed by
 * `modelId / sourceId / filePath` and carry an absolute timestamp plus a finite
 * TTL; expired entries are dropped on read and on write. Only failures that are
 * attributable to a *source* are recorded (a local disk error is not the
 * mirror's fault), and timeouts use the short TTL so a transient outage never
 * becomes a permanent "this mirror is broken" (48-1 §6.4).
 *
 * Layer: `backend/local/`. Imports only `node:` builtins, the shared contract in
 * `model-download-types.ts`, `download-http`'s typed error and the manifest
 * types; no higher-layer imports.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statfsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { EmbeddingHttpError } from "./download-http";
import {
  DEFAULT_DETERMINISTIC_FAILURE_TTL_MS,
  DEFAULT_TRANSIENT_FAILURE_TTL_MS,
  EmbeddingModelDownloadError,
  type EmbeddingModelNegativeCacheEntry,
} from "./model-download-types";
import type { EmbeddingModelManifest } from "./model-manifest";

const NEGATIVE_CACHE_SCHEMA_VERSION = 1;

interface NegativeCacheFile {
  readonly schemaVersion: number;
  readonly entries: Record<string, EmbeddingModelNegativeCacheEntry>;
}

/** Sidecar written before a download so a later run knows the source. */
export interface PartMeta {
  readonly sourceId: string;
}

/** Key for one (model, source, file) negative-cache entry. */
export function negativeCacheKey(
  modelId: string,
  sourceId: string,
  filePath: string,
): string {
  return `${modelId}\u0000${sourceId}\u0000${filePath}`;
}

/** Non-expired entry for `key`, or `null` (expired entries are dropped). */
export function lookupNegativeCache(
  cache: Map<string, EmbeddingModelNegativeCacheEntry>,
  key: string,
  now: () => number,
): EmbeddingModelNegativeCacheEntry | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (now() - entry.at >= entry.ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry;
}

/** Remember one source failure with the deterministic/transient TTL. */
export function recordNegativeCache(
  cache: Map<string, EmbeddingModelNegativeCacheEntry>,
  key: string,
  classification: { deterministic: boolean },
  options: { deterministicTtlMs?: number; transientTtlMs?: number },
  now: () => number,
): void {
  const ttlMs = classification.deterministic
    ? (options.deterministicTtlMs ?? DEFAULT_DETERMINISTIC_FAILURE_TTL_MS)
    : (options.transientTtlMs ?? DEFAULT_TRANSIENT_FAILURE_TTL_MS);
  cache.set(key, {
    at: now(),
    ttlMs,
    kind: classification.deterministic ? "deterministic" : "transient",
    message: "source failed; skipped until the TTL expires",
  });
}

/** Forget a file's failures across every source after a clean download. */
export function clearNegativeCacheFile(
  cache: Map<string, EmbeddingModelNegativeCacheEntry>,
  modelId: string,
  filePath: string,
  sources: EmbeddingModelManifest["sources"],
): void {
  for (const source of sources) {
    cache.delete(negativeCacheKey(modelId, source.id, filePath));
  }
}

/** Read the cache, dropping expired entries and tolerating a corrupt file. */
export async function readNegativeCache(
  stateFile: string,
  now: () => number,
): Promise<Map<string, EmbeddingModelNegativeCacheEntry>> {
  const cache = new Map<string, EmbeddingModelNegativeCacheEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return cache;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !==
      NEGATIVE_CACHE_SCHEMA_VERSION
  ) {
    return cache;
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (typeof entries !== "object" || entries === null) return cache;
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.at !== "number" ||
      typeof entry.ttlMs !== "number" ||
      typeof entry.kind !== "string" ||
      typeof entry.message !== "string"
    ) {
      continue;
    }
    if (now() - entry.at >= entry.ttlMs) continue;
    cache.set(key, {
      at: entry.at,
      ttlMs: entry.ttlMs,
      kind: entry.kind,
      message: entry.message,
    });
  }
  return cache;
}

/**
 * Merge the in-memory cache into the on-disk file and write atomically. The
 * merge keeps entries another model's fetch wrote while this one was running.
 */
export async function persistNegativeCache(
  stateFile: string,
  cache: Map<string, EmbeddingModelNegativeCacheEntry>,
  now: () => number,
): Promise<void> {
  const merged = await readNegativeCache(stateFile, now);
  for (const [key, entry] of cache) merged.set(key, entry);
  const entries: Record<string, EmbeddingModelNegativeCacheEntry> = {};
  const current = now();
  for (const [key, entry] of merged) {
    if (current - entry.at >= entry.ttlMs) continue;
    entries[key] = entry;
  }
  const payload: NegativeCacheFile = {
    schemaVersion: NEGATIVE_CACHE_SCHEMA_VERSION,
    entries,
  };
  await mkdir(dirname(stateFile), { recursive: true });
  const tempPath = `${stateFile}.tmp-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, stateFile);
}

/** Read the `.part` sidecar; `null` when absent or malformed. */
export async function readPartMeta(metaPath: string): Promise<PartMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const sourceId = (parsed as { sourceId?: unknown }).sourceId;
    return typeof sourceId === "string" ? { sourceId } : null;
  } catch {
    return null;
  }
}

/** Write the `.part` sidecar before the body starts. */
export async function writePartMeta(
  metaPath: string,
  sourceId: string,
): Promise<void> {
  await writeFile(metaPath, `${JSON.stringify({ sourceId })}\n`, "utf8");
}

/** sha256 hex digest of a file, streamed (no full-file buffer). */
export async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

/**
 * Free bytes on the volume holding a directory. Walks up to the nearest
 * existing ancestor so a not-yet-created cache directory still resolves;
 * `null` means "unknown", which the downloader treats as "do not block".
 */
export function defaultDiskFreeBytes(directory: string): number | null {
  let probe = resolve(directory);
  for (;;) {
    if (existsSync(probe)) {
      try {
        const stats = statfsSync(probe);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return null;
      }
    }
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
}

/** Remove a partial file; best effort so cleanup never masks the real error. */
export async function removeFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Nothing to do: the original failure is what reaches the caller.
  }
}

/** Short, redacted-enough error text for aggregated per-source messages. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 400 ? `${message.slice(0, 400)}…` : message;
}

/** Human-readable byte count for actionable disk/space messages. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/**
 * Whether `error` is a cancellation. C1 reports aborts as an
 * `EmbeddingHttpError` with kind `"aborted"`; a native `AbortError` is also
 * accepted so an injected downloader behaves the same.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof EmbeddingModelDownloadError) {
    return error.kind === "aborted";
  }
  if (error instanceof EmbeddingHttpError) return error.kind === "aborted";
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return (error as unknown as { kind?: unknown }).kind === "aborted";
}

/** Throw the typed cancellation error when the caller's signal already fired. */
export function throwIfAborted(
  signal: AbortSignal | undefined,
  modelId: string,
): void {
  if (signal?.aborted !== true) return;
  throw new EmbeddingModelDownloadError(
    "aborted",
    `Model download for ${modelId} was cancelled.`,
    { modelId },
  );
}

/**
 * Classify a failed source attempt for the negative cache. Deterministic:
 * 4xx (except 408/425/429), a checksum mismatch, a malformed URL. Transient:
 * DNS/timeout/refused/reset/TLS/proxy, 5xx, 429. Local I/O and unknowns are not
 * source faults and are not cached.
 */
export function classifySourceFailure(
  error: unknown,
): { deterministic: boolean } | null {
  if (error instanceof EmbeddingHttpError) {
    if (error.kind === "aborted") return null;
    if (error.kind === "http-status") {
      const status = error.statusCode ?? 0;
      if (status === 408 || status === 425 || status === 429) {
        return { deterministic: false };
      }
      if (status >= 400 && status <= 499) return { deterministic: true };
      return { deterministic: false };
    }
    return { deterministic: false };
  }
  if (error instanceof EmbeddingModelDownloadError) {
    if (error.kind === "checksum" || error.kind === "manifest") {
      return { deterministic: true };
    }
    return null;
  }
  return null;
}
