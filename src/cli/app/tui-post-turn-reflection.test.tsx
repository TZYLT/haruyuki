/**
 * Behaviour smoke for the TUI's post-turn reflection path (F-03 §8.1 #15).
 *
 * Mounts the production `<App>` against a fake in-process backend, types a real
 * prompt, and lets the real end_turn branch run: `useConversationLoop` →
 * `AppCoordinator.maybeRunPostTurnReflection` → `maybeLaunchPostTurnReflection`
 * → `launchReflectionSubagent` (cheap checks, run controller, memory lock, fork,
 * task spawn). Only the backend and the child process are fakes; there is no
 * real LLM call and no OS process.
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
import { mkdirSync, rmSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { type Instance, render } from "ink";
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
import {
  FakeHeadlessBackend,
  HEADLESS_BACKEND_CAPABILITIES,
} from "@/backend/dev/fake-headless-backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { resetReflectionRetries } from "@/cli/helpers/reflection-retry";
import { getReflectionTranscriptState } from "@/cli/helpers/reflection-transcript";
import { settingsManager } from "@/settings-manager";
import { initGitRepo } from "@/test-utils/temp-git-repo";
import { backgroundTasks } from "@/tools/impl/process_manager";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
} from "@/utils/message-queue-bridge";
import { formatTaskNotification } from "@/utils/task-notifications";

/**
 * Stand-in for the local backend's MemFS capability: reflection only runs when
 * memfs is enabled, and the local backend is memfs-capable by construction.
 */
class LocalMemfsFakeBackend extends FakeHeadlessBackend {
  override readonly capabilities = {
    ...HEADLESS_BACKEND_CAPABILITIES,
    localMemfs: true,
  };
}

/**
 * The child-process boundary. `spawnSubagent` is where a background subagent
 * becomes an OS process; everything above it stays real so the smoke covers the
 * TUI path and the launcher's fork/spawn wiring. Runs isolated per
 * `scripts/isolated-unit-tests.json`.
 */
const spawnCalls: Array<{
  type: string;
  prompt: string;
  existingConversationId: string | undefined;
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
      _subagentId,
      _signal,
      _existingAgentId,
      existingConversationId,
      _maxTurns,
      _forkedContext,
      _parentAgentId,
      _transcriptPath,
      _parentConversationId,
      _memoryScope,
      _systemPromptOverride,
      _environment,
      config,
    ]: Parameters<typeof spawnSubagent>
  ) => {
    spawnCalls.push({
      type,
      prompt,
      existingConversationId,
      config: config as { allowedTools?: unknown } | undefined,
    });
    // A running child: the TUI never waits for it; the test releases it.
    return new Promise<SubagentResult>((resolve) => {
      childResolvers.push(resolve);
    });
  },
}));

const { App } = await import("@/cli/App");

class TuiOutputStream extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

const renderedInstances = new Set<Instance>();
const memoryDirectories: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await sleep(10);
  }
}

/** Emits a completed compaction event, then a normal reply that ends the turn. */
function compactionThenReply(): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "summary_message",
        id: "compaction-summary-1",
        summary: "compacted history",
      } as unknown as LettaStreamingResponse;
      yield {
        message_type: "assistant_message",
        content: [{ type: "text", text: "pong after compaction" }],
      } as LettaStreamingResponse;
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function recordingExecutor(
  inputs: HeadlessTurnExecutorInput[],
  turns: HeadlessTurnExecutor["execute"][],
): HeadlessTurnExecutor {
  return {
    async execute(input) {
      inputs.push(input);
      const turn = turns[Math.min(inputs.length - 1, turns.length - 1)];
      if (!turn) throw new Error("No turn scripted");
      return turn(input);
    },
  };
}

async function renderReflectionApp(): Promise<{
  agentId: string;
  conversationId: string;
  stdin: NodeJS.ReadStream;
  inputs: HeadlessTurnExecutorInput[];
}> {
  const agentId = `agent-tui-reflection-${crypto.randomUUID()}`;
  const inputs: HeadlessTurnExecutorInput[] = [];
  const executor = recordingExecutor(inputs, [
    async () => createAssistantMessageStream(),
    async () => createAssistantMessageStream(),
  ]);
  const backend = new LocalMemfsFakeBackend(agentId, executor);
  __testSetBackend(backend);
  const agentState = await backend.retrieveAgent(agentId);
  const conversation = await backend.createConversation({ agent_id: agentId });

  // The launcher takes a real memory-operation lock inside the checkout.
  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  mkdirSync(memoryDir, { recursive: true });
  initGitRepo(memoryDir);
  memoryDirectories.push(memoryDir);

  const stdin = createInputStream();
  const stdout = new TuiOutputStream() as TuiOutputStream & NodeJS.WriteStream;
  const instance = render(
    <App
      agentId={agentId}
      agentState={agentState}
      conversationId={conversation.id}
      modsDisabled
      systemInfoReminderEnabled={false}
    />,
    {
      stdout,
      stdin,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  renderedInstances.add(instance);
  await waitFor(isQueueBridgeConnected, "the TUI queue bridge to mount");
  return { agentId, conversationId: conversation.id, stdin, inputs };
}

async function typePrompt(stdin: NodeJS.ReadStream, text: string) {
  await sleep(200);
  stdin.push(text);
  await sleep(50);
  stdin.push("\r");
}

beforeEach(async () => {
  spawnCalls.length = 0;
  childResolvers.length = 0;
  clearPendingMessages();
  await settingsManager.reset();
  await settingsManager.initialize();
  // The counter is off by default; turn it on with a threshold of one message.
  settingsManager.updateSettings({ reflectionEveryUserMessages: 1 });
});

afterEach(async () => {
  for (const instance of renderedInstances) {
    instance.unmount();
    instance.cleanup();
  }
  renderedInstances.clear();
  clearPendingMessages();
  resetReflectionRuns();
  resetReflectionRetries();
  clearAllSubagents();
  backgroundTasks.clear();
  __testSetBackend(null);
  await settingsManager.reset();
  for (const directory of memoryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.restore();
});

describe("TUI post-turn reflection", () => {
  test("a submitted prompt launches exactly one reflection after end_turn", async () => {
    const { agentId, conversationId, stdin, inputs } =
      await renderReflectionApp();

    await typePrompt(stdin, "first user turn");
    await waitFor(
      () => spawnCalls.length === 1,
      "the reflection launch after the user turn",
    );

    const run = getActiveReflectionRun(agentId);
    if (!run) throw new Error("Reflection run missing");
    expect(run.triggerSource).toBe("user-messages");
    expect(run.parentConversationId).toBe(conversationId);
    expect(run.forkConversationId).toBeString();

    expect(inputs).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
    const spawn = spawnCalls[0];
    if (!spawn) throw new Error("Spawn call missing");
    expect(spawn.type).toBe("reflection");
    expect(spawn.existingConversationId).toBe(run.forkConversationId);
    expect(spawn.prompt).toContain(`Run id: ${run.runId}`);
    expect(spawn.config?.allowedTools).toBe("all");

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_user_messages).toBe(1);
    expect(state.pending_user_message_trigger).toBeUndefined();
    expect(state.pending_reflected_user_messages).toBe(1);

    // Let the child finish so the staged mark can become real.
    childResolvers.shift()?.({
      agentId: "",
      conversationId: "unused",
      report: "",
      success: true,
    });
    await waitFor(
      () => !isReflectionRunActive(agentId),
      "the reflection run to finish",
    );

    // An automated turn (queue bridge task notification) arms nothing and must
    // not launch a second reflection even though one is due by count.
    addToMessageQueue({
      kind: "task_notification",
      text: formatTaskNotification({
        taskId: "reflection-smoke-notification",
        status: "completed",
        summary: "automated turn without a user message",
        result: "done",
        outputFile: "/tmp/reflection-smoke-notification.log",
      }),
    });
    await waitFor(() => inputs.length === 2, "the notification turn");
    await sleep(500);
    expect(spawnCalls).toHaveLength(1);
    expect(getActiveReflectionRun(agentId)).toBeUndefined();

    // The next real user message re-arms the one-shot counter trigger.
    await typePrompt(stdin, "second user turn");
    await waitFor(
      () => spawnCalls.length === 2,
      "the second reflection launch",
    );
    expect(getActiveReflectionRun(agentId)?.triggerSource).toBe(
      "user-messages",
    );
  }, 30_000);

  test("a compaction that ends the turn launches for compaction, not the counter", async () => {
    const agentId = `agent-tui-reflection-compaction-${crypto.randomUUID()}`;
    const inputs: HeadlessTurnExecutorInput[] = [];
    const backend = new LocalMemfsFakeBackend(
      agentId,
      recordingExecutor(inputs, [async () => compactionThenReply()]),
    );
    __testSetBackend(backend);
    const agentState = await backend.retrieveAgent(agentId);
    const conversation = await backend.createConversation({
      agent_id: agentId,
    });
    const memoryDir = getScopedMemoryFilesystemRoot(agentId);
    mkdirSync(memoryDir, { recursive: true });
    initGitRepo(memoryDir);
    memoryDirectories.push(memoryDir);

    const stdin = createInputStream();
    const stdout = new TuiOutputStream() as TuiOutputStream &
      NodeJS.WriteStream;
    const instance = render(
      <App
        agentId={agentId}
        agentState={agentState}
        conversationId={conversation.id}
        modsDisabled
        systemInfoReminderEnabled={false}
      />,
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );
    renderedInstances.add(instance);
    await waitFor(isQueueBridgeConnected, "the TUI queue bridge to mount");

    // The typed prompt arms the counter, so the compaction must win on merit.
    await typePrompt(stdin, "turn that compacts");
    await waitFor(
      () => spawnCalls.length === 1,
      "the compaction reflection launch",
    );

    expect(getActiveReflectionRun(agentId)?.triggerSource).toBe("compaction");
    expect(inputs).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);

    const state = await getReflectionTranscriptState(agentId, conversation.id);
    expect(state.pending_user_message_trigger).toBeUndefined();
    // Compaction wins: the counter trigger stages no reflected mark.
    expect(state.pending_reflected_user_messages).toBeUndefined();
  }, 30_000);
});
