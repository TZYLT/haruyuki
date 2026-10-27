/**
 * F-04 M1: the compaction summarizer.
 *
 * What these tests pin, in the order the module promises them:
 *
 * - the request really is the conversation's own frozen prefix (system bytes,
 *   frozen tools, projected messages) plus **exactly one** appended user
 *   instruction that lists the message ids and the existing markers;
 * - a valid reply parses into drafts whose `startMessageId` are real message ids;
 * - each output-contract rule has a counterexample — a hole at the front, an
 *   out-of-order start, an invented id, a missing restricted section, an empty
 *   narrative, a duplicate title, an over-long title/section, unparseable JSON —
 *   and every one retries once and then degrades to the one-step summary;
 * - a refusal degrades, auth/network aborts with no retry, an overflow
 *   middle-truncates and retries, and a cancelled call throws instead of being
 *   treated as a format failure.
 *
 * A local OpenAI-compatible stub serves discovery and the completion, so the
 * real provider dispatch runs without credentials and without egress. The
 * conversation itself is seeded through `LocalBackend` with a fake turn
 * executor, so the frozen snapshot is the same kind of snapshot a real turn
 * pins.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { ProviderCompletionError } from "@/backend/dev/provider-completion";
import {
  COMPACTION_INSTRUCTION_WORDING,
  CompactionCancelledError,
  DEGRADED_WHOLE_SECTION_LEAD_IN,
  type SummarizeInput,
  type SummarizeResult,
  summarizeConversation,
} from "@/backend/local/compaction-summarizer";
import { LocalBackend } from "@/backend/local/local-backend";
import { LocalStore } from "@/backend/local/local-store";
import { applyFrozenAgentOverrides } from "@/backend/local/prefix-freeze";

const MODEL_HANDLE = "lmstudio/summarizer-test";
const STUB_MODEL_ID = "summarizer-test";
const TEST_TIMEOUT_MS = 30_000;
const LEGACY_SUMMARY = "Legacy one-step summary of the whole segment.";

// --- stub provider ---------------------------------------------------------

interface CapturedRequest {
  path: string;
  body: Record<string, unknown> | undefined;
}

type StubReply = (
  request: CapturedRequest,
  callIndex: number,
) => Response | Promise<Response>;

interface StubServer {
  baseUrl: string;
  chatRequests(): CapturedRequest[];
  stop(): void;
}

function modelsResponse(): Response {
  return Response.json({
    object: "list",
    data: [
      {
        id: STUB_MODEL_ID,
        type: "llm",
        state: "loaded",
        loaded_context_length: 128_000,
        max_context_length: 128_000,
      },
    ],
  });
}

function startStub(reply: StubReply): StubServer {
  const requests: CapturedRequest[] = [];
  const chatRequests = (): CapturedRequest[] =>
    requests.filter((request) => request.path.endsWith("/chat/completions"));
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/api/v0/models")) return modelsResponse();
      if (url.pathname.endsWith("/models")) return modelsResponse();
      const body = (await req.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined;
      const callIndex = chatRequests().length;
      requests.push({ path: url.pathname, body });
      return reply({ path: url.pathname, body }, callIndex);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    chatRequests,
    stop: () => server.stop(true),
  };
}

function streamText(text: string): Response {
  const base = {
    id: "chatcmpl-summarizer-test",
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
          delta: { role: "assistant", content: text },
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

/** A model-level refusal: an error ending with no auth/network signature. */
function refusalResponse(): Response {
  const base = {
    id: "chatcmpl-summarizer-refusal",
    object: "chat.completion.chunk",
    created: 1,
    model: STUB_MODEL_ID,
  };
  const frames = [
    {
      ...base,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
    },
  ];
  const body = frames
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("");
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function overflowResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 999999 tokens. context_length_exceeded",
        type: "invalid_request_error",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: "invalid api key provided" } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

// --- conversation fixture --------------------------------------------------

function staticExecutor(): HeadlessTurnExecutor {
  return {
    async execute() {
      return lettaStreamFromChunks([
        {
          message_type: "assistant_message",
          content: [{ type: "text", text: "noted" }],
        } as LettaStreamingResponse,
        {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse,
      ]);
    },
  };
}

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

interface FixtureOptions {
  turns?: number;
  firstContent?: string;
  clientTools?: unknown[];
  compactionPrompt?: string;
}

interface Fixture {
  backend: LocalBackend;
  storageDir: string;
  agentId: string;
  conversationId: string;
  /** The frozen system prompt the request must reproduce byte for byte. */
  snapshotContent: string;
  /** The projected message ids, oldest first — what the reply may name. */
  messageIds: string[];
  /** The projected roles, oldest first. */
  projectedRoles: string[];
  input: SummarizeInput;
  cleanup(): Promise<void>;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const storageDir = await mkdtemp(
    join(tmpdir(), "hryk-compaction-summarizer-"),
  );
  const backend = new LocalBackend({
    storageDir,
    executor: staticExecutor(),
    memfsEnabled: false,
  });
  const created = await backend.createAgent({
    name: "Summarizer",
    model: MODEL_HANDLE,
  } as never);
  if (options.compactionPrompt) {
    await backend.updateAgent(created.id, {
      compaction_settings: { prompt: options.compactionPrompt },
    } as never);
  }
  const conversation = await backend.createConversation({
    agent_id: created.id,
  } as never);
  const turns = options.turns ?? 2;
  for (let index = 0; index < turns; index += 1) {
    const content =
      index === 0 && options.firstContent
        ? options.firstContent
        : `Turn ${index + 1} asks something.`;
    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: created.id,
        messages: [{ role: "user", content }],
        ...(options.clientTools ? { client_tools: options.clientTools } : {}),
      } as ConversationMessageCreateBody),
    );
  }
  const store = new LocalStore(created.id, {
    storageDir,
    seedDefaultAgent: false,
  });
  const snapshot = store.getCompiledSystemPrompt(conversation.id, created.id);
  if (!snapshot) throw new Error("fixture: the turn did not freeze a snapshot");
  const projected = store.listLocalMessages(conversation.id, created.id);
  // The fixture never seeds empty or orphaned messages, so the only projection
  // rule in play is the trailing-assistant strip (route C-11).
  while (projected.at(-1)?.role === "assistant") projected.pop();
  const agent = applyFrozenAgentOverrides(
    store.retrieveAgentRecord(created.id),
    snapshot,
  );
  const agentId = created.id;
  const conversationId = conversation.id;
  return {
    backend,
    storageDir,
    agentId,
    conversationId,
    snapshotContent: snapshot.content,
    messageIds: projected.map((message) => message.id),
    projectedRoles: projected.map((message) => message.role),
    input: { agent, agentId, conversationId, storageDir },
    cleanup: async () => {
      await rm(storageDir, { recursive: true, force: true });
    },
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

/**
 * Start a stub, seed a conversation against it, and always clean both up.
 *
 * The reply is built *after* the fixture exists so a case can name the real
 * message ids it expects the summarizer to see.
 */
async function withSummarizer(
  makeReply: (fixture: Fixture) => StubReply,
  body: (context: {
    fixture: Fixture;
    stub: StubServer;
    summarize: (overrides?: SummarizeInput) => Promise<SummarizeResult>;
  }) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> {
  let installed: StubReply = () =>
    new Response("no reply installed", { status: 500 });
  const stub = startStub((request, callIndex) => installed(request, callIndex));
  process.env.LMSTUDIO_BASE_URL = stub.baseUrl;
  const fixture = await createFixture(options);
  try {
    installed = makeReply(fixture);
    await body({
      fixture,
      stub,
      summarize: (overrides) =>
        summarizeConversation(overrides ?? fixture.input),
    });
  } finally {
    await fixture.cleanup();
    stub.stop();
  }
}

function lastMessageText(stub: StubServer, callIndex = 0): string {
  const messages = stub.chatRequests()[callIndex]?.body?.messages as
    | Array<{ role?: string; content?: unknown }>
    | undefined;
  return String(messages?.at(-1)?.content ?? "");
}

// --- canned replies --------------------------------------------------------

interface ReplyTopic {
  title?: string;
  startMessageId?: string;
  section?: string;
}

type RestrictedField = "open" | "errors" | "relationship" | "memoryIndex";

interface ReplyShape {
  topics: ReplyTopic[];
  restricted?: Partial<Record<RestrictedField, string>>;
  narrative?: string;
  omitRestricted?: RestrictedField;
}

function replyJson(shape: ReplyShape): string {
  const restricted: Record<string, string> = {
    open: "Still open.",
    errors: "Nothing ruled out.",
    relationship: "Steady.",
    memoryIndex: "No files.",
    ...shape.restricted,
  };
  if (shape.omitRestricted) delete restricted[shape.omitRestricted];
  return JSON.stringify({
    topics: shape.topics.map((topic) => ({
      title: topic.title ?? "Topic",
      startMessageId: topic.startMessageId ?? "",
      section: topic.section ?? "Section.",
    })),
    overview: {
      restricted,
      narrative: shape.narrative ?? "A story so far.",
    },
  });
}

/** A reply that satisfies every rule for the given projected ids. */
function validReply(ids: string[]): string {
  const first = ids[0] ?? "";
  const second = ids[1];
  return replyJson({
    topics: second
      ? [
          { title: "Opening", startMessageId: first, section: "Opening." },
          { title: "Later", startMessageId: second, section: "Later." },
        ]
      : [{ title: "Only topic", startMessageId: first, section: "Only." }],
  });
}

// --- the primary contract --------------------------------------------------

describe("summarizeConversation", () => {
  test(
    "sends the frozen prefix plus exactly one appended instruction",
    async () => {
      await withSummarizer(
        (fixture) => () => streamText(validReply(fixture.messageIds)),
        async ({ fixture, stub, summarize }) => {
          const result = await summarize();
          expect(result.degraded).toBeNull();
          expect(result.topics[0]?.startMessageId).toBe(
            fixture.messageIds[0] ?? "",
          );
          expect(result.overview.narrative).toBe("A story so far.");
          expect(result.usage.promptTokens).toBe(7);
          expect(result.usage.completionTokens).toBe(3);

          expect(stub.chatRequests()).toHaveLength(1);
          const messages = stub.chatRequests()[0]?.body?.messages as Array<{
            role?: string;
            content?: unknown;
          }>;
          // Byte-identical system prompt, then the projected context, then the
          // one instruction: system + N messages + instruction.
          expect(messages[0]).toMatchObject({ role: "system" });
          expect(messages[0]?.content).toBe(fixture.snapshotContent);
          expect(messages).toHaveLength(fixture.messageIds.length + 2);
          expect(messages.at(-1)?.role).toBe("user");
          expect(messages.slice(1, -1).map((message) => message.role)).toEqual(
            fixture.projectedRoles,
          );

          const instruction = lastMessageText(stub);
          for (const [offset, id] of fixture.messageIds.entries()) {
            expect(instruction).toContain(`[${offset + 1}]`);
            expect(instruction).toContain(id);
          }
          expect(instruction).toContain("startMessageId");
          expect(instruction).toContain('"memoryIndex"');
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "sends the frozen tool declarations, not a live set",
    async () => {
      await withSummarizer(
        (fixture) => () => streamText(validReply(fixture.messageIds)),
        async ({ stub, summarize }) => {
          await summarize();
          const tools = stub.chatRequests()[0]?.body?.tools as Array<{
            function?: { name?: string };
          }>;
          expect(tools[0]?.function?.name).toBe("Bash");
        },
        {
          clientTools: [
            {
              name: "Bash",
              description: "Run a shell command",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "lists the existing topic markers so the model respects their boundaries",
    async () => {
      await withSummarizer(
        (fixture) => () => streamText(validReply(fixture.messageIds)),
        async ({ fixture, stub, summarize }) => {
          const store = new LocalStore(fixture.agentId, {
            storageDir: fixture.storageDir,
            seedDefaultAgent: false,
          });
          const marker = store.contextRewrites.appendTopicMarker({
            conversationId: fixture.conversationId,
            agentId: fixture.agentId,
            title: "An existing boundary",
            createdBy: "user",
            anchorMessageId: fixture.messageIds[1] ?? null,
          });
          await summarize();
          const instruction = lastMessageText(stub);
          expect(instruction).toContain('"An existing boundary"');
          expect(instruction).toContain(`id=${marker.marker.anchorMessageId}`);
          expect(instruction).toContain("created by user");
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "uses a custom compaction prompt in place of the fixed template",
    async () => {
      await withSummarizer(
        (fixture) => () => streamText(validReply(fixture.messageIds)),
        async ({ stub, summarize }) => {
          await summarize();
          expect(lastMessageText(stub).startsWith("CUSTOM-SUMMARIZER")).toBe(
            true,
          );
        },
        { compactionPrompt: "CUSTOM-SUMMARIZER template." },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses to run without a frozen snapshot",
    async () => {
      const storageDir = await mkdtemp(join(tmpdir(), "hryk-summarizer-none-"));
      try {
        // A conversation created straight on the store has no compiled prefix:
        // `LocalBackend.createConversation` compiles one, so it cannot be used
        // to produce this state.
        const store = new LocalStore("agent-summarizer-none", {
          storageDir,
          seedDefaultAgent: false,
        });
        const created = store.createAgent({
          name: "Summarizer",
          model: MODEL_HANDLE,
        } as never);
        const conversation = store.createConversation({
          agent_id: created.id,
        } as never);
        await expect(
          summarizeConversation({
            agent: store.retrieveAgentRecord(created.id),
            agentId: created.id,
            conversationId: conversation.id,
            storageDir,
          }),
        ).rejects.toThrow("frozen system prompt");
      } finally {
        await rm(storageDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// --- retry, degradation and failure taxonomy -------------------------------

describe("failure taxonomy", () => {
  test(
    "retries once on a format failure and accepts the second reply",
    async () => {
      await withSummarizer(
        (fixture) => (_request, callIndex) =>
          streamText(
            callIndex === 0
              ? "not json at all"
              : validReply(fixture.messageIds),
          ),
        async ({ fixture, stub, summarize }) => {
          const result = await summarize();
          expect(result.degraded).toBeNull();
          expect(result.topics).toHaveLength(2);
          expect(result.topics[0]?.startMessageId).toBe(
            fixture.messageIds[0] ?? "",
          );
          expect(stub.chatRequests()).toHaveLength(2);
          expect(lastMessageText(stub, 1)).toContain(
            COMPACTION_INSTRUCTION_WORDING.retryHeading,
          );
          expect(lastMessageText(stub, 1)).toContain("not valid JSON");
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "degrades to the one-step summary after two rejected replies",
    async () => {
      await withSummarizer(
        (_fixture) => (_request, callIndex) =>
          streamText(callIndex < 2 ? "still not json" : LEGACY_SUMMARY),
        async ({ stub, summarize }) => {
          const result = await summarize();
          // Two judged attempts: the cause is a format outcome, not a refusal.
          expect(result.degraded).toBe("format");
          expect(result.topics).toEqual([]);
          expect(result.overview.restricted).toEqual({
            open: "",
            errors: "",
            relationship: "",
            memoryIndex: "",
          });
          expect(result.overview.narrative).toBe(
            `${DEGRADED_WHOLE_SECTION_LEAD_IN}\n\n${LEGACY_SUMMARY}`,
          );
          // attempt 1 + attempt 2 + the one-step fallback.
          expect(stub.chatRequests()).toHaveLength(3);
          // Both rejected attempts and the fallback call cost tokens, so the
          // degraded receipt must not read as a 0-token compaction (§5.14).
          expect(result.usage.promptTokens).toBe(21);
          expect(result.usage.completionTokens).toBe(9);
          expect(result.usage.wallMs).toBeGreaterThanOrEqual(0);
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "degrades on a model refusal instead of aborting",
    async () => {
      await withSummarizer(
        (_fixture) => (_request, callIndex) =>
          callIndex === 0 ? refusalResponse() : streamText(LEGACY_SUMMARY),
        async ({ stub, summarize }) => {
          const result = await summarize();
          // The model refused the request itself, so no structured attempt was
          // ever judged (§5.9.3①).
          expect(result.degraded).toBe("refusal");
          expect(result.topics).toEqual([]);
          expect(result.overview.narrative).toBe(
            `${DEGRADED_WHOLE_SECTION_LEAD_IN}\n\n${LEGACY_SUMMARY}`,
          );
          expect(stub.chatRequests()).toHaveLength(2);
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "aborts on auth failure without retrying or degrading",
    async () => {
      await withSummarizer(
        () => () => unauthorizedResponse(),
        async ({ stub, summarize }) => {
          await expect(summarize()).rejects.toBeInstanceOf(
            ProviderCompletionError,
          );
          expect(stub.chatRequests()).toHaveLength(1);
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "middle-truncates once when the request overflows",
    async () => {
      await withSummarizer(
        (fixture) => (_request, callIndex) =>
          callIndex === 0
            ? overflowResponse()
            : streamText(validReply(fixture.messageIds)),
        async ({ fixture, stub, summarize }) => {
          const result = await summarize();
          expect(result.degraded).toBeNull();
          expect(result.topics[0]?.startMessageId).toBe(
            fixture.messageIds[0] ?? "",
          );
          expect(stub.chatRequests()).toHaveLength(2);
          const firstBody = JSON.stringify(stub.chatRequests()[0]?.body ?? {});
          const secondBody = JSON.stringify(stub.chatRequests()[1]?.body ?? {});
          expect(secondBody.length).toBeLessThan(firstBody.length);
          expect(lastMessageText(stub, 1)).toContain(
            COMPACTION_INSTRUCTION_WORDING.truncatedHeading,
          );
          expect(secondBody).toContain("characters omitted");
        },
        { turns: 1, firstContent: "x".repeat(30_000) },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "degrades when the truncated retry overflows too",
    async () => {
      await withSummarizer(
        (_fixture) => (_request, callIndex) =>
          callIndex < 2 ? overflowResponse() : streamText(LEGACY_SUMMARY),
        async ({ stub, summarize }) => {
          const result = await summarize();
          // The structured product could not be produced after the truncation
          // ladder, which is the format outcome (§5.9.2).
          expect(result.degraded).toBe("format");
          expect(result.overview.narrative).toBe(
            `${DEGRADED_WHOLE_SECTION_LEAD_IN}\n\n${LEGACY_SUMMARY}`,
          );
          expect(stub.chatRequests()).toHaveLength(3);
        },
        { turns: 1, firstContent: "x".repeat(30_000) },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "throws a cancellation instead of retrying or degrading",
    async () => {
      await withSummarizer(
        (fixture) => () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () => resolve(streamText(validReply(fixture.messageIds))),
              3_000,
            );
          }),
        async ({ fixture, stub, summarize }) => {
          const controller = new AbortController();
          // Attach the rejection handler immediately: the abort lands while the
          // test is still polling, and an unhandled rejection would be reported.
          const pending = summarize({
            ...fixture.input,
            signal: controller.signal,
          }).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
          const started = Date.now();
          while (stub.chatRequests().length === 0) {
            if (Date.now() - started > 10_000) {
              throw new Error("the summarizer never reached the provider");
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          controller.abort();
          const outcome = await pending;
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") {
            expect(outcome.error).toBeInstanceOf(CompactionCancelledError);
          }
          expect(stub.chatRequests()).toHaveLength(1);
        },
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// --- one counterexample per output-contract rule ---------------------------

interface RejectionCase {
  name: string;
  reject: (ids: string[]) => string;
  reason: string;
}

const REJECTION_CASES: RejectionCase[] = [
  {
    name: "a leading hole (first topic not at the first message)",
    reject: (ids) =>
      replyJson({
        topics: [{ title: "Middle", startMessageId: ids[1] ?? "" }],
      }),
    reason: "leading hole",
  },
  {
    name: "an out-of-order boundary",
    reject: (ids) =>
      replyJson({
        topics: [
          { title: "First", startMessageId: ids[0] ?? "" },
          { title: "Second", startMessageId: ids[0] ?? "" },
        ],
      }),
    reason: "not after the previous topic's start",
  },
  {
    name: "an invented message id",
    reject: (ids) =>
      replyJson({
        topics: [
          { title: "First", startMessageId: ids[0] ?? "" },
          { title: "Second", startMessageId: "msg-does-not-exist" },
        ],
      }),
    reason: "not a message id from the input list",
  },
  {
    name: "a missing restricted section",
    reject: (ids) =>
      replyJson({
        topics: [{ title: "Only", startMessageId: ids[0] ?? "" }],
        omitRestricted: "errors",
      }),
    reason: "overview.restricted.errors is missing or empty",
  },
  {
    name: "an empty narrative",
    reject: (ids) =>
      replyJson({
        topics: [{ title: "Only", startMessageId: ids[0] ?? "" }],
        narrative: "   ",
      }),
    reason: "overview.narrative is missing or empty",
  },
  {
    name: "duplicate topic titles",
    reject: (ids) =>
      replyJson({
        topics: [
          { title: "Same", startMessageId: ids[0] ?? "" },
          { title: "Same", startMessageId: ids[1] ?? "" },
        ],
      }),
    reason: 'repeats "Same"',
  },
  {
    name: "an over-long title",
    reject: (ids) =>
      replyJson({
        topics: [{ title: "t".repeat(61), startMessageId: ids[0] ?? "" }],
      }),
    reason: "the limit is 60",
  },
  {
    name: "an over-long section",
    reject: (ids) =>
      replyJson({
        topics: [
          {
            title: "Long",
            startMessageId: ids[0] ?? "",
            section: "s".repeat(601),
          },
        ],
      }),
    reason: "the limit is 600",
  },
  {
    name: "an empty topic list",
    reject: () => replyJson({ topics: [] }),
    reason: "topics must be a non-empty array",
  },
  {
    name: "unparseable JSON",
    reject: () => "Here is my summary: { topics: [...] }",
    reason: "not valid JSON",
  },
];

describe("output contract", () => {
  test.each(REJECTION_CASES)(
    "rejects $name and then degrades",
    async (testCase) => {
      await withSummarizer(
        (fixture) => (_request, callIndex) =>
          streamText(
            callIndex < 2
              ? testCase.reject(fixture.messageIds)
              : LEGACY_SUMMARY,
          ),
        async ({ stub, summarize }) => {
          const result = await summarize();
          expect(result.degraded).toBe("format");
          expect(result.topics).toEqual([]);
          expect(result.overview.narrative).toBe(
            `${DEGRADED_WHOLE_SECTION_LEAD_IN}\n\n${LEGACY_SUMMARY}`,
          );
          expect(stub.chatRequests()).toHaveLength(3);
          expect(lastMessageText(stub, 1)).toContain(testCase.reason);
        },
      );
    },
    TEST_TIMEOUT_MS,
  );
});
