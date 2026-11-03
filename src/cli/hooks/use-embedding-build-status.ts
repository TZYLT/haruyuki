/**
 * Live build-status projection for the embedding index (48-2 §3.1 A5, §4.9).
 *
 * Three readers share one projection so the TUI line, `device_status.embedding`
 * and any later `/recall status` row cannot disagree:
 *
 * 1. {@link readEmbeddingBuildStatusSnapshot} — synchronous and cached. This is
 *    what a synchronous protocol projection (D2's `device_status` summary) can
 *    call on the hot path: it never awaits I/O, and it refreshes in the
 *    background at most once per {@link EMBEDDING_BUILD_STATUS_THROTTLE_MS}.
 * 2. {@link refreshEmbeddingBuildStatus} — the once-per-tick read that merges
 *    A4's in-process host state with A2's persisted `state.json` and fills the
 *    cache.
 * 3. {@link useEmbeddingBuildStatus} — the React loop. One 2 s interval, a JSON
 *    comparison before `setState`, and a cancelled flag on unmount: an unchanged
 *    reading never repaints a frame (`src/cli/AGENTS.md` flicker rules), and the
 *    interval is the only timer this module starts.
 *
 * Progress arrives from two places and both are **merged into the 2 s
 * cadence**, never painted per event: A4's `onProgress` callback (pass
 * {@link noteEmbeddingBuildProgress} as the host's `onProgress`) records the
 * newest snapshot in a pending slot, and the interval/provider read promotes it
 * once the throttle window opens. `state.json` is the cross-process source, so
 * a detached child's writes are picked up by polling rather than by a second
 * timer (48-2 §4.9: `device_status.embedding` is fed, not re-broadcast).
 *
 * Space selection: state lives at `<recall root>/<agentId>/<spaceId>/state.json`
 * (48-1 §6.3) and more than one model space may exist, so the reader prefers
 * A4's active space, then an explicit `spaceId`, then the most recently updated
 * space directory for that agent (rescanned at most once per
 * {@link EMBEDDING_BUILD_STATUS_SPACE_RESCAN_MS}).
 *
 * No network, no ONNX, no worker: everything below is file reads, in-process
 * host state and settings. Layer `cli/hooks/`; imports lower layers only.
 */

import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { useEffect, useRef, useState } from "react";

import {
  createEmptyEmbeddingBuildState,
  EMBEDDING_BUILD_STATE_FILE_NAME,
  type EmbeddingBuildFailure,
  type EmbeddingBuildStateReadResult,
  type EmbeddingBuildStateReadStatus,
  type EmbeddingBuildStateSnapshot,
  embeddingBuildStatePath,
  readEmbeddingBuildState,
  snapshotEmbeddingBuildState,
} from "@/backend/local/embedding-build-state";
import { getRecallVectorsRoot } from "@/backend/local/embedding-format";
import { EMBEDDING_LEASE_FILE_NAME } from "@/backend/local/embedding-lease";
import { EMBEDDING_BUILD_LOCK_FILE_NAME } from "@/backend/local/embedding-lock";
import type { EmbeddingProductStatusSnapshot } from "@/cli/display/product-status/embedding";
import {
  type EmbeddingBuildHostPhase,
  type EmbeddingBuildHostState,
  getEmbeddingBuildHostState,
} from "@/cli/helpers/embedding-build-host";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import {
  type EmbeddingMetricsSnapshot,
  embeddingMetrics,
} from "@/reminders/embedding-metrics";
import type { EmbeddingBuildState } from "@/types/embedding-protocol";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";

/**
 * Minimum gap between two published snapshots. The requirement is ≤0.5 Hz
 * (48-1 §7.4/§4.9), so 2 s is both the hook's poll interval and the throttle
 * the pending-progress merge honours.
 */
export const EMBEDDING_BUILD_STATUS_THROTTLE_MS = 2_000;

/**
 * How long a terminal phase stays projected after it finished. A finished or
 * failed build must be visible on the status surface (S-04: "no hit" and "not
 * working" must differ) but must not occupy the line forever; after the window
 * the projection returns `null` and an idle feature takes no row (48-1 §7.4).
 */
export const EMBEDDING_BUILD_STATUS_TERMINAL_RETENTION_MS = 300_000;

/** Upper bound on directory rescans for the active space of one agent. */
export const EMBEDDING_BUILD_STATUS_SPACE_RESCAN_MS = 10_000;

/** Same segment rule A4's host, A3's runner and B2's writer apply. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Injectable environment for one read; every field defaults to production. */
export interface EmbeddingBuildStatusReadOptions {
  /** Active space id; omitted = infer from A4/disk. */
  spaceId?: string;
  /** Active space directory; wins over `spaceId` (diagnostics/tests). */
  spaceDir?: string;
  /** Recall-vectors root; defaults to the call-time harness resolver. */
  root?: string;
  clock?: () => number;
  /** Resolved settings; defaults to the global settings record. */
  settings?: ResolvedEmbeddingSettings;
  /** Metrics window; defaults to the process-wide recorder. */
  metrics?: EmbeddingMetricsSnapshot;
  /** A4 host-state reader; defaults to the process host. */
  readHostState?: () => EmbeddingBuildHostState;
  /** A2 state reader; defaults to the real `state.json` reader. */
  readState?: typeof readEmbeddingBuildState;
}

/**
 * The D6 product-status shape plus the A5 bookkeeping a protocol consumer
 * needs. A superset is assignable to `EmbeddingProductStatusSnapshot`, so the
 * same value can drive `EmbeddingStatusRow`'s `readSnapshot` prop.
 */
export interface EmbeddingBuildStatusSnapshot
  extends EmbeddingProductStatusSnapshot {
  agentId: string;
  spaceId: string;
  spaceDir: string;
  /** A4's host phase, including its host-only `detached`; `null` without a host. */
  hostPhase: EmbeddingBuildHostPhase | null;
  /** True while a builder is alive (A4 host running/cancelling/detached or A2 running/cancelling). */
  working: boolean;
  /** Newest A2 checkpoint time, for status surfaces. */
  updatedAt: number;
  /** Bounded failure list (A2 caps it), newest last. */
  failures: readonly EmbeddingBuildFailure[];
  /** What the `state.json` read said; `missing` is normal before the first build. */
  readStatus: EmbeddingBuildStateReadStatus;
}

interface CachedStatus {
  snapshot: EmbeddingBuildStatusSnapshot | null;
  refreshedAt: number;
  inflight: Promise<EmbeddingBuildStatusSnapshot | null> | null;
  lastError: string | null;
}

interface CachedSpace {
  spaceDir: string | null;
  spaceId: string | null;
  at: number;
}

const statusByAgent = new Map<string, CachedStatus>();
const pendingProgress = new Map<string, EmbeddingBuildStateSnapshot>();
const lastPublishAt = new Map<string, number>();
const spaceByAgent = new Map<string, CachedSpace>();

function clockOf(
  options: EmbeddingBuildStatusReadOptions | undefined,
): () => number {
  return options?.clock ?? Date.now;
}

function readHost(
  options: EmbeddingBuildStatusReadOptions | undefined,
): EmbeddingBuildHostState {
  return (options?.readHostState ?? getEmbeddingBuildHostState)();
}

function hostForAgent(
  host: EmbeddingBuildHostState,
  agentId: string,
): EmbeddingBuildHostState | null {
  return host.identity !== null && host.identity.agentId === agentId
    ? host
    : null;
}

function isActiveHostPhase(phase: EmbeddingBuildHostPhase): boolean {
  return phase === "running" || phase === "cancelling" || phase === "detached";
}

function isTerminalBuildState(state: EmbeddingBuildState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

function hostPhaseAsBuildState(
  phase: EmbeddingBuildHostPhase,
): EmbeddingBuildState {
  // A4's host-only `detached` means "a child owns this build", which from the
  // outside is indistinguishable from a local run in progress.
  return phase === "detached" ? "running" : phase;
}

function failureText(
  failures: readonly EmbeddingBuildFailure[],
): string | null {
  const last = failures.at(-1);
  if (last === undefined) return null;
  return last.message === undefined
    ? last.code
    : `${last.code}: ${last.message}`;
}

interface ProjectionInput {
  agentId: string;
  spaceId: string;
  spaceDir: string;
  settings: ResolvedEmbeddingSettings;
  host: EmbeddingBuildHostState | null;
  source: EmbeddingBuildStateSnapshot;
  readStatus: EmbeddingBuildStateReadStatus;
  metrics: EmbeddingMetricsSnapshot;
  now: number;
}

/**
 * Turn one A2/A4 snapshot into the status-surface shape, or `null` when there
 * is nothing to show (feature disabled, idle, or a terminal build older than
 * the retention window).
 */
function projectStatus(
  input: ProjectionInput,
): EmbeddingBuildStatusSnapshot | null {
  const activeHostPhase =
    input.host !== null && isActiveHostPhase(input.host.phase)
      ? input.host.phase
      : null;
  const buildState =
    activeHostPhase !== null
      ? hostPhaseAsBuildState(activeHostPhase)
      : input.source.phase;
  const working =
    activeHostPhase !== null ||
    input.source.phase === "running" ||
    input.source.phase === "cancelling";

  if (!working) {
    if (!isTerminalBuildState(buildState)) return null;
    const finishedAt =
      input.source.finishedAt ??
      input.host?.finishedAt ??
      input.source.updatedAt;
    if (input.now - finishedAt > EMBEDDING_BUILD_STATUS_TERMINAL_RETENTION_MS) {
      return null;
    }
  }

  const last = input.metrics.last;
  const model =
    input.settings.backend === "endpoint"
      ? (input.settings.endpoint?.model ?? null)
      : input.settings.model;
  const failure =
    buildState === "failed"
      ? (input.host?.error?.message ?? failureText(input.source.failures))
      : null;

  return {
    enabled: true,
    backend: input.settings.backend,
    model,
    build: {
      state: buildState,
      progress: input.source.progress.fraction,
      processedChunks: input.source.progress.embeddedChunks,
      totalChunks: input.source.progress.totalChunks,
      etaMs: input.source.eta.remainingMs,
      error: failure,
    } as EmbeddingProductStatusSnapshot["build"],
    coverage: input.source.coverage.ratio,
    arms:
      last === null
        ? null
        : {
            lexical: last.lexical.candidates,
            vector: last.vector.candidates,
            injected: last.injected,
            degraded: last.degrade.length > 0,
          },
    degrade: last?.degrade[0] ?? null,
    agentId: input.agentId,
    spaceId: input.spaceId,
    spaceDir: input.spaceDir,
    hostPhase: input.host?.phase ?? null,
    working,
    updatedAt: input.source.updatedAt,
    failures: input.source.failures,
    readStatus: input.readStatus,
  };
}

/** Build the projection from a snapshot already in memory (the pending slot). */
function projectKnownSnapshot(
  agentId: string,
  snapshot: EmbeddingBuildStateSnapshot,
  options: EmbeddingBuildStatusReadOptions | undefined,
  now: number,
): EmbeddingBuildStatusSnapshot | null {
  const settings = options?.settings ?? readEmbeddingSettings();
  if (!settings.enabled) return null;
  const spaceId = snapshot.spaceId;
  if (!SAFE_SEGMENT.test(spaceId)) return null;
  const host = readHost(options);
  const hostState = hostForAgent(host, agentId);
  const spaceDir =
    hostState?.spaceDir ??
    join(options?.root ?? getRecallVectorsRoot(), agentId, spaceId);
  return projectStatus({
    agentId,
    spaceId,
    spaceDir,
    settings,
    host: hostState,
    source: snapshot,
    readStatus: "ok",
    metrics: options?.metrics ?? embeddingMetrics.snapshot(),
    now,
  });
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * The most recently touched space directory for an agent.
 *
 * A space directory is a candidate when it carries `state.json`, the lock or
 * the lease; a directory that only holds an old generation is not a build
 * space. Ties prefer one with a state file, then the newest mtime.
 */
async function scanSpaceDirectory(
  agentId: string,
  options: EmbeddingBuildStatusReadOptions | undefined,
): Promise<{ spaceDir: string; spaceId: string } | null> {
  const root = options?.root ?? getRecallVectorsRoot();
  const agentDir = join(root, agentId);
  let entries: Dirent[];
  try {
    entries = await readdir(agentDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: {
    spaceDir: string;
    spaceId: string;
    hasState: boolean;
    mtime: number;
  } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) continue;
    const spaceDir = join(agentDir, entry.name);
    const [stateStat, lockStat, leaseStat] = await Promise.all([
      statOrNull(join(spaceDir, EMBEDDING_BUILD_STATE_FILE_NAME)),
      statOrNull(join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME)),
      statOrNull(join(spaceDir, EMBEDDING_LEASE_FILE_NAME)),
    ]);
    const hasState = stateStat !== null;
    if (!hasState && lockStat === null && leaseStat === null) continue;
    const mtime = Math.max(
      stateStat?.mtimeMs ?? 0,
      lockStat?.mtimeMs ?? 0,
      leaseStat?.mtimeMs ?? 0,
    );
    const candidate = { spaceDir, spaceId: entry.name, hasState, mtime };
    if (
      best === null ||
      (candidate.hasState && !best.hasState) ||
      (candidate.hasState === best.hasState && candidate.mtime > best.mtime)
    ) {
      best = candidate;
    }
  }
  return best === null
    ? null
    : { spaceDir: best.spaceDir, spaceId: best.spaceId };
}

/** Resolve the space whose state this projection is about. */
async function resolveSpace(
  agentId: string,
  hostState: EmbeddingBuildHostState | null,
  options: EmbeddingBuildStatusReadOptions | undefined,
  now: number,
): Promise<{ spaceDir: string; spaceId: string } | null> {
  if (options?.spaceDir !== undefined) {
    const spaceId = options.spaceId ?? basename(options.spaceDir);
    if (!SAFE_SEGMENT.test(spaceId)) return null;
    return { spaceDir: options.spaceDir, spaceId };
  }
  const root = options?.root ?? getRecallVectorsRoot();
  if (options?.spaceId !== undefined) {
    if (!SAFE_SEGMENT.test(options.spaceId)) return null;
    return {
      spaceDir: join(root, agentId, options.spaceId),
      spaceId: options.spaceId,
    };
  }
  if (
    hostState !== null &&
    hostState.spaceDir !== null &&
    hostState.identity !== null &&
    SAFE_SEGMENT.test(hostState.identity.spaceId)
  ) {
    return {
      spaceDir: hostState.spaceDir,
      spaceId: hostState.identity.spaceId,
    };
  }
  const cacheKey = `${root}\u0000${agentId}`;
  const cached = spaceByAgent.get(cacheKey);
  if (
    cached !== undefined &&
    now - cached.at < EMBEDDING_BUILD_STATUS_SPACE_RESCAN_MS
  ) {
    return cached.spaceDir === null || cached.spaceId === null
      ? null
      : { spaceDir: cached.spaceDir, spaceId: cached.spaceId };
  }
  const scanned = await scanSpaceDirectory(agentId, options);
  spaceByAgent.set(cacheKey, {
    spaceDir: scanned?.spaceDir ?? null,
    spaceId: scanned?.spaceId ?? null,
    at: now,
  });
  return scanned;
}

/** Read A4 + A2, resolve the space and project one snapshot. */
async function composeEmbeddingBuildStatus(
  agentId: string,
  options: EmbeddingBuildStatusReadOptions | undefined,
  now: number,
): Promise<EmbeddingBuildStatusSnapshot | null> {
  if (!SAFE_SEGMENT.test(agentId)) return null;
  const settings = options?.settings ?? readEmbeddingSettings();
  if (!settings.enabled) return null;
  const host = readHost(options);
  const hostState = hostForAgent(host, agentId);
  const space = await resolveSpace(agentId, hostState, options, now);
  if (space === null) return null;

  const readState = options?.readState ?? readEmbeddingBuildState;
  let read: EmbeddingBuildStateReadResult;
  try {
    read = await readState(embeddingBuildStatePath(space.spaceDir), {
      agentId,
      spaceId: space.spaceId,
      clock: options?.clock,
    });
  } catch (error) {
    // A2's reader is documented as never throwing; a poisoned state file or a
    // permissions problem still must not hide a live in-process progress read.
    read = {
      state: createEmptyEmbeddingBuildState(
        { agentId, spaceId: space.spaceId },
        { clock: options?.clock },
      ),
      status: "corrupt",
      discarded: true,
      detail: getErrorMessage(error),
    };
  }

  const persisted = snapshotEmbeddingBuildState(read.state);
  const hostProgress = hostState?.progress ?? null;
  // An active A4 host is authoritative for its own in-process run, and its
  // snapshot is newer than any file read that is still catching up. A missing
  // `state.json` is projected with a read-time `updatedAt`, so the timestamps
  // are only compared when both sides actually carry a persisted snapshot.
  const hostActive = hostState !== null && isActiveHostPhase(hostState.phase);
  const source =
    hostProgress !== null &&
    (hostActive || hostProgress.updatedAt >= persisted.updatedAt)
      ? hostProgress
      : persisted;

  return projectStatus({
    agentId,
    spaceId: space.spaceId,
    spaceDir: space.spaceDir,
    settings,
    host: hostState,
    source,
    readStatus: read.status,
    metrics: options?.metrics ?? embeddingMetrics.snapshot(),
    now,
  });
}

function cacheStatus(
  agentId: string,
  snapshot: EmbeddingBuildStatusSnapshot | null,
  refreshedAt: number,
): EmbeddingBuildStatusSnapshot | null {
  statusByAgent.set(agentId, {
    snapshot,
    refreshedAt,
    inflight: null,
    lastError: null,
  });
  return snapshot;
}

/**
 * Record one A4 `onProgress` snapshot for the next publish.
 *
 * This is the seam a caller hands to `startEmbeddingBuild`'s `onProgress`: it
 * does no I/O and starts no timer, it only replaces the pending snapshot. The
 * next cached/interval read promotes it, so a runner that emits per batch
 * cannot repaint the TUI faster than {@link EMBEDDING_BUILD_STATUS_THROTTLE_MS}.
 */
export function noteEmbeddingBuildProgress(
  snapshot: EmbeddingBuildStateSnapshot,
): void {
  if (!SAFE_SEGMENT.test(snapshot.agentId)) return;
  pendingProgress.set(snapshot.agentId, snapshot);
}

function flushPendingProgress(
  agentId: string,
  options: EmbeddingBuildStatusReadOptions | undefined,
  now: number,
): EmbeddingBuildStatusSnapshot | null | undefined {
  const pending = pendingProgress.get(agentId);
  if (pending === undefined) return undefined;
  const publishedAt = lastPublishAt.get(agentId);
  if (
    publishedAt !== undefined &&
    now - publishedAt < EMBEDDING_BUILD_STATUS_THROTTLE_MS
  ) {
    return undefined;
  }
  pendingProgress.delete(agentId);
  const projected = projectKnownSnapshot(agentId, pending, options, now);
  lastPublishAt.set(agentId, now);
  return cacheStatus(agentId, projected, now);
}

/**
 * Force one read and refresh the cache. Concurrent callers share the in-flight
 * read; a failure keeps the previous snapshot (a stale number beats a blank
 * status line) and is reported once through `debugWarn`.
 */
export async function refreshEmbeddingBuildStatus(
  agentId: string,
  options: EmbeddingBuildStatusReadOptions = {},
): Promise<EmbeddingBuildStatusSnapshot | null> {
  const existing = statusByAgent.get(agentId);
  if (existing?.inflight) return existing.inflight;
  const promise = (async (): Promise<EmbeddingBuildStatusSnapshot | null> => {
    const now = clockOf(options)();
    try {
      const pendingSnapshot = flushPendingProgress(agentId, options, now);
      if (pendingSnapshot !== undefined) return pendingSnapshot;
      const snapshot = await composeEmbeddingBuildStatus(agentId, options, now);
      return cacheStatus(agentId, snapshot, clockOf(options)());
    } catch (error) {
      debugWarn(
        "embedding",
        `embedding build status read failed: ${getErrorMessage(error)}`,
      );
      const fallback = statusByAgent.get(agentId)?.snapshot ?? null;
      statusByAgent.set(agentId, {
        snapshot: fallback,
        refreshedAt: clockOf(options)(),
        inflight: null,
        lastError: getErrorMessage(error),
      });
      return fallback;
    }
  })();
  statusByAgent.set(agentId, {
    snapshot: existing?.snapshot ?? null,
    refreshedAt: existing?.refreshedAt ?? clockOf(options)(),
    inflight: promise,
    lastError: existing?.lastError ?? null,
  });
  return promise;
}

/**
 * The synchronous, non-React read shared by `device_status.embedding` and the
 * `/recall status` face.
 *
 * Returns the cached projection immediately; when the cache is older than the
 * throttle (or absent) it starts {@link refreshEmbeddingBuildStatus} in the
 * background and returns the previous value. A synchronous consumer therefore
 * never waits on `state.json`, and the first read after a cold start is
 * `null` — the next read at the 5 s `device_status` TTL sees the build.
 */
export function readEmbeddingBuildStatusSnapshot(
  agentId: string | null | undefined,
  options: EmbeddingBuildStatusReadOptions = {},
): EmbeddingBuildStatusSnapshot | null {
  if (!agentId || !SAFE_SEGMENT.test(agentId)) return null;
  const now = clockOf(options)();
  const flushed = flushPendingProgress(agentId, options, now);
  if (flushed !== undefined) return flushed;
  const cached = statusByAgent.get(agentId);
  if (cached === undefined) {
    void refreshEmbeddingBuildStatus(agentId, options).catch(() => undefined);
    return null;
  }
  if (
    now - cached.refreshedAt >= EMBEDDING_BUILD_STATUS_THROTTLE_MS &&
    cached.inflight === null
  ) {
    void refreshEmbeddingBuildStatus(agentId, options).catch(() => undefined);
  }
  return cached.snapshot;
}

/** Timer surface, injectable so tests drive the loop without fake timers. */
export interface EmbeddingBuildStatusTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const DEFAULT_TIMERS: EmbeddingBuildStatusTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface UseEmbeddingBuildStatusOptions
  extends EmbeddingBuildStatusReadOptions {
  /** The conversation's current agent; `null` means "nothing to watch". */
  agentId: string | null | undefined;
  /** Override the 2 s publish interval (tests only). */
  intervalMs?: number;
  /** Timer seam (tests only). */
  timers?: Partial<EmbeddingBuildStatusTimers>;
  /** Refresh seam (tests only). */
  refresh?: typeof refreshEmbeddingBuildStatus;
}

/**
 * Poll the current agent's build status on one 2 s timer and return the D6
 * product-status snapshot, or `null` when there is nothing to paint.
 *
 * The timer is the only resource; unmount clears it and a cancelled flag drops
 * a refresh that resolves afterwards. Publishing compares the serialized
 * snapshot, so identical readings keep the previous object and do not trigger
 * a re-render.
 */
export function useEmbeddingBuildStatus(
  options: UseEmbeddingBuildStatusOptions,
): EmbeddingBuildStatusSnapshot | null {
  const { agentId } = options;
  const intervalMs = options.intervalMs ?? EMBEDDING_BUILD_STATUS_THROTTLE_MS;
  const refresh = options.refresh ?? refreshEmbeddingBuildStatus;
  const [snapshot, setSnapshot] = useState<EmbeddingBuildStatusSnapshot | null>(
    null,
  );
  const lastJsonRef = useRef<string>("null");
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const timersRef = useRef<EmbeddingBuildStatusTimers | null>(null);
  if (timersRef.current === null) {
    timersRef.current = { ...DEFAULT_TIMERS, ...(options.timers ?? {}) };
  }

  useEffect(() => {
    lastJsonRef.current = "null";
    setSnapshot(null);
    if (!agentId || !SAFE_SEGMENT.test(agentId)) return;
    const timers = timersRef.current as EmbeddingBuildStatusTimers;
    let cancelled = false;
    const tick = (): void => {
      void refresh(agentId, optionsRef.current).then(
        (next) => {
          if (cancelled) return;
          const json = JSON.stringify(next);
          if (json === lastJsonRef.current) return;
          lastJsonRef.current = json;
          setSnapshot(next);
        },
        () => undefined,
      );
    };
    tick();
    const handle = timers.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      timers.clearInterval(handle);
    };
  }, [agentId, intervalMs, refresh]);

  return snapshot;
}

/** Drop every cache entry; tests and a host reset use this. */
export function resetEmbeddingBuildStatusCache(): void {
  statusByAgent.clear();
  pendingProgress.clear();
  lastPublishAt.clear();
  spaceByAgent.clear();
}
