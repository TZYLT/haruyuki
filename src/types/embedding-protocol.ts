import type { AgentRuntimeScope } from "./runtime-scope";

/**
 * R-26 embedding command family (F-07 / 48-1 §7.3, 48-2 §4.9).
 *
 * Kept in its own module so the pinned `protocol_v2.ts` only grows by the union
 * entries plus one namespace import: every shape here is additive and
 * local-first (the vector index is a rebuildable derivative of local data).
 */

export type EmbeddingBackendKind = "builtin" | "endpoint";
export type EmbeddingEndpointKind = "openai" | "ollama";
export type EmbeddingGpuRole = "auto" | "off" | "index-only";
export type EmbeddingQuantization = "float32" | "int8";
export type EmbeddingBuildMode = "incremental" | "full";
export type EmbeddingBuildState =
  | "idle"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

/** External endpoint configuration; `api_key` is never part of the resolved shape. */
export interface EmbeddingEndpointConfig {
  kind: EmbeddingEndpointKind;
  base_url: string;
  model: string;
  dimensions: number;
  timeout_ms?: number;
}

/**
 * The fully resolved configuration a client renders.
 *
 * Mirrors the `recallEmbedding*` settings keys (48-1 §8.1) in wire spelling. It
 * never carries a credential: `embedding_configure` accepts an `api_key` but the
 * response only echoes the settings snapshot.
 */
export interface EmbeddingSettingsSnapshot {
  enabled: boolean;
  backend: EmbeddingBackendKind;
  model: string;
  endpoint: EmbeddingEndpointConfig | null;
  /** Vector-arm weight in [0,1]; `0` = lexical only. */
  weight: number;
  /** Per-arm candidate depth; the two arms are always equal (P-02). */
  candidate_depth: number;
  chunk_target: number;
  chunk_max: number;
  chunk_overlap: number;
  max_chunks_per_message: number;
  threads: number;
  gpu: EmbeddingGpuRole;
  quantization: EmbeddingQuantization;
  keep_spaces: number;
}

/**
 * Mutable subset accepted by `embedding_configure`.
 *
 * `api_key` is write-only (48-2 O-18): the listener may persist it through the
 * secrets store, but no response, log or status snapshot echoes it back.
 */
export interface EmbeddingConfigurePatch {
  enabled?: boolean;
  backend?: EmbeddingBackendKind;
  model?: string;
  endpoint?: EmbeddingEndpointConfig | null;
  /** Write-only endpoint credential; never returned or logged. */
  api_key?: string;
  weight?: number;
  candidate_depth?: number;
  chunk_target?: number;
  chunk_max?: number;
  chunk_overlap?: number;
  max_chunks_per_message?: number;
  threads?: number;
  gpu?: EmbeddingGpuRole;
  quantization?: EmbeddingQuantization;
  keep_spaces?: number;
}

/** One model space on disk, as `/recall status` reports it. */
export interface EmbeddingSpaceSnapshot {
  space_id: string;
  model: string;
  dimensions: number;
  quantization: EmbeddingQuantization;
  /** Embeddable text that made it into the index, 0..1. */
  coverage: number;
  conversations: number;
  chunks: number;
  bytes: number;
  built_at: string | null;
}

/** Result of the bounded ≤5s calibration pass (48-1 §6.6). */
export interface EmbeddingCalibrationSnapshot {
  /** Hardware/runtime fingerprint; a change re-runs calibration. */
  fingerprint: string;
  measured_at: string;
  query_latency_p50_ms: number;
  query_latency_p90_ms: number;
  batch_throughput_per_s: number;
  gpu_role: EmbeddingGpuRole;
  threads: number;
  quantization: EmbeddingQuantization;
  /** Why a probed GPU was not used; already redacted by the handler. */
  gpu_reason?: string;
}

/** A live or last-finished build, projected from `state.json`. */
export interface EmbeddingBuildSnapshot {
  build_id: string;
  mode: EmbeddingBuildMode;
  state: EmbeddingBuildState;
  started_at: string;
  updated_at: string;
  /** 0..1. */
  progress: number;
  processed_chunks: number;
  total_chunks: number;
  /** Wall-clock estimate in ms; `null` until the runner has a rate. */
  eta_ms: number | null;
  /** Set when `state` is `failed`; the handler redacts credentials. */
  error?: string;
}

/** Everything `embedding_status` answers, in one round-trip. */
export interface EmbeddingStatusSnapshot {
  enabled: boolean;
  /** A configured space matches the current model and can answer queries. */
  ready: boolean;
  settings: EmbeddingSettingsSnapshot;
  space: EmbeddingSpaceSnapshot | null;
  calibration: EmbeddingCalibrationSnapshot | null;
  build: EmbeddingBuildSnapshot | null;
  /** Endpoint backend with a non-loopback URL: query text leaves the machine. */
  egress: boolean;
  /** Last enable/build failure, actionable and redacted; `null` when healthy. */
  failure: string | null;
}

/**
 * The embedding summary `device_status` carries (D2 owns its 5s TTL/dedup), so a
 * status bar needs no second round-trip to `embedding_status`.
 */
export interface EmbeddingDeviceSummary {
  enabled: boolean;
  state: EmbeddingBuildState;
  /** 0..1; omitted while idle so the wire stays small. */
  progress?: number;
  processed_chunks?: number;
  total_chunks?: number;
  eta_ms?: number | null;
  space_id?: string | null;
  model?: string | null;
  failure?: string | null;
}

export interface EmbeddingStatusCommand {
  type: "embedding_status";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface EmbeddingStatusResponseMessage {
  type: "embedding_status_response";
  request_id: string;
  success: boolean;
  status: EmbeddingStatusSnapshot | null;
  error?: string;
}

export interface EmbeddingConfigureCommand {
  type: "embedding_configure";
  request_id: string;
  runtime: AgentRuntimeScope;
  patch: EmbeddingConfigurePatch;
}
export interface EmbeddingConfigureResponseMessage {
  type: "embedding_configure_response";
  request_id: string;
  success: boolean;
  /** Resolved configuration after the patch; never includes `api_key`. */
  settings: EmbeddingSettingsSnapshot | null;
  /** True when model/dimension/chunk changes invalidated the existing space. */
  requires_rebuild: boolean;
  error?: string;
}

export interface EmbeddingEnableCommand {
  type: "embedding_enable";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface EmbeddingEnableResponseMessage {
  type: "embedding_enable_response";
  request_id: string;
  success: boolean;
  enabled: boolean;
  /** True when enabling kicked off the first background build. */
  build_started: boolean;
  /**
   * Why no first build started, when `build_started` is false and enabling did
   * try one (missing model/runtime, lock held, …). Additive: an older client
   * that never reads it keeps its previous behaviour.
   */
  reason?: string;
  error?: string;
}

export interface EmbeddingDisableCommand {
  type: "embedding_disable";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface EmbeddingDisableResponseMessage {
  type: "embedding_disable_response";
  request_id: string;
  success: boolean;
  enabled: boolean;
  error?: string;
}

export interface EmbeddingBuildCommand {
  type: "embedding_build";
  request_id: string;
  runtime: AgentRuntimeScope;
  /** `full` rebuilds every space; omitted = incremental. */
  mode?: EmbeddingBuildMode;
  /** A4 opt-in: keep the detached child running after the host exits. */
  keep_after_exit?: boolean;
}
export interface EmbeddingBuildResponseMessage {
  type: "embedding_build_response";
  request_id: string;
  success: boolean;
  /** `false` with a `reason` when the launcher declined (lock, disabled, ...). */
  started: boolean;
  build_id?: string;
  reason?: string;
  error?: string;
}

export interface EmbeddingCancelCommand {
  type: "embedding_cancel";
  request_id: string;
  runtime: AgentRuntimeScope;
  /** Cancel one build; omitted = whichever build is live for this agent. */
  build_id?: string;
}
export interface EmbeddingCancelResponseMessage {
  type: "embedding_cancel_response";
  request_id: string;
  success: boolean;
  /** `false` when no live build matched the id. */
  cancelled: boolean;
  error?: string;
}

export interface EmbeddingResetCommand {
  type: "embedding_reset";
  request_id: string;
  runtime: AgentRuntimeScope;
  /** `index` (default) drops vectors; `all` also drops the calibration result. */
  scope?: "index" | "all";
}
export interface EmbeddingResetResponseMessage {
  type: "embedding_reset_response";
  request_id: string;
  success: boolean;
  /** Spaces removed from disk; the next enable/query rebuilds lazily. */
  removed_spaces: number;
  requires_rebuild: boolean;
  error?: string;
}

export interface EmbeddingCalibrateCommand {
  type: "embedding_calibrate";
  request_id: string;
  runtime: AgentRuntimeScope;
  /** Persist the measured result into settings; default true. */
  persist?: boolean;
}
export interface EmbeddingCalibrateResponseMessage {
  type: "embedding_calibrate_response";
  request_id: string;
  success: boolean;
  calibration: EmbeddingCalibrationSnapshot | null;
  error?: string;
}

export type EmbeddingProtocolCommand =
  | EmbeddingStatusCommand
  | EmbeddingConfigureCommand
  | EmbeddingEnableCommand
  | EmbeddingDisableCommand
  | EmbeddingBuildCommand
  | EmbeddingCancelCommand
  | EmbeddingResetCommand
  | EmbeddingCalibrateCommand;

export type EmbeddingProtocolResponseMessage =
  | EmbeddingStatusResponseMessage
  | EmbeddingConfigureResponseMessage
  | EmbeddingEnableResponseMessage
  | EmbeddingDisableResponseMessage
  | EmbeddingBuildResponseMessage
  | EmbeddingCancelResponseMessage
  | EmbeddingResetResponseMessage
  | EmbeddingCalibrateResponseMessage;
