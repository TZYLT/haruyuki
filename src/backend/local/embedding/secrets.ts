/**
 * Embedding cache roots and endpoint-credential storage for the local backend.
 *
 * Two responsibilities, both small but easy to get wrong:
 *
 * 1. **Cache paths.** Runtime and model downloads live under the harness cache
 *    root, resolved through `@/utils/app-paths` on *every* call: `HOME` and
 *    `HARUYUKI_HOME` may change at runtime (the test preload redirects home), so
 *    a module-level constant would freeze whichever root happened to be current
 *    at import time and then silently disagree with every other resolver. This
 *    module never spells the harness directory name as a literal — app-paths
 *    owns that vocabulary. The cache root is deliberately *not* under the
 *    session directory or the agent memory worktree: those are user data, while
 *    downloaded runtimes/models are re-derivable cache.
 *
 * 2. **Endpoint API keys.** These are *not* re-implemented here: every read and
 *    write delegates to `@/utils/secrets-store`, which prefers the OS credential
 *    store under Bun (`Bun.secrets`) and automatically falls back to a local
 *    file. Two things are added on top:
 *    - `hardenEmbeddingSecretFile()` re-applies file mode 0600. `writeFileSync`'s
 *      `mode` option only takes effect when the file is created, so a file that
 *      already exists with looser permissions would keep them forever.
 *    - `getEmbeddingSecretStorageDisclosure()` states the truth for the UI and
 *      status surface (R-36): keychain where available, otherwise a plaintext
 *      0600 file whose contents are never written to logs, status output or
 *      protocol responses.
 *
 * Layer: `backend/local/`. Imports only `utils/` (plus the secrets store the
 * requirement pins); no `cli/`, `websocket/`, `reminders/` or `agent/` imports.
 */

import { chmodSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { APP_SUBDIRS, appHomePath } from "@/utils/app-paths";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";
import { isKeychainAvailable } from "@/utils/secrets";
import {
  deleteSecretOnServer,
  refreshAndListSecrets,
  setSecretOnServer,
} from "@/utils/secrets-store";

/**
 * Secret name an endpoint API key is stored under. Settings keep this reference
 * name only (plus `kind`/`baseUrl`/`model`/`dimensions`/`timeoutMs`), never the
 * key material itself.
 */
export const EMBEDDING_ENDPOINT_SECRET_NAME = "EMBEDDING_ENDPOINT_API_KEY";

const EMBEDDING_CACHE_DIR_NAME = "embedding";
const RUNTIME_DIR_NAME = "runtime";
const MODELS_DIR_NAME = "models";

/**
 * Mirror of `FILE_BACKED_LOCAL_SECRETS_PATH` in `@/utils/secrets-store` (that
 * constant is module-private). Keep these two in sync; `secrets.test.ts` checks
 * that a key written through the store lands in the file hardened here.
 */
const LOCAL_SECRETS_SUBDIR = "secrets";
const LOCAL_SECRETS_FILE_NAME = "local-agent-secrets.json";

/**
 * One safe path segment: starts with an alphanumeric character and contains only
 * alphanumerics, dots, dashes and underscores. Version strings (`1.31.1`), model
 * ids (`bge-small-zh-v1.5`) and platform triples (`win32-x64`) all fit; path
 * separators, drive letters, `..` and NUL bytes never do.
 */
const CACHE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown when a requested embedding cache path would leave the cache root. */
export class EmbeddingCachePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingCachePathError";
  }
}

/**
 * Root of the embedding download cache (`<harness cache>/embedding`). Resolved on
 * every call so `HARUYUKI_HOME` moves it, and never captured in a module-level
 * constant.
 */
export function getEmbeddingCacheDir(): string {
  return appHomePath([APP_SUBDIRS.cache, EMBEDDING_CACHE_DIR_NAME]);
}

/**
 * Directory a downloaded runtime version is unpacked into
 * (`<cache>/runtime/<version>`), matching 48-1 §6.4.
 */
export function getEmbeddingRuntimeDir(version: string): string {
  return resolveEmbeddingCachePath(RUNTIME_DIR_NAME, version);
}

/** Directory all model weights live under (`<cache>/models`). */
export function getEmbeddingModelsDir(): string {
  return resolveEmbeddingCachePath(MODELS_DIR_NAME);
}

/** Directory one model's weights live under (`<cache>/models/<modelId>`). */
export function getEmbeddingModelDir(modelId: string): string {
  return resolveEmbeddingCachePath(MODELS_DIR_NAME, modelId);
}

/**
 * Join path segments below the embedding cache root, refusing anything that is
 * not a single safe segment (traversal, absolute paths, separators). Callers
 * that build a path from downloaded metadata (model ids, versions, tar member
 * names) must go through this or {@link assertInsideEmbeddingCache}; that is the
 * path-side half of the sandbox: no write ever lands outside the cache root.
 */
export function resolveEmbeddingCachePath(...segments: string[]): string {
  const root = getEmbeddingCacheDir();
  const parts = segments.map((segment, index) =>
    sanitizeCacheSegment(segment, index),
  );
  const resolved = resolve(root, ...parts);
  if (!isInsidePath(root, resolved)) {
    throw new EmbeddingCachePathError(
      `Embedding cache path escapes the cache root: ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Validate a pre-built path (for example a tar entry target) stays inside the
 * embedding cache root. Returns the absolute path; throws
 * {@link EmbeddingCachePathError} otherwise.
 */
export function assertInsideEmbeddingCache(candidate: string): string {
  const resolved = resolve(candidate);
  if (!isInsidePath(getEmbeddingCacheDir(), resolved)) {
    throw new EmbeddingCachePathError(
      `Path is outside the embedding cache root: ${candidate}`,
    );
  }
  return resolved;
}

/** Non-throwing variant of {@link assertInsideEmbeddingCache}. */
export function isInsideEmbeddingCache(candidate: string): boolean {
  try {
    assertInsideEmbeddingCache(candidate);
    return true;
  } catch {
    return false;
  }
}

function sanitizeCacheSegment(segment: string, index: number): string {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new EmbeddingCachePathError(
      `Embedding cache path segment ${index} must be a non-empty string.`,
    );
  }
  if (
    !CACHE_SEGMENT_PATTERN.test(segment) ||
    segment === "." ||
    segment === ".."
  ) {
    throw new EmbeddingCachePathError(
      `Embedding cache path segment ${index} is not a safe path segment: ${JSON.stringify(segment)}`,
    );
  }
  return segment;
}

function isInsidePath(root: string, candidate: string): boolean {
  const nested = relative(resolve(root), resolve(candidate));
  return (
    nested === "" ||
    (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

/**
 * Absolute path of the file-backed secret store used when the OS credential
 * store is unavailable (always the case in the published Node build). This is
 * the file mode 0600 hardening applies to.
 */
export function getEmbeddingSecretFallbackPath(): string {
  return join(
    getLocalBackendStorageDir(),
    LOCAL_SECRETS_SUBDIR,
    LOCAL_SECRETS_FILE_NAME,
  );
}

/**
 * Re-apply mode 0600 to an already-existing secret file. `writeFileSync`'s mode
 * only applies at creation, so this closes the gap for files created by an older
 * build or under a permissive umask. Best effort: returns whether a chmod was
 * applied without reporting errors (Windows maps this to the write-protection
 * bit; other failures are non-fatal and must not block writes).
 */
export function hardenEmbeddingSecretFile(): boolean {
  const filePath = getEmbeddingSecretFallbackPath();
  if (!existsSync(filePath)) return false;
  try {
    chmodSync(filePath, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Where an embedding endpoint API key is actually stored right now. */
export type EmbeddingSecretStorage = "keychain" | "plaintext-file";

/** Honest storage disclosure for the settings UI and the status surface. */
export interface EmbeddingSecretStorageDisclosure {
  readonly storage: EmbeddingSecretStorage;
  readonly filePath: string;
  readonly disclosure: string;
}

const KEYCHAIN_DISCLOSURE =
  "Embedding endpoint API keys are stored in the operating system credential store (Bun.secrets).";

function plaintextSecretDisclosure(filePath: string): string {
  return `Embedding endpoint API keys are stored unencrypted in ${filePath} with file mode 0600. The key is never written to logs, status output, or protocol responses.`;
}

/**
 * Describe where the endpoint API key lives and how it is protected. Node's
 * published build always reports the plaintext-0600 fallback, because
 * `Bun.secrets` does not exist there; the Bun build prefers the keychain and
 * falls back to the same file when the keychain is empty or unwritable.
 */
export async function getEmbeddingSecretStorageDisclosure(): Promise<EmbeddingSecretStorageDisclosure> {
  const filePath = getEmbeddingSecretFallbackPath();
  if (await isKeychainAvailable()) {
    return {
      storage: "keychain",
      filePath,
      disclosure: KEYCHAIN_DISCLOSURE,
    };
  }
  return {
    storage: "plaintext-file",
    filePath,
    disclosure: plaintextSecretDisclosure(filePath),
  };
}

/**
 * Read the endpoint API key. Returns `null` when unset. Storage is delegated to
 * `@/utils/secrets-store` (keychain on Bun, 0600 file otherwise); the value is
 * never logged by this module.
 */
export async function getEmbeddingEndpointApiKey(
  agentId?: string,
  profileId?: string,
): Promise<string | null> {
  // Reading is also a chance to repair the permissions of a file written by an
  // older build (or under a permissive umask) before its value is used.
  hardenEmbeddingSecretFile();
  const entries = await refreshAndListSecrets(agentId);
  const name =
    profileId === undefined || profileId.length === 0
      ? EMBEDDING_ENDPOINT_SECRET_NAME
      : `${EMBEDDING_ENDPOINT_SECRET_NAME}.${profileId}`;
  for (const entry of entries) {
    if (entry.key === name) {
      return entry.value.length > 0 ? entry.value : null;
    }
  }
  // A profile-scoped read falls back to the pre-48-4 single-key name, so an
  // endpoint configured before this change keeps working.
  if (name !== EMBEDDING_ENDPOINT_SECRET_NAME) {
    for (const entry of entries) {
      if (entry.key === EMBEDDING_ENDPOINT_SECRET_NAME) {
        return entry.value.length > 0 ? entry.value : null;
      }
    }
  }
  return null;
}

function endpointSecretName(profileId?: string): string {
  return profileId === undefined || profileId.length === 0
    ? EMBEDDING_ENDPOINT_SECRET_NAME
    : `${EMBEDDING_ENDPOINT_SECRET_NAME}.${profileId}`;
}

/**
 * Persist the endpoint API key through the shared secrets store, then report
 * which storage actually accepted it. Used by the settings UI to show the R-36
 * disclosure immediately after saving.
 */
export async function saveEmbeddingEndpointApiKey(
  value: string,
  agentId?: string,
  profileId?: string,
): Promise<EmbeddingSecretStorage> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Embedding endpoint API key must not be empty.");
  }

  const keychainAvailable = await isKeychainAvailable();
  const name = endpointSecretName(profileId);
  await setSecretOnServer(name, trimmed, agentId);
  hardenEmbeddingSecretFile();

  if (keychainAvailable) {
    // Verify through the same scoped read path the retrieval uses
    // (`refreshAndListSecrets(agentId)`): a direct `getSecretValue` read is not
    // agent-scoped, so an agent-domain write read back as null and the
    // disclosure wrongly fell back to "plaintext-file".
    const entries = await refreshAndListSecrets(agentId);
    const stored = entries.find((entry) => entry.key === name);
    if (stored?.value === trimmed) return "keychain";
  }
  return "plaintext-file";
}

/**
 * Remove the endpoint API key from both storage layers (the store deletes the
 * keychain entry and the file copy). Returns whether anything was removed.
 */
export async function clearEmbeddingEndpointApiKey(
  agentId?: string,
  profileId?: string,
): Promise<boolean> {
  const deleted = await deleteSecretOnServer(
    endpointSecretName(profileId),
    agentId,
  );
  hardenEmbeddingSecretFile();
  return deleted;
}
