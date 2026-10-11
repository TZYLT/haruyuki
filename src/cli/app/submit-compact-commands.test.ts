/**
 * Behavioural coverage for `/compact` (D-110 + D-119).
 *
 * The command is where "the user picks the cut point" actually happens, so the
 * claims under test are: a numbered pick trims and reports; a bare `/compact`
 * parks a request for the picker instead of trimming; an unmarked conversation
 * trims by ratio without a picker; mode arguments are refused locally; and a
 * non-local backend keeps the cloud path. The environment (command runner,
 * reminder state, description regeneration) is faked, because the point is the
 * ordering of the calls the command makes, not the terminal it renders into.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  type CompactCommandContext,
  handleCompactCommand,
  isCompactCommand,
  offerTrimBeforeSend,
  type SendPressureContext,
} from "@/cli/app/submit-compact-commands";
import type { ActiveOverlay, AppCommandRunner } from "@/cli/app/types";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
} from "@/cli/helpers/compact-command";
import {
  type ContextTracker,
  createContextTracker,
} from "@/cli/helpers/context-tracker";
import { takeTopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import {
  createSharedReminderState,
  type SharedReminderState,
} from "@/reminders/state";
import { settingsManager } from "@/settings-manager";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "compact-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  __testSetBackend(null);
  takeTopicTrimRequest();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

const okExecutor: HeadlessTurnExecutor = {
  async execute() {
    return lettaStreamFromChunks([
      {
        message_type: "assistant_message",
        content: [{ type: "text", text: "ok" }],
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse,
    ]);
  },
};

interface RecordedCommand {
  input: string;
  output: string;
  succeeded: boolean;
  failed: boolean;
}

/** A command runner stand-in that records what the flow told the user. */
function recordingRunner(commands: RecordedCommand[]): AppCommandRunner {
  const start = (input: string, output: string) => {
    const record: RecordedCommand = {
      input,
      output,
      succeeded: false,
      failed: false,
    };
    commands.push(record);
    return {
      id: `cmd-${commands.length}`,
      input,
      update: (update: { output: string }) => {
        record.output = update.output;
      },
      finish: (output: string, success = true) => {
        record.output = output;
        record.succeeded = success;
      },
      fail: (output: string) => {
        record.output = output;
        record.failed = true;
      },
    };
  };
  return { start, getHandle: () => null } as unknown as AppCommandRunner;
}

interface Harness {
  ctx: CompactCommandContext & SendPressureContext;
  commands: RecordedCommand[];
  overlays: ActiveOverlay[];
  reminderState: SharedReminderState;
  tracker: ContextTracker;
  descriptions: () => number;
}

function harness(input: {
  conversationId: string;
  agentId: string;
  contextWindow?: number;
  contextTokens?: number;
}): Harness {
  const commands: RecordedCommand[] = [];
  const overlays: ActiveOverlay[] = [];
  const state = { descriptions: 0 };
  const reminderState = createSharedReminderState();
  const tracker = createContextTracker();
  tracker.lastContextTokens = input.contextTokens ?? 0;
  const ctx: CompactCommandContext & SendPressureContext = {
    agentDescription: null,
    agentId: input.agentId,
    agentName: "Local",
    agentStateRef: { current: null },
    appendTaskNotificationEvents: () => true,
    commandRunner: recordingRunner(commands),
    contextTrackerRef: { current: tracker },
    conversationIdRef: { current: input.conversationId },
    effectiveContextWindowSize: input.contextWindow,
    generateConversationDescription: async () => {
      state.descriptions += 1;
    },
    setActiveOverlay: (value) => {
      overlays.push(typeof value === "function" ? null : value);
    },
    setCommandRunning: () => {},
    sharedReminderStateRef: { current: reminderState },
  };
  return {
    ctx,
    commands,
    overlays,
    reminderState,
    tracker,
    descriptions: () => state.descriptions,
  };
}

/** A local conversation with `turns` turns of ~100 tokens each. */
async function localConversation(
  turns: number,
  markAfter?: { afterTurn: number; title: string },
): Promise<{
  backend: LocalBackend;
  agentId: string;
  conversationId: string;
  markTopic: (title: string) => void;
}> {
  const backend = new LocalBackend({
    storageDir: await createStorageDirectory(),
    executor: okExecutor,
    complete: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }) as never,
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Local",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: 2_000,
    },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  for (let turn = 0; turn < turns; turn += 1) {
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: agent.id,
        messages: [
          { role: "user", content: `turn ${turn} ${"x".repeat(400)}` },
        ],
      } as ConversationMessageCreateBody,
    );
    for await (const _chunk of stream) {
      // drain
    }
    if (markAfter && turn + 1 === markAfter.afterTurn) {
      backend.markTopic({
        conversationId: conversation.id,
        agentId: agent.id,
        title: markAfter.title,
        createdBy: "agent",
      });
    }
  }
  __testSetBackend(backend);
  return {
    backend,
    agentId: agent.id,
    conversationId: conversation.id,
    markTopic(title: string) {
      backend.markTopic({
        conversationId: conversation.id,
        agentId: agent.id,
        title,
        createdBy: "agent",
      });
    },
  };
}

describe("isCompactCommand", () => {
  test("matches the command and its arguments only", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("  /compact 2 ")).toBe(true);
    expect(isCompactCommand("/compaction")).toBe(false);
    expect(isCompactCommand("/topics")).toBe(false);
  });
});

describe("handleCompactCommand", () => {
  test("help prints the new usage and touches no backend", async () => {
    const h = harness({ conversationId: "c", agentId: "a" });

    await handleCompactCommand("/compact help", h.ctx);

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.succeeded).toBe(true);
    expect(h.commands[0]?.output).toBe(COMPACT_COMMAND_USAGE);
    expect(h.commands[0]?.output).toContain("/compact <n>");
  });

  test("an invalid argument is refused with the usage", async () => {
    const h = harness({ conversationId: "c", agentId: "a" });

    await handleCompactCommand("/compact nope", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain('Unknown argument "nope"');
  });

  test("a numbered pick trims, reports, and marks the context changed", async () => {
    const local = await localConversation(8);
    local.markTopic("Alpha");
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    // Pretend the one-shot execution-context reminders were already sent: a
    // compaction must re-arm them, because it evicted what they described.
    h.reminderState.hasSentAgentInfo = true;
    h.reminderState.hasSentSessionContext = true;

    await handleCompactCommand("/compact 2", h.ctx);

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.failed).toBe(false);
    expect(h.commands[0]?.output).toContain("Context trimmed.");
    expect(h.commands[0]?.output).toContain(
      "cut point:  the topic block you picked",
    );
    expect(h.commands[0]?.output).toContain("topics:     Alpha");
    expect(h.commands[0]?.output).toContain("evicts the provider cache");
    // A compaction owes the reminder runtime and the description a refresh.
    expect(h.reminderState.hasSentAgentInfo).toBe(false);
    expect(h.reminderState.hasSentSessionContext).toBe(false);
    expect(h.reminderState.pendingSessionContextReason).toBe("post_compaction");
    expect(h.descriptions()).toBe(1);
    // No picker was involved.
    expect(h.overlays).toEqual([]);
    expect(takeTopicTrimRequest()).toBeNull();
  });

  test("an out-of-range block is refused by name", async () => {
    const local = await localConversation(4);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact 9", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("There is no topic block 9");
  });

  test("picking the first block compresses down to the rate instead of refusing", async () => {
    const local = await localConversation(8);
    local.markTopic("Alpha");
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact 1", h.ctx);

    expect(h.commands[0]?.succeeded).toBe(true);
    expect(h.commands[0]?.output).toContain("Context trimmed.");
    expect(h.commands[0]?.output).toContain(
      "the compression rate (the picked block kept more than the rate allows)",
    );
  });

  test("a successful trim re-bases the pressure baseline (M-5)", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 2_000,
      contextTokens: 1_900,
    });
    h.tracker.lastPressureNotice = "hard";

    await handleCompactCommand("/compact 2", h.ctx);

    // The context shrank without a provider round trip, so the very next send has
    // to be judged on what is left rather than on the tokens the trim removed.
    expect(h.tracker.lastContextTokens).toBeLessThan(1_900);
    expect(h.tracker.lastContextTokens).toBeGreaterThan(0);
    // A fresh baseline deserves a fresh notice.
    expect(h.tracker.lastPressureNotice).toBeUndefined();
  });

  test("a refused trim leaves the pressure baseline alone (M-5)", async () => {
    // An empty context cannot be trimmed at all, so the baseline must stay where
    // the last provider round trip left it.
    const local = await localConversation(0);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 2_000,
      contextTokens: 1_900,
    });

    await handleCompactCommand("/compact", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain(
      "nothing in this conversation's context to trim",
    );
    expect(h.tracker.lastContextTokens).toBe(1_900);
  });

  test("a bare /compact with markers parks a picker request instead of trimming", async () => {
    // The marker closes a topic early, so the ratio suggestion lands in the
    // second block: the cursor's default is a block the user can pick.
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact", h.ctx);

    // The invocation itself is on the record before the picker opens, so Esc or
    // Cancel leaves a trace (L-1); nothing has been trimmed yet.
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.input).toBe("/compact");
    expect(h.commands[0]?.output).toBe("Choose the topic block to keep...");
    expect(h.commands[0]?.succeeded).toBe(false);
    expect(h.overlays).toEqual(["compaction"]);
    const request = takeTopicTrimRequest();
    expect(request).not.toBeNull();
    expect(request?.blocks.map((block) => block.title)).toEqual([
      "Alpha",
      null,
    ]);
    expect(request?.suggestionIndex).toBe(2);

    // The pick runs the trim the picker promised, and clears the overlay first.
    request?.onPick(2);
    await Bun.sleep(0);
    expect(h.overlays.at(-1)).toBeNull();
    expect(h.commands.at(-1)?.output).toContain("Context trimmed.");
  });

  test("cancelling the picker closes the invocation without trimming", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    await handleCompactCommand("/compact", h.ctx);

    takeTopicTrimRequest()?.onCancel?.();

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toBe("Cancelled: the context is unchanged.");
  });

  test("confirming the suggested row is reported as the ratio's suggestion (V9)", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    await handleCompactCommand("/compact", h.ctx);

    const request = takeTopicTrimRequest();
    expect(request?.suggestionIndex).toBe(2);
    // Enter on the default cursor row: the block is the ratio's suggestion.
    request?.onPick(request?.suggestionIndex ?? 0);
    await Bun.sleep(0);

    expect(h.commands.at(-1)?.output).toContain(
      "cut point:  compression rate (the suggested block kept more",
    );
    expect(h.commands.at(-1)?.output).not.toContain(
      "the topic block you picked",
    );
  });

  test("picking block 1 is cut down to the compression rate, not refused", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    await handleCompactCommand("/compact", h.ctx);

    // Block 1 keeps the whole context, and the rate caps what any cut may keep,
    // so the pick resolves to the rate's own cut instead of doing nothing.
    takeTopicTrimRequest()?.onPick(1);
    await Bun.sleep(0);

    expect(h.commands.at(-1)?.output).toContain("Context trimmed.");
    expect(h.commands.at(-1)?.output).toContain(
      "the compression rate (the picked block kept more than the rate allows)",
    );
    expect(h.commands.at(-1)?.output).not.toContain("Nothing to trim");
  });

  test("a bare /compact with no markers compresses by the rate and says so (D-119)", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact", h.ctx);

    // No picker: one ratio-driven trim, with the hint that explains why.
    expect(h.overlays).toEqual([]);
    expect(takeTopicTrimRequest()).toBeNull();
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("Context trimmed.");
    expect(h.commands[0]?.output).toContain(
      "cut point:  the compression rate (no marker defines a boundary here",
    );
    expect(h.commands[0]?.output).toContain(
      "compression rate decided the cut point",
    );
  });

  test("one marker at the start of the context compresses by the rate instead of a one-row picker (H-2)", async () => {
    // The marker's effective boundary clamps onto the first message, so the
    // context has a single block and there is no choice to offer.
    const local = await localConversation(8, { afterTurn: 1, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact", h.ctx);

    expect(h.overlays).toEqual([]);
    expect(takeTopicTrimRequest()).toBeNull();
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("Context trimmed.");
    expect(h.commands[0]?.output).toContain(
      "cut point:  the compression rate (no marker defines a boundary here",
    );
    // The note must not claim nothing was marked: the marker is right there.
    expect(h.commands[0]?.output).toContain(
      "sits at the very start of the current context",
    );
    expect(h.commands[0]?.output).not.toContain("No topic markers yet");
  });

  test("an out-of-range number points at the rate path instead of a dead end (H-2)", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact 9", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("There is no topic block 9");
    expect(h.commands[0]?.output).toContain("compress by the rate");
  });

  test("a mode argument is refused locally", async () => {
    const local = await localConversation(4);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact sliding_window", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toBe(COMPACT_MODE_LOCAL_UNSUPPORTED);
  });

  test("a non-local backend keeps the cloud path and rejects block numbers", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const h = harness({ conversationId: "default", agentId: "agent-x" });

    await handleCompactCommand("/compact 3", h.ctx);
    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("requires the local backend");
  });
});

describe("offerTrimBeforeSend (D-112)", () => {
  test("an uncrowded context says nothing and sends", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 100,
    });
    let sent = 0;

    const deferred = await offerTrimBeforeSend(h.ctx, async () => {
      sent += 1;
    });

    expect(deferred).toBe(false);
    expect(h.commands).toEqual([]);
    await Promise.resolve();
    expect(sent).toBe(0);
  });

  test("a soft crossing prints one line and does not repeat it", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 750,
    });

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("about 75%");
    expect(h.commands[0]?.output).toContain("/compact compresses older topics");

    // Same tier again: no second line.
    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toHaveLength(1);

    // Dropping back under the threshold re-arms the notice.
    h.tracker.lastContextTokens = 100;
    await offerTrimBeforeSend(h.ctx, async () => {});
    h.tracker.lastContextTokens = 750;
    await offerTrimBeforeSend(h.ctx, async () => {});
    expect(h.commands).toHaveLength(2);
  });

  test("a soft crossing advises /compact even when the transcript is tiny", async () => {
    // Two messages at 75% of the window: the prompt floor dominates the total.
    // The compression rate is relative to the transcript, so `/compact` still has
    // something to do — the advice is never impossible.
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 750,
    });

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands[0]?.output).toContain("/compact compresses older topics");
    expect(h.commands[0]?.output).not.toContain("would write nothing");
  });

  test("a hard crossing with blocks parks the picker, then sends after the trim", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 900,
    });
    const sent: number[] = [];

    const deferred = await offerTrimBeforeSend(h.ctx, async () => {
      sent.push(1);
    });

    expect(deferred).toBe(true);
    expect(sent).toEqual([]);
    expect(h.overlays).toEqual(["compaction"]);
    // The hint for "pick something" is not printed: the picker is the message.
    expect(h.commands).toEqual([]);

    const request = takeTopicTrimRequest();
    expect(request?.suggestionIndex).toBe(2);
    request?.onPick(2);
    await Bun.sleep(0);
    // The trim reports itself, and the message the user typed is sent afterwards.
    expect(h.commands[0]?.output).toContain("Context trimmed.");
    expect(sent).toEqual([1]);
    expect(h.overlays.at(-1)).toBeNull();
  });

  test("skipping the picker still sends the message", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 900,
    });
    const sent: number[] = [];

    await offerTrimBeforeSend(h.ctx, async () => {
      sent.push(1);
    });
    takeTopicTrimRequest()?.onCancel?.();
    await Bun.sleep(0);

    expect(sent).toEqual([1]);
    // Nothing was trimmed: skip means "send as it is".
    expect(h.commands).toEqual([]);
  });

  test("a hard crossing with no markers warns instead of trimming", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 900,
    });

    const deferred = await offerTrimBeforeSend(h.ctx, async () => {});

    expect(deferred).toBe(false);
    expect(h.overlays).toEqual([]);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain(
      "past the point where a turn this large can be sent",
    );
    expect(h.commands[0]?.output).toContain("/topic <title>");
  });

  test("a cloud backend is left alone", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const h = harness({
      conversationId: "default",
      agentId: "agent-x",
      contextWindow: 1_000,
      contextTokens: 900,
    });

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toEqual([]);
    expect(h.overlays).toEqual([]);
  });
});

/**
 * D-115: `topicSoftPressureRatio` decides where the advisory line starts, and
 * `0` turns it off (the hard tier, which refuses nothing by itself, is not the
 * user's to configure here).
 */
describe("the advisory tier follows topicSoftPressureRatio (D-115)", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "compact-ratio-settings-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  /** 75% of the window: above the default 0.7, below the 0.8 hard threshold. */
  async function crowded(): Promise<Harness> {
    const local = await localConversation(2);
    return harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 750,
    });
  }

  test("0 turns the advisory line off", async () => {
    settingsManager.updateSettings({ topicSoftPressureRatio: 0 });
    const h = await crowded();

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toEqual([]);
    expect(h.overlays).toEqual([]);
  });

  test("a lower ratio starts advising sooner", async () => {
    settingsManager.updateSettings({ topicSoftPressureRatio: 0.5 });
    const h = await crowded();

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("about 75%");
  });
});

/**
 * D-114: the user's half of the no-marker nudge. The reminder engine decides it
 * while building this turn's message and parks the numbers on the shared
 * reminder state; the send path prints the line once and clears it.
 */
describe("the topic nudge line (D-114)", () => {
  test("prints the parked notice once and clears it", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 10_000,
      contextTokens: 100,
    });
    h.reminderState.pendingTopicNudge = {
      turnsSinceLastMarker: 52,
      nudgeTurns: 50,
    };

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain(
      "52 user turns without a topic marker",
    );
    expect(h.commands[0]?.output).toContain("/topic <title>");
    expect(h.reminderState.pendingTopicNudge).toBeNull();

    // Nothing parked: the next send says nothing at all.
    await offerTrimBeforeSend(h.ctx, async () => {});
    expect(h.commands).toHaveLength(1);
  });

  test("a cloud backend never prints it", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const h = harness({
      conversationId: "default",
      agentId: "agent-x",
      contextWindow: 10_000,
      contextTokens: 100,
    });
    h.reminderState.pendingTopicNudge = {
      turnsSinceLastMarker: 52,
      nudgeTurns: 50,
    };

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toEqual([]);
    expect(h.reminderState.pendingTopicNudge).not.toBeNull();
  });
});

/**
 * Feature ②: the user's half of a recall degradation, timeout, or breaker trip.
 * Same contract as the topic nudge above — the provider parks the notice while
 * the turn is being built, and the send path prints it once and clears it.
 */
describe("the recall notice line (feature ②)", () => {
  test("prints a parked degradation once and clears it", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 10_000,
      contextTokens: 100,
    });
    h.reminderState.pendingRecallNotice = { kind: "index-missing" };

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("/recall build");
    expect(h.reminderState.pendingRecallNotice).toBeNull();

    // Nothing parked: the next send says nothing at all.
    await offerTrimBeforeSend(h.ctx, async () => {});
    expect(h.commands).toHaveLength(1);
  });

  test("names the trip and how to undo it", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 10_000,
      contextTokens: 100,
    });
    h.reminderState.pendingRecallNotice = {
      kind: "tripped",
      failures: 3,
      reason: "the recall deadline expired",
    };

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands[0]?.output).toContain("3 turns in a row");
    expect(h.commands[0]?.output).toContain("/recall on");
    expect(h.reminderState.pendingRecallNotice).toBeNull();
  });
});
