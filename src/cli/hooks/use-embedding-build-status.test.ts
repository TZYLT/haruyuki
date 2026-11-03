/**
 * Tests for the A5 build-status projection (`use-embedding-build-status.ts`).
 *
 * Everything is synthetic and isolated: a temp `HARUYUKI_HOME` fixture, A2
 * `state.json` files written through A2's own writer, injected settings/metrics/
 * host state/clock, and a fake `refresh` for the hook loop. No worker, ONNX,
 * network or real child is involved (docs/31 §1.2 A2), and the provider test
 * asserts only that A5 feeds D2's `device_status.embedding` projection — TTL and
 * dedup stay D2's tests.
 *
 * The repository has no fake-timer precedent, so the hook is driven with a
 * short real interval plus an injected clock for the throttle assertions, the
 * same pattern as `use-dream-run-status.test.tsx`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import { createElement } from "react";

import {
  createEmptyEmbeddingBuildState,
  type EmbeddingBuildStateRecord,
  type EmbeddingBuildStateSnapshot,
  embeddingBuildStatePath,
  snapshotEmbeddingBuildState,
  writeEmbeddingBuildState,
} from "@/backend/local/embedding-build-state";
import type { EmbeddingBuildHostState } from "@/cli/helpers/embedding-build-host";
import {
  EMBEDDING_BUILD_STATUS_TERMINAL_RETENTION_MS,
  type EmbeddingBuildStatusReadOptions,
  type EmbeddingBuildStatusSnapshot,
  noteEmbeddingBuildProgress,
  readEmbeddingBuildStatusSnapshot,
  refreshEmbeddingBuildStatus,
  resetEmbeddingBuildStatusCache,
  useEmbeddingBuildStatus,
} from "@/cli/hooks/use-embedding-build-status";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";
import {
  createEmbeddingMetricsRecorder,
  type EmbeddingMetricsSnapshot,
} from "@/reminders/embedding-metrics";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";
import { resetInkTtyState } from "@/test-utils/ink-tty";
import {
  getEmbeddingDeviceSummary,
  readEmbeddingBuildDeviceSummary,
  resetEmbeddingDeviceSummaryCache,
  setEmbeddingDeviceSummaryProvider,
} from "@/websocket/listener/embedding-device-status";

const AGENT = "agent-a5-status";
const SPACE = "space-a5";
const MODEL = "bge-small-zh-v1.5";

const ENABLED_SETTINGS: ResolvedEmbeddingSettings = {
  ...EMBEDDING_SETTING_DEFAULTS,
  enabled: true,
  model: MODEL,
};

const EMPTY_METRICS: EmbeddingMetricsSnapshot =
  createEmbeddingMetricsRecorder().snapshot();

const originalHome = process.env.HARUYUKI_HOME;
let dirs: EmbeddingFixtureDirs | null = null;

function idleHostState(): EmbeddingBuildHostState {
  return {
    phase: "idle",
    lifecycle: null,
    identity: null,
    spaceDir: null,
    modelId: null,
    backend: null,
    keepAfterExit: false,
    buildId: null,
    progress: null,
    result: null,
    error: null,
    calibration: null,
    detachedPid: null,
    startedAt: null,
    finishedAt: null,
  };
}

function spaceDirOf(agentId: string, spaceId: string): string {
  if (dirs === null) throw new Error("fixture dirs missing");
  return join(dirs.homeDir, "recall-vectors", agentId, spaceId);
}

function statePathOf(agentId: string, spaceId: string): string {
  return embeddingBuildStatePath(spaceDirOf(agentId, spaceId));
}

async function writeState(
  path: string,
  record: EmbeddingBuildStateRecord,
): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  await writeEmbeddingBuildState(path, record);
}

function baseRecord(
  agentId: string,
  spaceId: string,
  patch: Partial<EmbeddingBuildStateRecord> = {},
): EmbeddingBuildStateRecord {
  return {
    ...createEmptyEmbeddingBuildState(
      { agentId, spaceId },
      { clock: () => 1_000 },
    ),
    ...patch,
  };
}

/** A running record with a persisted rate window so ETA is computable. */
function runningRecord(
  agentId: string,
  spaceId: string,
  embeddedChunks = 340,
  totalChunks = 1_000,
): EmbeddingBuildStateRecord {
  return baseRecord(agentId, spaceId, {
    phase: "running",
    progress: {
      embeddedChunks,
      totalChunks,
      processedConversations: 3,
      totalConversations: 10,
    },
    coverage: { embeddedChars: 500, recallableChars: 1_000 },
    rateSamples: [
      { at: 1_000, embeddedChunks: 0 },
      { at: 2_000, embeddedChunks },
    ],
    startedAt: 1_000,
    updatedAt: 2_000,
  });
}

function snapshotOf(
  record: EmbeddingBuildStateRecord,
): EmbeddingBuildStateSnapshot {
  return snapshotEmbeddingBuildState(record);
}

function runningSnapshot(
  agentId: string,
  spaceId: string,
  progress: number,
): EmbeddingBuildStateSnapshot {
  const totalChunks = 1_000;
  return snapshotOf(
    baseRecord(agentId, spaceId, {
      phase: "running",
      progress: {
        embeddedChunks: Math.round(progress * totalChunks),
        totalChunks,
        processedConversations: 0,
        totalConversations: 0,
      },
      coverage: { embeddedChars: 0, recallableChars: 0 },
      updatedAt: 1_000 + Math.round(progress * 100),
    }),
  );
}

/** The hook's published shape, for the injected `refresh` seam. */
function productSnapshot(progress: number): EmbeddingBuildStatusSnapshot {
  return {
    enabled: true,
    backend: "builtin",
    model: MODEL,
    build: {
      state: "running",
      progress,
      processedChunks: 500,
      totalChunks: 1_000,
      etaMs: 1_000,
      error: null,
    },
    coverage: 0.5,
    arms: null,
    degrade: null,
    agentId: AGENT,
    spaceId: SPACE,
    spaceDir: spaceDirOf(AGENT, SPACE),
    hostPhase: "running",
    working: true,
    updatedAt: 1_000,
    failures: [],
    readStatus: "ok",
  };
}

function readOptions(
  overrides: Partial<EmbeddingBuildStatusReadOptions> = {},
): EmbeddingBuildStatusReadOptions {
  if (dirs === null) throw new Error("fixture dirs missing");
  return {
    root: join(dirs.homeDir, "recall-vectors"),
    settings: ENABLED_SETTINGS,
    metrics: EMPTY_METRICS,
    readHostState: idleHostState,
    ...overrides,
  };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await tick(5);
  }
  throw new Error("waitFor timed out");
}

function freshDirs(): void {
  dirs = createEmbeddingFixtureDirs();
  process.env.HARUYUKI_HOME = dirs.homeDir;
}

afterEach(() => {
  resetEmbeddingBuildStatusCache();
  resetEmbeddingDeviceSummaryCache();
  setEmbeddingDeviceSummaryProvider(readEmbeddingBuildDeviceSummary);
  if (dirs !== null) dirs.cleanup();
  dirs = null;
  if (originalHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHome;
});

// ── Projection ──────────────────────────────────────────────────────────────

describe("readEmbeddingBuildStatusSnapshot · projection", () => {
  test("maps A2 running state into the D6 product-status shape", async () => {
    freshDirs();
    await writeState(statePathOf(AGENT, SPACE), runningRecord(AGENT, SPACE));

    const snapshot = await refreshEmbeddingBuildStatus(AGENT, readOptions());
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      enabled: true,
      backend: "builtin",
      model: MODEL,
      agentId: AGENT,
      spaceId: SPACE,
      hostPhase: null,
      working: true,
      readStatus: "ok",
    });
    expect(snapshot?.build).toMatchObject({
      state: "running",
      progress: 0.34,
      processedChunks: 340,
      totalChunks: 1_000,
      // (1000 - 340) chunks at 340 chunks/s = 1942 ms.
      etaMs: 1_942,
      error: null,
    });
    expect(snapshot?.coverage).toBe(0.5);
    expect(snapshot?.failures).toEqual([]);

    // The synchronous read serves the cache populated above.
    expect(readEmbeddingBuildStatusSnapshot(AGENT, readOptions())).toBe(
      snapshot,
    );
  });

  test("returns null while the feature is disabled", async () => {
    freshDirs();
    await writeState(statePathOf(AGENT, SPACE), runningRecord(AGENT, SPACE));
    const snapshot = await refreshEmbeddingBuildStatus(
      AGENT,
      readOptions({ settings: { ...ENABLED_SETTINGS, enabled: false } }),
    );
    expect(snapshot).toBeNull();
  });

  test("returns null when nothing was ever built", async () => {
    freshDirs();
    expect(await refreshEmbeddingBuildStatus(AGENT, readOptions())).toBeNull();
  });

  test("keeps a failed build visible for the retention window (S-04)", async () => {
    freshDirs();
    await writeState(
      statePathOf(AGENT, SPACE),
      baseRecord(AGENT, SPACE, {
        phase: "failed",
        progress: {
          embeddedChunks: 10,
          totalChunks: 100,
          processedConversations: 1,
          totalConversations: 4,
        },
        failures: [
          {
            conversationId: "conv-1",
            code: "embed_failed",
            message: "worker exited",
            at: 1_000,
          },
        ],
        startedAt: 1_000,
        finishedAt: 2_000,
        updatedAt: 2_000,
      }),
    );

    const recent = await refreshEmbeddingBuildStatus(
      AGENT,
      readOptions({ clock: () => 2_000 + 1_000 }),
    );
    expect(recent?.build?.state).toBe("failed");
    expect(recent?.build?.error).toBe("embed_failed: worker exited");
    expect(recent?.working).toBe(false);

    const stale = await refreshEmbeddingBuildStatus(
      AGENT,
      readOptions({
        clock: () => 2_000 + EMBEDDING_BUILD_STATUS_TERMINAL_RETENTION_MS + 1,
      }),
    );
    expect(stale).toBeNull();
  });

  test("prefers the active A4 host space and its in-process progress", async () => {
    freshDirs();
    await writeState(
      statePathOf(AGENT, SPACE),
      runningRecord(AGENT, SPACE, 100),
    );
    const activeHost: EmbeddingBuildHostState = {
      ...idleHostState(),
      phase: "detached",
      lifecycle: "tui",
      identity: { agentId: AGENT, spaceId: "space-host" },
      spaceDir: spaceDirOf(AGENT, "space-host"),
      modelId: MODEL,
      backend: "builtin",
      progress: runningSnapshot(AGENT, "space-host", 0.75),
      startedAt: 1_000,
    };
    const snapshot = await refreshEmbeddingBuildStatus(
      AGENT,
      readOptions({ readHostState: () => activeHost }),
    );
    expect(snapshot?.spaceId).toBe("space-host");
    expect(snapshot?.hostPhase).toBe("detached");
    expect(snapshot?.build?.state).toBe("running");
    expect(snapshot?.build?.progress).toBe(0.75);
  });

  test("rescans to the most recently updated space when no host owns a build", async () => {
    freshDirs();
    await writeState(
      statePathOf(AGENT, "space-old"),
      baseRecord(AGENT, "space-old", {
        phase: "cancelled",
        finishedAt: 1_000,
        updatedAt: 1_000,
      }),
    );
    await writeState(
      statePathOf(AGENT, "space-new"),
      runningRecord(AGENT, "space-new"),
    );
    const statPath = statePathOf(AGENT, "space-new");
    const future = new Date(Date.now() + 60_000);
    await utimes(statPath, future, future);

    const snapshot = await refreshEmbeddingBuildStatus(AGENT, readOptions());
    expect(snapshot?.spaceId).toBe("space-new");
    expect(snapshot?.build?.progress).toBe(0.34);
  });
});

// ── Throttle / merge ────────────────────────────────────────────────────────

describe("progress throttling · ≤0.5 Hz", () => {
  test("merges onProgress pushes and publishes at most every 2 s", () => {
    freshDirs();
    resetEmbeddingBuildStatusCache();
    let now = 10_000;
    const options = readOptions({ clock: () => now });

    noteEmbeddingBuildProgress(runningSnapshot(AGENT, SPACE, 0.1));
    const first = readEmbeddingBuildStatusSnapshot(AGENT, options);
    expect(first?.build?.progress).toBe(0.1);

    // Inside the window: pending updates are merged, not published.
    now = 10_500;
    noteEmbeddingBuildProgress(runningSnapshot(AGENT, SPACE, 0.2));
    expect(
      readEmbeddingBuildStatusSnapshot(AGENT, options)?.build?.progress,
    ).toBe(0.1);

    now = 11_500;
    noteEmbeddingBuildProgress(runningSnapshot(AGENT, SPACE, 0.3));
    expect(
      readEmbeddingBuildStatusSnapshot(AGENT, options)?.build?.progress,
    ).toBe(0.1);

    // The window has elapsed: only the newest of the merged pushes is painted.
    now = 12_000;
    expect(
      readEmbeddingBuildStatusSnapshot(AGENT, options)?.build?.progress,
    ).toBe(0.3);
  });

  test("an unchanged projection keeps the same serialized value", async () => {
    freshDirs();
    await writeState(statePathOf(AGENT, SPACE), runningRecord(AGENT, SPACE));
    const first = await refreshEmbeddingBuildStatus(AGENT, readOptions());
    const second = await refreshEmbeddingBuildStatus(AGENT, readOptions());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("a cold synchronous read returns null and refreshes in the background", async () => {
    freshDirs();
    await writeState(statePathOf(AGENT, SPACE), runningRecord(AGENT, SPACE));
    expect(readEmbeddingBuildStatusSnapshot(AGENT, readOptions())).toBeNull();
    await waitFor(
      () => readEmbeddingBuildStatusSnapshot(AGENT, readOptions()) !== null,
    );
    expect(
      readEmbeddingBuildStatusSnapshot(AGENT, readOptions())?.build?.progress,
    ).toBe(0.34);
  });
});

// ── React loop ──────────────────────────────────────────────────────────────

class NullOutput extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

function createStdin(): NodeJS.ReadStream {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

interface ProbeState {
  renders: number;
  published: (EmbeddingBuildStatusSnapshot | null)[];
  refreshCalls: number;
}

function mountProbe(
  refresh: () => Promise<EmbeddingBuildStatusSnapshot | null>,
  state: ProbeState,
): { stop(): void } {
  function Probe(): ReturnType<typeof createElement> {
    const snapshot = useEmbeddingBuildStatus({
      agentId: AGENT,
      intervalMs: 10,
      refresh,
    });
    state.renders += 1;
    state.published.push(snapshot);
    return createElement(Text, null, snapshot === null ? "none" : "running");
  }
  const instance = render(createElement(Probe), {
    stdin: createStdin(),
    stdout: new NullOutput() as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

describe("useEmbeddingBuildStatus · one timer loop", () => {
  afterEach(() => {
    resetInkTtyState();
  });

  test("publishes once, then stops re-rendering for unchanged readings", async () => {
    freshDirs();
    const state: ProbeState = { renders: 0, published: [], refreshCalls: 0 };
    const refresh = async (): Promise<EmbeddingBuildStatusSnapshot | null> => {
      state.refreshCalls += 1;
      // A fresh object with identical JSON: the hook must keep the old state.
      return productSnapshot(0.5);
    };
    const probe = mountProbe(refresh, state);
    try {
      await waitFor(() => state.published.at(-1) !== null);
      const rendersAfterFirstPaint = state.renders;
      await tick(60);
      expect(state.refreshCalls).toBeGreaterThan(2);
      expect(state.renders).toBe(rendersAfterFirstPaint);
    } finally {
      probe.stop();
    }
  });

  test("unmount clears the interval and drops in-flight publications", async () => {
    freshDirs();
    const state: ProbeState = { renders: 0, published: [], refreshCalls: 0 };
    const refresh = async (): Promise<EmbeddingBuildStatusSnapshot | null> => {
      state.refreshCalls += 1;
      return productSnapshot(0.5);
    };
    const probe = mountProbe(refresh, state);
    await waitFor(() => state.published.at(-1) !== null);
    probe.stop();
    const callsAtStop = state.refreshCalls;
    await tick(50);
    expect(state.refreshCalls).toBe(callsAtStop);
  });
});

// ── device_status.embedding feeding ─────────────────────────────────────────

describe("readEmbeddingBuildDeviceSummary · feeding D2", () => {
  test("projects the running build into D1's wire shape", async () => {
    freshDirs();
    await writeState(statePathOf(AGENT, SPACE), runningRecord(AGENT, SPACE));
    await refreshEmbeddingBuildStatus(AGENT, readOptions());

    setEmbeddingDeviceSummaryProvider(readEmbeddingBuildDeviceSummary);
    resetEmbeddingDeviceSummaryCache();
    expect(getEmbeddingDeviceSummary(AGENT, Date.now())).toEqual({
      enabled: true,
      state: "running",
      progress: 0.34,
      processed_chunks: 340,
      total_chunks: 1_000,
      eta_ms: 1_942,
      space_id: SPACE,
      model: MODEL,
    });
  });

  test("a failed build carries the actionable failure text", async () => {
    freshDirs();
    // Recent enough for the retention window: the provider read uses the real
    // clock, so the finished build must have just happened.
    const now = Date.now();
    await writeState(
      statePathOf(AGENT, SPACE),
      baseRecord(AGENT, SPACE, {
        phase: "failed",
        failures: [
          { conversationId: "conv-1", code: "embed_failed", at: now - 500 },
        ],
        startedAt: now - 2_000,
        finishedAt: now - 1_000,
        updatedAt: now - 1_000,
      }),
    );
    await refreshEmbeddingBuildStatus(AGENT, readOptions());

    setEmbeddingDeviceSummaryProvider(readEmbeddingBuildDeviceSummary);
    resetEmbeddingDeviceSummaryCache();
    expect(getEmbeddingDeviceSummary(AGENT, Date.now())).toMatchObject({
      enabled: true,
      state: "failed",
      failure: "embed_failed",
    });
  });

  test("no build means no device_status summary", async () => {
    freshDirs();
    expect(await refreshEmbeddingBuildStatus(AGENT, readOptions())).toBeNull();
    setEmbeddingDeviceSummaryProvider(readEmbeddingBuildDeviceSummary);
    resetEmbeddingDeviceSummaryCache();
    expect(getEmbeddingDeviceSummary(AGENT, Date.now())).toBeNull();
  });
});
