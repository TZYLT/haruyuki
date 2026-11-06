/**
 * The production `EmbeddingCommandBackend` for the R-26 embedding family
 * (D2, 48-2 §4.9).
 *
 * Split from `embedding.ts` so the handler module stays a protocol adapter and
 * both files stay under the source-size ceiling. The adapter is thin on purpose:
 * D3's settings writer owns configure/enable/disable and calibration
 * persistence, A2's runtime port owns status/build/cancel/reset, and C5/C3 own
 * the bounded calibration pass. Nothing here spawns a worker, downloads or
 * touches the network directly.
 *
 * `EmbeddingCommandBackendDeps` is the test seam: a fake runtime/settings
 * writer/calibration pass keeps every listener test offline.
 *
 * Layer: `websocket/listener/`. Imports `cli/` helpers — the exception the rest
 * of the listener already uses — and leaf `backend/local/` modules.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";

import { checkEmbeddingBuiltinAssets } from "@/backend/local/embedding-assets";
import type { EmbeddingBuildStateSnapshot } from "@/backend/local/embedding-build-state";
import { runEmbeddingCalibration } from "@/backend/local/embedding-calibration-probe";
import { getRecallVectorsRoot } from "@/backend/local/embedding-format";
import {
  readEmbeddingProfile,
  setEmbeddingProfilePinned,
} from "@/backend/local/embedding-profile";
import { resolveEmbeddingSpace } from "@/backend/local/embedding-space";
import { saveEmbeddingApiKey } from "@/cli/app/pages/settings/embedding-secrets";
import {
  EmbeddingSettingsError,
  type EmbeddingSettingsPatch,
  embeddingPatchInvalidatesSpace,
  previewEmbeddingSettings,
  updateEmbeddingSettings,
  validateEmbeddingSettingsPatch,
} from "@/cli/app/pages/settings/embedding-settings";
import type {
  EmbeddingRuntimePort,
  EmbeddingRuntimeStatus,
} from "@/cli/commands/embedding-runtime-contract";
import { listEmbeddingModels } from "@/cli/helpers/embedding-models";
import {
  buildEmbeddingFromSettings,
  createEmbeddingRuntimePort,
} from "@/cli/helpers/embedding-runtime";
import {
  type EmbeddingCalibrationSettings,
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import type {
  EmbeddingBuildMode,
  EmbeddingBuildSnapshot,
  EmbeddingCalibrationSnapshot,
  EmbeddingConfigRow,
  EmbeddingConnectPatch,
  EmbeddingDeviceSnapshot,
  EmbeddingProfileRow,
  EmbeddingQuantization,
  EmbeddingSettingsSnapshot,
  EmbeddingSpaceSnapshot,
  EmbeddingStatusSnapshot,
} from "@/types/embedding-protocol";
import { getErrorMessage } from "@/utils/error";
import {
  configPatchOf,
  configRows,
  findProfileRow,
  profileSelectPatch,
  toWireDevice,
  toWireProfileRow,
} from "@/websocket/listener/commands/embedding-profile-wire";

/** Code used when the embedding runtime cannot answer in this process. */
export const EMBEDDING_NOT_CONFIGURED = "not_configured";

/**
 * The resolved settings select the endpoint backend but carry no endpoint.
 *
 * Returned by `configure` for a patch whose *merged* result would be unusable,
 * whichever side of the pair (backend or endpoint) the patch changed.
 */
export const EMBEDDING_ENDPOINT_CONFIG_REQUIRED =
  "embedding_endpoint_config_required";

/** A write command that the backend declined without throwing. */
export type EmbeddingBackendFailure = { ok: false; error: string };

/** First version of the family's result type; see the backend interface below. */
export type EmbeddingBackendResult<T> =
  | { ok: true; value: T }
  | EmbeddingBackendFailure;

/**
 * `embedding_status` distinguishes "not configured" from "read failed": the
 * former is a normal, renderable state (no space, no endpoint), not an error.
 */
export type EmbeddingStatusBackendResult =
  | { configured: true; status: EmbeddingStatusSnapshot }
  | { configured: false; error: string };

export type EmbeddingConnectBackendValue = {
  settings: EmbeddingSettingsSnapshot;
  spaceId: string | null;
  requiresRebuild: boolean;
};
export type EmbeddingProfilesListBackendValue = {
  profiles: EmbeddingProfileRow[];
};
export type EmbeddingProfileSelectBackendValue = {
  settings: EmbeddingSettingsSnapshot | null;
  requiresRebuild: boolean;
  reason?: string;
};
export type EmbeddingProfileDeleteBackendValue = {
  removedSpaces: number;
  requiresRebuild: boolean;
  requiresConfirmation?: boolean;
  preview?: string;
};
export type EmbeddingProfilePinBackendValue = {
  profiles: EmbeddingProfileRow[];
};
export type EmbeddingConfigGetBackendValue = {
  keys: EmbeddingConfigRow[];
  settings: EmbeddingSettingsSnapshot;
};
export type EmbeddingConfigSetBackendValue = {
  settings: EmbeddingSettingsSnapshot;
  requiresRebuild: boolean;
};
export type EmbeddingDeviceBackendValue = {
  device: EmbeddingDeviceSnapshot | null;
};
export type EmbeddingEnableBackendValue = {
  enabled: boolean;
  buildStarted: boolean;
  /** Why the attempted first build did not start (wire `reason`). */
  reason?: string;
};
export type EmbeddingDisableBackendValue = { enabled: boolean };
export type EmbeddingBuildBackendValue = {
  started: boolean;
  buildId?: string;
  reason?: string;
};
export type EmbeddingCancelBackendValue = { cancelled: boolean };
export type EmbeddingCalibrateBackendValue = {
  calibration: EmbeddingCalibrationSnapshot | null;
};

export type EmbeddingBuildOptions = {
  mode: EmbeddingBuildMode;
  keepAfterExit: boolean;
};

/**
 * The narrow seam between the protocol family and the embedding subsystem.
 *
 * Every method is agent-scoped: the vector index is a rebuildable derivative of
 * one agent's local data, so the runtime's conversation id is not a selector.
 * Failures are typed rather than thrown when the subsystem declines normally
 * (disabled, locked, not configured); an unexpected throw is caught by the
 * handler and mapped to the response's `error`.
 */
import type { EmbeddingProfileSelector } from "./embedding-profile-wire";

export type { EmbeddingProfileSelector } from "./embedding-profile-wire";

export interface EmbeddingProfileDeleteRequest
  extends EmbeddingProfileSelector {
  scope: "current" | "all" | "model";
  confirm: boolean;
}

export interface EmbeddingCommandBackend {
  status(agentId: string): Promise<EmbeddingStatusBackendResult>;
  connect(
    agentId: string,
    patch: EmbeddingConnectPatch,
  ): Promise<EmbeddingBackendResult<EmbeddingConnectBackendValue>>;
  enable(
    agentId: string,
  ): Promise<EmbeddingBackendResult<EmbeddingEnableBackendValue>>;
  disable(
    agentId: string,
  ): Promise<EmbeddingBackendResult<EmbeddingDisableBackendValue>>;
  build(
    agentId: string,
    options: EmbeddingBuildOptions,
  ): Promise<EmbeddingBackendResult<EmbeddingBuildBackendValue>>;
  cancel(
    agentId: string,
    buildId: string | undefined,
  ): Promise<EmbeddingBackendResult<EmbeddingCancelBackendValue>>;
  profilesList(
    agentId: string,
  ): Promise<EmbeddingBackendResult<EmbeddingProfilesListBackendValue>>;
  profileSelect(
    agentId: string,
    selector: EmbeddingProfileSelector,
  ): Promise<EmbeddingBackendResult<EmbeddingProfileSelectBackendValue>>;
  profileDelete(
    agentId: string,
    request: EmbeddingProfileDeleteRequest,
  ): Promise<EmbeddingBackendResult<EmbeddingProfileDeleteBackendValue>>;
  profilePin(
    agentId: string,
    selector: EmbeddingProfileSelector,
    pinned: boolean,
  ): Promise<EmbeddingBackendResult<EmbeddingProfilePinBackendValue>>;
  configGet(
    agentId: string,
    key: string | undefined,
  ): Promise<EmbeddingBackendResult<EmbeddingConfigGetBackendValue>>;
  configSet(
    agentId: string,
    key: string,
    value: number | string,
  ): Promise<EmbeddingBackendResult<EmbeddingConfigSetBackendValue>>;
  device(
    agentId: string,
  ): Promise<EmbeddingBackendResult<EmbeddingDeviceBackendValue>>;
  deviceTest(
    agentId: string,
  ): Promise<EmbeddingBackendResult<EmbeddingCalibrateBackendValue>>;
}

// ── Production backend ───────────────────────────────────────────────

/**
 * The production seams {@link createEmbeddingCommandBackend} adapts.
 *
 * Every default is the same owner the TUI/CLI path uses; tests replace one
 * field (usually `runtime`) to keep a build offline. The second parameter to
 * `createEmbeddingCommandBackend` takes these, while the first still accepts
 * whole-method overrides for the handler tests.
 */
export interface EmbeddingCommandBackendDeps {
  /** Production runtime port; defaults to A2's `createEmbeddingRuntimePort()`. */
  runtime?: EmbeddingRuntimePort;
  /** Settings reader; defaults to the resolved global embedding settings. */
  readSettings?: () => ResolvedEmbeddingSettings;
  /** D3's only settings writer; defaults to `updateEmbeddingSettings`. */
  writeSettings?: (patch: EmbeddingSettingsPatch) => ResolvedEmbeddingSettings;
  /** Write-only endpoint credential sink; defaults to D3's secret store. */
  saveApiKey?: (value: string, agentId: string) => Promise<unknown>;
  /** Space id for the status snapshot; defaults to A1's resolver. */
  readSpaceId?: (
    agentId: string,
    settings: ResolvedEmbeddingSettings,
  ) => string;
  /** Shared build entry (enable's first build); defaults to A2's. */
  buildFromSettings?: typeof buildEmbeddingFromSettings;
  /** Bounded calibration pass; defaults to C5/C3's worker probe. */
  runCalibration?: (
    settings: ResolvedEmbeddingSettings,
  ) => Promise<EmbeddingCalibrationSnapshot>;
}

/** A build receipt reporting a started (foreground or detached) build. */
const BUILD_STARTED_RECEIPT = /^Build started\b/;
/** A cancel receipt for an accepted request (settled or in flight). */
const CANCEL_RECEIPT = /^Cancel(?:led|ling)\b/;
/** `Deleted N vector space(s) …` from A2's reset receipt. */
const REMOVED_SPACES_RECEIPT = /^Deleted (\d+) vector space/;

function failureOf(error: unknown): EmbeddingBackendFailure {
  return {
    ok: false,
    error:
      error instanceof EmbeddingSettingsError
        ? error.message
        : getErrorMessage(error),
  };
}

function firstLine(receipt: string): string {
  const line = receipt.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 0 ? line : "The embedding build did not start.";
}

function removedSpacesOf(receipt: string): number {
  const match = REMOVED_SPACES_RECEIPT.exec(receipt);
  return match === null ? 0 : Number(match[1]);
}

function toWireEndpoint(
  endpoint: ResolvedEmbeddingSettings["endpoint"],
): EmbeddingSettingsSnapshot["endpoint"] {
  if (endpoint === null) return null;
  return {
    kind: endpoint.kind,
    base_url: endpoint.baseUrl,
    model: endpoint.model,
    dimensions: endpoint.dimensions,
    ...(endpoint.timeoutMs === undefined
      ? {}
      : { timeout_ms: endpoint.timeoutMs }),
  };
}

/** The resolved settings in D1 wire spelling. Never carries a credential. */
function toWireSettings(
  settings: ResolvedEmbeddingSettings,
): EmbeddingSettingsSnapshot {
  return {
    enabled: settings.enabled,
    backend: settings.backend,
    model: settings.model,
    endpoint: toWireEndpoint(settings.endpoint),
    weight: settings.weight,
    candidate_depth: settings.candidateDepth,
    chunk_target: settings.chunkTarget,
    chunk_max: settings.chunkMax,
    chunk_overlap: settings.chunkOverlap,
    max_chunks_per_message: settings.maxChunksPerMessage,
    threads: settings.threads,
    gpu: settings.gpu,
    quantization: settings.quantization,
    keep_spaces: settings.keepSpaces,
  };
}

/** The wire patch in D3's resolved field names (`api_key` stays separate). */
function toSettingsPatch(patch: EmbeddingConnectPatch): EmbeddingSettingsPatch {
  const next: EmbeddingSettingsPatch = {};
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.backend !== undefined) next.backend = patch.backend;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.endpoint !== undefined) {
    next.endpoint =
      patch.endpoint === null
        ? null
        : {
            kind: patch.endpoint.kind,
            baseUrl: patch.endpoint.base_url,
            model: patch.endpoint.model,
            dimensions: patch.endpoint.dimensions,
            ...(patch.endpoint.timeout_ms === undefined
              ? {}
              : { timeoutMs: patch.endpoint.timeout_ms }),
          };
  }
  if (patch.weight !== undefined) next.weight = patch.weight;
  if (patch.candidate_depth !== undefined) {
    next.candidateDepth = patch.candidate_depth;
  }
  if (patch.chunk_target !== undefined) next.chunkTarget = patch.chunk_target;
  if (patch.chunk_max !== undefined) next.chunkMax = patch.chunk_max;
  if (patch.chunk_overlap !== undefined) {
    next.chunkOverlap = patch.chunk_overlap;
  }
  if (patch.max_chunks_per_message !== undefined) {
    next.maxChunksPerMessage = patch.max_chunks_per_message;
  }
  if (patch.threads !== undefined) next.threads = patch.threads;
  if (patch.gpu !== undefined) next.gpu = patch.gpu;
  if (patch.quantization !== undefined) next.quantization = patch.quantization;
  if (patch.keep_spaces !== undefined) next.keepSpaces = patch.keep_spaces;
  return next;
}

function toWireCalibration(
  calibration: EmbeddingCalibrationSettings | null,
): EmbeddingCalibrationSnapshot | null {
  if (calibration === null) return null;
  return {
    fingerprint: calibration.fingerprint,
    measured_at: calibration.measuredAt,
    query_latency_p50_ms: calibration.queryLatencyP50Ms,
    query_latency_p90_ms: calibration.queryLatencyP90Ms,
    batch_throughput_per_s: calibration.batchThroughputPerSec,
    gpu_role: calibration.gpuRole,
    threads: calibration.threads,
    quantization: calibration.quantization,
  };
}

/**
 * D1's `bytes` is a required number, but A1's bounded summary deliberately
 * never walks generation files (a status read must stay cheap). This reports the
 * committed vector payload — chunks × width × element bytes, plus one float32
 * norm per chunk. It is an estimate: JSON headers, sidecars and unreferenced
 * generations are not included, and it is not the on-disk size.
 */
function estimateSpaceBytes(
  chunks: number,
  dimensions: number,
  quantization: EmbeddingQuantization,
): number {
  const elementBytes = quantization === "int8" ? 1 : 4;
  const perChunk = Math.max(0, Math.trunc(dimensions)) * elementBytes + 4;
  return Math.max(0, Math.trunc(chunks)) * perChunk;
}

function toWireSpace(
  agentId: string,
  settings: ResolvedEmbeddingSettings,
  status: EmbeddingRuntimeStatus,
  readSpaceId: (agentId: string, settings: ResolvedEmbeddingSettings) => string,
): EmbeddingSpaceSnapshot | null {
  if (status.space === null) return null;
  return {
    space_id: readSpaceId(agentId, settings),
    model: status.space.model,
    dimensions: status.space.dimensions,
    quantization: settings.quantization,
    coverage:
      status.space.coverage === null
        ? 0
        : Math.min(1, Math.max(0, status.space.coverage)),
    conversations: status.space.conversations,
    chunks: status.space.chunks,
    bytes: estimateSpaceBytes(
      status.space.chunks,
      status.space.dimensions,
      settings.quantization,
    ),
    built_at: status.space.builtAt,
  };
}

function toWireBuild(
  snapshot: EmbeddingBuildStateSnapshot | null,
): EmbeddingBuildSnapshot | null {
  if (snapshot === null) return null;
  const lastFailure = snapshot.failures.at(-1);
  return {
    build_id: snapshot.buildId ?? "",
    mode: snapshot.mode,
    state: snapshot.phase,
    started_at: new Date(
      snapshot.startedAt ?? snapshot.updatedAt,
    ).toISOString(),
    updated_at: new Date(snapshot.updatedAt).toISOString(),
    progress: snapshot.progress.fraction ?? 0,
    processed_chunks: snapshot.progress.embeddedChunks,
    total_chunks: snapshot.progress.totalChunks,
    eta_ms: snapshot.eta.remainingMs,
    ...(snapshot.phase === "failed" && lastFailure !== undefined
      ? { error: lastFailure.message ?? lastFailure.code }
      : {}),
  };
}

function defaultReadSpaceId(
  agentId: string,
  settings: ResolvedEmbeddingSettings,
): string {
  return resolveEmbeddingSpace(agentId, settings, {
    root: getRecallVectorsRoot(),
  }).spaceId;
}

/** C5's bounded pass through C3's worker, refusing when assets are missing. */
async function defaultCalibrationSnapshot(
  settings: ResolvedEmbeddingSettings,
): Promise<EmbeddingCalibrationSnapshot> {
  const check = await checkEmbeddingBuiltinAssets(settings.model, {});
  if (!check.installed) {
    throw new Error(
      `Built-in embedding assets are not installed (missing ${check.missing.join(" and ")}); run /recall embedding connect first.`,
    );
  }
  const { result, probe } = await runEmbeddingCalibration({
    settings,
    assets: check.assets,
  });
  try {
    return result.snapshot;
  } finally {
    await probe.dispose().catch(() => undefined);
  }
}

/** Whether a build can plausibly run for the current settings. */
function buildConfigured(settings: ResolvedEmbeddingSettings): boolean {
  return settings.backend === "endpoint" ? settings.endpoint !== null : true;
}

/**
 * The id of the live build, when the runtime can name one.
 *
 * `embedding_cancel`'s response promises `cancelled: false` when "no live build
 * matched the id", so a supplied id must be compared against the live build
 * before cancelling. A runtime that cannot read status, or a build that has no
 * id yet, cannot match: the id-filtered request is answered `cancelled: false`
 * rather than silently cancelling whichever build happens to be running.
 */
async function liveBuildId(
  runtime: EmbeddingRuntimePort,
  agentId: string,
): Promise<string | null> {
  const readStatus = runtime.readStatus;
  if (readStatus === undefined) return null;
  try {
    const status = await readStatus.call(runtime, {
      agentId,
      conversationId: null,
    });
    return status?.buildSnapshot?.buildId ?? null;
  } catch {
    return null;
  }
}

/**
 * The production {@link EmbeddingCommandBackend}.
 *
 * Thin by design: settings go through D3's writer, build/cancel/reset/status
 * through A2's runtime port, enable's first build through the same
 * `buildEmbeddingFromSettings` the wizard and CLI use, and calibration through
 * C5/C3. Nothing here spawns a worker or touches the network directly.
 *
 * Failures are typed (`ok: false` / `configured: false`) rather than thrown when
 * the subsystem declines normally; an unexpected throw still reaches the
 * handler, which maps it to the response's `error`.
 */
export function createEmbeddingCommandBackend(
  overrides: Partial<EmbeddingCommandBackend> = {},
  deps: EmbeddingCommandBackendDeps = {},
): EmbeddingCommandBackend {
  const runtime = deps.runtime ?? createEmbeddingRuntimePort();
  const readSettings = deps.readSettings ?? readEmbeddingSettings;
  const writeSettings =
    deps.writeSettings ??
    ((patch: EmbeddingSettingsPatch) => updateEmbeddingSettings(patch));
  const saveApiKey = deps.saveApiKey ?? saveEmbeddingApiKey;
  const readSpaceId = deps.readSpaceId ?? defaultReadSpaceId;
  const buildFromSettings =
    deps.buildFromSettings ?? buildEmbeddingFromSettings;
  const runCalibration = deps.runCalibration ?? defaultCalibrationSnapshot;
  const unavailable = async (): Promise<EmbeddingBackendFailure> => ({
    ok: false,
    error: EMBEDDING_NOT_CONFIGURED,
  });
  const unavailableStatus =
    async (): Promise<EmbeddingStatusBackendResult> => ({
      configured: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });

  const backend: EmbeddingCommandBackend = {
    async status(agentId) {
      const readStatus = runtime.readStatus;
      if (readStatus === undefined) return await unavailableStatus();
      const settings = readSettings();
      const status = await readStatus.call(runtime, {
        agentId,
        conversationId: null,
      });
      if (status === null) return await unavailableStatus();
      return {
        configured: true,
        status: {
          enabled: settings.enabled,
          ready: status.ready,
          settings: toWireSettings(settings),
          space: toWireSpace(agentId, settings, status, readSpaceId),
          calibration: toWireCalibration(settings.calibration),
          build: toWireBuild(status.buildSnapshot ?? null),
          egress: status.egress,
          failure: status.failure,
        },
      };
    },
    async connect(agentId, wirePatch) {
      const patch = toSettingsPatch(wirePatch);
      const current = readSettings();
      const invalid = validateEmbeddingSettingsPatch(patch, current);
      if (invalid !== null) return { ok: false, error: invalid };
      // D1's patch is partial, so endpoint coherence is a property of the
      // *merged* settings: selecting the endpoint backend is refused unless an
      // endpoint exists (stored or in this patch), and clearing the endpoint is
      // refused while the endpoint backend is active. Checking only the patch
      // would reject a legitimate two-step `endpoint` -> `backend:"endpoint"`
      // and would accept `endpoint:null` on an endpoint-backed config.
      const merged = previewEmbeddingSettings(patch, current);
      if (merged.backend === "endpoint" && merged.endpoint === null) {
        return { ok: false, error: EMBEDDING_ENDPOINT_CONFIG_REQUIRED };
      }
      try {
        // Write-only credential first: a settings write that follows a stored
        // key is recoverable by re-running connect; the reverse is not.
        if (wirePatch.api_key !== undefined) {
          await saveApiKey(wirePatch.api_key, agentId);
        }
        const updated = writeSettings(patch);
        let spaceId: string | null = null;
        try {
          spaceId = readSpaceId(agentId, updated);
        } catch {
          // An unresolvable space is reported as `null`; the settings still
          // landed and the client can list profiles once assets are ready.
        }
        return {
          ok: true,
          value: {
            settings: toWireSettings(updated),
            spaceId,
            requiresRebuild: embeddingPatchInvalidatesSpace(patch),
          },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
    async enable(agentId) {
      let updated: ResolvedEmbeddingSettings;
      try {
        updated = writeSettings({ enabled: true });
      } catch (error) {
        return failureOf(error);
      }
      // 48-2 §4.9 D2: enabling may start the first build. It starts one only
      // when the agent is configured and this space has nothing usable yet; a
      // refusal leaves the switch on and reports buildStarted: false together
      // with the launcher's first line, so the client can tell "already built"
      // from "cannot build yet" (48-1 F-08 degrade visibility).
      let buildStarted = false;
      let reason: string | undefined;
      const readStatus = runtime.readStatus;
      if (
        updated.enabled &&
        readStatus !== undefined &&
        buildConfigured(updated)
      ) {
        try {
          const status = await readStatus.call(runtime, {
            agentId,
            conversationId: null,
          });
          if (status !== null && status.space === null) {
            const receipt = await buildFromSettings({
              agentId,
              mode: "incremental",
              keepAfterExit: false,
              lifecycle: "websocket",
            });
            buildStarted = BUILD_STARTED_RECEIPT.test(receipt);
            if (!buildStarted) reason = firstLine(receipt);
          }
        } catch (error) {
          // Enabling must not fail because the optional first build did not
          // start; the client can send embedding_build and read the status.
          buildStarted = false;
          reason = firstLine(getErrorMessage(error));
        }
      }
      return {
        ok: true,
        value: {
          enabled: updated.enabled,
          buildStarted,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    },
    async disable(_agentId) {
      try {
        const updated = writeSettings({ enabled: false });
        return { ok: true, value: { enabled: updated.enabled } };
      } catch (error) {
        return failureOf(error);
      }
    },
    async build(agentId, options) {
      const build = runtime.build;
      if (build === undefined) return await unavailable();
      try {
        const receipt = await build.call(
          runtime,
          { agentId, conversationId: null },
          options.mode,
          {
            keepAfterExit: options.keepAfterExit,
            lifecycle: "websocket",
          },
        );
        if (BUILD_STARTED_RECEIPT.test(receipt)) {
          return { ok: true, value: { started: true } };
        }
        return {
          ok: true,
          value: { started: false, reason: firstLine(receipt) },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
    async cancel(agentId, buildId) {
      const cancel = runtime.cancel;
      if (cancel === undefined) return await unavailable();
      if (buildId !== undefined && buildId.length > 0) {
        const liveId = await liveBuildId(runtime, agentId);
        if (liveId !== buildId)
          return { ok: true, value: { cancelled: false } };
      }
      try {
        const receipt = await cancel.call(runtime, {
          agentId,
          conversationId: null,
        });
        return { ok: true, value: { cancelled: CANCEL_RECEIPT.test(receipt) } };
      } catch (error) {
        return failureOf(error);
      }
    },
    async profilesList(agentId) {
      try {
        const rows = await listEmbeddingModels({ agentId });
        return { ok: true, value: { profiles: rows.map(toWireProfileRow) } };
      } catch (error) {
        return failureOf(error);
      }
    },
    async profileSelect(agentId, selector) {
      try {
        const rows = await listEmbeddingModels({ agentId });
        const row = findProfileRow(rows, selector);
        if (row === null) {
          return { ok: false, error: "embedding_profile_not_found" };
        }
        const spaceDir = join(getRecallVectorsRoot(), agentId, row.spaceId);
        const profile = await readEmbeddingProfile(spaceDir);
        if (profile === null) {
          return {
            ok: true,
            value: {
              settings: null,
              requiresRebuild: false,
              reason: "legacy_profile_missing",
            },
          };
        }
        const updated = writeSettings(profileSelectPatch(profile));
        return {
          ok: true,
          value: { settings: toWireSettings(updated), requiresRebuild: false },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
    async profileDelete(agentId, request) {
      try {
        if (request.scope === "model") {
          const rows = await listEmbeddingModels({ agentId });
          const row = findProfileRow(rows, request);
          if (row === null) {
            return { ok: false, error: "embedding_profile_not_found" };
          }
          if (row.active) {
            return { ok: false, error: "embedding_profile_active" };
          }
          const preview = `model #${row.index} (${row.model}, ${row.chunks} chunks)`;
          if (!request.confirm) {
            return {
              ok: true,
              value: {
                removedSpaces: 0,
                requiresRebuild: false,
                requiresConfirmation: true,
                preview,
              },
            };
          }
          rmSync(join(getRecallVectorsRoot(), agentId, row.spaceId), {
            recursive: true,
            force: true,
          });
          return {
            ok: true,
            value: { removedSpaces: 1, requiresRebuild: false },
          };
        }
        if (!request.confirm) {
          return {
            ok: true,
            value: {
              removedSpaces: 0,
              requiresRebuild: false,
              requiresConfirmation: true,
              preview:
                request.scope === "all"
                  ? "all stored vector spaces for this agent"
                  : "the active vector space",
            },
          };
        }
        const reset = runtime.reset;
        if (reset === undefined) return await unavailable();
        const receipt = await reset.call(
          runtime,
          { agentId, conversationId: null },
          request.scope === "all" ? { kind: "all" } : { kind: "current" },
        );
        const removedSpaces = removedSpacesOf(receipt);
        return {
          ok: true,
          value: { removedSpaces, requiresRebuild: removedSpaces > 0 },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
    async profilePin(agentId, selector, pinned) {
      try {
        const rows = await listEmbeddingModels({ agentId });
        const row = findProfileRow(rows, selector);
        if (row === null) {
          return { ok: false, error: "embedding_profile_not_found" };
        }
        if (row.legacy) {
          return { ok: false, error: "embedding_profile_legacy" };
        }
        const written = await setEmbeddingProfilePinned(
          join(getRecallVectorsRoot(), agentId, row.spaceId),
          pinned,
        );
        if (!written) {
          return { ok: false, error: "embedding_profile_write_failed" };
        }
        const refreshed = await listEmbeddingModels({ agentId });
        return {
          ok: true,
          value: { profiles: refreshed.map(toWireProfileRow) },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
    async configGet(_agentId, key) {
      try {
        const settings = readSettings();
        const rows = configRows(settings, key);
        if (typeof rows === "string") return { ok: false, error: rows };
        return {
          ok: true,
          value: { keys: rows, settings: toWireSettings(settings) },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
    async configSet(_agentId, key, value) {
      try {
        const patch = configPatchOf(key, value);
        if (typeof patch === "string") return { ok: false, error: patch };
        const current = readSettings();
        const invalid = validateEmbeddingSettingsPatch(patch, current);
        if (invalid !== null) return { ok: false, error: invalid };
        const updated = writeSettings(patch);
        return {
          ok: true,
          value: {
            settings: toWireSettings(updated),
            requiresRebuild: embeddingPatchInvalidatesSpace(patch),
          },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
    async device(agentId) {
      const readStatus = runtime.readStatus;
      if (readStatus === undefined) return await unavailable();
      try {
        const status = await readStatus.call(runtime, {
          agentId,
          conversationId: null,
        });
        return {
          ok: true,
          value: {
            device: toWireDevice(status?.buildSnapshot?.device ?? null),
          },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
    async deviceTest(_agentId) {
      const settings = readSettings();
      if (settings.backend !== "builtin") {
        return { ok: false, error: "device_test_requires_builtin_backend" };
      }
      try {
        const calibration = await runCalibration(settings);
        return { ok: true, value: { calibration } };
      } catch (error) {
        return failureOf(error);
      }
    },
  };
  return { ...backend, ...overrides };
}
