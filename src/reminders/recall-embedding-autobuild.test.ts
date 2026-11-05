/**
 * Automatic incremental catch-up (48-1 §6.8/§6.10).
 *
 * What this file pins: the trigger only fires when embedding is on and a source
 * is newer than its committed unit; one build per cooldown; the build is
 * incremental and its worker is disposed; and a disabled/misconfigured feature
 * costs nothing. The build itself is A3's, tested elsewhere — the seams here
 * replace it, so no worker and no model are involved.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import type {
  EmbeddingRunnerOptions,
  EmbeddingRunResult,
  EmbeddingRunUnit,
} from "@/backend/local/embedding-runner";
import { resolveEmbeddingSpace } from "@/backend/local/embedding-space";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";
import {
  EMBEDDING_AUTOBUILD_COOLDOWN_MS,
  type EmbeddingAutobuildDeps,
  isEmbeddingIndexBehind,
  resetRecallEmbeddingAutobuildForTests,
  runEmbeddingCatchUpIfBehind,
} from "@/reminders/recall-embedding-autobuild";
import {
  EMBEDDING_FIXTURE_DIMENSIONS,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const AGENT_ID = "agent-autobuild";
const CONVERSATION_KEY = "conv-autobuild";

let root: string;
let storageDir: string;
let memoryDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haru-autobuild-"));
  storageDir = join(root, "storage");
  memoryDir = join(root, "memory");
  mkdirSync(memoryDir, { recursive: true });
  resetRecallEmbeddingAutobuildForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function settings(
  overrides: Record<string, unknown> = {},
): ResolvedEmbeddingSettings {
  return {
    ...EMBEDDING_SETTING_DEFAULTS,
    enabled: true,
    ...overrides,
  } as ResolvedEmbeddingSettings;
}

function spaceId(): string {
  return resolveEmbeddingSpace(AGENT_ID, settings(), { root }).spaceId;
}

/** `<storage>/conversations/<key>`, the unit's source directory. */
function conversationDir(): string {
  const directory = join(storageDir, "conversations", CONVERSATION_KEY);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "conversation.json"),
    JSON.stringify({ id: "conv-1", agent_id: AGENT_ID }),
  );
  writeFileSync(
    join(directory, "messages.jsonl"),
    `${JSON.stringify({ id: "m1", role: "user", content: "hello" })}\n`,
  );
  return directory;
}

/** Commits one unit for the conversation, as a completed build would. */
function writeUnit(): void {
  const text = "hello world";
  const unit = {
    agentId: AGENT_ID,
    spaceId: spaceId(),
    conversationKey: CONVERSATION_KEY,
  };
  const plan = buildEmbeddingChunkPlan({ parentId: "m1", text });
  writeEmbeddingIndex({
    unitDir: embeddingVectorUnitDir(unit, { root }),
    unit,
    modelId: "bge-small-zh-v1.5",
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    records: embeddingChunkRecordsFromPlan(plan),
    vectors: plan.chunks.map((chunk) => fakeEmbeddingVector(chunk.text)),
    coverage: {
      embeddedChars: text.length,
      recallableChars: text.length,
      ratio: 1,
    },
  });
}

type Recorder = {
  options: EmbeddingRunnerOptions | null;
  disposed: number;
  deps: EmbeddingAutobuildDeps;
};

function recorder(): Recorder {
  const recorded: Recorder = { options: null, disposed: 0, deps: {} };
  recorded.deps = {
    createEmbed: async () => ({
      embed: async () => [],
      dispose: async () => {
        recorded.disposed += 1;
      },
      degradedReason: null,
      device: {
        backend: "builtin",
        requested: ["cpu"],
        initialized: ["cpu"],
        gpu: false,
        degraded: false,
        threads: 0,
        warmupMs: 0,
        measuredAt: "2026-11-05T00:00:00.000Z",
      },
    }),
    runBuild: async (options): Promise<EmbeddingRunResult> => {
      recorded.options = options;
      return {
        status: "completed",
        aborted: false,
        buildId: "fake-build",
        mode: "incremental",
        totalUnits: 0,
        completedUnits: 0,
        failedUnits: 0,
        reusedChunks: 0,
        embeddedChunks: 0,
        elapsedMs: 1,
        state: null,
        unitFailures: [],
      };
    },
    scanUnits: (): EmbeddingRunUnit[] => [],
  };
  return recorded;
}

function input(recorded: Recorder, now?: number) {
  return {
    backend: { getLocalStorageDir: () => storageDir },
    agentId: AGENT_ID,
    settings: settings(),
    root,
    deps: recorded.deps,
    ...(now === undefined ? {} : { now: () => now }),
  };
}

describe("the catch-up trigger", () => {
  test("does nothing when the feature is off or the endpoint has no form", async () => {
    const recorded = recorder();
    expect(
      await runEmbeddingCatchUpIfBehind({
        ...input(recorded),
        settings: settings({ enabled: false }),
      }),
    ).toBe(false);
    expect(
      await runEmbeddingCatchUpIfBehind({
        ...input(recorded),
        settings: settings({ backend: "endpoint", endpoint: null }),
      }),
    ).toBe(false);
    expect(recorded.options).toBeNull();
  });

  test("an unbuilt conversation is behind; one incremental build runs and disposes", async () => {
    conversationDir();
    const recorded = recorder();
    expect(await runEmbeddingCatchUpIfBehind(input(recorded))).toBe(true);
    expect(recorded.options?.mode).toBe("incremental");
    expect(recorded.options?.identity.agentId).toBe(AGENT_ID);
    expect(recorded.disposed).toBe(1);
  });

  test("a committed unit that is older than its source is behind", () => {
    const directory = conversationDir();
    writeUnit();
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(directory, "messages.jsonl"), future, future);

    expect(
      isEmbeddingIndexBehind({
        agentId: AGENT_ID,
        space: {
          spaceId: spaceId(),
          spaceDir: join(root, AGENT_ID, spaceId()),
        },
        storageDir,
        memoryDir,
        root,
      }),
    ).toBe(true);
  });

  test("a committed unit whose source is older is not behind", () => {
    const directory = conversationDir();
    writeUnit();
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(directory, "messages.jsonl"), past, past);

    expect(
      isEmbeddingIndexBehind({
        agentId: AGENT_ID,
        space: {
          spaceId: spaceId(),
          spaceDir: join(root, AGENT_ID, spaceId()),
        },
        storageDir,
        memoryDir,
        root,
      }),
    ).toBe(false);
  });

  test("the cooldown starts at most one build per window", async () => {
    conversationDir();
    const recorded = recorder();
    const base = 1_000_000;
    expect(await runEmbeddingCatchUpIfBehind(input(recorded, base))).toBe(true);
    expect(
      await runEmbeddingCatchUpIfBehind(
        input(recorded, base + EMBEDDING_AUTOBUILD_COOLDOWN_MS - 1),
      ),
    ).toBe(false);
    expect(recorded.disposed).toBe(1);
  });
});
