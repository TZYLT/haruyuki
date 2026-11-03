/**
 * Persisted build state (`state.json`) for the embedding index builder (48-2
 * §3.1 A2, 48-1 §6.8).
 *
 * The builder is a long background job, so its progress has to survive the
 * process that runs it: a restart resumes from the per-conversation checkpoints
 * and the status surfaces read this file instead of asking a live runner. The
 * file is a witness and a checkpoint, never the source of truth for the index —
 * every count in it is re-derivable from the per-conversation snapshots, so a
 * damaged file costs a rescan and never correctness.
 *
 * Three rules shape this module:
 *
 * 1. **Atomic writes.** `state.json` is written to a private temporary file and
 *    published with a single `rename`, so a reader never observes a half-written
 *    file and a killed process can only lose the last update (the previous file
 *    stays intact). Writes are not fsynced: the contract here is "no half file",
 *    not power-loss durability of the newest bytes.
 * 2. **Corruption is tolerated, not thrown.** {@link readEmbeddingBuildState}
 *    returns an empty state plus a `status`/`discarded` marker for a missing,
 *    half-written, unparsable or obsolete file instead of throwing — the caller
 *    rebuilds from that marker, it never guesses (48-1 §6.3).
 * 3. **The snapshot is immutable.** Reads return detached copies, and
 *    {@link snapshotEmbeddingBuildState} deep-freezes the projection of every
 *    field a progress/status surface needs, so no consumer can mutate builder
 *    state through it (48-2 §3.1).
 *
 * Rate and ETA are derived here from a small bounded sample window that is
 * persisted with the state, so the estimate survives a restart. Write cadence
 * (throttling) belongs to the caller (A5, 48-2 §3.4); this module only offers
 * read/merge/write.
 *
 * Layer: `backend/local/`. Imports node builtins plus the leaf type module
 * `@/types/embedding-protocol`; no `cli/`, `websocket/`, `reminders/` or
 * `agent/` import.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EmbeddingBuildMode,
  EmbeddingBuildState as EmbeddingBuildPhase,
} from "@/types/embedding-protocol";

/** Bumped whenever the persisted shape changes incompatibly; readers discard. */
export const EMBEDDING_BUILD_STATE_SCHEMA_VERSION = 1;

/** File name of the state checkpoint inside one space directory. */
export const EMBEDDING_BUILD_STATE_FILE_NAME = "state.json";

/**
 * Rolling window used for the chunk rate / ETA estimate. The window is kept
 * short on purpose: the builder's throughput changes with batch mix, so a
 * minute of history already makes the estimate lag behind a slow-down.
 */
export const EMBEDDING_BUILD_RATE_WINDOW_MS = 30_000;

/** Upper bound on persisted rate samples; a corrupt/hostile file cannot bloat. */
export const EMBEDDING_BUILD_MAX_RATE_SAMPLES = 24;

/** Failed conversations are listed for the status surface; the list is bounded. */
export const EMBEDDING_BUILD_MAX_FAILURES = 100;

/** One (agentId, spaceId) pair owns exactly one state file. */
export interface EmbeddingBuildIdentity {
  agentId: string;
  spaceId: string;
}

/** A conversation skipped by the builder; `/recall status` lists these (48-1 §6.9). */
export interface EmbeddingBuildFailure {
  conversationId: string;
  /** Stable, machine-readable reason code (e.g. `embed_failed`, `too_large`). */
  code: string;
  /** Human-readable detail; must already be redacted of credentials by callers. */
  message?: string;
  /** Clock time the failure was recorded. */
  at: number;
}

/** One rate sample: chunks embedded at a moment in time. */
export interface EmbeddingBuildRateSample {
  at: number;
  embeddedChunks: number;
}

/** Progress counters as persisted. `embeddedChunks <= totalChunks` is not forced. */
export interface EmbeddingBuildProgressCounters {
  embeddedChunks: number;
  totalChunks: number;
  processedConversations: number;
  totalConversations: number;
}

/** Coverage of the recallable corpus (48-1 §6.2: `embeddedChars / recallableChars`). */
export interface EmbeddingBuildCoverage {
  embeddedChars: number;
  recallableChars: number;
}

/**
 * The persisted shape of `state.json`.
 *
 * `phase` reuses the app-server protocol's `EmbeddingBuildState` union so the
 * runner, the checkpoint and the status projection speak one vocabulary.
 */
export interface EmbeddingBuildStateRecord {
  schemaVersion: number;
  agentId: string;
  spaceId: string;
  buildId: string | null;
  mode: EmbeddingBuildMode;
  phase: EmbeddingBuildPhase;
  progress: EmbeddingBuildProgressCounters;
  coverage: EmbeddingBuildCoverage;
  failures: EmbeddingBuildFailure[];
  rateSamples: EmbeddingBuildRateSample[];
  /** First time a build entered `running`; `null` while idle. */
  startedAt: number | null;
  /** Set when the build reached a terminal phase. */
  finishedAt: number | null;
  /** Clock time of the last merge/write; `lastUpdated` in 48-2 §3.1 terms. */
  updatedAt: number;
}

export type EmbeddingBuildStateReadStatus =
  | "ok"
  | "missing"
  | "corrupt"
  | "unsupported_schema";

export interface EmbeddingBuildStateReadResult {
  /** The parsed state, or a fresh empty state when the file was unusable. */
  state: EmbeddingBuildStateRecord;
  status: EmbeddingBuildStateReadStatus;
  /** True when an existing file was thrown away (corrupt or obsolete schema). */
  discarded: boolean;
  /** Why a file was discarded; never contains the file's raw content. */
  detail?: string;
}

/** Derived rate as the status surface renders it; `null` until two samples. */
export interface EmbeddingBuildRateSnapshot {
  chunksPerSecond: number | null;
  /** Time actually spanned by the samples used, not the configured window. */
  windowMs: number;
  sampleCount: number;
}

/** Derived ETA; `remainingMs` is `null` when no rate is known yet. */
export interface EmbeddingBuildEtaSnapshot {
  remainingChunks: number;
  remainingMs: number | null;
}

export interface EmbeddingBuildProgressSnapshot {
  embeddedChunks: number;
  totalChunks: number;
  processedConversations: number;
  totalConversations: number;
  remainingChunks: number;
  /** 0..1, or `null` while the total is unknown (not started/scanned). */
  fraction: number | null;
}

export interface EmbeddingBuildCoverageSnapshot {
  embeddedChars: number;
  recallableChars: number;
  /** 0..1, or `null` when nothing recallable was discovered. */
  ratio: number | null;
}

/**
 * The read-only projection a status bar / `onProgress` consumes in one pass
 * (48-2 §3.1). Deep-frozen: consumers may keep it, never mutate it.
 */
export interface EmbeddingBuildStateSnapshot {
  schemaVersion: number;
  agentId: string;
  spaceId: string;
  buildId: string | null;
  mode: EmbeddingBuildMode;
  phase: EmbeddingBuildPhase;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: EmbeddingBuildProgressSnapshot;
  coverage: EmbeddingBuildCoverageSnapshot;
  rate: EmbeddingBuildRateSnapshot;
  eta: EmbeddingBuildEtaSnapshot;
  failures: readonly EmbeddingBuildFailure[];
}

/** Absolute path of `state.json` for one space directory. */
export function embeddingBuildStatePath(spaceDir: string): string {
  return join(spaceDir, EMBEDDING_BUILD_STATE_FILE_NAME);
}

/** A fresh, empty state for `identity` (idle, zero progress, no samples). */
export function createEmptyEmbeddingBuildState(
  identity: EmbeddingBuildIdentity,
  options?: {
    clock?: () => number;
    buildId?: string | null;
    mode?: EmbeddingBuildMode;
  },
): EmbeddingBuildStateRecord {
  const now = clockOf(options?.clock)();
  return {
    schemaVersion: EMBEDDING_BUILD_STATE_SCHEMA_VERSION,
    agentId: identity.agentId,
    spaceId: identity.spaceId,
    buildId: options?.buildId ?? null,
    mode: options?.mode ?? "incremental",
    phase: "idle",
    progress: emptyProgress(),
    coverage: emptyCoverage(),
    failures: [],
    rateSamples: [],
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
}

export interface EmbeddingBuildStateReadOptions extends EmbeddingBuildIdentity {
  clock?: () => number;
}

/**
 * Read `state.json` without ever throwing on bad content.
 *
 * Missing → `missing`; unreadable/partial/unparsable/foreign-identity → `corrupt`;
 * an incompatible `schemaVersion` → `unsupported_schema`. All three unusable
 * cases return a fresh empty state (with the caller's identity) and set
 * `discarded` when a file existed, which is the "rebuild, do not guess" signal
 * from 48-1 §6.3.
 */
export async function readEmbeddingBuildState(
  statePath: string,
  options: EmbeddingBuildStateReadOptions,
): Promise<EmbeddingBuildStateReadResult> {
  const emptyState = createEmptyEmbeddingBuildState(options, {
    clock: options.clock,
  });

  let raw: string;
  try {
    raw = await readFile(statePath, "utf-8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { state: emptyState, status: "missing", discarded: false };
    }
    return {
      state: emptyState,
      status: "corrupt",
      discarded: true,
      detail: `state file could not be read (${errorCode(error) ?? "unknown error"})`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: emptyState,
      status: "corrupt",
      discarded: true,
      detail: "state file is not valid JSON (partial write or external damage)",
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      state: emptyState,
      status: "corrupt",
      discarded: true,
      detail: "state file root is not a JSON object",
    };
  }

  const version = parsed.schemaVersion;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return {
      state: emptyState,
      status: "corrupt",
      discarded: true,
      detail: "state file has no numeric schemaVersion",
    };
  }
  if (version !== EMBEDDING_BUILD_STATE_SCHEMA_VERSION) {
    return {
      state: emptyState,
      status: "unsupported_schema",
      discarded: true,
      detail: `schemaVersion ${version} is not supported (expected ${EMBEDDING_BUILD_STATE_SCHEMA_VERSION})`,
    };
  }

  const parsedState = parseEmbeddingBuildStateRecord(parsed);
  if (!parsedState.ok) {
    return {
      state: emptyState,
      status: "corrupt",
      discarded: true,
      detail: parsedState.detail,
    };
  }
  if (
    parsedState.state.agentId !== options.agentId ||
    parsedState.state.spaceId !== options.spaceId
  ) {
    return {
      state: emptyState,
      status: "corrupt",
      discarded: true,
      detail: "state file belongs to a different (agentId, spaceId)",
    };
  }
  return { state: parsedState.state, status: "ok", discarded: false };
}

/** Progress update accepted by {@link mergeEmbeddingBuildProgress}. */
export interface EmbeddingBuildProgressUpdate {
  buildId?: string | null;
  mode?: EmbeddingBuildMode;
  phase?: EmbeddingBuildPhase;
  embeddedChunks?: number;
  totalChunks?: number;
  processedConversations?: number;
  totalConversations?: number;
  embeddedChars?: number;
  recallableChars?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  /** Appended to the failure list (which is bounded by max failures). */
  failure?: Omit<EmbeddingBuildFailure, "at">;
}

export interface EmbeddingBuildMergeOptions {
  clock?: () => number;
  /** Only used to prune samples; exposed so tests can shrink the window. */
  rateWindowMs?: number;
}

/**
 * Merge a progress patch into `state` and return a new record (the input is not
 * mutated). Safe to call repeatedly: counter fields are absolute values, the
 * failure list appends, and one rate sample is taken per call that reports
 * `embeddedChunks`.
 */
export function mergeEmbeddingBuildProgress(
  state: EmbeddingBuildStateRecord,
  update: EmbeddingBuildProgressUpdate,
  options?: EmbeddingBuildMergeOptions,
): EmbeddingBuildStateRecord {
  const now = clockOf(options?.clock)();
  const rateWindowMs = options?.rateWindowMs ?? EMBEDDING_BUILD_RATE_WINDOW_MS;

  const progress: EmbeddingBuildProgressCounters = {
    embeddedChunks: sanitizeCount(
      update.embeddedChunks,
      state.progress.embeddedChunks,
    ),
    totalChunks: sanitizeCount(update.totalChunks, state.progress.totalChunks),
    processedConversations: sanitizeCount(
      update.processedConversations,
      state.progress.processedConversations,
    ),
    totalConversations: sanitizeCount(
      update.totalConversations,
      state.progress.totalConversations,
    ),
  };
  const coverage: EmbeddingBuildCoverage = {
    embeddedChars: sanitizeCount(
      update.embeddedChars,
      state.coverage.embeddedChars,
    ),
    recallableChars: sanitizeCount(
      update.recallableChars,
      state.coverage.recallableChars,
    ),
  };

  const phase = update.phase ?? state.phase;
  let startedAt =
    update.startedAt !== undefined ? update.startedAt : state.startedAt;
  let finishedAt =
    update.finishedAt !== undefined ? update.finishedAt : state.finishedAt;
  if (update.phase !== undefined) {
    if (update.phase === "running" && startedAt === null) startedAt = now;
    if (isTerminalBuildPhase(update.phase)) {
      if (finishedAt === null) finishedAt = now;
    } else if (update.phase === "running" || update.phase === "cancelling") {
      finishedAt = null;
    }
  }

  let failures = state.failures;
  if (update.failure) {
    const failure: EmbeddingBuildFailure = {
      conversationId: update.failure.conversationId,
      code: update.failure.code,
      ...(update.failure.message !== undefined
        ? { message: update.failure.message }
        : {}),
      at: now,
    };
    failures = [...state.failures, failure];
    if (failures.length > EMBEDDING_BUILD_MAX_FAILURES) {
      failures = failures.slice(failures.length - EMBEDDING_BUILD_MAX_FAILURES);
    }
  }

  const rateSamples =
    update.embeddedChunks !== undefined
      ? appendRateSample(
          state.rateSamples,
          { at: now, embeddedChunks: progress.embeddedChunks },
          rateWindowMs,
        )
      : state.rateSamples;

  return {
    schemaVersion: EMBEDDING_BUILD_STATE_SCHEMA_VERSION,
    agentId: state.agentId,
    spaceId: state.spaceId,
    buildId: update.buildId !== undefined ? update.buildId : state.buildId,
    mode: update.mode ?? state.mode,
    phase,
    progress,
    coverage,
    failures,
    rateSamples,
    startedAt,
    finishedAt,
    updatedAt: now,
  };
}

/**
 * Atomically persist `state` (temp file + single `rename`). Parent directories
 * are created on demand; the written record is normalized so counters are
 * finite non-negative integers and the bounded lists stay bounded.
 */
export async function writeEmbeddingBuildState(
  statePath: string,
  state: EmbeddingBuildStateRecord,
): Promise<void> {
  const content = `${JSON.stringify(normalizeUnboundedLists(state))}\n`;
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf-8");
    await rename(temporaryPath, statePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export interface EmbeddingBuildStateUpdateResult {
  /** The merged state that was written. */
  state: EmbeddingBuildStateRecord;
  /** Read status of the file *before* this update (useful for recovery logs). */
  readStatus: EmbeddingBuildStateReadStatus;
  /** True when a corrupt/obsolete file was discarded and rebuilt by this call. */
  recovered: boolean;
}

/**
 * Read → merge → write in one call, with the recovery signal attached. The
 * caller still owns write throttling (A5); this is the convenient path for a
 * progress tick that wants to persist immediately.
 */
export async function updateEmbeddingBuildState(
  statePath: string,
  options: EmbeddingBuildStateReadOptions,
  update: EmbeddingBuildProgressUpdate,
  mergeOptions?: EmbeddingBuildMergeOptions,
): Promise<EmbeddingBuildStateUpdateResult> {
  const read = await readEmbeddingBuildState(statePath, options);
  const merged = mergeEmbeddingBuildProgress(read.state, update, {
    clock: mergeOptions?.clock ?? options.clock,
    ...(mergeOptions?.rateWindowMs !== undefined
      ? { rateWindowMs: mergeOptions.rateWindowMs }
      : {}),
  });
  await writeEmbeddingBuildState(statePath, merged);
  return {
    state: merged,
    readStatus: read.status,
    recovered:
      read.status === "corrupt" || read.status === "unsupported_schema",
  };
}

/**
 * Build the frozen projection a progress/status surface consumes. Rate and ETA
 * use the persisted sample window; no clock is read here, so the same state
 * always yields the same snapshot (deterministic for tests and for a
 * write-throttled reader).
 */
export function snapshotEmbeddingBuildState(
  state: EmbeddingBuildStateRecord,
): EmbeddingBuildStateSnapshot {
  const remainingChunks = Math.max(
    0,
    state.progress.totalChunks - state.progress.embeddedChunks,
  );
  const rate = computeRateSnapshot(state.rateSamples);
  const eta: EmbeddingBuildEtaSnapshot = {
    remainingChunks,
    remainingMs:
      remainingChunks === 0
        ? 0
        : rate.chunksPerSecond === null
          ? null
          : computeEtaMs(remainingChunks, rate.chunksPerSecond),
  };
  const progress: EmbeddingBuildProgressSnapshot = {
    embeddedChunks: state.progress.embeddedChunks,
    totalChunks: state.progress.totalChunks,
    processedConversations: state.progress.processedConversations,
    totalConversations: state.progress.totalConversations,
    remainingChunks,
    fraction: ratio(state.progress.embeddedChunks, state.progress.totalChunks),
  };
  const coverage: EmbeddingBuildCoverageSnapshot = {
    embeddedChars: state.coverage.embeddedChars,
    recallableChars: state.coverage.recallableChars,
    ratio: ratio(state.coverage.embeddedChars, state.coverage.recallableChars),
  };
  const failures: readonly EmbeddingBuildFailure[] = Object.freeze(
    state.failures.map((failure) => Object.freeze({ ...failure })),
  );
  return Object.freeze({
    schemaVersion: state.schemaVersion,
    agentId: state.agentId,
    spaceId: state.spaceId,
    buildId: state.buildId,
    mode: state.mode,
    phase: state.phase,
    updatedAt: state.updatedAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    progress: Object.freeze(progress),
    coverage: Object.freeze(coverage),
    rate: Object.freeze(rate),
    eta: Object.freeze(eta),
    failures,
  });
}

/** Is this phase terminal (no further progress expected for the build)? */
export function isTerminalBuildPhase(phase: EmbeddingBuildPhase): boolean {
  return phase === "completed" || phase === "cancelled" || phase === "failed";
}

function emptyProgress(): EmbeddingBuildProgressCounters {
  return {
    embeddedChunks: 0,
    totalChunks: 0,
    processedConversations: 0,
    totalConversations: 0,
  };
}

function emptyCoverage(): EmbeddingBuildCoverage {
  return { embeddedChars: 0, recallableChars: 0 };
}

type ParsedState =
  | { ok: true; state: EmbeddingBuildStateRecord }
  | { ok: false; detail: string };

/**
 * Structural validation of a parsed `state.json`. Optional fields get defaults;
 * anything that would silently misreport progress (non-numeric counters, an
 * unknown phase, a non-record progress block) is `corrupt` instead.
 */
function parseEmbeddingBuildStateRecord(value: unknown): ParsedState {
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.agentId)) {
    return { ok: false, detail: "state file has no agentId" };
  }
  if (!isNonEmptyString(record.spaceId)) {
    return { ok: false, detail: "state file has no spaceId" };
  }
  if (!isBuildPhase(record.phase)) {
    return { ok: false, detail: "state file has an unknown phase" };
  }
  const progress = parseProgressCounters(record.progress);
  if (!progress) {
    return { ok: false, detail: "state file has invalid progress counters" };
  }
  const coverage = parseCoverage(record.coverage);
  if (!coverage) {
    return { ok: false, detail: "state file has invalid coverage counters" };
  }
  const failures = parseFailures(record.failures);
  if (!failures) {
    return { ok: false, detail: "state file has an invalid failures list" };
  }
  const rateSamples = parseRateSamples(record.rateSamples);
  if (!rateSamples) {
    return { ok: false, detail: "state file has an invalid rate sample list" };
  }
  return {
    ok: true,
    state: {
      schemaVersion: EMBEDDING_BUILD_STATE_SCHEMA_VERSION,
      agentId: record.agentId,
      spaceId: record.spaceId,
      buildId: isNonEmptyString(record.buildId) ? record.buildId : null,
      mode: record.mode === "full" ? "full" : "incremental",
      phase: record.phase,
      progress,
      coverage,
      failures,
      rateSamples,
      startedAt: finiteNumberOrNull(record.startedAt),
      finishedAt: finiteNumberOrNull(record.finishedAt),
      updatedAt:
        typeof record.updatedAt === "number" &&
        Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : 0,
    },
  };
}

function parseProgressCounters(
  value: unknown,
): EmbeddingBuildProgressCounters | null {
  if (!isPlainObject(value)) return null;
  const embeddedChunks = finiteNumber(value.embeddedChunks);
  const totalChunks = finiteNumber(value.totalChunks);
  const processedConversations = finiteNumber(value.processedConversations);
  const totalConversations = finiteNumber(value.totalConversations);
  if (
    embeddedChunks === null ||
    totalChunks === null ||
    processedConversations === null ||
    totalConversations === null
  ) {
    return null;
  }
  return {
    embeddedChunks: Math.max(0, Math.floor(embeddedChunks)),
    totalChunks: Math.max(0, Math.floor(totalChunks)),
    processedConversations: Math.max(0, Math.floor(processedConversations)),
    totalConversations: Math.max(0, Math.floor(totalConversations)),
  };
}

function parseCoverage(value: unknown): EmbeddingBuildCoverage | null {
  if (value === undefined) return emptyCoverage();
  if (!isPlainObject(value)) return null;
  const embeddedChars = finiteNumber(value.embeddedChars);
  const recallableChars = finiteNumber(value.recallableChars);
  if (embeddedChars === null || recallableChars === null) return null;
  return {
    embeddedChars: Math.max(0, Math.floor(embeddedChars)),
    recallableChars: Math.max(0, Math.floor(recallableChars)),
  };
}

function parseFailures(value: unknown): EmbeddingBuildFailure[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const failures: EmbeddingBuildFailure[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    if (!isNonEmptyString(entry.conversationId)) return null;
    if (!isNonEmptyString(entry.code)) return null;
    const at = finiteNumber(entry.at);
    if (at === null) return null;
    failures.push({
      conversationId: entry.conversationId,
      code: entry.code,
      ...(isNonEmptyString(entry.message) ? { message: entry.message } : {}),
      at,
    });
  }
  return failures.length > EMBEDDING_BUILD_MAX_FAILURES
    ? failures.slice(failures.length - EMBEDDING_BUILD_MAX_FAILURES)
    : failures;
}

function parseRateSamples(value: unknown): EmbeddingBuildRateSample[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const samples: EmbeddingBuildRateSample[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    const at = finiteNumber(entry.at);
    const embeddedChunks = finiteNumber(entry.embeddedChunks);
    if (at === null || embeddedChunks === null) return null;
    samples.push({
      at,
      embeddedChunks: Math.max(0, Math.floor(embeddedChunks)),
    });
  }
  return samples.length > EMBEDDING_BUILD_MAX_RATE_SAMPLES
    ? samples.slice(samples.length - EMBEDDING_BUILD_MAX_RATE_SAMPLES)
    : samples;
}

/** Bound the persisted lists again right before a write. */
function normalizeUnboundedLists(
  state: EmbeddingBuildStateRecord,
): EmbeddingBuildStateRecord {
  const failures =
    state.failures.length > EMBEDDING_BUILD_MAX_FAILURES
      ? state.failures.slice(
          state.failures.length - EMBEDDING_BUILD_MAX_FAILURES,
        )
      : state.failures;
  const rateSamples =
    state.rateSamples.length > EMBEDDING_BUILD_MAX_RATE_SAMPLES
      ? state.rateSamples.slice(
          state.rateSamples.length - EMBEDDING_BUILD_MAX_RATE_SAMPLES,
        )
      : state.rateSamples;
  return {
    ...state,
    schemaVersion: EMBEDDING_BUILD_STATE_SCHEMA_VERSION,
    progress: {
      embeddedChunks: sanitizeCount(state.progress.embeddedChunks, 0),
      totalChunks: sanitizeCount(state.progress.totalChunks, 0),
      processedConversations: sanitizeCount(
        state.progress.processedConversations,
        0,
      ),
      totalConversations: sanitizeCount(state.progress.totalConversations, 0),
    },
    coverage: {
      embeddedChars: sanitizeCount(state.coverage.embeddedChars, 0),
      recallableChars: sanitizeCount(state.coverage.recallableChars, 0),
    },
    failures,
    rateSamples,
  };
}

/**
 * Append a sample and keep the window useful: samples inside the window, plus
 * the newest sample just outside it as a baseline, so a build that ticks slower
 * than the window still yields a rate. Bounded to the sample cap.
 */
function appendRateSample(
  samples: readonly EmbeddingBuildRateSample[],
  sample: EmbeddingBuildRateSample,
  windowMs: number,
): EmbeddingBuildRateSample[] {
  const last = samples.at(-1);
  const appended =
    last && last.at === sample.at
      ? [...samples.slice(0, -1), sample]
      : [...samples, sample];
  const cutoff = sample.at - windowMs;
  const within = appended.filter((entry) => entry.at >= cutoff);
  const outside = appended.filter((entry) => entry.at < cutoff);
  const baseline = outside.at(-1);
  const kept = baseline ? [baseline, ...within] : within;
  return kept.length > EMBEDDING_BUILD_MAX_RATE_SAMPLES
    ? kept.slice(kept.length - EMBEDDING_BUILD_MAX_RATE_SAMPLES)
    : kept;
}

function computeRateSnapshot(
  samples: readonly EmbeddingBuildRateSample[],
): EmbeddingBuildRateSnapshot {
  const first = samples.at(0);
  const last = samples.at(-1);
  if (!first || !last) {
    return { chunksPerSecond: null, windowMs: 0, sampleCount: samples.length };
  }
  const windowMs = last.at - first.at;
  if (windowMs <= 0 || last.embeddedChunks < first.embeddedChunks) {
    return { chunksPerSecond: null, windowMs: 0, sampleCount: samples.length };
  }
  return {
    chunksPerSecond:
      (last.embeddedChunks - first.embeddedChunks) / (windowMs / 1000),
    windowMs,
    sampleCount: samples.length,
  };
}

function computeEtaMs(
  remainingChunks: number,
  chunksPerSecond: number,
): number {
  if (remainingChunks <= 0 || chunksPerSecond <= 0) return 0;
  return Math.ceil((remainingChunks / chunksPerSecond) * 1000);
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.min(1, Math.max(0, numerator / denominator));
}

function clockOf(clock: (() => number) | undefined): () => number {
  return clock ?? Date.now;
}

function sanitizeCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return finiteNumber(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuildPhase(value: unknown): value is EmbeddingBuildPhase {
  return (
    value === "idle" ||
    value === "running" ||
    value === "cancelling" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "failed"
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

function errorCode(error: unknown): string | undefined {
  const captured = (error as NodeJS.ErrnoException | null)?.code;
  return typeof captured === "string" ? captured : undefined;
}
