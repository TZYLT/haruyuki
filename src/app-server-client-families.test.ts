/**
 * Client-level coverage for the M5-A additive command families added to
 * `AppServerClient` (cron, dream, compaction, usage).
 *
 * Kept in its own file so the original `app-server-client.test.ts` keeps its
 * size; each family gets a table-driven proof that the wrapper sends the right
 * discriminant and only resolves the matching response type + request id.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppServerClient,
  type AppServerSocketLike,
  type AppServerSocketOptions,
  createAppServerClient,
} from "./app-server-client";

type Listener = (event: unknown) => void;

class FakeSocket implements AppServerSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly options?: AppServerSocketOptions,
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createFakeClient() {
  const client = createAppServerClient({
    url: "http://127.0.0.1:4500",
    WebSocket: FakeSocket,
    requestTimeoutMs: 50,
  });
  // The table-driven cases build one client per iteration, so take the socket
  // the constructor just registered rather than the first one in the file.
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!socket) throw new Error("expected one socket");
  return { client, socket };
}

function sentCommand(socket: FakeSocket, index = 0): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };

type FamilyCase = {
  name: string;
  expectedType: string;
  responseType: string;
  invoke: (client: AppServerClient) => Promise<unknown>;
};

async function expectFamilyCorrelation(cases: FamilyCase[]): Promise<void> {
  for (const testCase of cases) {
    const { client, socket } = createFakeClient();
    const pending = testCase.invoke(client);
    const sent = sentCommand(socket);
    expect(sent.type, testCase.name).toBe(testCase.expectedType);
    expect(typeof sent.request_id, testCase.name).toBe("string");

    const response = {
      type: testCase.responseType,
      request_id: sent.request_id,
      success: true,
    };
    socket.receive(response);
    expect(await pending, testCase.name).toEqual(response);
    client.close();
  }
}

afterEach(() => {
  FakeSocket.instances = [];
});

describe("cron family helpers", () => {
  test("every cron wrapper sends its discriminant and correlates its response", async () => {
    await expectFamilyCorrelation([
      {
        name: "cronList",
        expectedType: "cron_list",
        responseType: "cron_list_response",
        invoke: (client) => client.cronList(),
      },
      {
        name: "cronGet",
        expectedType: "cron_get",
        responseType: "cron_get_response",
        invoke: (client) => client.cronGet({ task_id: "task-1" }),
      },
      {
        name: "cronAdd",
        expectedType: "cron_add",
        responseType: "cron_add_response",
        invoke: (client) =>
          client.cronAdd({
            agent_id: "agent-1",
            name: "Task",
            description: "A schedule",
            cron: "*/5 * * * *",
            recurring: true,
            prompt: "Do the work",
          }),
      },
      {
        name: "cronUpdate",
        expectedType: "cron_update",
        responseType: "cron_update_response",
        invoke: (client) =>
          client.cronUpdate({ task_id: "task-1", prompt: "Updated" }),
      },
      {
        name: "cronDelete",
        expectedType: "cron_delete",
        responseType: "cron_delete_response",
        invoke: (client) => client.cronDelete({ task_id: "task-1" }),
      },
      {
        name: "cronDeleteAll",
        expectedType: "cron_delete_all",
        responseType: "cron_delete_all_response",
        invoke: (client) => client.cronDeleteAll({ agent_id: "agent-1" }),
      },
      {
        name: "cronRuns",
        expectedType: "cron_runs",
        responseType: "cron_runs_response",
        invoke: (client) =>
          client.cronRuns({ task_id: "task-1", limit: 10, offset: 0 }),
      },
      {
        name: "cronTrigger",
        expectedType: "cron_trigger",
        responseType: "cron_trigger_response",
        invoke: (client) => client.cronTrigger({ task_id: "task-1" }),
      },
      {
        name: "cronPause",
        expectedType: "cron_pause",
        responseType: "cron_pause_response",
        invoke: (client) => client.cronPause({ task_id: "task-1" }),
      },
      {
        name: "cronResume",
        expectedType: "cron_resume",
        responseType: "cron_resume_response",
        invoke: (client) =>
          client.cronResume({
            task_id: "task-1",
            scheduled_for: "2026-11-01T00:00:00.000Z",
          }),
      },
    ]);
  });

  test("cronAdd resolves the cron_add_response task shape", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.cronAdd({
      agent_id: "agent-1",
      name: "Task",
      description: "A schedule",
      cron: "*/5 * * * *",
      recurring: true,
      prompt: "Do the work",
    });
    const sent = sentCommand(socket);
    const response = {
      type: "cron_add_response",
      request_id: sent.request_id,
      success: true,
      task: {
        id: "task-1",
        agent_id: "agent-1",
        conversation_id: "conv-1",
        name: "Task",
        cron: "*/5 * * * *",
        recurring: true,
        prompt: "Do the work",
        type: "prompt",
        payload: "Do the work",
        permission: "unrestricted",
        catch_up: false,
        timeout_minutes: 30,
        wait_minutes: 10,
      },
    };
    socket.receive(response);
    expect(await pending).toMatchObject(response);
    client.close();
  });

  test("cronList resolves the cron_list_response task list", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.cronList({ agent_id: "agent-1" });
    const sent = sentCommand(socket);
    expect(sent).toMatchObject({
      type: "cron_list",
      agent_id: "agent-1",
    });
    const response = {
      type: "cron_list_response",
      request_id: sent.request_id,
      success: true,
      tasks: [{ id: "task-1" }, { id: "task-2" }],
    };
    socket.receive(response);
    expect(await pending).toMatchObject(response);
    client.close();
  });

  test("passes a success:false cron_trigger_response through", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.cronTrigger({ task_id: "task-1" });
    const sent = sentCommand(socket);
    const failure = {
      type: "cron_trigger_response",
      request_id: sent.request_id,
      success: false,
      found: false,
      error: "Cron task not found",
    };
    socket.receive(failure);
    expect(await pending).toMatchObject(failure);
    client.close();
  });

  test("cronUpdate sends the F-05 fields, including the task_type wire name", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.cronUpdate({
      task_id: "task-1",
      task_type: "command",
      payload: "compact",
      target: { kind: "existing", conversation_id: "conv-1" },
      permission: "acceptEdits",
      catch_up: true,
      timeout_minutes: 0,
      wait_minutes: 5,
    });
    const sent = sentCommand(socket);
    expect(sent).toMatchObject({
      type: "cron_update",
      task_id: "task-1",
      task_type: "command",
      payload: "compact",
      target: { kind: "existing", conversation_id: "conv-1" },
      permission: "acceptEdits",
      catch_up: true,
      timeout_minutes: 0,
      wait_minutes: 5,
    });
    socket.receive({
      type: "cron_update_response",
      request_id: sent.request_id,
      success: true,
    });
    await pending;
    client.close();
  });

  test("reuses a caller-supplied request_id", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.cronGet({
      task_id: "task-1",
      request_id: "client-42",
    });
    expect(sentCommand(socket)).toMatchObject({
      type: "cron_get",
      request_id: "client-42",
      task_id: "task-1",
    });
    socket.receive({
      type: "cron_get_response",
      request_id: "client-42",
      success: true,
      found: false,
      task: null,
    });
    await pending;
    client.close();
  });
});

describe("dream family helpers", () => {
  test("every dream wrapper sends its discriminant and correlates its response", async () => {
    await expectFamilyCorrelation([
      {
        name: "dreamStatus",
        expectedType: "dream_status",
        responseType: "dream_status_response",
        invoke: (client) => client.dreamStatus({ runtime }),
      },
      {
        name: "dreamRun",
        expectedType: "dream_run",
        responseType: "dream_run_response",
        invoke: (client) => client.dreamRun({ runtime, trigger: "manual" }),
      },
      {
        name: "getDreamSettings",
        expectedType: "get_dream_settings",
        responseType: "get_dream_settings_response",
        invoke: (client) => client.getDreamSettings({ runtime }),
      },
      {
        name: "setDreamSettings",
        expectedType: "set_dream_settings",
        responseType: "set_dream_settings_response",
        invoke: (client) =>
          client.setDreamSettings({
            runtime,
            settings: { enabled: true, autoTrigger: false },
            scope: "agent",
          }),
      },
    ]);
  });

  test("surfaces a declined dream_run launch", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.dreamRun({ runtime, trigger: "manual" });
    const sent = sentCommand(socket);
    const decline = {
      type: "dream_run_response",
      request_id: sent.request_id,
      success: true,
      started: false,
      reason: "A dream run is already active",
    };
    socket.receive(decline);
    expect(await pending).toMatchObject(decline);
    client.close();
  });

  test("setDreamSettings sends the patch and scope", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.setDreamSettings({
      runtime,
      settings: { enabled: true, tiers: { task: false } },
      scope: "global",
    });
    expect(sentCommand(socket)).toMatchObject({
      type: "set_dream_settings",
      runtime,
      settings: { enabled: true, tiers: { task: false } },
      scope: "global",
    });
    socket.receive({
      type: "set_dream_settings_response",
      request_id: sentCommand(socket).request_id,
      success: true,
      settings: null,
    });
    await pending;
    client.close();
  });
});

describe("compaction family helpers", () => {
  test("every compaction wrapper sends its discriminant and correlates its response", async () => {
    await expectFamilyCorrelation([
      {
        name: "compactionPrepare",
        expectedType: "compaction_prepare",
        responseType: "compaction_prepare_response",
        invoke: (client) =>
          client.compactionPrepare({ conversation_id: "conv-1" }),
      },
      {
        name: "compactionCommit",
        expectedType: "compaction_commit",
        responseType: "compaction_commit_response",
        invoke: (client) =>
          client.compactionCommit({
            conversation_id: "conv-1",
            prepare_id: "prep-1",
            block_index: 2,
          }),
      },
      {
        name: "compactionCancel",
        expectedType: "compaction_cancel",
        responseType: "compaction_cancel_response",
        invoke: (client) =>
          client.compactionCancel({
            conversation_id: "conv-1",
            prepare_id: "prep-1",
          }),
      },
    ]);
  });

  test("compactionPrepare resolves the prepare_id and topic report", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.compactionPrepare({
      conversation_id: "conv-1",
      body: { agent_id: "agent-1" },
    });
    const sent = sentCommand(socket);
    expect(sentCommand(socket)).toMatchObject({
      type: "compaction_prepare",
      conversation_id: "conv-1",
      body: { agent_id: "agent-1" },
    });
    const response = {
      type: "compaction_prepare_response",
      request_id: sent.request_id,
      success: true,
      prepare_id: "prep-1",
      topic_report: { blocks: [] },
    };
    socket.receive(response);
    expect(await pending).toMatchObject(response);
    client.close();
  });

  test("compactionCommit surfaces the prepare_expired failure", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.compactionCommit({
      conversation_id: "conv-1",
      prepare_id: "stale-prep",
    });
    const sent = sentCommand(socket);
    // Mirrors `COMPACTION_PREPARE_EXPIRED_TEXT` from the listener, so the test
    // pins the wire prefix a desktop keys on rather than a placeholder.
    const expired = {
      type: "compaction_commit_response",
      request_id: sent.request_id,
      success: false,
      error:
        "prepare_expired: this compaction preview is no longer pending (it expired, was cancelled, or was already committed). Run compaction_prepare again to get a fresh preview.",
    };
    socket.receive(expired);
    const result = await pending;
    expect(result).toMatchObject({
      type: "compaction_commit_response",
      request_id: sent.request_id,
      success: false,
    });
    expect(result.error).toStartWith("prepare_expired:");
    client.close();
  });
});

describe("usage family helper", () => {
  test("usageAggregate sends the filters and resolves the totals", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.usageAggregate({
      agent_id: "agent-1",
      run_id: "run-1",
      from: "2026-10-01T00:00:00.000Z",
    });
    expect(sentCommand(socket)).toMatchObject({
      type: "usage_aggregate",
      agent_id: "agent-1",
      run_id: "run-1",
      from: "2026-10-01T00:00:00.000Z",
    });
    const response = {
      type: "usage_aggregate_response",
      request_id: sentCommand(socket).request_id,
      success: true,
      totals: { turns: 1 },
      runs: [{ runId: "run-1", outcomes: ["success"] }],
    };
    socket.receive(response);
    expect(await pending).toMatchObject(response);
    client.close();
  });
});

describe("correlation isolation", () => {
  test("ignores a response with the wrong type or request_id", async () => {
    const { client, socket } = createFakeClient();
    const pending = client.dreamStatus({ runtime });
    const requestId = sentCommand(socket).request_id;
    // Wrong type, then wrong id, then the matching frame.
    socket.receive({
      type: "dream_run_response",
      request_id: requestId,
      success: true,
      started: false,
    });
    socket.receive({
      type: "dream_status_response",
      request_id: "other-request",
      success: true,
      status: null,
    });
    const matching = {
      type: "dream_status_response",
      request_id: requestId,
      success: true,
      status: null,
    };
    socket.receive(matching);
    expect(await pending).toMatchObject(matching);
    client.close();
  });
});
