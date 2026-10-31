/**
 * B3: the reflection-settings wire carries the F-03 switches and the two
 * F-01/F-03 fields, additively.
 *
 * The old wire (`trigger` + `step_count`) stays required and keeps migrating
 * onto the two switches; the new fields are optional and win when present.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { settingsManager } from "@/settings-manager";
import type {
  GetReflectionSettingsCommand,
  SetReflectionSettingsCommand,
} from "@/types/protocol_v2";
import { getWorkingDirectoryScopeKey } from "@/websocket/listener/cwd";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { isSetReflectionSettingsCommand } from "@/websocket/listener/protocol-inbound";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { handleReflectionSettingsCommand } from "./settings";

const AGENT_ID = "agent-reflection";
const CONVERSATION_ID = "conversation-reflection";

const previousHome = process.env.HOME;
const previousHaruyukiHome = process.env.HARUYUKI_HOME;

let testHome: string;
let listener: ListenerRuntime;
let responses: Array<Record<string, unknown>>;

class MockSocket {
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
}

function runtimeScope() {
  return { agent_id: AGENT_ID, conversation_id: CONVERSATION_ID };
}

function getCommand(requestId: string): GetReflectionSettingsCommand {
  return {
    type: "get_reflection_settings",
    request_id: requestId,
    runtime: runtimeScope(),
  };
}

function setCommand(
  requestId: string,
  settings: SetReflectionSettingsCommand["settings"],
  scope: SetReflectionSettingsCommand["scope"] = "global",
): SetReflectionSettingsCommand {
  return {
    type: "set_reflection_settings",
    request_id: requestId,
    runtime: runtimeScope(),
    settings,
    scope,
  };
}

async function sendGet(requestId: string): Promise<Record<string, unknown>> {
  await handleReflectionSettingsCommand(
    getCommand(requestId),
    new MockSocket() as unknown as WebSocket,
    listener,
    (_socket, data) => {
      responses.push(data as Record<string, unknown>);
      return true;
    },
  );
  return responses.at(-1) as Record<string, unknown>;
}

async function sendSet(
  command: SetReflectionSettingsCommand,
): Promise<Record<string, unknown>> {
  await handleReflectionSettingsCommand(
    command,
    new MockSocket() as unknown as WebSocket,
    listener,
    (_socket, data) => {
      responses.push(data as Record<string, unknown>);
      return true;
    },
  );
  return responses.at(-1) as Record<string, unknown>;
}

beforeEach(async () => {
  await settingsManager.reset();
  testHome = await mkdtemp(join(tmpdir(), "hryk-reflection-settings-"));
  process.env.HARUYUKI_HOME = testHome;
  process.env.HOME = testHome;
  await settingsManager.initialize();
  listener = createRuntime();
  // Pin the conversation cwd so the handler never reads the checkout's own
  // project-local settings.
  listener.workingDirectoryByConversation.set(
    getWorkingDirectoryScopeKey(AGENT_ID, CONVERSATION_ID),
    join(testHome, "workspace"),
  );
  responses = [];
});

afterEach(async () => {
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(testHome, { recursive: true, force: true });
});

describe("reflection settings protocol (B3)", () => {
  test("GET returns the F-03 switches and the timeout/delete fields", async () => {
    const response = await sendGet("get-defaults");

    expect(response).toMatchObject({
      type: "get_reflection_settings_response",
      success: true,
    });
    expect(response.reflection_settings).toMatchObject({
      agent_id: AGENT_ID,
      onCompaction: true,
      everyUserMessages: 0,
      deleteSessionOnSuccess: true,
      timeoutMinutes: 3,
      // Legacy display aliases stay on the wire.
      trigger: "compaction-event",
      step_count: 25,
      merge: "auto",
      merge_instructions: "",
    });
  });

  test("SET round-trips the new fields through the persisted settings", async () => {
    const setResponse = await sendSet(
      setCommand("set-new", {
        trigger: "compaction-event",
        step_count: 25,
        on_compaction: false,
        every_user_messages: 7,
        delete_session_on_success: false,
        timeout_minutes: 9,
      }),
    );

    expect(setResponse).toMatchObject({
      type: "set_reflection_settings_response",
      success: true,
      scope: "global",
    });
    expect(setResponse.reflection_settings).toMatchObject({
      onCompaction: false,
      everyUserMessages: 7,
      deleteSessionOnSuccess: false,
      timeoutMinutes: 9,
      // Derived from the switches, not from the legacy selector.
      trigger: "step-count",
      step_count: 7,
    });

    // Re-read from disk: the persistence path actually stored the new keys.
    await settingsManager.reset();
    await settingsManager.initialize();
    const reread = await sendGet("get-after-set");
    expect(reread.reflection_settings).toMatchObject({
      onCompaction: false,
      everyUserMessages: 7,
      deleteSessionOnSuccess: false,
      timeoutMinutes: 9,
    });
  });

  test("an old request with only trigger/step_count keeps its old behaviour", async () => {
    await sendSet(
      setCommand("set-then-legacy", {
        trigger: "compaction-event",
        step_count: 25,
        timeout_minutes: 12,
        delete_session_on_success: false,
      }),
    );

    const legacyResponse = await sendSet(
      setCommand("legacy-only", {
        trigger: "step-count",
        step_count: 12,
        merge: "explicit",
        merge_instructions: "ignored",
      }),
    );

    // The legacy selector still migrates onto the two switches...
    expect(legacyResponse.reflection_settings).toMatchObject({
      onCompaction: false,
      everyUserMessages: 12,
      trigger: "step-count",
      step_count: 12,
    });
    // ...while the omitted new fields keep their current values.
    expect(legacyResponse.reflection_settings).toMatchObject({
      timeoutMinutes: 12,
      deleteSessionOnSuccess: false,
    });
  });

  test("isSetReflectionSettingsCommand accepts valid new fields and rejects invalid ones", () => {
    const base: SetReflectionSettingsCommand = setCommand("validate", {
      trigger: "off",
      step_count: 25,
    });

    expect(isSetReflectionSettingsCommand(base)).toBe(true);
    expect(
      isSetReflectionSettingsCommand({
        ...base,
        settings: {
          ...base.settings,
          on_compaction: false,
          every_user_messages: 0,
          delete_session_on_success: true,
          timeout_minutes: 60,
        },
      }),
    ).toBe(true);

    for (const invalid of [
      { on_compaction: "yes" },
      { every_user_messages: -1 },
      { every_user_messages: 1.5 },
      { every_user_messages: "7" },
      { delete_session_on_success: "true" },
      { timeout_minutes: 0 },
      { timeout_minutes: 1.5 },
    ]) {
      expect(
        isSetReflectionSettingsCommand({
          ...base,
          settings: { ...base.settings, ...invalid },
        }),
      ).toBe(false);
    }
  });
});
