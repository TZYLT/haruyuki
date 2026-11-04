/**
 * Embedding space identity and on-disk layout (feature 48, rework A1).
 *
 * A *space* is one model's vector space: changing the model, the dimension, the
 * quantization or the chunking parameters changes what a stored vector means, so
 * it must land in a different directory instead of mixing incomparable vectors
 * (48-1 §6.3: 切分参数变化 = 空间失效重建).
 *
 * The identity is a truncated sha256 over every input that can move a vector:
 *
 * ```
 * <recall root>/<agentId>/<spaceId>/<conversationKey>/
 * <recall root>/<agentId>/<spaceId>/memory/<fileKey>/
 * ```
 *
 * `spaceId` deliberately uses a 20-hex prefix rather than a friendly model name:
 * two settings combinations must never collide onto one directory, and the
 * directory is a derived cache, not something a user is meant to read.
 *
 * This module is pure layout/identity. It reads directories only to list the
 * spaces already on disk; it never creates, writes or deletes one. Readers that
 * need the existing set (`/recall embedding status`, retention) call
 * {@link listEmbeddingSpaceDirs}.
 *
 * Layer: `backend/local/embedding*`. Imports only sibling embedding modules, the
 * call-time harness path resolver and the `ResolvedEmbeddingSettings` *type*
 * (type-only, so the reminders/settings stack is not pulled in at runtime).
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinModelManifest } from "@/backend/local/embedding/model-manifest";
import { EMBEDDING_CHUNK_DEFAULTS } from "@/backend/local/embedding-chunk";
import {
  EMBEDDING_INDEX_CHUNKER_VERSION,
  type EmbeddingIndexQuant,
  getRecallVectorsRoot,
} from "@/backend/local/embedding-format";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";

/** How many hex characters of the sha256 become the space directory name. */
const SPACE_ID_HEX_LENGTH = 20;

/** Domain separator: bump if the hashed payload itself ever changes shape. */
const SPACE_HASH_DOMAIN = "haruyuki-embedding-space-v1";

/** One safe path component; same rule `embedding-format.ts` applies. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown when an id would leave the recall root or cannot be a directory. */
export class EmbeddingSpacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingSpacePathError";
  }
}

/** Quantization as settings spell it; `resolveEmbeddingSpace` maps to `f32`. */
export type EmbeddingSpaceQuantization = "float32" | "int8";

/** Every input that decides which directory a vector belongs to. */
export interface EmbeddingSpaceIdInput {
  /** Built-in model id, or the endpoint's model id. */
  readonly modelId: string;
  /** Vector width the model produces. */
  readonly dimensions: number;
  /** Stored precision; `float32` and `int8` are different spaces. */
  readonly quantization: EmbeddingSpaceQuantization;
  /** Chunker algorithm version; defaults to `EMBEDDING_INDEX_CHUNKER_VERSION`. */
  readonly chunkerVersion?: number;
  /** Chunk window target in estimated tokens; defaults to the chunker default. */
  readonly chunkTarget?: number;
  /** Hard chunk ceiling in estimated tokens; defaults to the chunker default. */
  readonly chunkMax?: number;
  /** Chunk overlap in estimated tokens; defaults to the chunker default. */
  readonly chunkOverlap?: number;
}

/** One agent's resolved space, including the directory it lives in. */
export interface EmbeddingSpaceIdentity {
  readonly agentId: string;
  readonly spaceId: string;
  readonly modelId: string;
  readonly dimensions: number;
  /** Storage precision in the on-disk vocabulary (`f32` / `int8`). */
  readonly quantization: EmbeddingIndexQuant;
  /** Recall root the space was resolved against. */
  readonly root: string;
  /** `<root>/<agentId>/<spaceId>`. */
  readonly spaceDir: string;
}

/** One space directory found on disk. */
export interface EmbeddingSpaceDirectory {
  readonly spaceId: string;
  readonly spaceDir: string;
  /** Directory mtime in ms, or `null` when it could not be stat-ed. */
  readonly updatedAtMs: number | null;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `${label} must be a non-negative integer, received ${String(value)}.`,
    );
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  const resolved = requireNonNegativeInteger(value, label);
  if (resolved === 0) {
    throw new TypeError(`${label} must be a positive integer, received 0.`);
  }
  return resolved;
}

function requireQuantization(
  value: EmbeddingSpaceQuantization,
): EmbeddingSpaceQuantization {
  if (value !== "float32" && value !== "int8") {
    throw new TypeError(
      `quantization must be "float32" or "int8", received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function assertSafeSpaceSegment(segment: string, label: string): string {
  if (typeof segment !== "string" || !SAFE_SEGMENT.test(segment)) {
    throw new EmbeddingSpacePathError(
      `Embedding space ${label} is not a safe path segment: ${JSON.stringify(segment)}`,
    );
  }
  return segment;
}

/**
 * Deterministic id for one embedding space.
 *
 * Every argument is normalised to its effective value first, so omitting an
 * optional chunk parameter and passing the chunker's own default produce the
 * same id. Any real change — model, width, precision, chunker version, window
 * target, ceiling or overlap — produces a different id, which is how a chunking
 * change invalidates the old space instead of silently reusing it.
 */
export function resolveEmbeddingSpaceId(input: EmbeddingSpaceIdInput): string {
  if (typeof input.modelId !== "string" || input.modelId.length === 0) {
    throw new TypeError("Embedding space modelId must be a non-empty string.");
  }
  const dimensions = requirePositiveInteger(input.dimensions, "dimensions");
  const quantization = requireQuantization(input.quantization);
  const chunkerVersion = requirePositiveInteger(
    input.chunkerVersion ?? EMBEDDING_INDEX_CHUNKER_VERSION,
    "chunkerVersion",
  );
  const chunkTarget = requirePositiveInteger(
    input.chunkTarget ?? EMBEDDING_CHUNK_DEFAULTS.targetTokens,
    "chunkTarget",
  );
  const chunkMax = requirePositiveInteger(
    input.chunkMax ?? EMBEDDING_CHUNK_DEFAULTS.maxTokens,
    "chunkMax",
  );
  const chunkOverlap = requireNonNegativeInteger(
    input.chunkOverlap ?? EMBEDDING_CHUNK_DEFAULTS.overlapTokens,
    "chunkOverlap",
  );
  const payload = [
    `domain=${SPACE_HASH_DOMAIN}`,
    `modelId=${input.modelId}`,
    `dimensions=${dimensions}`,
    `quantization=${quantization}`,
    `chunkerVersion=${chunkerVersion}`,
    `chunkTarget=${chunkTarget}`,
    `chunkMax=${chunkMax}`,
    `chunkOverlap=${chunkOverlap}`,
  ].join("\n");
  return createHash("sha256")
    .update(payload, "utf8")
    .digest("hex")
    .slice(0, SPACE_ID_HEX_LENGTH);
}

/**
 * Resolve the space a set of embedding settings describes.
 *
 * `builtin` takes the width from the built-in manifest — never from a settings
 * field, so a stale editing artifact cannot declare a width the model does not
 * produce. `endpoint` takes the declared width from the endpoint form and
 * refuses to guess when it is missing: an endpoint without a declared dimension
 * cannot be pinned to a directory, because every stored vector's width would be
 * unverified.
 */
export function resolveEmbeddingSpace(
  agentId: string,
  settings: ResolvedEmbeddingSettings,
  options: { readonly root?: string } = {},
): EmbeddingSpaceIdentity {
  assertSafeSpaceSegment(agentId, "agentId");
  const model =
    settings.backend === "endpoint"
      ? resolveEndpointSpaceModel(settings)
      : resolveBuiltinSpaceModel(settings);
  const quantization = requireQuantization(settings.quantization);
  const spaceId = resolveEmbeddingSpaceId({
    modelId: model.modelId,
    dimensions: model.dimensions,
    quantization,
    chunkTarget: settings.chunkTarget,
    chunkMax: settings.chunkMax,
    chunkOverlap: settings.chunkOverlap,
  });
  const root = options.root ?? getRecallVectorsRoot();
  return {
    agentId,
    spaceId,
    modelId: model.modelId,
    dimensions: model.dimensions,
    quantization: quantization === "int8" ? "int8" : "f32",
    root,
    spaceDir: join(root, agentId, spaceId),
  };
}

function resolveBuiltinSpaceModel(settings: ResolvedEmbeddingSettings): {
  modelId: string;
  dimensions: number;
} {
  const manifest = getBuiltinModelManifest(settings.model);
  return { modelId: manifest.id, dimensions: manifest.dimensions };
}

function resolveEndpointSpaceModel(settings: ResolvedEmbeddingSettings): {
  modelId: string;
  dimensions: number;
} {
  const endpoint = settings.endpoint;
  if (endpoint === null) {
    throw new Error(
      'The embedding backend is "endpoint" but no endpoint is configured; run /recall embedding setup and complete the endpoint form first.',
    );
  }
  return { modelId: endpoint.model, dimensions: endpoint.dimensions };
}

/**
 * The spaces an agent already has on disk, newest first.
 *
 * Missing agent directory (the common case before the first build) returns `[]`;
 * files, dot-directories and names that are not one safe component are ignored,
 * so a stray `.tmp-` directory or a user file can never be reported as a space.
 */
export function listEmbeddingSpaceDirs(
  agentId: string,
  options: { readonly root?: string } = {},
): EmbeddingSpaceDirectory[] {
  assertSafeSpaceSegment(agentId, "agentId");
  const root = options.root ?? getRecallVectorsRoot();
  const agentDir = join(root, agentId);
  const spaces: EmbeddingSpaceDirectory[] = [];
  for (const entry of readDirectoryEntries(agentDir)) {
    if (!entry.isDirectory()) continue;
    if (!SAFE_SEGMENT.test(entry.name)) continue;
    const spaceDir = join(agentDir, entry.name);
    spaces.push({
      spaceId: entry.name,
      spaceDir,
      updatedAtMs: readDirectoryMtimeMs(spaceDir),
    });
  }
  spaces.sort((left, right) => {
    const leftUpdated = left.updatedAtMs ?? -1;
    const rightUpdated = right.updatedAtMs ?? -1;
    if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
    return left.spaceId.localeCompare(right.spaceId);
  });
  return spaces;
}

function readDirectoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readDirectoryMtimeMs(directory: string): number | null {
  try {
    const stats = statSync(directory);
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}
