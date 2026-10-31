/**
 * Behaviour smoke for the listener's post-turn reflection path (F-03 §8.1 #15).
 *
 * The listener calls the shared evaluator from `turn-completion.ts`; the real
 * chain is exercised here: a completed turn → `maybeLaunchPostTurnReflection` →
 * `buildMaybeLaunchReflectionSubagent` → the real `launchReflectionSubagent`
 * (cheap checks, run controller, memory lock, fork through the backend, task
 * spawn) with only the child process faked. No source grep, no real LLM, no
 * network.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  getActiveReflectionRun,
  isReflectionRunActive,
  resetReflectionRuns,
} from "@/agent/reflection-run";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import type { spawnSubagent } from "@/agent/subagents/manager";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import { resetReflectionRetries } from "@/cli/helpers/reflection-retry";
import {
  getReflectionTranscriptState,
  recordReflectionUserMessage,
} from "@/cli/helpers/reflection-transcript";
import { settingsManager } from "@/settings-manager";
import { initGitRepo } from "@/test-utils/temp-git-repo";
import { backgroundTasks } from "@/tools/impl/process_manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import type { ListenerTransport } from "./transport";

/**
 * The child-process boundary. `spawnSubagent` is the single point where a
 * background subagent becomes an OS process; keeping everything above it real
 * (task bookkeeping, subagent state, run controller) is what makes this a
 * listener-path smoke rather than a unit test of the launcher.
 * Runs in its own process via `scripts/isolated-unit-tests.json`.
 */
const spawnCalls: Array<{
  type: string;
  prompt: string;
  subagentId: string;
  existingConversationId: string | undefined;
  parentConversationId: string | undefined;
  config: { allowedTools?: unknown } | undefined;
}> = [];
const childResolvers: Array<(result: SubagentResult) => void> = [];

const actualManager = await import("@/agent/subagents/manager");
mock.module("@/agent/subagents/manager", () => ({
  ...actualManager,
  spawnSubagent: (
    ...[
      type,
      prompt,
      _exactModelHandle,
      subagentId,
      _signal,
      _existingAgentId,
      existingConversationId,
      _maxTurns,
      _forkedContext,
      _parentAgentId,
      _transcriptPath,
      parentConversationId,
      _memoryScope,
      _systemPromptOverride,
      _environment,
      config,
    ]: Parameters<typeof spawnSubagent>
  ) => {
    spawnCalls.push({
      type,
      prompt,
      subagentId,
      existingConversationId,
      parentConversationId,
      config: config as { allowedTools?: unknown } | undefined,
    });
    // A running child: the listener never waits for it, and the test releases it
    // when it wants the run to settle.
    return new Promise<SubagentResult>((resolve) => {
      childResolvers.push(resolve);
    });
  },
}));

const { completeSuccessfulListenerTurn } = await import("./turn-completion");

const openTransport: ListenerTransport = {
  kind: "local",
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};

const memoryDirectories: string[] = [];
const turnWorkingDirectories: string[] = [];

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await Bun.sleep(5);
  }
}

/** One fresh agent: settings, a conversation and a git-backed memory checkout. */
async function setupTurn() {
  const agentId = `agent-listener-reflection-${crypto.randomUUID()}`;
  const backend = new FakeHeadlessBackend(agentId);
  await backend.retrieveAgent(agentId);
  const conversation = await backend.createConversation({ agent_id: agentId });
  __testSetBackend(backend);
  settingsManager.setMemfsEnabled(agentId, true);

  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  mkdirSync(memoryDir, { recursive: true });
  initGitRepo(memoryDir);
  memoryDirectories.push(memoryDir);

  // The post-turn evaluator resolves reflection settings against the
  // conversation's working directory. Pin it to a throwaway project: the
  // 3-level settings chain reads that project's (empty) `.haruyuki/` layers, so
  // a gitignored `.haruyuki/settings.local.json` in the checkout cannot
  // override the global threshold this test sets. Project-local settings are
  // loaded lazily by unrelated paths (subagent stop hooks) and would otherwise
  // win for the lifetime of the process.
  const workingDirectory = mkdtempSync(join(tmpdir(), "hryk-reflection-turn-"));
  turnWorkingDirectories.push(workingDirectory);

  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    agentId,
    conversation.id,
  );

  const completeTurn = () =>
    completeSuccessfulListenerTurn({
      runtime,
      socket: openTransport,
      agentId,
      conversationId: conversation.id,
      workingDirectory,
      permissionMode: "standard",
      transcriptLines: [],
      getCachedAgent: () => null,
      isInterrupted: () => false,
    });

  return {
    agentId,
    backend,
    conversationId: conversation.id,
    workingDirectory,
    runtime,
    completeTurn,
  };
}

beforeEach(async () => {
  spawnCalls.length = 0;
  childResolvers.length = 0;
  await settingsManager.reset();
  await settingsManager.initialize();
  // The counter is off by default; turn it on with a threshold of one message.
  settingsManager.updateSettings({ reflectionEveryUserMessages: 1 });
});

afterEach(async () => {
  resetReflectionRuns();
  resetReflectionRetries();
  clearAllSubagents();
  backgroundTasks.clear();
  __testSetBackend(null);
  await settingsManager.reset();
  for (const directory of memoryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const directory of turnWorkingDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.restore();
});

describe("listener post-turn reflection", () => {
  test("a completed turn launches exactly one reflection on a fork of the conversation", async () => {
    const turn = await setupTurn();
    await recordReflectionUserMessage(turn.agentId, turn.conversationId);

    expect(await turn.completeTurn()).toBe("completed");
    await waitFor(
      () => getActiveReflectionRun(turn.agentId) !== undefined,
      "the reflection run to be registered",
    );

    const run = getActiveReflectionRun(turn.agentId);
    if (!run) throw new Error("Reflection run missing");
    expect(run.triggerSource).toBe("user-messages");
    expect(run.parentConversationId).toBe(turn.conversationId);
    const forkConversationId = run.forkConversationId;
    if (!forkConversationId) throw new Error("Reflection fork missing");

    // The fork is a real conversation record in the backend, hidden from the
    // default listing and visible only when hidden conversations are asked for.
    const fork = await turn.backend.retrieveConversation(forkConversationId);
    expect(fork.id).toBe(forkConversationId);
    const listIds = async (includeHidden: boolean) => {
      const page = await turn.backend.listConversations(
        includeHidden ? { include_hidden: true } : {},
      );
      const items = Array.isArray(page)
        ? (page as Array<{ id: string }>)
        : (
            page as unknown as { getPaginatedItems(): Array<{ id: string }> }
          ).getPaginatedItems();
      return items.map((conversation) => conversation.id);
    };
    expect(await listIds(false)).not.toContain(forkConversationId);
    expect(await listIds(true)).toContain(forkConversationId);

    // Exactly one child, resumed on the fork, carrying the run's task message.
    expect(spawnCalls).toHaveLength(1);
    const spawn = spawnCalls[0];
    if (!spawn) throw new Error("Spawn call missing");
    expect(spawn.type).toBe("reflection");
    expect(spawn.existingConversationId).toBe(forkConversationId);
    expect(spawn.parentConversationId).toBe(turn.conversationId);
    expect(spawn.prompt).toContain(`Run id: ${run.runId}`);
    expect(spawn.config?.allowedTools).toBe("all");

    const state = await getReflectionTranscriptState(
      turn.agentId,
      turn.conversationId,
    );
    // A consumed arm is stored as absent, never as a truthy flag.
    expect(state.pending_user_message_trigger).toBeUndefined();
    expect(state.pending_reflected_user_messages).toBe(1);
  });

  test("a turn with no new user message launches nothing once the previous run finished", async () => {
    const turn = await setupTurn();
    // Fixture guard: the effective policy must be the global threshold above,
    // not a project-local override the checkout's `.haruyuki/` layers would
    // supply once any unrelated path loads them.
    expect(
      getReflectionSettings(turn.agentId, turn.workingDirectory)
        .everyUserMessages,
    ).toBe(1);
    await recordReflectionUserMessage(turn.agentId, turn.conversationId);
    await turn.completeTurn();
    await waitFor(
      () => getActiveReflectionRun(turn.agentId) !== undefined,
      "the first reflection run",
    );

    // The child finishes: the staged reflected mark may now become real.
    childResolvers.shift()?.({
      agentId: "",
      conversationId: "unused",
      report: "",
      success: true,
    });
    await waitFor(
      () => !isReflectionRunActive(turn.agentId),
      "the reflection run to finish",
    );

    // An automated turn (no counted user message) must not launch anything.
    expect(await turn.completeTurn()).toBe("completed");
    expect(spawnCalls).toHaveLength(1);
    expect(
      await getReflectionTranscriptState(turn.agentId, turn.conversationId),
    ).toMatchObject({
      total_user_messages: 1,
      reflected_user_messages: 1,
      messages_since_last_successful_reflection: 0,
    });

    // The next real user message re-arms the one-shot trigger.
    await recordReflectionUserMessage(turn.agentId, turn.conversationId);
    await turn.completeTurn();
    await waitFor(
      () => spawnCalls.length === 2,
      "the second reflection launch",
    );
    expect(getActiveReflectionRun(turn.agentId)?.triggerSource).toBe(
      "user-messages",
    );
  });

  test("a compaction event wins over the counter arm and is consumed once", async () => {
    const turn = await setupTurn();
    // Both triggers are on for this turn: one counted user message (the counter
    // would fire at N=1) and a pending compaction.
    settingsManager.updateSettings({
      reflectionOnCompaction: true,
      reflectionEveryUserMessages: 1,
    });
    await recordReflectionUserMessage(turn.agentId, turn.conversationId);
    turn.runtime.contextTracker.pendingReflectionTrigger = true;

    await turn.completeTurn();
    await waitFor(
      () => getActiveReflectionRun(turn.agentId) !== undefined,
      "the compaction reflection run",
    );

    expect(getActiveReflectionRun(turn.agentId)?.triggerSource).toBe(
      "compaction",
    );
    expect(spawnCalls).toHaveLength(1);

    const state = await getReflectionTranscriptState(
      turn.agentId,
      turn.conversationId,
    );
    // Compaction wins: the counter arm is discarded, and no mark is staged.
    expect(state.pending_user_message_trigger).toBeUndefined();
    expect(state.pending_reflected_user_messages).toBeUndefined();
    expect(turn.runtime.contextTracker.pendingReflectionTrigger).toBe(false);
  });
});
