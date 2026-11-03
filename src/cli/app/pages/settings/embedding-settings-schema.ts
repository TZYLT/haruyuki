// src/cli/app/pages/settings/embedding-settings-schema.ts

import { readEmbeddingSettings } from "@/recall-settings";
import type {
  EmbeddingBackendKind,
  EmbeddingGpuRole,
  EmbeddingQuantization,
} from "@/types/embedding-protocol";
import {
  embeddingApiKeyRowValue,
  saveEmbeddingApiKey,
} from "./embedding-secrets";
import {
  updateEmbeddingSettings,
  validateEmbeddingModelInput,
} from "./embedding-settings";
import type { SettingsGroup, SettingsItem } from "./settings-model";

/**
 * The settings page's Vector recall section (D3; 48-1 §8.1, 48-2 §4.9).
 *
 * One row per stored key, all global and all writing through
 * `embedding-settings.ts` — the only writer. The resolved value is what the page
 * paints (`readEmbeddingSettings`), so a value written by the wizard, the
 * protocol handler or `/recall embedding` is what the row shows.
 *
 * Two rows are deliberately not editable:
 *
 * - **Endpoint** is one form with a tested credential (`setup` owns it): editing
 *   a URL here without a test-embed round trip is exactly the state 48-1 §7.2
 *   says must not become reachable. The row summarises it and `Enter` fills
 *   `/recall embedding setup` into the composer.
 * - **Calibration** is measured, not typed; it is re-derived when the hardware
 *   fingerprint changes (48-2 §4.5).
 * - The **endpoint API key** *is* editable, but as a `secret` row: it paints
 *   mask characters, and the stored value is never read back into the page.
 *
 * Wiring this section into `SETTINGS_GROUPS`/`SETTINGS_ITEMS` is the shell's
 * integration step (`settings-schema.ts` is outside D3's write scope); both
 * exports are spread-ready.
 */

const EMBEDDING_BACKEND_OPTIONS = [
  { value: "builtin", label: "builtin (bundled model)" },
  { value: "endpoint", label: "endpoint (OpenAI / Ollama)" },
] as const;

const EMBEDDING_GPU_OPTIONS = [
  { value: "auto", label: "auto (index builds may use the GPU)" },
  { value: "off", label: "off (CPU only)" },
  { value: "index-only", label: "index-only (GPU builds, CPU queries)" },
] as const;

const EMBEDDING_QUANTIZATION_OPTIONS = [
  { value: "float32", label: "float32" },
  { value: "int8", label: "int8 (stage 3)" },
] as const;

/** One write for a row: the single writer validates before anything lands. */
function writeEmbedding(
  patch: Parameters<typeof updateEmbeddingSettings>[0],
): void {
  updateEmbeddingSettings(patch);
}

function endpointSummary(): string {
  const { endpoint } = readEmbeddingSettings();
  if (endpoint === null) return "not configured";
  return `${endpoint.kind} · ${endpoint.baseUrl} · ${endpoint.model} · ${endpoint.dimensions}d`;
}

function calibrationSummary(): string {
  const { calibration } = readEmbeddingSettings();
  if (calibration === null) return "not calibrated yet";
  return `${calibration.gpuRole} · ${calibration.threads} threads · p50 ${calibration.queryLatencyP50Ms}ms · p90 ${calibration.queryLatencyP90Ms}ms · ${calibration.quantization}`;
}

export const EMBEDDING_SETTINGS_GROUP: SettingsGroup = {
  id: "embedding",
  section: "memory",
  label: "Vector recall (embedding)",
};

export const EMBEDDING_SETTINGS_ITEMS: readonly SettingsItem[] = [
  {
    id: "recallEmbeddingEnabled",
    section: "memory",
    group: "embedding",
    label: "Embedding recall",
    kind: "toggle",
    scope: "global",
    editable: true,
    read: () => (readEmbeddingSettings().enabled ? "true" : "false"),
    write: (_ctx, value) => {
      writeEmbedding({ enabled: value === "true" });
    },
  },
  {
    id: "recallEmbeddingBackend",
    section: "memory",
    group: "embedding",
    label: "Backend",
    kind: "select",
    options: EMBEDDING_BACKEND_OPTIONS,
    scope: "global",
    editable: true,
    read: () => readEmbeddingSettings().backend,
    write: (_ctx, value) => {
      writeEmbedding({ backend: value as EmbeddingBackendKind });
    },
  },
  {
    id: "recallEmbeddingModel",
    section: "memory",
    group: "embedding",
    label: "Model (rebuilds space)",
    kind: "text",
    scope: "global",
    editable: true,
    validate: validateEmbeddingModelInput,
    read: () => readEmbeddingSettings().model,
    write: (_ctx, value) => {
      writeEmbedding({ model: value });
    },
  },
  {
    id: "recallEmbeddingEndpoint",
    section: "memory",
    group: "embedding",
    label: "Endpoint",
    kind: "text",
    scope: "global",
    editable: false,
    jump: "/recall embedding setup",
    reason: "use /recall embedding setup (tests the endpoint)",
    read: endpointSummary,
  },
  {
    id: "recallEmbeddingApiKey",
    section: "memory",
    group: "embedding",
    label: "Endpoint API key",
    kind: "secret",
    scope: "global",
    editable: true,
    validate: (value) =>
      value.trim().length === 0 ? "needs an API key" : null,
    // Never the key: a presence word until the store has been queried.
    read: embeddingApiKeyRowValue,
    write: (ctx, value) =>
      saveEmbeddingApiKey(value, ctx.agentId).then(() => undefined),
  },
  {
    id: "recallEmbeddingWeight",
    section: "memory",
    group: "embedding",
    label: "Vector weight (0 = lexical only)",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.1,
    scope: "global",
    editable: true,
    read: () => String(readEmbeddingSettings().weight),
    write: (_ctx, value) => {
      writeEmbedding({ weight: Number(value) });
    },
  },
  {
    id: "recallEmbeddingCandidateDepth",
    section: "memory",
    group: "embedding",
    label: "Candidates per arm",
    kind: "number",
    min: 1,
    max: 1_000,
    step: 10,
    scope: "global",
    editable: true,
    read: () => String(readEmbeddingSettings().candidateDepth),
    write: (_ctx, value) => {
      writeEmbedding({ candidateDepth: Number(value) });
    },
  },
  {
    id: "recallEmbeddingChunkTarget",
    section: "memory",
    group: "embedding",
    label: "Chunk target, tokens (rebuilds space)",
    kind: "number",
    min: 1,
    max: 4_096,
    step: 16,
    scope: "global",
    editable: true,
    read: () => String(readEmbeddingSettings().chunkTarget),
    write: (_ctx, value) => {
      writeEmbedding({ chunkTarget: Number(value) });
    },
  },
  {
    id: "recallEmbeddingChunkMax",
    section: "memory",
    group: "embedding",
    label: "Chunk ceiling, tokens (rebuilds space)",
    kind: "number",
    min: 1,
    max: 4_096,
    step: 16,
    scope: "global",
    editable: true,
    read: () => String(readEmbeddingSettings().chunkMax),
    write: (_ctx, value) => {
      writeEmbedding({ chunkMax: Number(value) });
    },
  },
  {
    id: "recallEmbeddingChunkOverlap",
    section: "memory",
    group: "embedding",
    label: "Chunk overlap, tokens (rebuilds space)",
    kind: "number",
    min: 0,
    max: 4_096,
    step: 8,
    scope: "global",
    editable: true,
    read: () => String(readEmbeddingSettings().chunkOverlap),
    write: (_ctx, value) => {
      writeEmbedding({ chunkOverlap: Number(value) });
    },
  },
  {
    id: "recallEmbeddingMaxChunksPerMessage",
    section: "memory",
    group: "embedding",
    label: "Chunks per message cap",
    kind: "number",
    min: 1,
    max: 1_024,
    step: 128,
    scope: "global",
    editable: true,
    read: () => String(readEmbeddingSettings().maxChunksPerMessage),
    write: (_ctx, value) => {
      writeEmbedding({ maxChunksPerMessage: Number(value) });
    },
  },
  {
    id: "recallEmbeddingThreads",
    section: "memory",
    group: "embedding",
    label: "Threads (0 = automatic)",
    kind: "number",
    min: 0,
    max: 256,
    step: 1,
    scope: "global",
    editable: true,
    read: () => String(readEmbeddingSettings().threads),
    write: (_ctx, value) => {
      writeEmbedding({ threads: Number(value) });
    },
  },
  {
    id: "recallEmbeddingGpu",
    section: "memory",
    group: "embedding",
    label: "GPU role",
    kind: "select",
    options: EMBEDDING_GPU_OPTIONS,
    scope: "global",
    editable: true,
    read: () => readEmbeddingSettings().gpu,
    write: (_ctx, value) => {
      writeEmbedding({ gpu: value as EmbeddingGpuRole });
    },
  },
  {
    id: "recallEmbeddingQuantization",
    section: "memory",
    group: "embedding",
    label: "Vector precision",
    kind: "select",
    options: EMBEDDING_QUANTIZATION_OPTIONS,
    scope: "global",
    editable: true,
    read: () => readEmbeddingSettings().quantization,
    write: (_ctx, value) => {
      writeEmbedding({ quantization: value as EmbeddingQuantization });
    },
  },
  {
    id: "recallEmbeddingKeepSpaces",
    section: "memory",
    group: "embedding",
    label: "Model spaces kept",
    kind: "number",
    min: 1,
    max: 16,
    step: 1,
    scope: "global",
    editable: true,
    read: () => String(readEmbeddingSettings().keepSpaces),
    write: (_ctx, value) => {
      writeEmbedding({ keepSpaces: Number(value) });
    },
  },
  {
    id: "recallEmbeddingCalibration",
    section: "memory",
    group: "embedding",
    label: "Calibration",
    kind: "text",
    scope: "global",
    editable: false,
    reason: "re-measured when the hardware changes",
    read: calibrationSummary,
  },
];

/** Group + rows as one spread-ready pair, for the shell's settings table. */
export const EMBEDDING_SETTINGS_GROUPS: readonly SettingsGroup[] = [
  EMBEDDING_SETTINGS_GROUP,
];
