/**
 * Wire projections and knob rules for the embedding protocol's profile/config/
 * device commands (48-4 D-09/D-10/D-16).
 *
 * Split from `embedding-backend.ts` for the 1,000-line ceiling: the adapter
 * there owns I/O and this module owns pure shape conversion plus the one-knob
 * patch rules, so both stay readable and independently testable.
 *
 * Layer: `websocket/listener/`. Type-only imports from `cli/` and the protocol
 * shapes.
 */

import type { EmbeddingBuildDeviceSnapshot } from "@/backend/local/embedding-build-state";
import type { EmbeddingProfile } from "@/backend/local/embedding-profile";
import type { EmbeddingSettingsPatch } from "@/cli/app/pages/settings/embedding-settings";
import type { EmbeddingModelRow } from "@/cli/helpers/embedding-models";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";
import type {
  EmbeddingConfigRow,
  EmbeddingDeviceSnapshot,
  EmbeddingProfileRow,
} from "@/types/embedding-protocol";

/** One stored-space selector: an index, a space id, or both (index wins). */
export interface EmbeddingProfileSelector {
  index?: number;
  spaceId?: string;
}

/** The stored-space row in wire spelling. */
export function toWireProfileRow(row: EmbeddingModelRow): EmbeddingProfileRow {
  return {
    index: row.index,
    space_id: row.spaceId,
    model: row.model,
    dimensions: row.dimensions,
    quantization: row.quantization,
    chunks: row.chunks,
    bytes: row.bytes,
    built_at: row.builtAt,
    active: row.active,
    pinned: row.pinned,
    legacy: row.legacy,
  };
}

/** The build knobs `config` may read and write, in wire spelling. */
export const EMBEDDING_CONFIG_KEYS = [
  "chunk_target",
  "chunk_max",
  "chunk_overlap",
  "max_chunks_per_message",
  "threads",
  "gpu",
] as const;

export type EmbeddingConfigKey = (typeof EMBEDDING_CONFIG_KEYS)[number];

export function isEmbeddingConfigKey(
  value: string,
): value is EmbeddingConfigKey {
  return (EMBEDDING_CONFIG_KEYS as readonly string[]).includes(value);
}

/** One knob's current value, or the typed refusal code. */
export function configRows(
  settings: ResolvedEmbeddingSettings,
  key: string | undefined,
): EmbeddingConfigRow[] | string {
  if (key !== undefined && !isEmbeddingConfigKey(key)) {
    return `unknown_embedding_config_key:${key}`;
  }
  const all: EmbeddingConfigRow[] = [
    { key: "chunk_target", value: settings.chunkTarget },
    { key: "chunk_max", value: settings.chunkMax },
    { key: "chunk_overlap", value: settings.chunkOverlap },
    { key: "max_chunks_per_message", value: settings.maxChunksPerMessage },
    { key: "threads", value: settings.threads },
    { key: "gpu", value: settings.gpu },
  ];
  return key === undefined ? all : all.filter((row) => row.key === key);
}

/** One knob write in D3's patch spelling, or the typed refusal code. */
export function configPatchOf(
  key: string,
  value: number | string,
): EmbeddingSettingsPatch | string {
  if (!isEmbeddingConfigKey(key)) {
    return `unknown_embedding_config_key:${key}`;
  }
  if (key === "gpu") {
    if (value !== "auto" && value !== "off") {
      return "invalid_embedding_config_value:gpu";
    }
    return { gpu: value };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return `invalid_embedding_config_value:${key}`;
  }
  switch (key) {
    case "chunk_target":
      return value > 0
        ? { chunkTarget: value }
        : `invalid_embedding_config_value:${key}`;
    case "chunk_max":
      return value > 0
        ? { chunkMax: value }
        : `invalid_embedding_config_value:${key}`;
    case "chunk_overlap":
      return value >= 0
        ? { chunkOverlap: value }
        : `invalid_embedding_config_value:${key}`;
    case "max_chunks_per_message":
      return value > 0
        ? { maxChunksPerMessage: value }
        : `invalid_embedding_config_value:${key}`;
    case "threads":
      return value >= 0
        ? { threads: value }
        : `invalid_embedding_config_value:${key}`;
  }
}

/** The settings a stored profile restores (48-4 D-10). */
export function profileSelectPatch(
  profile: EmbeddingProfile,
): EmbeddingSettingsPatch {
  return {
    enabled: true,
    backend: profile.backend,
    model: profile.modelId,
    ...(profile.endpoint === undefined
      ? {}
      : {
          endpoint: {
            kind: profile.endpoint.kind,
            baseUrl: profile.endpoint.baseUrl,
            model: profile.endpoint.model,
            dimensions: profile.endpoint.dimensions,
          },
        }),
    quantization: profile.quantization,
    chunkTarget: profile.chunkTarget,
    chunkMax: profile.chunkMax,
    chunkOverlap: profile.chunkOverlap,
    maxChunksPerMessage: profile.maxChunksPerMessage,
  };
}

export function findProfileRow(
  rows: readonly EmbeddingModelRow[],
  selector: EmbeddingProfileSelector,
): EmbeddingModelRow | null {
  if (selector.spaceId !== undefined) {
    return rows.find((row) => row.spaceId === selector.spaceId) ?? null;
  }
  if (selector.index !== undefined) {
    return rows.find((row) => row.index === selector.index) ?? null;
  }
  return null;
}

/** The `state.json` device block in wire spelling. */
export function toWireDevice(
  device: EmbeddingBuildDeviceSnapshot | null,
): EmbeddingDeviceSnapshot | null {
  if (device === null) return null;
  return {
    backend: device.backend,
    requested: [...device.requested],
    initialized: [...device.initialized],
    gpu: device.gpu,
    degraded: device.degraded,
    ...(device.degradedReason === undefined
      ? {}
      : { degraded_reason: device.degradedReason }),
    threads: device.threads,
    warmup_ms: device.warmupMs,
    measured_at: device.measuredAt,
  };
}
