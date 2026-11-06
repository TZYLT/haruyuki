import type {
  EmbeddingBuildCommand,
  EmbeddingCancelCommand,
  EmbeddingConfigGetCommand,
  EmbeddingConfigSetCommand,
  EmbeddingConnectCommand,
  EmbeddingConnectPatch,
  EmbeddingDeviceCommand,
  EmbeddingDeviceTestCommand,
  EmbeddingDisableCommand,
  EmbeddingEnableCommand,
  EmbeddingProfileDeleteCommand,
  EmbeddingProfilePinCommand,
  EmbeddingProfileSelectCommand,
  EmbeddingProfilesListCommand,
  EmbeddingStatusCommand,
} from "@/types/embedding-protocol";
import type { AgentRuntimeScope } from "@/types/runtime-scope";
import { isAgentRuntimeScope, isObjectRecord } from "./protocol-validation";

/**
 * Inbound validation for the R-26 embedding command family (D1).
 *
 * Kept beside the other family guards so the pinned `protocol-inbound.ts` only
 * grows by the OR-chain entries: the command shapes live in
 * `@/types/embedding-protocol` and every field here is optional/additive.
 */

const BACKEND_KINDS = ["builtin", "endpoint"] as const;
const ENDPOINT_KINDS = ["openai", "ollama"] as const;
const GPU_ROLES = ["auto", "off", "index-only"] as const;
const QUANTIZATIONS = ["float32", "int8"] as const;
const BUILD_MODES = ["incremental", "full"] as const;
const DELETE_SCOPES = ["current", "all", "model"] as const;

type EmbeddingEnvelope = Record<string, unknown> & {
  type: string;
  request_id: string;
  runtime: AgentRuntimeScope;
};

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === "string" && (allowed as readonly string[]).includes(value)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Shared envelope check: discriminant, non-empty request id, agent scope. */
function hasEmbeddingEnvelope(
  value: unknown,
  type: string,
): value is EmbeddingEnvelope {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === type &&
    typeof value.request_id === "string" &&
    value.request_id.length > 0 &&
    isAgentRuntimeScope(value.runtime)
  );
}

function isEmbeddingEndpointConfig(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    isOneOf(value.kind, ENDPOINT_KINDS) &&
    typeof value.base_url === "string" &&
    value.base_url.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    isPositiveInteger(value.dimensions) &&
    (value.timeout_ms === undefined || isPositiveInteger(value.timeout_ms))
  );
}

/**
 * Validates the `embedding_connect` payload.
 *
 * `api_key` is accepted here (O-18: same-machine WebSocket, equivalent to the
 * TUI prompt) but is write-only — no response or status echoes it. Cross-field
 * coherence (for example `chunk_max >= chunk_target`) belongs to the handler.
 */
export function isEmbeddingConnectPatch(
  value: unknown,
): value is EmbeddingConnectPatch {
  if (!isObjectRecord(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return false;
  }
  if (value.backend !== undefined && !isOneOf(value.backend, BACKEND_KINDS)) {
    return false;
  }
  if (value.model !== undefined && !isNonEmptyString(value.model)) {
    return false;
  }
  if (
    value.endpoint !== undefined &&
    value.endpoint !== null &&
    !isEmbeddingEndpointConfig(value.endpoint)
  ) {
    return false;
  }
  if (value.api_key !== undefined && !isNonEmptyString(value.api_key)) {
    return false;
  }
  if (
    value.weight !== undefined &&
    (typeof value.weight !== "number" ||
      !(value.weight >= 0) ||
      !(value.weight <= 1))
  ) {
    return false;
  }
  for (const key of [
    "candidate_depth",
    "chunk_target",
    "chunk_max",
    "max_chunks_per_message",
    "keep_spaces",
  ] as const) {
    const field = value[key];
    if (field !== undefined && !isPositiveInteger(field)) return false;
  }
  if (
    value.chunk_overlap !== undefined &&
    !isNonNegativeInteger(value.chunk_overlap)
  ) {
    return false;
  }
  if (value.threads !== undefined && !isNonNegativeInteger(value.threads)) {
    return false;
  }
  if (value.gpu !== undefined && !isOneOf(value.gpu, GPU_ROLES)) return false;
  if (
    value.quantization !== undefined &&
    !isOneOf(value.quantization, QUANTIZATIONS)
  ) {
    return false;
  }
  return true;
}

/** One stored-space selector: an index, a space id, or both (handler checks). */
function hasProfileSelector(value: EmbeddingEnvelope): boolean {
  return (
    (value.index === undefined || isPositiveInteger(value.index)) &&
    (value.space_id === undefined || isNonEmptyString(value.space_id))
  );
}

export function isEmbeddingStatusCommand(
  value: unknown,
): value is EmbeddingStatusCommand {
  return hasEmbeddingEnvelope(value, "embedding_status");
}

export function isEmbeddingConnectCommand(
  value: unknown,
): value is EmbeddingConnectCommand {
  if (!hasEmbeddingEnvelope(value, "embedding_connect")) return false;
  return isEmbeddingConnectPatch(value.patch);
}

export function isEmbeddingEnableCommand(
  value: unknown,
): value is EmbeddingEnableCommand {
  return hasEmbeddingEnvelope(value, "embedding_enable");
}

export function isEmbeddingDisableCommand(
  value: unknown,
): value is EmbeddingDisableCommand {
  return hasEmbeddingEnvelope(value, "embedding_disable");
}

export function isEmbeddingBuildCommand(
  value: unknown,
): value is EmbeddingBuildCommand {
  if (!hasEmbeddingEnvelope(value, "embedding_build")) return false;
  return (
    (value.mode === undefined || isOneOf(value.mode, BUILD_MODES)) &&
    (value.keep_after_exit === undefined ||
      typeof value.keep_after_exit === "boolean")
  );
}

export function isEmbeddingCancelCommand(
  value: unknown,
): value is EmbeddingCancelCommand {
  if (!hasEmbeddingEnvelope(value, "embedding_cancel")) return false;
  // `""` is the status snapshot's "no build id was ever assigned" sentinel; a
  // client that echoes it back means "whatever is live", not a malformed id.
  // Rejecting it left such a client waiting for a response that never came.
  return value.build_id === undefined || typeof value.build_id === "string";
}

export function isEmbeddingProfilesListCommand(
  value: unknown,
): value is EmbeddingProfilesListCommand {
  return hasEmbeddingEnvelope(value, "embedding_profiles_list");
}

export function isEmbeddingProfileSelectCommand(
  value: unknown,
): value is EmbeddingProfileSelectCommand {
  if (!hasEmbeddingEnvelope(value, "embedding_profile_select")) return false;
  return (
    hasProfileSelector(value) &&
    (value.index !== undefined || value.space_id !== undefined)
  );
}

export function isEmbeddingProfileDeleteCommand(
  value: unknown,
): value is EmbeddingProfileDeleteCommand {
  if (!hasEmbeddingEnvelope(value, "embedding_profile_delete")) return false;
  if (value.scope !== undefined && !isOneOf(value.scope, DELETE_SCOPES)) {
    return false;
  }
  if (!hasProfileSelector(value)) return false;
  if (value.confirm !== undefined && typeof value.confirm !== "boolean") {
    return false;
  }
  return true;
}

export function isEmbeddingProfilePinCommand(
  value: unknown,
): value is EmbeddingProfilePinCommand {
  if (!hasEmbeddingEnvelope(value, "embedding_profile_pin")) return false;
  return (
    typeof value.pinned === "boolean" &&
    hasProfileSelector(value) &&
    (value.index !== undefined || value.space_id !== undefined)
  );
}

export function isEmbeddingConfigGetCommand(
  value: unknown,
): value is EmbeddingConfigGetCommand {
  if (!hasEmbeddingEnvelope(value, "embedding_config_get")) return false;
  return value.key === undefined || isNonEmptyString(value.key);
}

export function isEmbeddingConfigSetCommand(
  value: unknown,
): value is EmbeddingConfigSetCommand {
  if (!hasEmbeddingEnvelope(value, "embedding_config_set")) return false;
  return (
    isNonEmptyString(value.key) &&
    (typeof value.value === "number" || typeof value.value === "string")
  );
}

export function isEmbeddingDeviceCommand(
  value: unknown,
): value is EmbeddingDeviceCommand {
  return hasEmbeddingEnvelope(value, "embedding_device");
}

export function isEmbeddingDeviceTestCommand(
  value: unknown,
): value is EmbeddingDeviceTestCommand {
  return hasEmbeddingEnvelope(value, "embedding_device_test");
}
