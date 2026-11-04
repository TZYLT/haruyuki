/**
 * The narrow runtime contract `/recall embedding` talks to (feature 48,
 * rework A2/A4 integration point).
 *
 * The command handler (`embedding.ts`) must stay a parser + renderer: status,
 * build, cancel and reset are asked of this port, and no data source is
 * implemented there. The shapes live in their own module because they are the
 * seam three callers share — the command, the production port
 * (`cli/helpers/embedding-runtime.ts`) and the wiring tests — while
 * `embedding.ts` is already close to the 1,000-line ceiling.
 *
 * Every method is optional on purpose: the settings-only actions
 * (on/off/knobs/setup) work with no runtime at all, and the command says so
 * instead of pretending. `embedding.ts` re-exports these types so the existing
 * import sites keep working.
 *
 * Layer: `cli/commands/`. Type-only imports; no behaviour.
 */

import type { EmbeddingBuildStateSnapshot } from "@/backend/local/embedding-build-state";
import type {
  EmbeddingBuildMode,
  EmbeddingBuildState,
  EmbeddingEndpointKind,
  EmbeddingGpuRole,
  EmbeddingQuantization,
} from "@/types/embedding-protocol";

/** What `reset` deletes. The default is the space for the current model. */
export type EmbeddingResetTarget =
  | { kind: "current" }
  | { kind: "all" }
  | { kind: "model"; model: string };

/** Build progress as the status face paints it. */
export interface EmbeddingRuntimeBuildProgress {
  state: EmbeddingBuildState;
  /** 0..1. */
  progress: number;
  processedChunks: number;
  totalChunks: number;
  etaMs: number | null;
  /** Redacted, actionable failure text. */
  error?: string;
}

/** One stored model space, summarised. */
export interface EmbeddingRuntimeSpace {
  model: string;
  dimensions: number;
  chunks: number;
  /** Conversations the space has a unit for (memory files are separate). */
  conversations: number;
  /**
   * Memory files the space has a unit for. Optional so a caller that only knows
   * the conversation count still satisfies the shape; the status face prints it
   * separately rather than folding it into the conversation total.
   */
  memoryFiles?: number;
  /** 0..1, or `null` when nothing recallable was found. */
  coverage: number | null;
  builtAt: string | null;
}

/** The bounded calibration result, as measured. */
export interface EmbeddingRuntimeCalibration {
  measuredAt: string;
  queryLatencyP50Ms: number;
  queryLatencyP90Ms: number;
  throughputPerSecond: number;
  gpuRole: EmbeddingGpuRole;
  threads: number;
  quantization: EmbeddingQuantization;
}

/** Everything `status` needs beyond settings. */
export interface EmbeddingRuntimeStatus {
  /** A configured space matches the current settings and can answer queries. */
  ready: boolean;
  space: EmbeddingRuntimeSpace | null;
  build: EmbeddingRuntimeBuildProgress | null;
  /**
   * A2's raw build-state projection (`state.json`), when the runtime can read
   * it. Used for the extra coverage/rate/skipped lines only while {@link build}
   * is absent, so the same progress is never printed twice.
   */
  buildSnapshot?: EmbeddingBuildStateSnapshot | null;
  calibration: EmbeddingRuntimeCalibration | null;
  /** Endpoint queries leave the machine (non-loopback base URL). */
  egress: boolean;
  /** Last failure, redacted; `null` when healthy. */
  failure: string | null;
}

/** Scoping for a runtime call; at least the agent is required to find a space. */
export interface EmbeddingRuntimeScope {
  agentId: string;
  conversationId: string | null;
}

/** The result of a successful endpoint test-embed. */
export interface EmbeddingEndpointProbeResult {
  kind: EmbeddingEndpointKind;
  /** Model id the endpoint reported; defaults to the one asked for. */
  model?: string;
  dimensions: number;
  timeoutMs?: number;
}

/** Input for one endpoint probe; `apiKey` is never persisted or echoed here. */
export interface EmbeddingEndpointProbeInput {
  agentId: string | null;
  baseUrl: string;
  model: string | null;
  /** Read from the named environment variable by the caller; may be `null`. */
  apiKey: string | null;
}

/** Options a caller may pass to {@link EmbeddingRuntimePort.build}. */
export interface EmbeddingRuntimeBuildOptions {
  /** Opt into a detached child that outlives this process (default `false`). */
  keepAfterExit?: boolean;
  /** Which surface owns the build; defaults to the runtime's own choice. */
  lifecycle?: "tui" | "headless" | "websocket";
}

/**
 * The runtime seam. Every method is optional on purpose: the command works for
 * the settings-only actions (on/off/knobs/setup) with no runtime at all, and
 * says so instead of throwing when a runtime action is not wired.
 */
export interface EmbeddingRuntimePort {
  readStatus?(
    scope: EmbeddingRuntimeScope,
  ): Promise<EmbeddingRuntimeStatus | null>;
  build?(
    scope: EmbeddingRuntimeScope,
    mode: EmbeddingBuildMode,
    options?: EmbeddingRuntimeBuildOptions,
  ): Promise<string>;
  cancel?(scope: EmbeddingRuntimeScope): Promise<string>;
  reset?(
    scope: EmbeddingRuntimeScope,
    target: EmbeddingResetTarget,
  ): Promise<string>;
  configureEndpoint?(
    input: EmbeddingEndpointProbeInput,
  ): Promise<EmbeddingEndpointProbeResult>;
}
