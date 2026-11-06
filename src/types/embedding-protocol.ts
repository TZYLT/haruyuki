import type { AgentRuntimeScope } from "./runtime-scope";

/**
 * R-26 embedding command family (F-07 / 48-1 §7.3, 48-2 §4.9).
 *
 * Kept in its own module so the pinned `protocol_v2.ts` only grows by the union
 * entries plus one namespace import: every shape here is additive and
 * local-first (the vector index is a rebuildable derivative of local data).
 *
 * 48-4 renamed the surface to match the CLI: `configure` became `connect`,
 * `reset` became `profile_delete`, `calibrate` became `device_test`, and the
 * profile/config/device read paths gained their own commands. The protocol is a
 * client contract, so this is a deliberate breaking rename for 0.6.0 (D-18 was
 * opened by the maintainer; there are no compatibility aliases).
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
 * never carries a credential: `embedding_connect` accepts an `api_key` but the
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
 * Mutable subset accepted by `embedding_connect` and `embedding_config_set`.
 *
 * `api_key` is write-only (48-2 O-18): the listener may persist it through the
 * secrets store, but no response, log or status snapshot echoes it back.
 */
export interface EmbeddingConnectPatch {
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

/** One stored model space, as the `model` picker lists it (48-4 D-09). */
export interface EmbeddingProfileRow {
  /** 1-based row number used by select/delete/pin. */
  index: number;
  space_id: string;
  model: string;
  dimensions: number | null;
  quantization: string | null;
  chunks: number;
  bytes: number | null;
  built_at: string | null;
  active: boolean;
  pinned: boolean;
  /** True when the space predates `profile.json`; listable but not selectable. */
  legacy: boolean;
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

/**
 * Which device the last build actually used (48-4 D-02), projected from
 * `state.json`. Optional fields keep the wire small when a build predates the
 * block.
 */
export interface EmbeddingDeviceSnapshot {
  backend: "builtin" | "endpoint";
  requested: string[];
  initialized: string[];
  /** True when a non-CPU provider was accepted. */
  gpu: boolean;
  degraded: boolean;
  degraded_reason?: string;
  threads: number;
  warmup_ms: number;
  /** ISO timestamp of the run that recorded the block. */
  measured_at: string;
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

/** One `config` row: a build knob's wire name and current value. */
export interface EmbeddingConfigRow {
  key: string;
  value: number | string;
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

/** Create or replace the vector source (the old `embedding_configure`). */
export interface EmbeddingConnectCommand {
  type: "embedding_connect";
  request_id: string;
  runtime: AgentRuntimeScope;
  patch: EmbeddingConnectPatch;
}
export interface EmbeddingConnectResponseMessage {
  type: "embedding_connect_response";
  request_id: string;
  success: boolean;
  /** Resolved configuration after the patch; never includes `api_key`. */
  settings: EmbeddingSettingsSnapshot | null;
  /** Space the merged settings address; `null` when the id could not resolve. */
  space_id: string | null;
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
   * try one (missing model/runtime, lock held, …).
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

/** List every stored model space for the agent. */
export interface EmbeddingProfilesListCommand {
  type: "embedding_profiles_list";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface EmbeddingProfilesListResponseMessage {
  type: "embedding_profiles_list_response";
  request_id: string;
  success: boolean;
  profiles: EmbeddingProfileRow[];
  error?: string;
}

/** Restore the settings that produced one stored space. */
export interface EmbeddingProfileSelectCommand {
  type: "embedding_profile_select";
  request_id: string;
  runtime: AgentRuntimeScope;
  /** 1-based row number from `embedding_profiles_list`. */
  index?: number;
  /** Space id; an alternative to `index`. */
  space_id?: string;
}
export interface EmbeddingProfileSelectResponseMessage {
  type: "embedding_profile_select_response";
  request_id: string;
  success: boolean;
  settings: EmbeddingSettingsSnapshot | null;
  requires_rebuild: boolean;
  /** Set when the space is legacy and cannot be selected. */
  reason?: string;
  error?: string;
}

/**
 * Drop stored spaces (the old `embedding_reset`) or one stored model.
 *
 * `scope: "current"` deletes the space the current settings address,
 * `scope: "all"` deletes every space for the agent, and `scope: "model"` deletes
 * the one named by `index`/`space_id`. Destructive calls require `confirm`.
 */
export interface EmbeddingProfileDeleteCommand {
  type: "embedding_profile_delete";
  request_id: string;
  runtime: AgentRuntimeScope;
  scope?: "current" | "all" | "model";
  index?: number;
  space_id?: string;
  confirm?: boolean;
}
export interface EmbeddingProfileDeleteResponseMessage {
  type: "embedding_profile_delete_response";
  request_id: string;
  success: boolean;
  /** Spaces removed; `0` when the request was only a preview. */
  removed_spaces: number;
  requires_rebuild: boolean;
  /** True when the destructive call needs `confirm: true` to proceed. */
  requires_confirmation?: boolean;
  /** Human-readable preview of what would be deleted. */
  preview?: string;
  error?: string;
}

/** Pin or unpin one stored space so retention keeps it. */
export interface EmbeddingProfilePinCommand {
  type: "embedding_profile_pin";
  request_id: string;
  runtime: AgentRuntimeScope;
  index?: number;
  space_id?: string;
  pinned: boolean;
}
export interface EmbeddingProfilePinResponseMessage {
  type: "embedding_profile_pin_response";
  request_id: string;
  success: boolean;
  profiles: EmbeddingProfileRow[];
  error?: string;
}

/** Read the build knobs (`/recall embedding config`). */
export interface EmbeddingConfigGetCommand {
  type: "embedding_config_get";
  request_id: string;
  runtime: AgentRuntimeScope;
  /** Omit to read every key. */
  key?: string;
}
export interface EmbeddingConfigGetResponseMessage {
  type: "embedding_config_get_response";
  request_id: string;
  success: boolean;
  keys: EmbeddingConfigRow[];
  settings: EmbeddingSettingsSnapshot | null;
  error?: string;
}

/** Write one build knob (`/recall embedding config <key> <value>`). */
export interface EmbeddingConfigSetCommand {
  type: "embedding_config_set";
  request_id: string;
  runtime: AgentRuntimeScope;
  key: string;
  value: number | string;
}
export interface EmbeddingConfigSetResponseMessage {
  type: "embedding_config_set_response";
  request_id: string;
  success: boolean;
  settings: EmbeddingSettingsSnapshot | null;
  requires_rebuild: boolean;
  error?: string;
}

/** Device facts recorded by the last build (read-only). */
export interface EmbeddingDeviceCommand {
  type: "embedding_device";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface EmbeddingDeviceResponseMessage {
  type: "embedding_device_response";
  request_id: string;
  success: boolean;
  device: EmbeddingDeviceSnapshot | null;
  error?: string;
}

/** Read-only device measurement (the old `embedding_calibrate`). */
export interface EmbeddingDeviceTestCommand {
  type: "embedding_device_test";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface EmbeddingDeviceTestResponseMessage {
  type: "embedding_device_test_response";
  request_id: string;
  success: boolean;
  calibration: EmbeddingCalibrationSnapshot | null;
  error?: string;
}

export type EmbeddingProtocolCommand =
  | EmbeddingStatusCommand
  | EmbeddingConnectCommand
  | EmbeddingEnableCommand
  | EmbeddingDisableCommand
  | EmbeddingBuildCommand
  | EmbeddingCancelCommand
  | EmbeddingProfilesListCommand
  | EmbeddingProfileSelectCommand
  | EmbeddingProfileDeleteCommand
  | EmbeddingProfilePinCommand
  | EmbeddingConfigGetCommand
  | EmbeddingConfigSetCommand
  | EmbeddingDeviceCommand
  | EmbeddingDeviceTestCommand;

export type EmbeddingProtocolResponseMessage =
  | EmbeddingStatusResponseMessage
  | EmbeddingConnectResponseMessage
  | EmbeddingEnableResponseMessage
  | EmbeddingDisableResponseMessage
  | EmbeddingBuildResponseMessage
  | EmbeddingCancelResponseMessage
  | EmbeddingProfilesListResponseMessage
  | EmbeddingProfileSelectResponseMessage
  | EmbeddingProfileDeleteResponseMessage
  | EmbeddingProfilePinResponseMessage
  | EmbeddingConfigGetResponseMessage
  | EmbeddingConfigSetResponseMessage
  | EmbeddingDeviceResponseMessage
  | EmbeddingDeviceTestResponseMessage;
