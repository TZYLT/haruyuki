/**
 * F-04 M0: the one-shot provider call the compaction summarizer makes.
 *
 * The claims under test are the ones the multi-step `/compact` route depends on:
 * the request really is the conversation's own context and settings (system
 * bytes first, frozen tools, the agent's sampling settings), an overflow is
 * classified as an overflow rather than a generic failure, an error ending
 * surfaces as a failure the caller can abort on, and a provider-reported
 * `aborted` is returned as a normal result so the caller can map it to "user
 * cancelled" (route C-13).
 *
 * A local OpenAI-compatible stub serves discovery and one streaming reply, so
 * the test exercises the real provider dispatch without credentials or egress.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { LocalPiModelsRuntime } from "./pi-models-runtime";
import { toPiTools } from "./pi-stream-adapter";
import {
  completeProviderOnce,
  ProviderCompletionError,
  ProviderCompletionOverflowError,
} from "./provider-completion";

const MODEL_HANDLE = "lmstudio/compact-test";
const STUB_MODEL_ID = "compact-test";

interface CapturedRequest {
  path: string;
  body: Record<string, unknown> | undefined;
}

type StubReply = (request: CapturedRequest) => Response | Promise<Response>;

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  stop(): void;
}

function okStream(): Response {
  const base = {
    id: "chatcmpl-compact-test",
    object: "chat.completion.chunk",
    created: 1,
    model: STUB_MODEL_ID,
  };
  const frames = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ok" },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    },
  ];
  const body = frames
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("");
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function startStub(reply: StubReply): StubServer {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/api/v0/models")) {
        return Response.json({
          object: "list",
          data: [
            {
              id: STUB_MODEL_ID,
              type: "llm",
              state: "loaded",
              loaded_context_length: 128000,
              max_context_length: 128000,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [{ id: STUB_MODEL_ID, object: "model" }],
        });
      }
      const body = (await req.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined;
      const request = { path: url.pathname, body };
      requests.push(request);
      return reply(request);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

function frozenTools(): NonNullable<ReturnType<typeof toPiTools>> {
  const tools = toPiTools([
    {
      name: "Bash",
      description: "Run a shell command",
      parameters: { type: "object", properties: {} },
    },
  ]);
  if (!tools) throw new Error("expected the stub tool to project");
  return tools;
}

function context(): {
  systemPrompt: string;
  messages: Message[];
  tools: NonNullable<ReturnType<typeof toPiTools>>;
} {
  return {
    systemPrompt: "SYSTEM-BYTES",
    messages: [
      {
        role: "user",
        content: "hello from the turn",
        timestamp: 1_700_000_000,
      },
    ],
    tools: frozenTools(),
  };
}

function agent() {
  return {
    id: "agent-compact-test",
    name: "Compact",
    description: null,
    system: "unused by the request",
    tags: [],
    model: MODEL_HANDLE,
    model_settings: {
      max_tokens: 321,
      sampling_params: { temperature: 0.25 },
    },
  };
}

function abortedMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "lmstudio",
    model: STUB_MODEL_ID,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    timestamp: Date.now(),
  };
}

let previousBaseUrl: string | undefined;

beforeEach(() => {
  previousBaseUrl = process.env.LMSTUDIO_BASE_URL;
});

afterEach(() => {
  if (previousBaseUrl === undefined) {
    delete process.env.LMSTUDIO_BASE_URL;
  } else {
    process.env.LMSTUDIO_BASE_URL = previousBaseUrl;
  }
});

describe("completeProviderOnce", () => {
  test("sends the context and the agent's settings as one request", async () => {
    const stub = startStub(() => okStream());
    process.env.LMSTUDIO_BASE_URL = stub.baseUrl;
    try {
      const result = await completeProviderOnce({
        agent: agent(),
        context: context(),
        conversationId: "local-conv-compact-test",
        modelsRuntime: new LocalPiModelsRuntime(),
      });

      expect(stub.requests).toHaveLength(1);
      const body = stub.requests[0]?.body;
      expect(body?.model).toBe(STUB_MODEL_ID);
      // pi-ai maps the option's `maxTokens` onto the completions body.
      expect(body?.max_completion_tokens).toBe(321);
      expect(body?.temperature).toBe(0.25);

      const messages = body?.messages as Array<Record<string, unknown>>;
      expect(messages[0]).toMatchObject({ role: "system" });
      expect(messages[0]?.content).toBe("SYSTEM-BYTES");
      expect(messages.at(-1)).toMatchObject({ role: "user" });

      const tools = body?.tools as Array<{ function?: { name?: string } }>;
      expect(tools[0]?.function?.name).toBe("Bash");

      expect(result.message.stopReason).toBe("stop");
      expect(result.usage.promptTokens).toBe(7);
      expect(result.usage.completionTokens).toBe(3);
      expect(result.usage.wallMs).toBeGreaterThanOrEqual(0);
    } finally {
      stub.stop();
    }
  });

  test("classifies a context-window overflow as an overflow", async () => {
    const stub = startStub(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 128000 tokens. However, your messages resulted in 999999 tokens. context_length_exceeded",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    process.env.LMSTUDIO_BASE_URL = stub.baseUrl;
    try {
      await expect(
        completeProviderOnce({
          agent: agent(),
          context: context(),
          conversationId: "local-conv-overflow",
          modelsRuntime: new LocalPiModelsRuntime(),
        }),
      ).rejects.toBeInstanceOf(ProviderCompletionOverflowError);
    } finally {
      stub.stop();
    }
  });

  test("surfaces an error ending as a provider failure", async () => {
    const stub = startStub(
      () =>
        new Response(
          JSON.stringify({ error: { message: "upstream exploded" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    process.env.LMSTUDIO_BASE_URL = stub.baseUrl;
    try {
      await expect(
        completeProviderOnce({
          agent: agent(),
          context: context(),
          conversationId: "local-conv-error",
          modelsRuntime: new LocalPiModelsRuntime(),
        }),
      ).rejects.toBeInstanceOf(ProviderCompletionError);
    } finally {
      stub.stop();
    }
  });

  test("returns a provider-reported abort instead of treating it as a failure", async () => {
    const stub = startStub(() => okStream());
    process.env.LMSTUDIO_BASE_URL = stub.baseUrl;
    try {
      const runtime = new LocalPiModelsRuntime();
      // pi-ai resolves an in-flight abort with `stopReason: "aborted"` rather
      // than throwing (route C-13); that is the shape the classifier handles.
      const message = abortedMessage();
      (runtime as unknown as { streamSimple: () => unknown }).streamSimple =
        () =>
          ({
            async *[Symbol.asyncIterator]() {},
            result: async () => message,
          }) as unknown;

      const result = await completeProviderOnce({
        agent: agent(),
        context: context(),
        conversationId: "local-conv-aborted",
        modelsRuntime: runtime,
      });

      expect(result.message.stopReason).toBe("aborted");
    } finally {
      stub.stop();
    }
  });

  test("passes the caller's abort signal to the request", async () => {
    const stub = startStub(
      () =>
        new Promise<Response>((resolvePromise) => {
          // Answer late; the client must give up on its own signal first.
          setTimeout(() => resolvePromise(okStream()), 2_000);
        }),
    );
    process.env.LMSTUDIO_BASE_URL = stub.baseUrl;
    try {
      const controller = new AbortController();
      const pending = completeProviderOnce({
        agent: agent(),
        context: context(),
        conversationId: "local-conv-cancel",
        modelsRuntime: new LocalPiModelsRuntime(),
        signal: controller.signal,
      });
      controller.abort();
      // A real fetch rejects with an AbortError; the summarizer maps that (and
      // an already-aborted signal) to "user cancelled", never to a failure.
      await expect(pending).rejects.toThrow();
    } finally {
      stub.stop();
    }
  });
});
