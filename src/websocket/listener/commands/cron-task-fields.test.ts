/**
 * F-05 additive schedule fields on the app-server protocol.
 *
 * Kept beside the handler rather than inside `protocol-inbound.test.ts`: the
 * inbound monolith is a legacy file and directory guidance says not to grow it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type WebSocket from "ws";
import {
  addTask,
  DREAM_PLACEHOLDER_CRON,
  getTask,
  serializeDreamTaskPayload,
} from "@/cron";
import type { CronAddCommand, CronUpdateCommand } from "@/types/protocol_v2";
import { handleCronCommand } from "@/websocket/listener/commands/cron";
import type { SafeSocketSend } from "@/websocket/listener/commands/types";
import {
  isCronAddCommand,
  isCronUpdateCommand,
} from "@/websocket/listener/protocol-inbound";

const TEST_DIR = path.join(import.meta.dir, "__cron_task_fields_test_tmp__");
const originalHome = process.env.HARUYUKI_HOME;

let messages: unknown[];
const socket = {} as WebSocket;
const safeSocketSend: SafeSocketSend = (_socket, payload) => {
  messages.push(payload);
  return true;
};

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  messages = [];
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (originalHome) process.env.HARUYUKI_HOME = originalHome;
  else delete process.env.HARUYUKI_HOME;
});

type SentMessage = {
  type: string;
  request_id?: string;
  success?: boolean;
  error?: string;
  task?: Record<string, unknown>;
};

function findSent(type: string): SentMessage | undefined {
  return messages.find(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === type,
  ) as SentMessage | undefined;
}

function cronAdd(overrides: Partial<CronAddCommand> = {}): CronAddCommand {
  return {
    type: "cron_add",
    request_id: "add-1",
    agent_id: "agent-1",
    conversation_id: "conv-1",
    name: "Task",
    description: "A schedule",
    cron: "*/5 * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "Do the work",
    ...overrides,
  };
}

function cronUpdate(
  taskId: string,
  overrides: Partial<CronUpdateCommand> = {},
): CronUpdateCommand {
  return {
    type: "cron_update",
    request_id: "update-1",
    task_id: taskId,
    ...overrides,
  };
}

function addStoredPromptTask(prompt = "Original prompt") {
  return addTask({
    agent_id: "agent-1",
    conversation_id: "conv-1",
    name: "Stored task",
    description: "A stored schedule",
    cron: "*/5 * * * *",
    timezone: "UTC",
    recurring: true,
    prompt,
  }).task;
}

function addStoredCommandTask() {
  return addTask({
    agent_id: "agent-1",
    conversation_id: "conv-1",
    name: "Command task",
    description: "Runs a command",
    cron: "*/5 * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "",
    type: "command",
    payload: "compact",
    target: { kind: "existing", conversation_id: "conv-1" },
  }).task;
}

function addStoredDreamTask() {
  return addTask({
    agent_id: "agent-1",
    name: "Dream carrier",
    description: "",
    cron: DREAM_PLACEHOLDER_CRON,
    timezone: "UTC",
    recurring: true,
    prompt: "",
    payload: serializeDreamTaskPayload({ version: 1 }),
    type: "dream",
    target: { kind: "new", hidden: true },
    timeout_minutes: 0,
    wait_minutes: 0,
  }).task;
}

// ── Validator: additive acceptance ──────────────────────────────────

describe("cron command validators accept the F-05 fields", () => {
  test("a prompt-only cron_add is still valid", () => {
    expect(isCronAddCommand(cronAdd())).toBe(true);
  });

  test("a fully specified cron_add is valid", () => {
    expect(
      isCronAddCommand(
        cronAdd({
          task_type: "command",
          payload: "compact",
          target: { kind: "existing", conversation_id: "conv-1" },
          permission: "acceptEdits",
          catch_up: true,
          timeout_minutes: 0,
          wait_minutes: 5,
        }),
      ),
    ).toBe(true);
  });

  test("a new-conversation target is valid", () => {
    expect(
      isCronAddCommand(
        cronAdd({
          task_type: "prompt",
          conversation_id: undefined,
          target: { kind: "new", hidden: true },
        }),
      ),
    ).toBe(true);
  });

  test("a minimal cron_update is still valid", () => {
    expect(
      isCronUpdateCommand({
        type: "cron_update",
        request_id: "update-1",
        task_id: "task-1",
      }),
    ).toBe(true);
  });

  test("a fully specified cron_update is valid", () => {
    expect(
      isCronUpdateCommand(
        cronUpdate("task-1", {
          task_type: "prompt",
          payload: "Updated body",
          target: { kind: "new", hidden: false },
          permission: "standard",
          catch_up: false,
          timeout_minutes: 5,
          wait_minutes: 0,
        }),
      ),
    ).toBe(true);
  });
});

// ── Validator: rejection ────────────────────────────────────────────

const invalidAddFields: Array<[string, Record<string, unknown>]> = [
  ["unknown task_type", { task_type: "reflection" }],
  ["wrong-case task_type", { task_type: "Prompt" }],
  ["non-string payload", { payload: 42 }],
  ["null target", { target: null }],
  ["unknown target kind", { target: { kind: "future", hidden: false } }],
  ["new target without hidden", { target: { kind: "new" } }],
  [
    "new target with non-boolean hidden",
    { target: { kind: "new", hidden: "yes" } },
  ],
  ["existing target without conversation_id", { target: { kind: "existing" } }],
  [
    "existing target with non-string conversation_id",
    { target: { kind: "existing", conversation_id: 7 } },
  ],
  ["unknown permission tier", { permission: "admin" }],
  ["non-boolean catch_up", { catch_up: "true" }],
  ["negative timeout_minutes", { timeout_minutes: -1 }],
  ["fractional timeout_minutes", { timeout_minutes: 1.5 }],
  ["string wait_minutes", { wait_minutes: "5" }],
];

for (const [label, patch] of invalidAddFields) {
  test(`rejects cron_add with ${label}`, () => {
    expect(isCronAddCommand({ ...cronAdd(), ...patch })).toBe(false);
  });
}

const invalidUpdateFields: Array<[string, Record<string, unknown>]> = [
  ["unknown task_type", { task_type: "reflect" }],
  ["non-string payload", { payload: 42 }],
  ["unknown target kind", { target: { kind: "future" } }],
  ["new target without hidden", { target: { kind: "new" } }],
  ["unknown permission tier", { permission: "root" }],
  ["non-boolean catch_up", { catch_up: 1 }],
  ["negative wait_minutes", { wait_minutes: -5 }],
  ["fractional timeout_minutes", { timeout_minutes: 0.5 }],
];

for (const [label, patch] of invalidUpdateFields) {
  test(`rejects cron_update with ${label}`, () => {
    expect(isCronUpdateCommand({ ...cronUpdate("task-1"), ...patch })).toBe(
      false,
    );
  });
}

// ── Handler: cron_add passthrough ───────────────────────────────────

describe("cron_add of the F-05 fields", () => {
  test("persists and echoes every additive field", async () => {
    await handleCronCommand(
      cronAdd({
        task_type: "command",
        payload: "compact",
        target: { kind: "existing", conversation_id: "conv-1" },
        permission: "acceptEdits",
        catch_up: true,
        timeout_minutes: 0,
        wait_minutes: 5,
      }),
      socket,
      safeSocketSend,
    );

    const response = findSent("cron_add_response");
    expect(response).toMatchObject({
      success: true,
      task: {
        type: "command",
        payload: "compact",
        target: { kind: "existing", conversation_id: "conv-1" },
        permission: "acceptEdits",
        catch_up: true,
        timeout_minutes: 0,
        wait_minutes: 5,
      },
    });

    const task = getTask(response?.task?.id as string);
    expect(task).toMatchObject({
      conversation_id: "conv-1",
      type: "command",
      payload: "compact",
      target: { kind: "existing", conversation_id: "conv-1" },
      permission: "acceptEdits",
      catch_up: true,
      timeout_minutes: 0,
      wait_minutes: 5,
    });
  });

  test("a prompt-only request keeps the pre-F-05 record shape and defaults", async () => {
    await handleCronCommand(cronAdd(), socket, safeSocketSend);

    const response = findSent("cron_add_response");
    expect(response).toMatchObject({
      success: true,
      task: {
        type: "prompt",
        prompt: "Do the work",
        payload: "Do the work",
        permission: "unrestricted",
        catch_up: false,
        timeout_minutes: 30,
        wait_minutes: 10,
      },
    });

    const task = getTask(response?.task?.id as string);
    expect(task).toMatchObject({
      type: "prompt",
      prompt: "Do the work",
      payload: "Do the work",
      target: { kind: "existing", conversation_id: "conv-1" },
      permission: "unrestricted",
      catch_up: false,
      timeout_minutes: 30,
      wait_minutes: 10,
    });
  });
});

// ── Handler: cron_update passthrough and coherence ──────────────────

describe("cron_update of the F-05 fields", () => {
  test("persists and echoes the additive fields", async () => {
    const task = addStoredPromptTask();

    await handleCronCommand(
      cronUpdate(task.id, {
        task_type: "command",
        payload: "compact",
        target: { kind: "existing", conversation_id: "conv-1" },
        permission: "standard",
        catch_up: true,
        timeout_minutes: 15,
        wait_minutes: 2,
      }),
      socket,
      safeSocketSend,
    );

    const response = findSent("cron_update_response");
    expect(response).toMatchObject({
      success: true,
      task: {
        type: "command",
        payload: "compact",
        permission: "standard",
        catch_up: true,
        timeout_minutes: 15,
        wait_minutes: 2,
      },
    });
    expect(getTask(task.id)).toMatchObject({
      conversation_id: "conv-1",
      type: "command",
      payload: "compact",
      target: { kind: "existing", conversation_id: "conv-1" },
      permission: "standard",
      catch_up: true,
      timeout_minutes: 15,
      wait_minutes: 2,
    });
  });

  test("a target-only update derives conversation_id", async () => {
    const task = addStoredPromptTask();

    await handleCronCommand(
      cronUpdate(task.id, {
        target: { kind: "existing", conversation_id: "conv-2" },
      }),
      socket,
      safeSocketSend,
    );

    expect(findSent("cron_update_response")).toMatchObject({ success: true });
    expect(getTask(task.id)).toMatchObject({
      conversation_id: "conv-2",
      target: { kind: "existing", conversation_id: "conv-2" },
    });
  });

  test("a legacy conversation_id-only update derives the target", async () => {
    const task = addStoredPromptTask();

    await handleCronCommand(
      cronUpdate(task.id, { conversation_id: "conv-3" }),
      socket,
      safeSocketSend,
    );

    expect(findSent("cron_update_response")).toMatchObject({ success: true });
    expect(getTask(task.id)).toMatchObject({
      conversation_id: "conv-3",
      target: { kind: "existing", conversation_id: "conv-3" },
    });
  });

  test("a legacy prompt-only update keeps prompt and payload coherent", async () => {
    const task = addStoredPromptTask("Original prompt");

    await handleCronCommand(
      cronUpdate(task.id, { prompt: "Updated prompt" }),
      socket,
      safeSocketSend,
    );

    expect(findSent("cron_update_response")).toMatchObject({ success: true });
    expect(getTask(task.id)).toMatchObject({
      type: "prompt",
      prompt: "Updated prompt",
      payload: "Updated prompt",
    });
  });

  test("rejects a target that contradicts conversation_id", async () => {
    const task = addStoredPromptTask();

    await handleCronCommand(
      cronUpdate(task.id, {
        conversation_id: "conv-1",
        target: { kind: "existing", conversation_id: "conv-9" },
      }),
      socket,
      safeSocketSend,
    );

    const response = findSent("cron_update_response");
    expect(response).toMatchObject({ success: false });
    expect(response?.error).toContain("target and conversation_id disagree");
    expect(getTask(task.id)?.conversation_id).toBe("conv-1");
  });
});

// ── Merged-state constraint: command tasks need an existing target ──

describe("cron_update enforces the command target constraint", () => {
  test("rejects retyping to command or retargeting a command to a new conversation", async () => {
    // prompt -> command while the merged target would be `new`.
    const promptTask = addStoredPromptTask();
    await handleCronCommand(
      cronUpdate(promptTask.id, {
        task_type: "command",
        target: { kind: "new", hidden: false },
      }),
      socket,
      safeSocketSend,
    );
    const retypeResponse = findSent("cron_update_response");
    expect(retypeResponse).toMatchObject({ success: false });
    expect(retypeResponse?.error).toContain("existing conversation");
    expect(getTask(promptTask.id)).toMatchObject({
      type: "prompt",
      conversation_id: "conv-1",
      target: { kind: "existing", conversation_id: "conv-1" },
    });

    // A command task cannot be retargeted to a fresh conversation either.
    messages = [];
    const commandTask = addStoredCommandTask();
    await handleCronCommand(
      cronUpdate(commandTask.id, {
        target: { kind: "new", hidden: false },
      }),
      socket,
      safeSocketSend,
    );
    const retargetResponse = findSent("cron_update_response");
    expect(retargetResponse).toMatchObject({ success: false });
    expect(retargetResponse?.error).toContain("existing conversation");
    expect(getTask(commandTask.id)).toMatchObject({
      type: "command",
      conversation_id: "conv-1",
      target: { kind: "existing", conversation_id: "conv-1" },
    });
  });

  test("allows retyping to command when the target is an existing conversation", async () => {
    const task = addStoredPromptTask();

    await handleCronCommand(
      cronUpdate(task.id, {
        task_type: "command",
        target: { kind: "existing", conversation_id: "conv-1" },
      }),
      socket,
      safeSocketSend,
    );

    expect(findSent("cron_update_response")).toMatchObject({ success: true });
    expect(getTask(task.id)).toMatchObject({
      type: "command",
      conversation_id: "conv-1",
      target: { kind: "existing", conversation_id: "conv-1" },
    });
  });

  test("allows a prompt task to target a new conversation", async () => {
    const task = addStoredPromptTask();

    await handleCronCommand(
      cronUpdate(task.id, {
        task_type: "prompt",
        target: { kind: "new", hidden: true },
      }),
      socket,
      safeSocketSend,
    );

    expect(findSent("cron_update_response")).toMatchObject({ success: true });
    expect(getTask(task.id)).toMatchObject({
      type: "prompt",
      conversation_id: "new",
      target: { kind: "new", hidden: true },
    });
  });
});

// ── Dream carriers (F-06) ───────────────────────────────────────────

describe("cron_update protects dream carriers", () => {
  test("refuses to retype, repayload, or retarget a dream carrier", async () => {
    const task = addStoredDreamTask();
    const patches: Array<Partial<CronUpdateCommand>> = [
      { task_type: "prompt" },
      { payload: "plain text" },
      { target: { kind: "existing", conversation_id: "conv-1" } },
    ];

    for (const patch of patches) {
      messages = [];
      await handleCronCommand(
        cronUpdate(task.id, patch),
        socket,
        safeSocketSend,
      );

      const response = findSent("cron_update_response");
      expect(response).toMatchObject({ success: false });
      expect(response?.error).toContain("Dream schedule carriers");
      expect(getTask(task.id)).toMatchObject({
        type: "dream",
        target: { kind: "new", hidden: true },
      });
    }
  });

  test("refuses to convert a normal task into a dream carrier", async () => {
    const task = addStoredPromptTask();

    await handleCronCommand(
      cronUpdate(task.id, { task_type: "dream" }),
      socket,
      safeSocketSend,
    );

    const response = findSent("cron_update_response");
    expect(response).toMatchObject({ success: false });
    expect(response?.error).toContain("cannot be converted into a dream");
    expect(getTask(task.id)?.type).toBe("prompt");
  });
});
