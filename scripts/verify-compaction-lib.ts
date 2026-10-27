/**
 * verify-compaction-lib.ts — the stub provider both compaction gates share.
 *
 * `verify-compaction-prefix.ts` (F-04 M0) proves the summarizer's request
 * *bytes*; `verify-compaction-apply.ts` (P1.5) proves the summarizer's product
 * can be written back by the real backend. Both gates depend on the same two
 * wire decisions — which request is the summarizer's, and which reply the real
 * validator accepts — so that logic lives here exactly once. Two copies would
 * let the gates disagree about what they observed and still both report PASS.
 *
 * The default reply is the M0 gate's one-topic product, byte for byte. The
 * options only widen it (a second topic the cut keeps, sections the caller can
 * name) for the apply gate, which must tell a folded section from a kept one —
 * a distinction the prefix gate has no use for.
 */

/** The single model id the stub advertises and serves. */
export const STUB_MODEL_ID = "verify-compact-model";

/**
 * The provider handle that routes to the stub: `lmstudio/<id>` plus
 * `LMSTUDIO_BASE_URL` pointing at the stub's `/v1`.
 */
export const DEFAULT_STUB_MODEL = `lmstudio/${STUB_MODEL_ID}`;

/**
 * Provider credentials that may be present in the operator's shell. A gate
 * must not be able to reach a real endpoint even when one is configured; the
 * explicit model handle plus the stub base URL already fixes routing, and
 * dropping these names from the environment makes that a guarantee.
 */
export const AMBIENT_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "HARUYUKI_DISABLE_LOCAL_MODEL_DISCOVERY",
] as const;

export interface StubProviderStats {
  /** Chat completions whose last message carried the summarizer contract. */
  summarizerRequests: number;
  /** Every other chat completion (the conversation's own turn). */
  turnRequests: number;
}

export interface StubProvider {
  port: number;
  stop: () => void;
  /** Chat completions by kind, counted from the request bytes. */
  stats: () => StubProviderStats;
}

/** Field names only the summarizer's reply contract puts in a request. */
const SUMMARIZER_CONTRACT_MARKERS = ['"topics"', '"startMessageId"'] as const;

/** The text of the request's last message (the appended instruction). */
export function lastMessageText(body: unknown): string {
  const messages = (body as { messages?: unknown } | null)?.messages;
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  const content = (last as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text ?? "").join("\n");
}

export function isSummarizerRequest(body: unknown): boolean {
  // Test the raw text, not `JSON.stringify(body)`: serializing escapes the
  // contract's quotes to `\"topics\"`, which these markers would not match.
  const instruction = lastMessageText(body);
  return SUMMARIZER_CONTRACT_MARKERS.every((marker) =>
    instruction.includes(marker),
  );
}

/** The id table's ids (`[1] user id=<id>: preview`), in provider order. */
export function listedMessageIds(instruction: string): string[] {
  const ids: string[] = [];
  for (const line of instruction.split(/\r?\n/)) {
    const match = /^\[\d+\]\s+\S+\s+id=(\S+?):/.exec(line.trim());
    const id = match?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export const STUB_SECTION =
  "Stub section: the provider only needs a reply the validator accepts, so this stands in for the topic's section.";

export interface SummarizerReplyOptions {
  /**
   * `"single"` (default) is the M0 gate's reply: one topic covering the whole
   * input. `"split"` adds a second topic near `secondTopicFraction` of the id
   * table, so a cut between the two folds only the first.
   */
  topics?: "single" | "split";
  /**
   * Where the second topic starts, as a fraction of the id table. The default
   * (`0.6`) leaves the second topic well inside the region a compression-rate
   * cut keeps.
   */
  secondTopicFraction?: number;
  /** Prefix for topic titles, so a chained run can name each compaction's. */
  titlePrefix?: string;
  /**
   * Prefix for section bodies. When absent every topic carries `STUB_SECTION`,
   * which keeps the default reply byte-identical to the M0 gate's.
   */
  sectionPrefix?: string;
  /** Appended to the four restricted fields and the narrative. */
  overviewSuffix?: string;
}

/**
 * A reply the validator accepts: a boundary on the first listed id, four
 * non-empty restricted fields, a non-empty narrative. With no readable id table
 * it replies with the legal degraded shape (`topics: []` + narrative), which
 * the parser rejects: the module retries and degrades, and the gate says so.
 */
export function summarizerReply(
  instruction: string,
  options: SummarizerReplyOptions = {},
): string {
  const suffix = options.overviewSuffix ?? "";
  const overview = {
    restricted: {
      open: `Stub: nothing pending; this reply exists to exercise the compaction gate.${suffix}`,
      errors: `Stub: no failed approach to record.${suffix}`,
      relationship: `Stub: the relationship line is not under test here.${suffix}`,
      memoryIndex: `Stub: no memory files referenced.${suffix}`,
    },
    narrative: `Stub narrative: the structured reply parsed end to end, so the gate observes one provider request and no degradation.${suffix}`,
  };
  const ids = listedMessageIds(instruction);
  const [first] = ids;
  if (first === undefined) return JSON.stringify({ topics: [], overview });

  const topics = [
    {
      title: `${options.titlePrefix ?? "Stub topic "}one`,
      startMessageId: first,
      section:
        options.sectionPrefix === undefined
          ? STUB_SECTION
          : `${options.sectionPrefix}topic-1`,
    },
  ];
  if (options.topics === "split" && ids.length > 1) {
    const fraction = options.secondTopicFraction ?? 0.6;
    const secondIndex = Math.max(
      1,
      Math.min(ids.length - 1, Math.floor(ids.length * fraction)),
    );
    const second = ids[secondIndex];
    if (second !== undefined && second !== first) {
      topics.push({
        title: `${options.titlePrefix ?? "Stub topic "}two`,
        startMessageId: second,
        section:
          options.sectionPrefix === undefined
            ? STUB_SECTION
            : `${options.sectionPrefix}topic-2`,
      });
    }
  }
  return JSON.stringify({ topics, overview });
}

/** Builds the reply for one summarizer call; `callIndex` is 0-based. */
export type StubSummarizerReply = (
  instruction: string,
  callIndex: number,
) => string;

export interface StubProviderOptions {
  /** Defaults to `summarizerReply(instruction)` — the M0 gate's product. */
  summarizerReply?: StubSummarizerReply;
}

/**
 * Minimal OpenAI-compatible endpoint the local backend can complete one turn
 * against. `/api/v0/models` is the LM Studio discovery surface, `/v1/models` is
 * the OpenAI-compatible fallback, and `/v1/chat/completions` returns one plain
 * assistant reply as SSE — no tool calls, so a request finishes in one shot.
 */
export function startStubProvider(
  options: StubProviderOptions = {},
): StubProvider {
  let summarizerRequests = 0;
  let turnRequests = 0;
  const replyFor =
    options.summarizerReply ??
    ((instruction: string): string => summarizerReply(instruction));
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/api/v0/models")) {
        return Response.json({
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
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const requestBody: unknown = await req.json().catch(() => undefined);
      const summarizer = isSummarizerRequest(requestBody);
      const callIndex = summarizerRequests;
      if (summarizer) {
        summarizerRequests += 1;
      } else {
        turnRequests += 1;
      }
      const replyText = summarizer
        ? replyFor(lastMessageText(requestBody), callIndex)
        : "ok";
      const base = {
        id: "chatcmpl-verify-compact",
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
              delta: { role: "assistant", content: replyText },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      ];
      const body = frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join("");
      return new Response(`${body}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port,
    stop: () => server.stop(true),
    stats: () => ({ summarizerRequests, turnRequests }),
  };
}
