/**
 * Gate 2 (feature 48) — group B: the **built-in model** path end to end, and
 * group C: the F-10 three-surface consistency rules.
 *
 * Group B replaces the one thing L1 cannot run (the ONNX runtime) with a real
 * child process: a plain-JS worker that speaks C3's JSON-Lines protocol and
 * returns deterministic vectors. Everything else is production code:
 * C4's install marker written offline and checked by `isEmbeddingModelInstalled`,
 * C3's `EmbeddingWorkerClient` (spawn, handshake, framing, base64 vectors),
 * A4's `startEmbeddingBuild({ lifecycle: "headless" })` running A3's runner over
 * temp transcript/memory fixtures, B2's index on disk, A5's
 * `readEmbeddingBuildStatusSnapshot`, and E2/E3 querying and fusing it. A second
 * build proves incrementality (`reusedChunks > 0`, none re-embedded).
 *
 * Group C compares the three surfaces of one state against the real settings
 * writer and the real A5 projection: headless (`applyEmbeddingSetupFlags`),
 * TUI (`runEmbeddingSubmitCommand`) and websocket
 * (`getEmbeddingDeviceSummary`). The first-run case must write nothing and
 * print the copy-paste hint on both interactive and non-interactive paths; a
 * running build's progress and a cancelled build must read the same everywhere.
 *
 * Isolation follows `docs/31` §1.2 A2: temp home/local-backend roots are
 * redirected and restored, no real harness data, no public network.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddingModelInstalled } from "@/backend/local/embedding/model-download-install";
import type { EmbeddingBuildStateSnapshot } from "@/backend/local/embedding-build-state";
import { loadEmbeddingIndex } from "@/backend/local/embedding-cache";
import type { EmbeddingParentLineSpan } from "@/backend/local/embedding-format";
import { embeddingVectorUnitDir } from "@/backend/local/embedding-format";
import { buildMemoryVectorPlan } from "@/backend/local/embedding-memory";
import type { EmbeddingRunUnit } from "@/backend/local/embedding-runner";
import {
  lineSpanWithinParent,
  readRecallMessageTexts,
} from "@/backend/local/recall-snippets";
import { updateEmbeddingSettings } from "@/cli/app/pages/settings/embedding-settings";
import {
  type EmbeddingRuntimePort,
  type EmbeddingRuntimeStatus,
  formatEmbeddingFirstRunHint,
  isEmbeddingConfigured,
} from "@/cli/commands/embedding";
import { applyEmbeddingSetupFlags } from "@/cli/commands/embedding-flags";
import {
  type EmbeddingSubmitRunner,
  runEmbeddingSubmitCommand,
} from "@/cli/commands/embedding-submit";
import { createBuiltinEmbedAdapter } from "@/cli/helpers/embedding-build-embed-adapters";
import {
  cancelEmbeddingBuild,
  resetEmbeddingBuildHost,
  startEmbeddingBuild,
} from "@/cli/helpers/embedding-build-host";
import {
  type EmbeddingBuildStatusSnapshot,
  refreshEmbeddingBuildStatus,
  resetEmbeddingBuildStatusCache,
} from "@/cli/hooks/use-embedding-build-status";
import { readEmbeddingSettings } from "@/recall-settings";
import { resetEmbeddingMetrics } from "@/reminders/embedding-metrics";
import { runRecall } from "@/reminders/recall-service";
import {
  createEmbeddingIndexSearch,
  createLocalVectorParentPort,
  createVectorRecallSource,
} from "@/reminders/recall-vector-source";
import { settingsManager } from "@/settings-manager";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";
import {
  createGate2Environment,
  createGate2RecallBackend,
  createGate2WorkerClient,
  GATE2_DIMENSIONS,
  type Gate2Environment,
  type Gate2ModelInstall,
  gate2MemoryDir,
  gate2TranscriptPlans,
  gate2WaitFor,
  writeGate2Conversation,
  writeGate2FakeWorkerScript,
  writeGate2MemoryFile,
  writeGate2ModelInstall,
} from "@/test-utils/embedding-gate2-fixtures";
import type { EmbeddingBuildState } from "@/types/embedding-protocol";
import {
  getEmbeddingDeviceSummary,
  resetEmbeddingDeviceSummaryCache,
} from "@/websocket/listener/embedding-device-status";

const AGENT_ID = "agent-gate2-builtin";
const SCOPE = { agentId: AGENT_ID, conversationId: "conversation-gate2" };

let env: Gate2Environment;
let vectorRoot: string;
let modelsDir: string;
let install: Gate2ModelInstall;
let storageDir: string;
let memoryDir: string;
let workerClient: ReturnType<typeof createGate2WorkerClient>;

type EmbeddingWorkerClient = ReturnType<typeof createGate2WorkerClient>;

function modelOptions() {
  return {
    modelId: install.manifest.id,
    manifest: install.manifest,
    modelsDir,
  } as const;
}

function isInstalled(): Promise<boolean> {
  return isEmbeddingModelInstalled(modelOptions());
}

/** The A3 units provider: one unit per conversation plus one per memory file. */
function buildUnits(input: {
  spaceId: string;
  conversationDirectories: readonly string[];
}): EmbeddingRunUnit[] {
  const units: EmbeddingRunUnit[] = [];
  for (const directory of input.conversationDirectories) {
    const messages = readRecallMessageTexts(
      join(storageDir, "conversations", directory),
    );
    units.push({
      unit: {
        agentId: AGENT_ID,
        spaceId: input.spaceId,
        conversationKey: directory,
      },
      plans: gate2TranscriptPlans(messages).plans,
    });
  }
  const plan = buildMemoryVectorPlan(memoryDir);
  for (const file of plan.files) {
    const spans = new Map<string, EmbeddingParentLineSpan>();
    for (const parent of file.parents) {
      for (const chunk of parent.plan.chunks) {
        spans.set(
          `${parent.parentId}:${chunk.chunkIndex}`,
          lineSpanWithinParent({
            parentText: parent.text,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
            parentStartLine: parent.startLine,
          }),
        );
      }
    }
    units.push({
      unit: {
        agentId: AGENT_ID,
        spaceId: input.spaceId,
        memoryFileKey: file.signature.fileKey,
      },
      plans: file.parents.map((parent) => parent.plan),
      parentLineSpan: (chunk) =>
        spans.get(`${chunk.parentId}:${chunk.chunkIndex}`),
    });
  }
  return units;
}

/** A4's in-process host wired to C3 through A4's own built-in adapter. */
async function startGate2Build(input: {
  spaceId: string;
  units: EmbeddingRunUnit[];
  onProgress?: (snapshot: EmbeddingBuildStateSnapshot) => void;
}) {
  const client = workerClient as EmbeddingWorkerClient;
  const adapter = createBuiltinEmbedAdapter({
    async embedBatched(texts) {
      const output = await client.embedBatched(texts, { batchSize: 32 });
      return { vectors: output.vectors, cancelled: output.cancelled };
    },
  });
  return startEmbeddingBuild({
    lifecycle: "headless",
    identity: { agentId: AGENT_ID, spaceId: input.spaceId },
    modelId: install.manifest.id,
    backend: "builtin",
    embed: adapter,
    units: input.units,
    root: vectorRoot,
    dimensions: GATE2_DIMENSIONS,
    skipCalibration: true,
    isModelInstalled: isInstalled,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
}

function tuiRunner(): { runner: EmbeddingSubmitRunner; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    runner: {
      start(input, output) {
        lines.push(`${input} :: ${output}`);
        return {
          finish(text) {
            lines.push(text);
          },
          fail(text) {
            lines.push(text);
          },
        };
      },
    },
  };
}

/** The TUI's runtime port, backed by A5's own snapshot (the wiring contract). */
function tuiRuntimePort(
  status: EmbeddingBuildStatusSnapshot | null,
): EmbeddingRuntimePort {
  return {
    async readStatus(): Promise<EmbeddingRuntimeStatus> {
      const build = status?.build ?? null;
      return {
        ready: build?.state === "completed",
        space:
          status === null
            ? null
            : {
                model: status.model ?? "",
                dimensions: GATE2_DIMENSIONS,
                chunks: build?.totalChunks ?? 0,
                conversations: 1,
                coverage: status.coverage ?? null,
                builtAt: new Date(status.updatedAt).toISOString(),
              },
        build:
          build === null
            ? null
            : {
                state: build.state as EmbeddingBuildState,
                progress: build.progress ?? 0,
                processedChunks: build.processedChunks ?? 0,
                totalChunks: build.totalChunks ?? 0,
                etaMs: build.etaMs ?? null,
                ...(build.error === undefined || build.error === null
                  ? {}
                  : { error: build.error }),
              },
        calibration: null,
        egress: false,
        failure: null,
      };
    },
  };
}

async function tuiStatus(
  status: EmbeddingBuildStatusSnapshot | null,
): Promise<string> {
  const { runner } = tuiRunner();
  return runEmbeddingSubmitCommand("/recall embedding status", SCOPE, runner, {
    runtime: tuiRuntimePort(status),
    openSetup: () => false,
  });
}

function recallBackend() {
  return createGate2RecallBackend(storageDir);
}

beforeAll(async () => {
  env = createGate2Environment("haru-gate2-builtin-");
  vectorRoot = join(env.homeDir, "recall-vectors");
  modelsDir = join(env.root, "models");
  storageDir = env.localBackendDir;
  memoryDir = gate2MemoryDir(storageDir, AGENT_ID);
  mkdirSync(vectorRoot, { recursive: true });
  install = writeGate2ModelInstall({ modelsDir });

  await settingsManager.reset();
  await settingsManager.initialize();

  const workerScript = writeGate2FakeWorkerScript(env.root);
  workerClient = createGate2WorkerClient(workerScript);
  await workerClient.start();
  await workerClient.init({
    runtimeDir: join(env.root, "runtime"),
    modelPath: join(install.modelDir, "onnx", "model.onnx"),
    tokenizerPath: join(install.modelDir, "tokenizer.json"),
  });
});

afterEach(async () => {
  resetEmbeddingBuildHost();
  resetEmbeddingBuildStatusCache();
  resetEmbeddingDeviceSummaryCache();
  resetEmbeddingMetrics();
});

afterAll(async () => {
  await workerClient.shutdown({ timeoutMs: 2_000 }).catch(() => undefined);
  await settingsManager.reset();
  env.cleanup();
  env.restore();
});

// ---------------------------------------------------------------------------
// Group B: built-in path E2E
// ---------------------------------------------------------------------------

describe("group B - built-in model path", () => {
  test("the fake worker is as deterministic as the fixture vector", async () => {
    const vector = await workerClient.embedOne("gate-2 determinism check");
    expect(vector).not.toBeNull();
    expect(Array.from(vector ?? [])).toEqual(
      Array.from(
        fakeEmbeddingVector("gate-2 determinism check", GATE2_DIMENSIONS),
      ),
    );
  });

  test("C4 marker + C3 worker -> A4 headless build -> A5 status -> query + fusion, then incremental", async () => {
    // C4: the marker is real and validated without a download.
    expect(await isInstalled()).toBe(true);

    // Temp transcript + memory fixtures, read back by the same readers A3 uses.
    const historyDirectory = await writeGate2Conversation({
      storageDir,
      directory: "conv-b1",
      conversationId: "conversation-b1",
      agentId: AGENT_ID,
      messages: [
        {
          id: "m-b1",
          role: "assistant",
          text: "财务系统的记账方式是每日对账。对账结果写入当日的台账。",
        },
        { id: "m-b2", role: "user", text: "部署窗口定在周五晚上八点。" },
      ],
    });
    writeGate2MemoryFile({
      storageDir,
      agentId: AGENT_ID,
      path: "reference/notes.md",
      content: "# 记账\n\n财务系统每日对账一次，结果写入台账。\n",
    });

    // Prove the C4 check is what gates the build (the same call A4 makes).
    const spaceId = "space-b1";
    const units = buildUnits({
      spaceId,
      conversationDirectories: [historyDirectory],
    });
    expect(units.length).toBeGreaterThanOrEqual(2);
    const totalChunks = units.reduce(
      (sum, unit) =>
        sum + unit.plans.reduce((inner, plan) => inner + plan.chunks.length, 0),
      0,
    );
    expect(totalChunks).toBeGreaterThan(0);

    const progress: string[] = [];
    const started = await startGate2Build({
      spaceId,
      units,
      onProgress: (snapshot) => {
        progress.push(snapshot.phase);
      },
    });
    if (!started.ok) {
      throw new Error(`build was refused: ${started.error.code}`);
    }
    const outcome = await started.outcome;
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.embeddedChunks).toBe(totalChunks);
    expect(outcome.result?.reusedChunks).toBe(0);
    expect(progress).toContain("running");

    // The index really is on disk with the expected width.
    const conversationUnitDir = embeddingVectorUnitDir(
      { agentId: AGENT_ID, spaceId, conversationKey: historyDirectory },
      { root: vectorRoot },
    );
    const loaded = loadEmbeddingIndex(conversationUnitDir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.index.meta.dimensions).toBe(GATE2_DIMENSIONS);
      expect(loaded.index.meta.modelId).toBe(install.manifest.id);
    }

    // A5: enable the feature in real settings, then read the projection.
    updateEmbeddingSettings({
      enabled: true,
      backend: "builtin",
      model: install.manifest.id,
    });
    const status = await refreshEmbeddingBuildStatus(AGENT_ID, {
      root: vectorRoot,
    });
    expect(status).not.toBeNull();
    expect(status?.enabled).toBe(true);
    expect(status?.backend).toBe("builtin");
    expect(status?.model).toBe(install.manifest.id);
    expect(status?.build?.state).toBe("completed");
    expect(status?.build?.processedChunks).toBe(totalChunks);
    expect(status?.build?.totalChunks).toBe(totalChunks);
    expect(status?.build?.progress).toBeCloseTo(1, 6);
    expect(status?.readStatus).toBe("ok");

    // E2 + E3: query the built index through the real worker and fusion.
    const messages = readRecallMessageTexts(
      join(storageDir, "conversations", historyDirectory),
    );
    const memoryPlan = buildMemoryVectorPlan(memoryDir);
    const searchUnits = [
      { kind: "transcript" as const, conversationKey: historyDirectory },
      ...memoryPlan.files.map((file) => ({
        kind: "memory" as const,
        file: file.signature.path,
        memoryFileKey: file.signature.fileKey,
      })),
    ];
    const vectorSource = createVectorRecallSource({
      encoder: {
        id: "worker:gate2",
        async encodeQuery(text) {
          return await workerClient.embedOne(text);
        },
      },
      search: createEmbeddingIndexSearch({
        space: { agentId: AGENT_ID, spaceId },
        root: vectorRoot,
        units: searchUnits,
      }),
      parentReader: createLocalVectorParentPort({ storageDir, memoryDir }),
      topK: 50,
      budgetMs: 0,
    });
    const decision = await runRecall({
      backend: recallBackend(),
      agentId: AGENT_ID,
      conversationId: "conversation-b1",
      userText: messages[0]?.text ?? "",
      currentTurn: 1,
      dryRun: true,
      options: { limit: 3 },
      vectorSource,
    });
    expect(decision.status).toBe("injected");
    const vectorDiagnostic = decision.diagnostics.sources.find(
      (diagnostic) => diagnostic.source === "vector",
    );
    expect(vectorDiagnostic?.status).toBe("searched");
    expect(vectorDiagnostic?.candidates ?? 0).toBeGreaterThan(0);
    expect(
      decision.entries.some((entry) =>
        entry.fingerprint.startsWith(`transcript:${historyDirectory}:`),
      ),
    ).toBe(true);
    const injectedTotal = decision.entries.reduce(
      (sum, entry) => sum + entry.text.length,
      0,
    );
    expect(injectedTotal).toBeLessThanOrEqual(1200);

    // Second build: everything is reused, nothing is re-embedded.
    const again = await startGate2Build({ spaceId, units });
    if (!again.ok)
      throw new Error(`second build was refused: ${again.error.code}`);
    const second = await again.outcome;
    expect(second.status).toBe("completed");
    expect(second.result?.reusedChunks).toBe(totalChunks);
    expect(second.result?.embeddedChunks).toBe(0);
  });

  test("a missing C4 marker refuses the build with an actionable error (no download)", async () => {
    const before = performance.now();
    const started = await startEmbeddingBuild({
      lifecycle: "headless",
      identity: { agentId: AGENT_ID, spaceId: "space-missing-model" },
      modelId: "bge-small-zh-v1.5",
      backend: "builtin",
      embed: async () => [],
      units: [],
      root: vectorRoot,
      dimensions: GATE2_DIMENSIONS,
      skipCalibration: true,
    });
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.code).toBe("model_missing");
      expect(started.error.message).toContain("not installed");
      expect(started.error.action).toContain("connect");
    }
    // The refusal is immediate: nothing was downloaded or spawned.
    expect(performance.now() - before).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// Group C: three-surface consistency (F-10)
// ---------------------------------------------------------------------------

describe("group C - headless / TUI / websocket consistency", () => {
  test("first-run on both paths writes nothing and prints the same hint", async () => {
    const fresh = await useFreshSettingsHome("settings-c1");
    try {
      expect(isEmbeddingConfigured()).toBe(false);

      const headless = await applyEmbeddingSetupFlags({
        "recall-embedding": "on",
      });
      expect(headless.ok).toBe(true);
      if (headless.ok) {
        expect(headless.receipt).toBe(formatEmbeddingFirstRunHint());
        expect(headless.receipt).toContain("Nothing was changed");
      }
      expect(isEmbeddingConfigured()).toBe(false);
      expect(storedEmbeddingKeys()).toEqual([]);

      // The TUI seam (append shell: no settings page) refuses identically.
      const { runner } = tuiRunner();
      const tuiOutput = await runEmbeddingSubmitCommand(
        "/recall embedding on",
        SCOPE,
        runner,
        { openSetup: () => false },
      );
      expect(tuiOutput).toBe(formatEmbeddingFirstRunHint());
      expect(isEmbeddingConfigured()).toBe(false);
      expect(storedEmbeddingKeys()).toEqual([]);
    } finally {
      await fresh();
    }
  });

  test("headless flags write real settings and the TUI reads the same state", async () => {
    const fresh = await useFreshSettingsHome("settings-c2");
    try {
      const configured = await applyEmbeddingSetupFlags({
        "recall-embedding": "on",
        "recall-embedding-backend": "builtin",
        "recall-embedding-model": install.manifest.id,
      });
      expect(configured.ok).toBe(true);
      if (configured.ok) {
        expect(configured.receipt).toContain("Embedding settings saved.");
        expect(configured.receipt).toContain(
          `backend builtin · model ${install.manifest.id}`,
        );
      }
      // The writer is the real settings manager, not a mock.
      const settings = readEmbeddingSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.backend).toBe("builtin");
      expect(settings.model).toBe(install.manifest.id);
      expect(storedEmbeddingKeys()).toContain("recallEmbeddingBackend");

      // The TUI status face reads the very same persisted state.
      const output = await tuiStatus(null);
      expect(output).toContain("Vector recall: on");
      expect(output).toContain(`Backend: builtin · ${install.manifest.id}`);
      expect(output).toContain("Build: idle");
    } finally {
      await fresh();
    }
  });

  test("progress and cancellation read consistently across the three surfaces", async () => {
    const fresh = await useFreshSettingsHome("settings-c3");
    try {
      updateEmbeddingSettings({
        enabled: true,
        backend: "builtin",
        model: install.manifest.id,
      });

      const spaceId = "space-c3";
      const first = await writeGate2Conversation({
        storageDir,
        directory: "conv-c3-a",
        conversationId: "conversation-c3-a",
        agentId: AGENT_ID,
        messages: [
          { id: "m-c3-a", role: "user", text: "第一条用于进度的会话。" },
        ],
      });
      const second = await writeGate2Conversation({
        storageDir,
        directory: "conv-c3-b",
        conversationId: "conversation-c3-b",
        agentId: AGENT_ID,
        messages: [
          { id: "m-c3-b", role: "user", text: "第二条用于进度的会话。" },
        ],
      });
      const third = await writeGate2Conversation({
        storageDir,
        directory: "conv-c3-c",
        conversationId: "conversation-c3-c",
        agentId: AGENT_ID,
        messages: [
          { id: "m-c3-c", role: "user", text: "第三条用于取消的会话。" },
        ],
      });
      const units = buildUnits({
        spaceId,
        conversationDirectories: [first, second, third],
      }).filter((unit) => unit.unit.agentId === AGENT_ID);
      // Only the two transcript units run here; memory is covered by group B.
      const transcriptUnits = units.filter(
        (unit) => "conversationKey" in unit.unit,
      );
      expect(transcriptUnits).toHaveLength(3);

      let embedCalls = 0;
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const started = await startEmbeddingBuild({
        lifecycle: "headless",
        identity: { agentId: AGENT_ID, spaceId },
        modelId: install.manifest.id,
        backend: "builtin",
        embed: async (chunks) => {
          embedCalls += 1;
          if (embedCalls >= 2) await gate;
          return chunks.map((chunk) =>
            fakeEmbeddingVector(chunk.text, GATE2_DIMENSIONS),
          );
        },
        units: transcriptUnits,
        root: vectorRoot,
        dimensions: GATE2_DIMENSIONS,
        skipCalibration: true,
        isModelInstalled: isInstalled,
      });
      if (!started.ok)
        throw new Error(`build was refused: ${started.error.code}`);

      // Wait until the second unit's embed is in flight: the first unit's
      // checkpoint (A2 state + A4 progress) is already published.
      await gate2WaitFor(() => embedCalls >= 2, "the second embed call");
      const running = await refreshEmbeddingBuildStatus(AGENT_ID, {
        root: vectorRoot,
      });
      expect(running?.build?.state).toBe("running");
      expect(running?.working).toBe(true);
      expect(running?.build?.processedChunks ?? 0).toBeGreaterThanOrEqual(1);
      expect(running?.build?.progress).toBeGreaterThan(0);

      // Websocket: the provider projects the same A5 snapshot.
      resetEmbeddingDeviceSummaryCache();
      const summary = getEmbeddingDeviceSummary(AGENT_ID);
      expect(summary).not.toBeNull();
      expect(summary?.enabled).toBe(true);
      expect(summary?.state).toBe("running");
      expect(summary?.model).toBe(install.manifest.id);
      expect(summary?.space_id).toBe(spaceId);
      expect(summary?.progress).toBe(running?.build?.progress ?? undefined);
      expect(summary?.processed_chunks).toBe(running?.build?.processedChunks);
      expect(summary?.total_chunks).toBe(running?.build?.totalChunks);

      // TUI: its status face is fed by the same snapshot and must agree.
      const runningOutput = await tuiStatus(running);
      expect(runningOutput).toContain("Vector recall: on");
      expect(runningOutput).toContain(
        `Backend: builtin · ${install.manifest.id}`,
      );
      expect(runningOutput).toContain("Build: running");
      expect(runningOutput).toContain(
        `${running?.build?.processedChunks}/${running?.build?.totalChunks} chunks`,
      );

      // Cancel, then let the in-flight embed finish so the runner checkpoints.
      const cancelPromise = cancelEmbeddingBuild({ timeoutMs: 10_000 });
      releaseGate();
      const cancelResult = await cancelPromise;
      expect(cancelResult.cancelled).toBe(true);
      const outcome = await started.outcome;
      expect(outcome.status).toBe("cancelled");

      const cancelled = await refreshEmbeddingBuildStatus(AGENT_ID, {
        root: vectorRoot,
      });
      expect(cancelled?.build?.state).toBe("cancelled");
      expect(cancelled?.working).toBe(false);

      resetEmbeddingDeviceSummaryCache();
      const cancelledSummary = getEmbeddingDeviceSummary(AGENT_ID);
      expect(cancelledSummary?.state).toBe("cancelled");
      expect(cancelledSummary?.enabled).toBe(true);
      expect(cancelledSummary?.model).toBe(install.manifest.id);

      const cancelledOutput = await tuiStatus(cancelled);
      expect(cancelledOutput).toContain("Build: cancelled");
      expect(cancelledOutput).toContain("Vector recall: on");
      expect(cancelledOutput).toContain(
        `Backend: builtin · ${install.manifest.id}`,
      );
    } finally {
      await fresh();
    }
  });
});

/**
 * Point HOME/HARUYUKI_HOME at a new empty temp home and initialize the real
 * settings manager there, so "nothing was written" means this test's writes.
 * The returned callback restores the file-level environment.
 */
async function useFreshSettingsHome(
  label: string,
): Promise<() => Promise<void>> {
  const home = join(env.root, label);
  mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  const previousHaruyukiHome = process.env.HARUYUKI_HOME;
  process.env.HOME = home;
  process.env.HARUYUKI_HOME = home;
  await settingsManager.reset();
  await settingsManager.initialize();
  return async () => {
    await settingsManager.reset();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
    else process.env.HARUYUKI_HOME = previousHaruyukiHome;
    await settingsManager.initialize();
  };
}

/** Stored `recallEmbedding*` keys in the real settings record (0 = unwritten). */
function storedEmbeddingKeys(): string[] {
  const raw = settingsManager.getSettings() as unknown as Record<
    string,
    unknown
  >;
  return Object.keys(raw)
    .filter((key) => key.startsWith("recallEmbedding"))
    .sort();
}
