import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishReflectionRun,
  getReflectionRun,
  isReflectionRunActive,
  resetReflectionRuns,
  startReflectionRun,
} from "@/agent/reflection-run";
import type { SubagentConfig } from "@/agent/subagents";
import type { ForkParentConversationParams } from "@/agent/subagents/fork-conversation";
import {
  clearAutomaticReflectionSuppression,
  getReflectionLaunchSkippedMessage,
  isAutomaticReflectionSuppressed,
  launchReflectionSubagent,
  type ReflectionLaunchDependencies,
  type ReflectionLaunchOptions,
  recordReflectionConfigurationFailure,
  releaseReflectionLaunch,
  shouldSuppressReflectionLaunch,
} from "@/cli/helpers/reflection-launcher";
import { resetReflectionRetries } from "@/cli/helpers/reflection-retry";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import type { TimedOutReflectionRunInput } from "@/usage/automated";

const agentId = "agent-t1-launcher";
const conversationId = "conv-parent";
const temporaryDirectories: string[] = [];

afterEach(() => {
  resetReflectionRuns();
  resetReflectionRetries();
  releaseReflectionLaunch(agentId);
  clearAutomaticReflectionSuppression(agentId);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function launchOptions(
  overrides: Partial<ReflectionLaunchOptions> = {},
): ReflectionLaunchOptions {
  return {
    agentId,
    conversationId,
    memfsEnabled: true,
    triggerSource: "user-messages",
    ...overrides,
  };
}

const reflectionConfig: SubagentConfig = {
  name: "reflection",
  description: "Reflect",
  systemPrompt: "",
  allowedTools: ["Bash", "Edit"],
  skills: [],
  fork: false,
  launchProfile: "memory-subagent",
};

interface Harness {
  deps: ReflectionLaunchDependencies;
  forks: ForkParentConversationParams[];
  spawns: SpawnBackgroundSubagentTaskArgs[];
  metadata: unknown[];
  deleted: string[];
  lockReleases: number;
  complete: (result: { success: boolean; error?: string }) => Promise<void>;
}

/**
 * Every seam a launch crosses is stubbed: no filesystem, no settings manager, no
 * child process. The defaults are the "happy" answers each test then bends.
 */
function harness(
  overrides: Partial<ReflectionLaunchDependencies> = {},
): Harness {
  const memoryRoot = mkdtempSync(join(tmpdir(), "reflection-launch-"));
  temporaryDirectories.push(memoryRoot);
  const forks: Harness["forks"] = [];
  const spawns: SpawnBackgroundSubagentTaskArgs[] = [];
  const metadata: unknown[] = [];
  const deleted: string[] = [];
  let lockReleases = 0;
  let complete: Harness["complete"] = async () => undefined;

  const deps: ReflectionLaunchDependencies = {
    claimMemoryLock: async () => async () => {
      lockReleases += 1;
    },
    forkConversation: async (params) => {
      forks.push(params);
      return { id: "conv-fork-1" };
    },
    spawnTask: (args) => {
      spawns.push(args);
      complete = async (result) => {
        await args.onComplete?.(result);
      };
      return {
        taskId: "task-1",
        outputFile: "/tmp/task-1.out",
        subagentId: "subagent-1",
      };
    },
    resolveConfig: async () => reflectionConfig,
    memoryRoot: () => memoryRoot,
    memoryFormat: () => "memfs-v1",
    deleteConversation: async (forkId) => {
      deleted.push(forkId);
    },
    writeRunMetadata: async (input) => {
      metadata.push(input);
    },
    ...overrides,
  };

  return {
    deps,
    forks,
    spawns,
    metadata,
    deleted,
    get lockReleases() {
      return lockReleases;
    },
    complete: (result) => complete(result),
  } as Harness;
}

describe("launchReflectionSubagent cheap checks", () => {
  test("skips when the memory filesystem is disabled", async () => {
    const h = harness();
    const result = await launchReflectionSubagent(
      launchOptions({ memfsEnabled: false }),
      h.deps,
    );

    expect(result).toEqual({ launched: false, reason: "memfs_disabled" });
    expect(h.forks).toHaveLength(0);
    expect(h.spawns).toHaveLength(0);
  });

  test("skips while automatic reflection is suppressed by a bad model config", async () => {
    recordReflectionConfigurationFailure({
      agentId,
      model: "openai-proxy/missing",
      error: '400 {"error":"Model handle not found: openai-proxy/missing"}',
    });
    const h = harness();

    const automatic = await launchReflectionSubagent(launchOptions(), h.deps);
    const manual = await launchReflectionSubagent(
      launchOptions({ triggerSource: "manual" }),
      h.deps,
    );

    expect(automatic).toEqual({
      launched: false,
      reason: "configuration_error",
    });
    expect(manual.launched).toBe(true);
  });

  test("skips while a run is already registered for the agent", async () => {
    startReflectionRun({
      agentId,
      parentConversationId: conversationId,
      triggerSource: "compaction",
      timeoutMinutes: 3,
    });
    const h = harness();

    const result = await launchReflectionSubagent(
      launchOptions({ triggerSource: "compaction" }),
      h.deps,
    );

    expect(result).toEqual({ launched: false, reason: "already_active" });
    expect(h.forks).toHaveLength(0);
  });

  test("skips and releases the run when the memory checkout is held", async () => {
    const h = harness({
      claimMemoryLock: async () => null,
    });

    const result = await launchReflectionSubagent(launchOptions(), h.deps);

    expect(result).toEqual({ launched: false, reason: "lock_busy" });
    expect(h.forks).toHaveLength(0);
    // The reserved run did not leak: the agent can launch again.
    expect(isReflectionRunActive(agentId)).toBe(false);
  });
});

describe("launchReflectionSubagent run creation", () => {
  test("creates exactly one fork and spawns exactly once", async () => {
    const h = harness();
    const taskInstruction = "focus on the migration plan";

    const result = await launchReflectionSubagent(
      launchOptions({ instruction: taskInstruction }),
      h.deps,
    );

    expect(result.launched).toBe(true);
    if (!result.launched) throw new Error("expected a launch");

    // One fork, context-only, from this conversation.
    expect(h.forks).toHaveLength(1);
    expect(h.forks[0]).toMatchObject({
      parentAgentId: agentId,
      parentConversationId: conversationId,
      origin: "reflection",
      contextMode: "inherited-context",
      provenanceParentConversationId: conversationId,
    });

    // One spawn, resuming the fork, with the tool set left untouched: the child
    // must not narrow what the frozen prefix already advertised (§5.1.8).
    expect(h.spawns).toHaveLength(1);
    const spawn = h.spawns[0];
    expect(spawn?.existingConversationId).toBe("conv-fork-1");
    expect(spawn?.subagentType).toBe("reflection");
    expect(spawn?.config?.allowedTools).toBe("all");
    expect(spawn?.prompt).toContain(result.runId);
    expect(spawn?.prompt).toContain(taskInstruction);

    // The durable run record is written `running` before the spawn is attached.
    expect(h.metadata).toEqual([
      {
        conversationId: "conv-fork-1",
        metadata: expect.objectContaining({
          runId: result.runId,
          triggerSource: "user-messages",
          parentConversationId: conversationId,
          status: "running",
          deadlineAt: expect.any(Number),
        }),
      },
    ]);

    expect(h.deleted).toHaveLength(0);
    expect(isReflectionRunActive(agentId)).toBe(true);
    expect(result.forkConversationId).toBe("conv-fork-1");
    expect(result.subagentId).toBe("subagent-1");

    // Completion finishes the run once, releases the lock once and releases the
    // reservation so the next turn can reflect again.
    await h.complete({ success: true });

    expect(getReflectionRun(result.runId)?.status).toBe("succeeded");
    expect(isReflectionRunActive(agentId)).toBe(false);
    expect(h.lockReleases).toBe(1);
    expect(h.forks).toHaveLength(1);
    expect(h.spawns).toHaveLength(1);
  });

  test("records the deadline the controller armed after the spawn", async () => {
    const h = harness();
    const before = Date.now();
    const result = await launchReflectionSubagent(
      launchOptions({ reflectionSettings: { timeoutMinutes: 7 } }),
      h.deps,
    );
    if (!result.launched) throw new Error("expected a launch");

    const recorded = h.metadata[0] as {
      metadata: { deadlineAt: number | null };
    };
    // Anchored at the successful spawn, not at registration: the recorded value
    // is the controller's, within a few ms of launch time + the configured cap.
    expect(recorded.metadata.deadlineAt).toBeGreaterThanOrEqual(
      before + 7 * 60_000,
    );
    expect(recorded.metadata.deadlineAt).toBeLessThanOrEqual(
      Date.now() + 7 * 60_000,
    );
  });

  test("records a null deadline for a run with no wall-clock limit", async () => {
    const h = harness();
    const result = await launchReflectionSubagent(
      launchOptions({ reflectionSettings: { timeoutMinutes: 0 } }),
      h.deps,
    );
    if (!result.launched) throw new Error("expected a launch");

    const recorded = h.metadata[0] as {
      metadata: { deadlineAt: number | null };
    };
    expect(recorded.metadata.deadlineAt).toBeNull();
  });

  test("launches even when recording the run metadata fails", async () => {
    const h = harness({
      writeRunMetadata: async () => {
        throw new Error("conversation.json is read-only");
      },
    });

    const result = await launchReflectionSubagent(launchOptions(), h.deps);

    // Durable copy is best effort; the in-process run is the gate authority.
    expect(result.launched).toBe(true);
    expect(h.spawns).toHaveLength(1);
  });
});

describe("launchReflectionSubagent failure cleanup", () => {
  test("skips with fork_failed and releases the lock when forking throws", async () => {
    const h = harness({
      forkConversation: async () => {
        throw new Error("conversation not found");
      },
    });

    const result = await launchReflectionSubagent(launchOptions(), h.deps);

    expect(result).toEqual({
      launched: false,
      reason: "fork_failed",
      error: expect.any(Error),
    });
    expect(h.spawns).toHaveLength(0);
    expect(h.lockReleases).toBe(1);
    expect(isReflectionRunActive(agentId)).toBe(false);
    // No fork existed, so nothing to delete.
    expect(h.deleted).toHaveLength(0);
  });

  test("deletes the half-built fork when the spawn throws", async () => {
    const h = harness({
      spawnTask: () => {
        throw new Error("background task capacity exceeded");
      },
    });

    const result = await launchReflectionSubagent(launchOptions(), h.deps);

    expect(result).toEqual({
      launched: false,
      reason: "error",
      error: expect.any(Error),
    });
    // A fork nobody will ever run on must not survive as an empty hidden session.
    expect(h.deleted).toEqual(["conv-fork-1"]);
    expect(h.lockReleases).toBe(1);
    expect(isReflectionRunActive(agentId)).toBe(false);

    // A startup failure opens the §5.5.7 backoff window: the next automatic
    // attempt is deferred, a manual one is not.
    const retry = harness();
    const deferred = await launchReflectionSubagent(
      launchOptions(),
      retry.deps,
    );
    expect(deferred).toEqual({ launched: false, reason: "retry_backoff" });
    const manual = await launchReflectionSubagent(
      launchOptions({ triggerSource: "manual" }),
      retry.deps,
    );
    expect(manual.launched).toBe(true);
  });
});

describe("reflection configuration failure suppression", () => {
  test("suppresses automatic launches but allows manual retries", () => {
    expect(
      recordReflectionConfigurationFailure({
        agentId,
        model: "openai-proxy/deepseek-v4-flash",
        error:
          '400 {"error":"Model handle not found: openai-proxy/deepseek-v4-flash"}',
      }),
    ).toBe(true);

    expect(isAutomaticReflectionSuppressed(agentId)).toBe(true);
    expect(shouldSuppressReflectionLaunch(agentId, "user-messages")).toBe(true);
    expect(shouldSuppressReflectionLaunch(agentId, "compaction")).toBe(true);
    expect(shouldSuppressReflectionLaunch(agentId, "manual")).toBe(false);
  });

  test("does not suppress automatic reflection for retryable failures", () => {
    expect(
      recordReflectionConfigurationFailure({
        agentId,
        model: "letta/auto-memory",
        error: "Connection error.",
      }),
    ).toBe(false);
    expect(isAutomaticReflectionSuppressed(agentId)).toBe(false);
  });
});

describe("getReflectionLaunchSkippedMessage", () => {
  test("formats the reasons a caller can surface", () => {
    expect(getReflectionLaunchSkippedMessage("already_active")).toContain(
      "already running",
    );
    expect(getReflectionLaunchSkippedMessage("memfs_disabled")).toContain(
      "Memory filesystem is not enabled.",
    );
    expect(getReflectionLaunchSkippedMessage("configuration_error")).toContain(
      "Automatic reflection is paused",
    );
    expect(getReflectionLaunchSkippedMessage("lock_busy")).toContain(
      "another process",
    );
    // Silent skips: nothing to tell the user.
    expect(getReflectionLaunchSkippedMessage("retry_backoff")).toBeUndefined();
    expect(getReflectionLaunchSkippedMessage("fork_failed")).toBeUndefined();
    expect(getReflectionLaunchSkippedMessage("error")).toBeUndefined();
  });
});

describe("launchReflectionSubagent timeout accounting", () => {
  test("writes one zero-token timeout row when the run already ended at its deadline", async () => {
    const rows: TimedOutReflectionRunInput[] = [];
    const h = harness({
      recordTimeoutUsage: async (input) => {
        rows.push(input);
        return true;
      },
    });

    const result = await launchReflectionSubagent(launchOptions(), h.deps);
    if (!result.launched) throw new Error("expected a launch");

    // The controller finishes a timed-out run before the child's completion
    // callback arrives; only the parent can record that ending (§5.16.4).
    await finishReflectionRun(result.runId, "timeout");
    await h.complete({ success: false, error: "timed out" });

    expect(rows).toEqual([
      {
        runId: result.runId,
        agentId,
        sessionId: "conv-fork-1",
        parentSessionId: conversationId,
        model: "unknown",
        wallMs: 0,
      },
    ]);
  });

  test("writes no timeout row when the run finishes normally", async () => {
    const rows: TimedOutReflectionRunInput[] = [];
    const h = harness({
      recordTimeoutUsage: async (input) => {
        rows.push(input);
        return true;
      },
    });

    const result = await launchReflectionSubagent(launchOptions(), h.deps);
    if (!result.launched) throw new Error("expected a launch");
    await h.complete({ success: true });

    expect(getReflectionRun(result.runId)?.status).toBe("succeeded");
    expect(rows).toHaveLength(0);
  });
});
