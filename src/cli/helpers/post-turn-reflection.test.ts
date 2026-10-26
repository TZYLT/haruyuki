import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextTracker } from "@/cli/helpers/context-tracker";
import {
  maybeLaunchPostTurnReflection,
  type PostTurnReflectionTrigger,
} from "@/cli/helpers/post-turn-reflection";
import {
  getReflectionTranscriptState,
  REFLECTION_STATE_SCHEMA_VERSION,
  type ReflectionTranscriptState,
  recordReflectionUserMessage,
} from "@/cli/helpers/reflection-transcript";
import type { ReflectionSettings } from "@/reflection-settings";
import { createSharedReminderState } from "@/reminders/state";

const COMPACTION_ONLY: ReflectionSettings = {
  onCompaction: true,
  everyUserMessages: 0,
  timeoutMinutes: 3,
  deleteSessionOnSuccess: true,
};

const COUNTER_SETTINGS: ReflectionSettings = {
  onCompaction: false,
  everyUserMessages: 3,
  timeoutMinutes: 3,
  deleteSessionOnSuccess: true,
};

const BOTH_ON: ReflectionSettings = {
  onCompaction: true,
  everyUserMessages: 3,
  timeoutMinutes: 3,
  deleteSessionOnSuccess: true,
};

function stateWith(
  overrides: Partial<ReflectionTranscriptState> = {},
): ReflectionTranscriptState {
  const total = overrides.total_user_messages ?? 0;
  const reflected = overrides.reflected_user_messages ?? 0;
  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_user_messages: total,
    reflected_user_messages: reflected,
    messages_since_last_successful_reflection: Math.max(0, total - reflected),
    ...overrides,
  };
}

type RunOptions = {
  state?: ReflectionTranscriptState;
  settings?: ReflectionSettings;
  armed?: boolean;
  active?: boolean;
  launched?: boolean;
  pendingCompaction?: boolean;
};

async function run(options: RunOptions = {}) {
  const reminderState = createSharedReminderState();
  reminderState.pendingReflectionTrigger = options.pendingCompaction === true;
  const contextTracker = createContextTracker();
  const launches: PostTurnReflectionTrigger[] = [];
  const mark = mock(async () => stateWith());
  const consume = mock(async () => options.armed === true);
  const applyPending = mock(async () =>
    stateWith({ total_user_messages: 1, reflected_user_messages: 1 }),
  );
  const launch = mock(async (trigger: PostTurnReflectionTrigger) => {
    launches.push(trigger);
    return options.launched !== false;
  });
  const onCompaction = mock(async () => {});

  const didLaunch = await maybeLaunchPostTurnReflection({
    agentId: "agent-1",
    conversationId: "conv-1",
    memfsEnabled: true,
    reflectionSettings: options.settings ?? COUNTER_SETTINGS,
    reminderState,
    contextTracker,
    getTranscriptState: mock(async () => options.state ?? stateWith()),
    markUserMessagesReflected: mark as never,
    consumeUserMessageTrigger: consume as never,
    applyPendingUserMessages: applyPending as never,
    isReflectionActive: () => options.active === true,
    launch,
    onCompaction,
  });

  return {
    didLaunch,
    launches,
    mark,
    consume,
    applyPending,
    launch,
    onCompaction,
    reminderState,
    contextTracker,
  };
}

describe("maybeLaunchPostTurnReflection", () => {
  test("launches from the counter on an armed turn that reached the threshold", async () => {
    const result = await run({
      state: stateWith({ total_user_messages: 3, reflected_user_messages: 0 }),
      armed: true,
    });

    expect(result.didLaunch).toBe(true);
    expect(result.launches).toEqual(["user-messages"]);
    expect(result.mark).toHaveBeenCalledTimes(1);
  });

  test("a notification turn (nothing armed) never evaluates the counter, even above the threshold", async () => {
    const result = await run({
      state: stateWith({ total_user_messages: 5, reflected_user_messages: 0 }),
      armed: false,
    });

    expect(result.didLaunch).toBe(false);
    expect(result.launches).toEqual([]);
    expect(result.mark).not.toHaveBeenCalled();
  });

  test("an armed turn below the threshold does not launch", async () => {
    const result = await run({
      state: stateWith({ total_user_messages: 2, reflected_user_messages: 0 }),
      armed: true,
    });

    expect(result.didLaunch).toBe(false);
    expect(result.launches).toEqual([]);
    expect(result.mark).not.toHaveBeenCalled();
  });

  test("a skipped launch stages nothing, and the following notification turn stays quiet", async () => {
    const skipped = await run({
      state: stateWith({ total_user_messages: 3, reflected_user_messages: 0 }),
      armed: true,
      launched: false,
    });
    expect(skipped.didLaunch).toBe(false);
    expect(skipped.mark).not.toHaveBeenCalled();

    const notificationTurn = await run({
      state: stateWith({ total_user_messages: 3, reflected_user_messages: 0 }),
      armed: false,
    });
    expect(notificationTurn.didLaunch).toBe(false);
    expect(notificationTurn.launches).toEqual([]);
  });

  test("compaction wins over the counter when both switches are on", async () => {
    const contextTracker = createContextTracker();
    contextTracker.pendingReflectionTrigger = true;
    const reminderState = createSharedReminderState();
    const launches: PostTurnReflectionTrigger[] = [];
    const mark = mock(async () => stateWith());
    const onCompaction = mock(async () => {});

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: BOTH_ON,
      reminderState,
      contextTracker,
      getTranscriptState: mock(async () =>
        stateWith({ total_user_messages: 10 }),
      ),
      markUserMessagesReflected: mark as never,
      consumeUserMessageTrigger: mock(async () => true) as never,
      applyPendingUserMessages: mock(async () => stateWith()) as never,
      isReflectionActive: () => false,
      launch: mock(async (trigger: PostTurnReflectionTrigger) => {
        launches.push(trigger);
        return true;
      }),
      onCompaction,
    });

    expect(didLaunch).toBe(true);
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(launches).toEqual(["compaction"]);
    expect(mark).not.toHaveBeenCalled();
    expect(contextTracker.pendingReflectionTrigger).toBe(false);
    expect(reminderState.pendingReflectionTrigger).toBe(false);
  });

  test("a compaction event with the compaction switch off falls through to the counter when armed", async () => {
    const contextTracker = createContextTracker();
    contextTracker.pendingReflectionTrigger = true;
    const launches: PostTurnReflectionTrigger[] = [];

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: { ...COUNTER_SETTINGS },
      reminderState: createSharedReminderState(),
      contextTracker,
      getTranscriptState: mock(async () =>
        stateWith({ total_user_messages: 3 }),
      ),
      markUserMessagesReflected: mock(async () => stateWith()) as never,
      consumeUserMessageTrigger: mock(async () => true) as never,
      applyPendingUserMessages: mock(async () => stateWith()) as never,
      isReflectionActive: () => false,
      launch: mock(async (trigger: PostTurnReflectionTrigger) => {
        launches.push(trigger);
        return true;
      }),
    });

    expect(didLaunch).toBe(true);
    expect(launches).toEqual(["user-messages"]);
  });

  test("does not launch compaction reflection with no pending event", async () => {
    const result = await run({ settings: COMPACTION_ONLY });

    expect(result.didLaunch).toBe(false);
    expect(result.launch).not.toHaveBeenCalled();
  });

  test("never launches when both switches are off, but still consumes the event", async () => {
    const contextTracker = createContextTracker();
    contextTracker.pendingReflectionTrigger = true;
    const reminderState = createSharedReminderState();

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: {
        onCompaction: false,
        everyUserMessages: 0,
        timeoutMinutes: 3,
        deleteSessionOnSuccess: true,
      },
      reminderState,
      contextTracker,
      getTranscriptState: mock(async () =>
        stateWith({ total_user_messages: 10 }),
      ),
      consumeUserMessageTrigger: mock(async () => false) as never,
      launch: mock(async () => true),
    });

    expect(didLaunch).toBe(false);
    expect(contextTracker.pendingReflectionTrigger).toBe(false);
    expect(reminderState.pendingReflectionTrigger).toBe(false);
  });

  test("restores post-compaction reminders without launching when memfs is disabled", async () => {
    const launch = mock(async () => true);
    const reminderState = createSharedReminderState();
    reminderState.hasSentAgentInfo = true;
    reminderState.hasSentSessionContext = true;
    reminderState.hasSentSecretsInfo = true;
    const contextTracker = createContextTracker();
    contextTracker.pendingReflectionTrigger = true;

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: false,
      reflectionSettings: BOTH_ON,
      reminderState,
      contextTracker,
      getTranscriptState: mock(async () =>
        stateWith({ total_user_messages: 10 }),
      ),
      launch,
    });

    expect(didLaunch).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(reminderState.hasSentAgentInfo).toBe(false);
    expect(reminderState.hasSentSessionContext).toBe(false);
    expect(reminderState.hasSentSecretsInfo).toBe(false);
    expect(reminderState.pendingReflectionTrigger).toBe(false);
    expect(contextTracker.pendingReflectionTrigger).toBe(false);
  });

  test("never launches without an agent id, and clears the flag", async () => {
    const launch = mock(async () => true);
    const reminderState = createSharedReminderState();
    reminderState.pendingReflectionTrigger = true;

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: null,
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: BOTH_ON,
      reminderState,
      contextTracker: createContextTracker(),
      getTranscriptState: mock(async () =>
        stateWith({ total_user_messages: 10 }),
      ),
      launch,
    });

    expect(didLaunch).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(reminderState.pendingReflectionTrigger).toBe(false);
  });

  test("applies a staged mark once the run is no longer active, before evaluating", async () => {
    const applied = await run({
      state: stateWith({
        total_user_messages: 2,
        reflected_user_messages: 1,
        pending_reflected_user_messages: 2,
      }),
      active: false,
      armed: false,
    });
    expect(applied.applyPending).toHaveBeenCalledTimes(1);
    expect(applied.didLaunch).toBe(false);

    const stillRunning = await run({
      state: stateWith({
        total_user_messages: 2,
        reflected_user_messages: 1,
        pending_reflected_user_messages: 2,
      }),
      active: true,
      armed: false,
    });
    expect(stillRunning.applyPending).not.toHaveBeenCalled();
  });
});

describe("counter trigger across automated turns", () => {
  test("N=1: three user rounds with notification turns between them launch exactly three times", async () => {
    const root = await mkdtemp(join(tmpdir(), "reflection-turns-"));
    const previousRoot = process.env.LETTA_TRANSCRIPT_ROOT;
    process.env.LETTA_TRANSCRIPT_ROOT = root;
    const agentId = "agent-turns";
    const conversationId = "conv-turns";
    const settings: ReflectionSettings = {
      onCompaction: false,
      everyUserMessages: 1,
      timeoutMinutes: 3,
      deleteSessionOnSuccess: true,
    };
    let launchCount = 0;
    try {
      const turn = async (kind: "user" | "notification") => {
        if (kind === "user") {
          await recordReflectionUserMessage(agentId, conversationId);
        }
        return maybeLaunchPostTurnReflection({
          agentId,
          conversationId,
          memfsEnabled: true,
          reflectionSettings: settings,
          reminderState: createSharedReminderState(),
          contextTracker: createContextTracker(),
          // A run that finishes before the next turn: the next turn reconciles.
          isReflectionActive: () => false,
          launch: async (_trigger: PostTurnReflectionTrigger) => {
            launchCount += 1;
            return true;
          },
        });
      };

      expect(await turn("user")).toBe(true);
      expect(await turn("notification")).toBe(false);
      expect(await turn("user")).toBe(true);
      expect(await turn("notification")).toBe(false);
      expect(await turn("user")).toBe(true);
      expect(await turn("notification")).toBe(false);
      expect(launchCount).toBe(3);

      const state = await getReflectionTranscriptState(agentId, conversationId);
      expect(state.total_user_messages).toBe(3);
      expect(state.reflected_user_messages).toBe(3);
      expect(state.messages_since_last_successful_reflection).toBe(0);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.LETTA_TRANSCRIPT_ROOT;
      } else {
        process.env.LETTA_TRANSCRIPT_ROOT = previousRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
