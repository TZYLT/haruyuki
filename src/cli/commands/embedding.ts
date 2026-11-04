/**
 * `/recall embedding` — feature ③'s command face (48-1 §7.1, 48-2 §4.9 D4).
 *
 * One handler for every surface: the TUI's `/recall embedding …`, the binary's
 * `haruyuki recall embedding …` (through `handleRecallCommand`), and the
 * headless flag path (through {@link applyEmbeddingCliFlags}). The spellings,
 * the refusals and the copy are therefore tested once.
 *
 * Three seams keep this module honest while its runtime is being built:
 *
 * 1. **Settings never bypass D3.** Every write goes through
 *    `updateEmbeddingSettings` (`embedding-settings.ts`), the single validator
 *    and key map the settings page also uses. The command parses a value into a
 *    patch; it never touches `settingsManager` itself.
 * 2. **Runtime reads/writes are a narrow injectable port.** Status, build
 *    progress, cancel and reset are asked of {@link EmbeddingRuntimePort}. No
 *    real data source is wired here (A2/A3/A4 own that); an injected fake is what
 *    the tests use, and the default port is absent, which the command reports as
 *    an honest "not available in this process" instead of pretending.
 * 3. **Credentials are references, never values.** `--recall-embedding-api-key-env`
 *    names an environment variable; the key is read from the environment and
 *    written through D3's secret store. Nothing this module returns contains it.
 *
 * First enable without configuration does **not** write: 48-1 §7.2 says the
 * wizard owns first-run setup and cancelling it leaves the feature off. A shell
 * without a wizard gets the copy-paste commands instead (R-12's non-interactive
 * path), which is also why {@link formatEmbeddingFirstRunHint} is exported: the
 * headless first-run notice is the same text.
 */

import type { DreamCommandScope } from "@/agent/reflection-runs";
import { saveEmbeddingApiKey } from "@/cli/app/pages/settings/embedding-secrets";
import {
  EmbeddingSettingsError,
  type EmbeddingSettingsPatch,
  embeddingPatchInvalidatesSpace,
  updateEmbeddingSettings,
  validateEmbeddingSettingsPatch,
} from "@/cli/app/pages/settings/embedding-settings";
import type { EmbeddingSetupFlags } from "@/cli/args";
import {
  embeddingCalibrationMeasured,
  formatEmbeddingBuildSnapshotLines,
  formatEmbeddingMetricsLines,
  formatEmbeddingStoredCalibrationLine,
} from "@/cli/commands/embedding-status";
import { embeddingSetCommand } from "@/cli/helpers/settings-deep-link";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import {
  type EmbeddingMetricsSnapshot,
  embeddingMetrics,
} from "@/reminders/embedding-metrics";
import { settingsManager } from "@/settings-manager";
import type { EmbeddingBuildMode } from "@/types/embedding-protocol";

// ── Copy ────────────────────────────────────────────────────────────

/** The usage table. Kept beside the parser so a new spelling updates both. */
export const EMBEDDING_COMMAND_USAGE = [
  "/recall embedding [command]",
  "",
  "Vector recall embeds the parts of earlier conversations and memory files",
  "that passive recall may inject, and searches them by meaning instead of",
  "words alone. It is off by default; the first enable needs a setup step.",
  "",
  "USAGE",
  "  /recall embedding                 what vector recall is doing right now",
  "  /recall embedding status          same, spelled out",
  "  /recall embedding on              enable; first run opens setup",
  "  /recall embedding off             disable; stored vectors stay on disk",
  "  /recall embedding build [--full] [--keep-after-exit]",
  "                                    build or refresh the vector index",
  "  /recall embedding cancel          stop a running build",
  "  /recall embedding reset [--all|--model <id>] [--confirm]",
  "                                    delete stored vector spaces",
  "  /recall embedding setup           re-run first-run setup (current values)",
  "",
  "TUNING",
  "  /recall embedding weight <0..1>   vector-arm weight (0 = lexical only)",
  "  /recall embedding depth <n>       candidates per arm",
  "  /recall embedding chunk <tokens>  target chunk window",
  "  /recall embedding chunk-max <tokens>",
  "  /recall embedding chunk-overlap <tokens>",
  "  /recall embedding max-chunks <n>  chunks embedded per message cap",
  "  /recall embedding threads <n>     encode/build threads (0 = automatic)",
  "  /recall embedding gpu auto|off|index-only",
  "  /recall embedding quant float32|int8",
  "  /recall embedding spaces <n>      model spaces kept on disk",
  "",
  "WITHOUT A TUI",
  "  haruyuki recall embedding status",
  "  haruyuki --recall-embedding on --recall-embedding-backend builtin",
].join("\n");

/** Every setting changes a stored key; the writer validates before any write. */
const EMBEDDING_KNOB_LABEL: Readonly<Record<string, string>> = {
  weight: "vector weight",
  depth: "candidate depth",
  chunk: "chunk target",
  "chunk-max": "chunk ceiling",
  "chunk-overlap": "chunk overlap",
  "max-chunks": "chunks per message cap",
  threads: "threads",
  gpu: "GPU role",
  quant: "vector precision",
  spaces: "model spaces kept",
};

const NEEDS_AGENT =
  "Embedding recall needs an active agent for this action; pass --agent <id> or run it in a session.";

const RUNTIME_UNAVAILABLE = {
  status:
    "Space and build status are not available in this process: the embedding runtime is not wired here yet. The settings above are live.",
  build:
    "Starting an embedding build needs the background runner, which this process does not have. Nothing was started.",
  cancel:
    "No build runner is available in this process, so there is nothing to cancel.",
  reset:
    "Deleting vector spaces needs the index store, which this process does not have. Nothing was deleted.",
  endpoint:
    "Testing an endpoint needs the embedding runtime, which this process does not have. Nothing was written. Run /recall embedding setup in the TUI.",
} as const;

// ── Command parser ──────────────────────────────────────────────────

/** One parsed `/recall embedding` invocation. */
export type EmbeddingCommand =
  | { kind: "status" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "build"; mode: EmbeddingBuildMode; keepAfterExit: boolean }
  | { kind: "cancel" }
  | { kind: "reset"; target: EmbeddingResetTarget; confirmed: boolean }
  | { kind: "setup" }
  | { kind: "set"; label: string; updates: EmbeddingSettingsPatch }
  | { kind: "usage" }
  | { kind: "error"; message: string };

/** A non-negative whole number, or `null` when the text is not one. */
// The runtime contract lives in its own module so this parser/renderer stays
// under the file-size ceiling; these re-exports keep the public import site.
import type {
  EmbeddingResetTarget,
  EmbeddingRuntimeBuildProgress,
  EmbeddingRuntimeCalibration,
  EmbeddingRuntimePort,
  EmbeddingRuntimeScope,
  EmbeddingRuntimeSpace,
  EmbeddingRuntimeStatus,
} from "@/cli/commands/embedding-runtime-contract";

export type {
  EmbeddingEndpointProbeInput,
  EmbeddingEndpointProbeResult,
  EmbeddingResetTarget,
  EmbeddingRuntimeBuildOptions,
  EmbeddingRuntimeBuildProgress,
  EmbeddingRuntimeCalibration,
  EmbeddingRuntimePort,
  EmbeddingRuntimeScope,
  EmbeddingRuntimeSpace,
  EmbeddingRuntimeStatus,
} from "@/cli/commands/embedding-runtime-contract";

export function parseEmbeddingCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** A ratio in `[0, 1]`; above 1 is refused rather than clamped. */
export function parseEmbeddingRatio(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function error(message: string): EmbeddingCommand {
  return { kind: "error", message };
}

/** The single argument of a one-value knob, or `undefined` when it has company. */
function oneValue(rest: string[]): string | undefined {
  return rest.length === 1 ? rest[0] : undefined;
}

function parseReset(rest: string[]): EmbeddingCommand {
  let all = false;
  let model: string | undefined;
  let confirmed = false;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === "--all") {
      all = true;
      continue;
    }
    if (word === "--confirm") {
      confirmed = true;
      continue;
    }
    if (word === "--model") {
      const value = rest[index + 1]?.trim();
      if (value === undefined || value === "") {
        return error("`/recall embedding reset --model` needs a model id.");
      }
      model = value;
      index += 1;
      continue;
    }
    return error(`\`/recall embedding reset\` does not take "${word}".`);
  }
  if (all && model !== undefined) {
    return error("`/recall embedding reset` takes --all or --model, not both.");
  }
  const target: EmbeddingResetTarget = all
    ? { kind: "all" }
    : model === undefined
      ? { kind: "current" }
      : { kind: "model", model };
  return { kind: "reset", target, confirmed };
}

/**
 * Parse `build`'s flags: `--full` rebuilds every chunk, `--keep-after-exit`
 * opts into a detached child (48-1 R-34's only exception to "the build dies with
 * its host"). Both are optional and order-independent; an unknown word is
 * refused rather than ignored.
 */
function parseBuild(rest: string[]): EmbeddingCommand {
  let full = false;
  let keepAfterExit = false;
  for (const word of rest) {
    if (word === "--full") {
      full = true;
      continue;
    }
    if (word === "--keep-after-exit") {
      keepAfterExit = true;
      continue;
    }
    return error(
      "`/recall embedding build` takes only --full and --keep-after-exit: /recall embedding build [--full] [--keep-after-exit].",
    );
  }
  return {
    kind: "build",
    mode: full ? "full" : "incremental",
    keepAfterExit,
  };
}

/**
 * Parse the words after `/recall embedding`.
 *
 * A bare invocation answers the status, because opening an overlay is the TUI
 * submit layer's job (D5/D6) and every other channel can only print. Every
 * spelling the completion table offers has a branch here; the drift test in
 * `embedding.test.ts` walks the table and feeds each row through this function.
 */
export function parseEmbeddingCommand(args: string[]): EmbeddingCommand {
  const [head, ...rest] = args;
  if (head === undefined) return { kind: "status" };
  if (head === "help" || head === "--help" || head === "-h") {
    if (rest.length > 0)
      return error("`/recall embedding help` takes no arguments.");
    return { kind: "usage" };
  }

  switch (head) {
    case "status":
      return rest.length === 0
        ? { kind: "status" }
        : error("`/recall embedding status` takes no arguments.");
    case "on":
      return rest.length === 0
        ? { kind: "on" }
        : error("`/recall embedding on` takes no arguments.");
    case "off":
      return rest.length === 0
        ? { kind: "off" }
        : error("`/recall embedding off` takes no arguments.");
    case "setup":
      return rest.length === 0
        ? { kind: "setup" }
        : error("`/recall embedding setup` takes no arguments.");
    case "build": {
      const parsed = parseBuild(rest);
      return parsed;
    }
    case "cancel":
      return rest.length === 0
        ? { kind: "cancel" }
        : error("`/recall embedding cancel` takes no arguments.");
    case "reset":
      return parseReset(rest);
    case "weight": {
      const value = parseEmbeddingRatio(oneValue(rest));
      return value === null
        ? error(
            "`/recall embedding weight` needs a number from 0 to 1: /recall embedding weight 0.5.",
          )
        : {
            kind: "set",
            label: EMBEDDING_KNOB_LABEL.weight ?? "weight",
            updates: { weight: value },
          };
    }
    case "depth":
    case "chunk":
    case "chunk-max":
    case "max-chunks":
    case "threads":
    case "spaces":
    case "chunk-overlap": {
      const value = parseEmbeddingCount(oneValue(rest));
      if (value === null) {
        return error(
          `\`/recall embedding ${head}\` needs a whole number: /recall embedding ${head} <n>.`,
        );
      }
      const label = EMBEDDING_KNOB_LABEL[head] ?? head;
      switch (head) {
        case "depth":
          return { kind: "set", label, updates: { candidateDepth: value } };
        case "chunk":
          return { kind: "set", label, updates: { chunkTarget: value } };
        case "chunk-max":
          return { kind: "set", label, updates: { chunkMax: value } };
        case "chunk-overlap":
          return { kind: "set", label, updates: { chunkOverlap: value } };
        case "max-chunks":
          return {
            kind: "set",
            label,
            updates: { maxChunksPerMessage: value },
          };
        case "threads":
          return { kind: "set", label, updates: { threads: value } };
        default:
          return { kind: "set", label, updates: { keepSpaces: value } };
      }
    }
    case "gpu": {
      const value = oneValue(rest);
      if (value !== "auto" && value !== "off" && value !== "index-only") {
        return error(
          "`/recall embedding gpu` needs one of: auto, off, index-only.",
        );
      }
      return {
        kind: "set",
        label: EMBEDDING_KNOB_LABEL.gpu ?? "gpu",
        updates: { gpu: value },
      };
    }
    case "quant": {
      const value = oneValue(rest);
      if (value !== "float32" && value !== "int8") {
        return error("`/recall embedding quant` needs one of: float32, int8.");
      }
      return {
        kind: "set",
        label: EMBEDDING_KNOB_LABEL.quant ?? "quant",
        updates: { quantization: value },
      };
    }
    default:
      return error(`Unknown embedding command: ${head}.`);
  }
}

// ── Dependencies ────────────────────────────────────────────────────

/** Everything the handler reads; the defaults are the production readers. */
export interface EmbeddingCommandDeps {
  runtime?: EmbeddingRuntimePort | null;
  readSettings?: () => ResolvedEmbeddingSettings;
  writeSettings?: (patch: EmbeddingSettingsPatch) => ResolvedEmbeddingSettings;
  /**
   * The raw stored record, for the "has the user configured this" question.
   * Resolved defaults are not a decision, so this reads the keys, not the
   * resolver (the same distinction `isDreamConfigured` makes).
   */
  readRawSettings?: () => Record<string, unknown>;
  /** Raise the first-run wizard; returns `false` when the shell has none. */
  openSetup?: (commandInput: string) => boolean;
  /** Write the endpoint API key into the secret store (D3). */
  saveApiKey?: (value: string, agentId: string | null) => Promise<unknown>;
  /** Environment for `--recall-embedding-api-key-env`; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Which surface is running this command: the TUI (immediate receipt) or the
   * CLI/headless path (waits for the build's terminal checkpoint). Defaults to
   * `tui`, because the interactive shell is the one place where a long-running
   * build must not block the prompt.
   */
  lifecycle?: "tui" | "headless" | "websocket";
  /**
   * The process-wide recall telemetry (`embedding-metrics`); defaults to the
   * shared recorder, because the turn path and this command live in one
   * process.
   */
  readMetrics?: () => EmbeddingMetricsSnapshot | null;
}

interface ResolvedDeps {
  runtime: EmbeddingRuntimePort | null;
  readSettings: () => ResolvedEmbeddingSettings;
  writeSettings: (patch: EmbeddingSettingsPatch) => ResolvedEmbeddingSettings;
  readRawSettings: () => Record<string, unknown>;
  openSetup: ((commandInput: string) => boolean) | null;
  saveApiKey: (value: string, agentId: string | null) => Promise<unknown>;
  env: Record<string, string | undefined>;
  lifecycle: "tui" | "headless" | "websocket";
  readMetrics: () => EmbeddingMetricsSnapshot | null;
}

function readRawSettingsRecord(): Record<string, unknown> {
  try {
    return settingsManager.getSettings() as unknown as Record<string, unknown>;
  } catch {
    // No settings manager yet: nothing was configured in this process.
    return {};
  }
}

function resolveDeps(deps: EmbeddingCommandDeps): ResolvedDeps {
  return {
    runtime: deps.runtime ?? null,
    readSettings: deps.readSettings ?? readEmbeddingSettings,
    writeSettings: deps.writeSettings ?? updateEmbeddingSettings,
    readRawSettings: deps.readRawSettings ?? readRawSettingsRecord,
    openSetup: deps.openSetup ?? null,
    saveApiKey:
      deps.saveApiKey ??
      ((value, agentId) => saveEmbeddingApiKey(value, agentId ?? undefined)),
    env: deps.env ?? process.env,
    lifecycle: deps.lifecycle ?? "tui",
    // The process-wide recorder is the status face's source by default: the turn
    // path and this command share one process, so a round the turn recorded is
    // exactly what status should show. An injected reader still wins (tests,
    // and a future per-agent recorder).
    readMetrics: deps.readMetrics ?? (() => embeddingMetrics.snapshot()),
  };
}

// ── Configuration questions ─────────────────────────────────────────

/**
 * Whether the user has explicitly chosen a backend (48-1 §7.2).
 *
 * A resolved default is not a decision: only a written `recallEmbedding*` key
 * counts. Without one, `on` opens the wizard instead of enabling an index whose
 * model was never agreed to.
 */
export function isEmbeddingConfigured(
  readRaw: () => Record<string, unknown> = readRawSettingsRecord,
): boolean {
  let raw: Record<string, unknown>;
  try {
    raw = readRaw();
  } catch {
    return false;
  }
  if (raw.recallEmbeddingBackend !== undefined) return true;
  if (typeof raw.recallEmbeddingModel === "string") return true;
  const endpoint = raw.recallEmbeddingEndpoint;
  return endpoint !== undefined && endpoint !== null;
}

/**
 * The copy-paste first-run commands (R-12's non-interactive path).
 *
 * Exported because the headless first-run notice and the `/recall` refusal are
 * the same text: a second copy would drift from the flags `args.ts` accepts.
 */
export function formatEmbeddingFirstRunHint(): string {
  // The setup spelling comes from D3's deep-link table, so the fallback text the
  // settings page prints and this hint cannot drift apart.
  const setupCommand = embeddingSetCommand("recallEmbeddingBackend", "legacy");
  return [
    "Vector recall is not configured yet. Nothing was changed.",
    "",
    "Finish setup in the TUI:",
    `  ${setupCommand}`,
    "",
    "Or configure it from a shell (the API key is read from the named variable,",
    "never passed as a flag):",
    "  haruyuki --recall-embedding on --recall-embedding-backend builtin",
    "  haruyuki --recall-embedding on --recall-embedding-backend endpoint --recall-embedding-endpoint https://api.example.com/v1 --recall-embedding-api-key-env HARUYUKI_EMBEDDING_API_KEY",
    "",
    "Then check it with: haruyuki recall embedding status",
  ].join("\n");
}

// ── Formatting ──────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function endpointLeavesMachine(settings: ResolvedEmbeddingSettings): boolean {
  const endpoint = settings.endpoint;
  if (settings.backend !== "endpoint" || endpoint === null) return false;
  try {
    return !LOOPBACK_HOSTS.has(
      new URL(endpoint.baseUrl).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

function formatEndpoint(settings: ResolvedEmbeddingSettings): string {
  const endpoint = settings.endpoint;
  if (settings.backend !== "endpoint") return `builtin · ${settings.model}`;
  if (endpoint === null) return "endpoint · not configured (run setup)";
  return `${endpoint.kind} · ${endpoint.baseUrl} · ${endpoint.model} · ${endpoint.dimensions}d · key stored separately`;
}

function formatPercent(value: number | null): string {
  return value === null ? "unknown" : `${Math.round(value * 100)}%`;
}

function formatEta(etaMs: number | null): string {
  if (etaMs === null) return "";
  if (etaMs < 60_000) return ` · ETA ${Math.max(1, Math.round(etaMs / 1000))}s`;
  return ` · ETA ${Math.round(etaMs / 60_000)}m`;
}

/** One line naming the effective embedding configuration. */
export function formatEmbeddingSettingsSummary(
  settings: ResolvedEmbeddingSettings,
): string {
  return `backend ${settings.backend} · model ${settings.backend === "endpoint" ? (settings.endpoint?.model ?? "unset") : settings.model} · weight ${settings.weight} · chunk ${settings.chunkTarget}/${settings.chunkMax}/${settings.chunkOverlap} · ${settings.gpu} gpu · ${settings.quantization}`;
}

function formatSpace(space: EmbeddingRuntimeSpace): string {
  const built =
    space.builtAt === null ? "built time unknown" : `built ${space.builtAt}`;
  // Memory units are indexed too, but they are not conversations; the status
  // face lists them separately instead of inflating the conversation total.
  const memory =
    space.memoryFiles === undefined || space.memoryFiles <= 0
      ? ""
      : ` · ${space.memoryFiles} memory files`;
  return `Space: ${space.model} · ${space.dimensions}d · ${space.chunks} chunks · ${space.conversations} conversations${memory} · coverage ${formatPercent(space.coverage)} · ${built}`;
}

function formatBuild(build: EmbeddingRuntimeBuildProgress): string {
  if (build.state === "failed") {
    return `Build: failed — ${build.error ?? "see the embedding log"}`;
  }
  if (build.state === "running" || build.state === "cancelling") {
    return `Build: ${build.state} ${formatPercent(build.progress)} (${build.processedChunks}/${build.totalChunks} chunks${formatEta(build.etaMs)})`;
  }
  if (build.state === "cancelled")
    return "Build: cancelled; finished chunks stay";
  if (build.state === "idle")
    return "Build: idle — run /recall embedding build";
  return `Build: ${build.state}`;
}

function formatCalibration(calibration: EmbeddingRuntimeCalibration): string {
  // A defaults-based record (zeros) is not a measurement; say so instead of
  // "p50 0ms · 0/s" (48-2 R-43's rule, applied to the status face too).
  if (
    !embeddingCalibrationMeasured({
      p50Ms: calibration.queryLatencyP50Ms,
      throughputPerSecond: calibration.throughputPerSecond,
    })
  ) {
    return `Calibration: not measured — the documented default budget is in use (recorded ${calibration.measuredAt}); re-run /recall embedding setup to measure it.`;
  }
  return `Calibration: ${calibration.measuredAt} · p50 ${calibration.queryLatencyP50Ms}ms · p90 ${calibration.queryLatencyP90Ms}ms · ${calibration.throughputPerSecond}/s · ${calibration.gpuRole} gpu · ${calibration.threads} threads · ${calibration.quantization}`;
}

function formatStatus(
  settings: ResolvedEmbeddingSettings,
  configured: boolean,
  runtime: EmbeddingRuntimeStatus | null,
  runtimeNote: "not-wired" | "no-agent" | null,
  metrics: EmbeddingMetricsSnapshot | null,
): string {
  const lines: string[] = [];
  const enabled = settings.enabled ? "on" : "off";
  lines.push(
    configured
      ? `Vector recall: ${enabled}`
      : `Vector recall: ${enabled} — setup is incomplete: run /recall embedding setup`,
  );
  lines.push(`Backend: ${formatEndpoint(settings)}`);
  lines.push(
    `Weight: ${settings.weight} · candidates ${settings.candidateDepth} per arm`,
  );
  lines.push(
    `Chunks: target ${settings.chunkTarget} / max ${settings.chunkMax} / overlap ${settings.chunkOverlap} tokens · cap ${settings.maxChunksPerMessage}/message`,
  );
  lines.push(
    `Encoding: ${settings.gpu} gpu · ${settings.threads === 0 ? "threads auto" : `${settings.threads} threads`} · ${settings.quantization}`,
  );
  lines.push(
    `Egress: ${
      endpointLeavesMachine(settings)
        ? "query text leaves this machine (endpoint)"
        : "query text stays on this machine"
    }`,
  );
  if (runtimeNote === "not-wired") {
    lines.push(`Space: ${RUNTIME_UNAVAILABLE.status}`);
    lines.push(...formatEmbeddingStoredCalibrationLine(settings.calibration));
  } else if (runtimeNote === "no-agent") {
    lines.push(
      "Space: pass --agent <id> to inspect the index (or run this in a session).",
    );
    lines.push(...formatEmbeddingStoredCalibrationLine(settings.calibration));
  } else if (runtime !== null) {
    if (runtime.space !== null) lines.push(formatSpace(runtime.space));
    else lines.push("Space: not built yet — run /recall embedding build");
    if (runtime.build !== null) lines.push(formatBuild(runtime.build));
    else if (runtime.buildSnapshot) {
      lines.push(...formatEmbeddingBuildSnapshotLines(runtime.buildSnapshot));
    } else lines.push("Build: idle — run /recall embedding build");
    if (runtime.calibration !== null) {
      lines.push(formatCalibration(runtime.calibration));
    } else {
      const stored = formatEmbeddingStoredCalibrationLine(settings.calibration);
      lines.push(
        ...(stored.length > 0 ? stored : ["Calibration: not measured yet"]),
      );
    }
    lines.push(
      `Ready: ${runtime.ready ? "yes, queries can use the index" : "no, the next query falls back to lexical recall"}`,
    );
    if (runtime.failure !== null) lines.push(`Failure: ${runtime.failure}`);
  }
  // D6's two-arm counters, after the configuration lines: they answer "did the
  // vector arm do anything" (S-04), which the settings cannot.
  lines.push(...formatEmbeddingMetricsLines(metrics));
  if (!settings.enabled && configured) {
    lines.push("Next: /recall embedding on to enable it.");
  } else if (!configured) {
    lines.push(
      `Next: ${embeddingSetCommand("recallEmbeddingBackend", "legacy")} (or the flags in the usage).`,
    );
  }
  return lines.join("\n");
}

// ── Actions ─────────────────────────────────────────────────────────

function runtimeScope(
  scope: DreamCommandScope | undefined,
): EmbeddingRuntimeScope | null {
  const agentId = scope?.agentId?.trim();
  if (!agentId) return null;
  return { agentId, conversationId: scope?.conversationId ?? null };
}

function runOn(deps: ResolvedDeps): string {
  if (!isEmbeddingConfigured(deps.readRawSettings)) {
    const opened = deps.openSetup?.("/recall embedding setup") ?? false;
    return opened
      ? "Opening the embedding setup wizard. Nothing is written until you finish it."
      : formatEmbeddingFirstRunHint();
  }
  const updated = deps.writeSettings({ enabled: true });
  const lines = [
    "Vector recall is on.",
    `  ${formatEmbeddingSettingsSummary(updated)}`,
  ];
  if (endpointLeavesMachine(updated)) {
    lines.push("  Endpoint queries leave this machine.");
  }
  lines.push(
    "  Build the index with /recall embedding build if it has never run.",
  );
  return lines.join("\n");
}

function runOff(deps: ResolvedDeps): string {
  const updated = deps.writeSettings({ enabled: false });
  return [
    "Vector recall is off.",
    `  ${formatEmbeddingSettingsSummary(updated)}`,
    "Stored vectors stay on disk and are reused when you turn it back on.",
    "Remove them with /recall embedding reset.",
  ].join("\n");
}

async function runStatus(
  scope: DreamCommandScope | undefined,
  deps: ResolvedDeps,
): Promise<string> {
  const settings = deps.readSettings();
  const configured = isEmbeddingConfigured(deps.readRawSettings);
  const runtime = deps.runtime;
  const metrics = deps.readMetrics();
  if (runtime?.readStatus === undefined) {
    return formatStatus(settings, configured, null, "not-wired", metrics);
  }
  const runtimeScopeValue = runtimeScope(scope);
  if (runtimeScopeValue === null) {
    return formatStatus(settings, configured, null, "no-agent", metrics);
  }
  const status = await runtime.readStatus(runtimeScopeValue);
  return formatStatus(settings, configured, status, null, metrics);
}

async function runBuild(
  command: Extract<EmbeddingCommand, { kind: "build" }>,
  scope: DreamCommandScope | undefined,
  deps: ResolvedDeps,
): Promise<string> {
  const runtimeScopeValue = runtimeScope(scope);
  if (runtimeScopeValue === null) return NEEDS_AGENT;
  if (deps.runtime?.build === undefined) return RUNTIME_UNAVAILABLE.build;
  const receipt = await deps.runtime.build(runtimeScopeValue, command.mode, {
    keepAfterExit: command.keepAfterExit,
    lifecycle: deps.lifecycle,
  });
  return deps.readSettings().enabled
    ? receipt
    : `${receipt}\n  Note: vector recall is off; the build is still usable once you turn it on.`;
}

async function runCancel(
  scope: DreamCommandScope | undefined,
  deps: ResolvedDeps,
): Promise<string> {
  const runtimeScopeValue = runtimeScope(scope);
  if (runtimeScopeValue === null) return NEEDS_AGENT;
  if (deps.runtime?.cancel === undefined) return RUNTIME_UNAVAILABLE.cancel;
  return deps.runtime.cancel(runtimeScopeValue);
}

function describeResetTarget(target: EmbeddingResetTarget): string {
  switch (target.kind) {
    case "all":
      return "every stored vector space for this agent";
    case "model":
      return `the stored vector space for model "${target.model}"`;
    default:
      return "the stored vector space for the current model";
  }
}

async function runReset(
  command: Extract<EmbeddingCommand, { kind: "reset" }>,
  scope: DreamCommandScope | undefined,
  deps: ResolvedDeps,
): Promise<string> {
  const runtimeScopeValue = runtimeScope(scope);
  if (runtimeScopeValue === null) return NEEDS_AGENT;
  const target = describeResetTarget(command.target);
  if (!command.confirmed) {
    const commandText =
      command.target.kind === "all"
        ? "/recall embedding reset --all --confirm"
        : command.target.kind === "model"
          ? `/recall embedding reset --model ${command.target.model} --confirm`
          : "/recall embedding reset --confirm";
    return [
      `This deletes ${target} and leaves transcripts, memory files and settings untouched.`,
      "Nothing was deleted. To confirm, run:",
      `  ${commandText}`,
    ].join("\n");
  }
  if (deps.runtime?.reset === undefined) return RUNTIME_UNAVAILABLE.reset;
  return deps.runtime.reset(runtimeScopeValue, command.target);
}

function runSetup(deps: ResolvedDeps): string {
  const opened = deps.openSetup?.("/recall embedding setup") ?? false;
  return opened
    ? "Opening the embedding setup wizard with the current values."
    : formatEmbeddingFirstRunHint();
}

function runSet(
  command: Extract<EmbeddingCommand, { kind: "set" }>,
  deps: ResolvedDeps,
): string {
  let updated: ResolvedEmbeddingSettings;
  try {
    updated = deps.writeSettings(command.updates);
  } catch (caught) {
    if (caught instanceof EmbeddingSettingsError) {
      return `Not saved: ${caught.message}`;
    }
    throw caught;
  }
  const lines = [
    `Updated ${command.label}.`,
    `  ${formatEmbeddingSettingsSummary(updated)}`,
  ];
  if (embeddingPatchInvalidatesSpace(command.updates)) {
    lines.push(
      "  This changes the vector space: run /recall embedding build --full to rebuild it. The current index is untouched until then.",
    );
  }
  return lines.join("\n");
}

/** Run one `/recall embedding` invocation; the reply is the user-facing text. */
export async function handleEmbeddingCommand(
  args: string[],
  scope?: DreamCommandScope,
  deps: EmbeddingCommandDeps = {},
): Promise<string> {
  const command = parseEmbeddingCommand(args);
  if (command.kind === "usage") return EMBEDDING_COMMAND_USAGE;
  if (command.kind === "error") {
    return `${command.message}\n\n${EMBEDDING_COMMAND_USAGE}`;
  }

  const resolved = resolveDeps(deps);
  switch (command.kind) {
    case "on":
      return runOn(resolved);
    case "off":
      return runOff(resolved);
    case "status":
      return runStatus(scope, resolved);
    case "build":
      return runBuild(command, scope, resolved);
    case "cancel":
      return runCancel(scope, resolved);
    case "reset":
      return runReset(command, scope, resolved);
    case "setup":
      return runSetup(resolved);
    case "set":
      return runSet(command, resolved);
  }
}

// ── Non-interactive first-run flags ─────────────────────────────────

/**
 * Apply the `--recall-embedding*` flags parsed by `args.ts`.
 *
 * Called once after settings are loaded, before the first turn. It returns the
 * receipt to print (or `""` when no flag was given); the process exit code stays
 * 0 for a successful write, which is what R-12's non-interactive path requires.
 *
 * Endpoint configuration is *not* written without a test-embed: 48-1 §7.2 only
 * accepts an endpoint after a successful round trip, so the flags hand the
 * probe to the injected runtime and write nothing when it is absent.
 */
export async function applyEmbeddingCliFlags(
  flags: EmbeddingSetupFlags,
  scope?: { agentId?: string | null; conversationId?: string | null },
  deps: EmbeddingCommandDeps = {},
): Promise<string> {
  const resolved = resolveDeps(deps);
  const agentId = scope?.agentId?.trim() || null;
  const asked = Object.values(flags).some((value) => value !== undefined);
  if (!asked) return "";

  // Enabling without a backend choice is first-run setup, not a write.
  if (
    flags.enabled === true &&
    flags.backend === undefined &&
    flags.model === undefined &&
    flags.endpoint === undefined &&
    !isEmbeddingConfigured(resolved.readRawSettings)
  ) {
    return formatEmbeddingFirstRunHint();
  }

  const patch: EmbeddingSettingsPatch = {};
  if (flags.enabled !== undefined) patch.enabled = flags.enabled;
  if (flags.backend !== undefined) patch.backend = flags.backend;
  if (flags.model !== undefined) patch.model = flags.model;

  let endpointApiKey: string | null = null;
  if (flags.endpoint !== undefined) {
    if (resolved.runtime?.configureEndpoint === undefined) {
      return RUNTIME_UNAVAILABLE.endpoint;
    }
    if (flags.apiKeyEnv !== undefined) {
      const value = resolved.env[flags.apiKeyEnv]?.trim();
      if (value === undefined || value === "") {
        return `Environment variable ${flags.apiKeyEnv} is empty; set it before configuring the endpoint. Nothing was written (the key never goes on the command line).`;
      }
      endpointApiKey = value;
    }
    const probe = await resolved.runtime.configureEndpoint({
      agentId,
      baseUrl: flags.endpoint,
      model: flags.model ?? null,
      apiKey: endpointApiKey,
    });
    patch.backend = "endpoint";
    patch.endpoint = {
      kind: probe.kind,
      baseUrl: flags.endpoint,
      model: probe.model ?? flags.model ?? "",
      dimensions: probe.dimensions,
      ...(probe.timeoutMs === undefined ? {} : { timeoutMs: probe.timeoutMs }),
    };
  } else if (
    flags.backend === "endpoint" &&
    resolved.readSettings().endpoint === null
  ) {
    return "The endpoint backend needs an endpoint: add --recall-embedding-endpoint <url> (or run /recall embedding setup). Nothing was written.";
  }

  const validationError = validateEmbeddingSettingsPatch(
    patch,
    resolved.readSettings(),
  );
  if (validationError !== null) {
    return `Not saved: ${validationError}.`;
  }

  try {
    if (endpointApiKey !== null) {
      await resolved.saveApiKey(endpointApiKey, agentId);
    }
    const updated = resolved.writeSettings(patch);
    const lines = [
      "Embedding settings saved.",
      `  ${formatEmbeddingSettingsSummary(updated)}`,
    ];
    if (embeddingPatchInvalidatesSpace(patch)) {
      lines.push(
        "  Run `haruyuki recall embedding build --full` to rebuild the vector space.",
      );
    }
    return lines.join("\n");
  } catch (caught) {
    if (caught instanceof EmbeddingSettingsError) {
      return `Not saved: ${caught.message}`;
    }
    throw caught;
  }
}
