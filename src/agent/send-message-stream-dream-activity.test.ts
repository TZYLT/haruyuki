/**
 * F-06 idle semantics at the dispatch seam.
 *
 * The TUI, headless and the listener all send through
 * `sendMessageStreamWithBackend`. These tests pin the contract that matters to
 * dreaming: an interactive user turn stamps the agent's activity clock and
 * keeps it live for the whole request; an automated turn (scheduler/task
 * notification, dream/reflection/subagent child) never does; and a request
 * that never reached the model does not stamp anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  hasDreamActivitySince,
  markDreamActivity,
  readDreamActivity,
} from "@/agent/dream/dream-activity";
import type { SendMessageStreamOptions } from "@/agent/message";
import { sendMessageStreamWithBackend } from "@/agent/message";
import type { Backend } from "@/backend";
import { USAGE_SOURCE_ENV } from "@/utils/subagent-launch-marker";

const previousHome = process.env.HARUYUKI_HOME;
const previousRole = process.env.HARUYUKI_CODE_AGENT_ROLE;
const previousUsageSource = process.env[USAGE_SOURCE_ENV];
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hryk-message-activity-"));
  process.env.HARUYUKI_HOME = home;
  delete process.env.HARUYUKI_CODE_AGENT_ROLE;
  delete process.env[USAGE_SOURCE_ENV];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousRole === undefined) delete process.env.HARUYUKI_CODE_AGENT_ROLE;
  else process.env.HARUYUKI_CODE_AGENT_ROLE = previousRole;
  if (previousUsageSource === undefined) delete process.env[USAGE_SOURCE_ENV];
  else process.env[USAGE_SOURCE_ENV] = previousUsageSource;
});

function makeStream(
  chunks: LettaStreamingResponse[] = [],
): Stream<LettaStreamingResponse> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function sendOpts(
  agentId: string,
  overrides: Partial<SendMessageStreamOptions> = {},
): SendMessageStreamOptions {
  return {
    streamTokens: true,
    background: true,
    agentId,
    skillSources: [],
    preparedToolContext: {
      contextId: `ctx-${agentId}`,
      clientTools: [],
      loadedToolNames: [],
    },
    ...overrides,
  };
}

function send(
  backend: Backend,
  agentId: string,
  overrides: Partial<SendMessageStreamOptions> = {},
) {
  return sendMessageStreamWithBackend(
    backend,
    `conv-${agentId}`,
    [{ role: "user", content: "hello" }],
    sendOpts(agentId, overrides),
    { maxRetries: 0 },
  );
}

describe("dream activity at the dispatch seam", () => {
  test("an interactive turn stamps activity and stays live while in flight", async () => {
    const agentId = "agent-interactive";
    const backend = {
      async createConversationMessageStream() {
        return makeStream();
      },
    } as unknown as Backend;

    const startedAt = Date.now();
    const stream = await send(backend, agentId);

    expect(readDreamActivity(agentId)).toBeGreaterThanOrEqual(startedAt);
    // The request is still open, so the turn counts as activity right now.
    expect(hasDreamActivitySince(agentId, startedAt)).toBe(true);

    // Draining the stream ends the turn without losing the stamp.
    for await (const _chunk of stream as AsyncIterable<LettaStreamingResponse>) {
      // no chunks in the fixture
    }
    const settled = readDreamActivity(agentId);
    expect(settled).toBeGreaterThanOrEqual(startedAt);
    // Settled means a timestamp, not the moving "now" of an in-flight turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readDreamActivity(agentId)).toBe(settled);
  });

  test("a long turn keeps suppressing the silence window across requests", async () => {
    const agentId = "agent-long-turn";
    const runStartedAt = Date.now() - 30 * 60_000;
    // The previous request is older than the 30-minute silence window.
    markDreamActivity(agentId, runStartedAt - 60_000);
    expect(hasDreamActivitySince(agentId, runStartedAt)).toBe(false);

    const backend = {
      async createConversationMessageStream() {
        return makeStream();
      },
    } as unknown as Backend;

    const first = await send(backend, agentId);
    expect(hasDreamActivitySince(agentId, runStartedAt)).toBe(true);
    for await (const _chunk of first as AsyncIterable<LettaStreamingResponse>) {
      // drain
    }

    // A later request of the same turn re-stamps it.
    await send(backend, agentId);
    expect(hasDreamActivitySince(agentId, runStartedAt)).toBe(true);
  });

  test("an automated turn never stamps the clock", async () => {
    const agentId = "agent-automated";
    const backend = {
      async createConversationMessageStream() {
        return makeStream();
      },
    } as unknown as Backend;

    await send(backend, agentId, { automatedTurn: true });
    expect(readDreamActivity(agentId)).toBeNull();
  });

  test("a subagent child never stamps the clock", async () => {
    process.env.HARUYUKI_CODE_AGENT_ROLE = "subagent";
    const agentId = "agent-subagent";
    const backend = {
      async createConversationMessageStream() {
        return makeStream();
      },
    } as unknown as Backend;

    await send(backend, agentId);
    expect(readDreamActivity(agentId)).toBeNull();
  });

  test("a tagged automated child never stamps the clock", async () => {
    process.env[USAGE_SOURCE_ENV] = "reflection";
    const agentId = "agent-reflection";
    const backend = {
      async createConversationMessageStream() {
        return makeStream();
      },
    } as unknown as Backend;

    await send(backend, agentId);
    expect(readDreamActivity(agentId)).toBeNull();
  });

  test("a rejected request does not stamp the clock", async () => {
    const agentId = "agent-rejected";
    const backend = {
      async createConversationMessageStream() {
        throw new Error("no model for you");
      },
    } as unknown as Backend;

    await expect(send(backend, agentId)).rejects.toThrow();
    expect(readDreamActivity(agentId)).toBeNull();
  });
});
