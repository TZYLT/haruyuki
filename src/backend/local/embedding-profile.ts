/**
 * `profile.json` — what one vector space was built from (48-4 D-10).
 *
 * A space directory is named by a hash of its inputs, so the id alone cannot
 * tell the user which model/chunk window produced it, and `meta.json` carries
 * only part of it. This file is the durable, user-selectable identity: `model`
 * reads it to render the list and to restore settings when a space is selected.
 *
 * It deliberately contains **no secret**: the endpoint API key lives in the
 * secrets store under a name derived from {@link endpointFingerprint}.
 *
 * Layer: `backend/local/` (leaf). Imports node built-ins only.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { debugWarn } from "@/utils/debug";

/** File name inside one space directory. */
export const EMBEDDING_PROFILE_FILE_NAME = "profile.json";

/** Bumped only for an incompatible shape; unknown versions are ignored. */
export const EMBEDDING_PROFILE_SCHEMA_VERSION = 1;

export type EmbeddingProfileBackend = "builtin" | "endpoint";
export type EmbeddingProfileQuant = "float32" | "int8";

/** The endpoint form a profile was connected with (never the key). */
export interface EmbeddingProfileEndpoint {
  kind: "openai" | "ollama";
  baseUrl: string;
  model: string;
  dimensions: number;
  /** Stable identity of the endpoint (scheme+host+port+path). */
  fingerprint: string;
}

export interface EmbeddingProfile {
  schemaVersion: number;
  backend: EmbeddingProfileBackend;
  modelId: string;
  dimensions: number;
  quantization: EmbeddingProfileQuant;
  chunkTarget: number;
  chunkMax: number;
  chunkOverlap: number;
  maxChunksPerMessage: number;
  chunkerVersion: number;
  endpoint?: EmbeddingProfileEndpoint;
  createdAt: string;
  /** Retention protection: a pinned space is never pruned automatically. */
  pinned: boolean;
}

/**
 * Stable endpoint identity: scheme, lower-cased host, explicit port and path,
 * without query or trailing slash. Two URLs that differ only in those produce
 * different space ids and different secret names.
 */
export function endpointFingerprint(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const path = url.pathname.replace(/\/+$/, "");
  const port = url.port !== "" ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}`;
}

/**
 * Stable secret-name suffix for one endpoint (48-4 D-15). Hashed so a URL never
 * becomes a secret-store key verbatim.
 */
export function endpointSecretId(fingerprint: string): string {
  return createHash("sha256")
    .update(fingerprint, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function embeddingProfilePath(spaceDir: string): string {
  return join(spaceDir, EMBEDDING_PROFILE_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function parseEndpoint(value: unknown): EmbeddingProfileEndpoint | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "openai" && value.kind !== "ollama") return null;
  if (typeof value.baseUrl !== "string" || value.baseUrl.length === 0)
    return null;
  if (typeof value.model !== "string" || value.model.length === 0) return null;
  const dimensions = positiveInteger(value.dimensions);
  if (dimensions === null) return null;
  const fingerprint =
    typeof value.fingerprint === "string" && value.fingerprint.length > 0
      ? value.fingerprint
      : endpointFingerprint(value.baseUrl);
  return {
    kind: value.kind,
    baseUrl: value.baseUrl,
    model: value.model,
    dimensions,
    fingerprint,
  };
}

/** Structural parse; anything unusable is `null` (never throws). */
export function parseEmbeddingProfile(value: unknown): EmbeddingProfile | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== EMBEDDING_PROFILE_SCHEMA_VERSION) return null;
  const backend = value.backend === "endpoint" ? "endpoint" : "builtin";
  if (typeof value.modelId !== "string" || value.modelId.length === 0)
    return null;
  const dimensions = positiveInteger(value.dimensions);
  const chunkTarget = positiveInteger(value.chunkTarget);
  const chunkMax = positiveInteger(value.chunkMax);
  const chunkOverlap = nonNegativeInteger(value.chunkOverlap);
  const maxChunksPerMessage = positiveInteger(value.maxChunksPerMessage);
  const chunkerVersion = positiveInteger(value.chunkerVersion);
  if (
    dimensions === null ||
    chunkTarget === null ||
    chunkMax === null ||
    chunkOverlap === null ||
    maxChunksPerMessage === null ||
    chunkerVersion === null
  ) {
    return null;
  }
  const quantization = value.quantization === "int8" ? "int8" : "float32";
  const endpoint = parseEndpoint(value.endpoint);
  if (backend === "endpoint" && endpoint === null) return null;
  return {
    schemaVersion: EMBEDDING_PROFILE_SCHEMA_VERSION,
    backend,
    modelId: value.modelId,
    dimensions,
    quantization,
    chunkTarget,
    chunkMax,
    chunkOverlap,
    maxChunksPerMessage,
    chunkerVersion,
    ...(endpoint === null ? {} : { endpoint }),
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : new Date(0).toISOString(),
    pinned: value.pinned === true,
  };
}

/** Read `profile.json`; a missing or unreadable file is `null`. */
export async function readEmbeddingProfile(
  spaceDir: string,
): Promise<EmbeddingProfile | null> {
  try {
    const text = await readFile(embeddingProfilePath(spaceDir), "utf-8");
    return parseEmbeddingProfile(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Atomic write: temp file + rename, same discipline as `state.json`. */
export async function writeEmbeddingProfile(
  spaceDir: string,
  profile: EmbeddingProfile,
): Promise<void> {
  const target = embeddingProfilePath(spaceDir);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(profile)}\n`, "utf-8");
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Best-effort profile write for the build path: a profile is diagnostic
 * metadata, so a read-only or full disk must not fail a build that can still
 * commit vectors.
 */
export async function writeEmbeddingProfileBestEffort(
  spaceDir: string,
  profile: EmbeddingProfile,
): Promise<void> {
  try {
    await writeEmbeddingProfile(spaceDir, profile);
  } catch (error) {
    debugWarn(
      "embedding",
      `profile.json could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Flip `pinned` on an existing profile. Returns false when the space has no
 * readable profile (a legacy space), so the caller can say so instead of
 * pretending a pin was written.
 */
export async function setEmbeddingProfilePinned(
  spaceDir: string,
  pinned: boolean,
): Promise<boolean> {
  const profile = await readEmbeddingProfile(spaceDir);
  if (profile === null) return false;
  await writeEmbeddingProfile(spaceDir, { ...profile, pinned });
  return true;
}
