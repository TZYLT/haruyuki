import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
  TSchema,
} from "@earendil-works/pi-ai";
import { isContextOverflow, Type } from "@earendil-works/pi-ai";

import {
  emptyLocalUsage,
  type LocalAssistantMessage,
  type LocalMessage,
} from "@/backend/local/local-message";
import { removeOrphanLocalToolResults } from "@/backend/local/local-message-projection";
import { resolveAvailableLocalModelForTurn } from "@/backend/local/local-model-config";
import type { LocalAgentRecord } from "@/backend/local/local-store";
import type { ClientTool } from "@/tools/manager";
import { debugLog } from "@/utils/debug";
import { isRecord } from "@/utils/type-guards";
import {
  CONTEXT_OVERFLOW_GUIDANCE,
  isContextWindowOverflowError,
  LocalContextOverflowError,
} from "./context-window-overflow";
import {
  isRetryableLocalProviderError,
  localProviderRetryDelayMs,
  localProviderRetryMessage,
  normalizeLocalProviderError,
} from "./local-provider-errors";
import {
  elideImagePayloadsForProviderRetry,
  isOversizedPayloadTransportFailure,
} from "./pi-image-elision";
import {
  applyPiEnvOverrides,
  type ResolvedPiModel,
  reasoningForSettings,
  resolvePiModelForAgent,
} from "./pi-model-factory";
import { LocalPiModelsRuntime } from "./pi-models-runtime";
import { resolvePiRequestHeaders } from "./pi-request-headers";
import { isPiModelOutputEvent } from "./pi-stream-output";
import { withPrefixProbe } from "./prefix-probe";
import type {
  LlmEndErrorInfo,
  LlmEndInfo,
  LlmStartInfo,
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./provider-turn-executor";
import {
  contextPressureLevel,
  estimateProviderContextTokens,
  estimateProviderPromptFloorTokens,
  providerLettaChunk,
  providerLocalMessage,
  providerStreamPart,
} from "./provider-turn-executor";

const LOCAL_PROVIDER_MAX_RETRIES = 3;
const LOCAL_PROVIDER_ADAPTIVE_IMAGE_ELISION_AFTER_RETRIES =
  LOCAL_PROVIDER_MAX_RETRIES - 1;

export type PiStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export interface PiStreamAdapterOptions {
  stream?: PiStreamFunction;
  abortSignal?: AbortSignal;
  localProviderAuthStorageDir?: string;
  /**
   * Per-backend pi-ai Models runtime used for model resolution and stream
   * dispatch. A dedicated instance is created when not provided; the local
   * backend passes its own so /model listing and turn execution share one
   * provider registry.
   */
  modelsRuntime?: LocalPiModelsRuntime;
  onLlmStart?: (info: LlmStartInfo) => void | Promise<void>;
  onLlmEnd?: (info: LlmEndInfo) => void | Promise<void>;
}

class PiProviderError extends Error {
  readonly assistant: AssistantMessage;
  readonly statusCode?: number;

  constructor(assistant: AssistantMessage) {
    super(assistant.errorMessage ?? "Unknown local provider error");
    this.name = "PiProviderError";
    this.assistant = assistant;
    const status = assistant.diagnostics
      ?.map(
        (diagnostic) =>
          diagnostic.details?.statusCode ?? diagnostic.details?.status,
      )
      .find((value): value is number => typeof value === "number");
    this.statusCode = status;
  }
}

async function sleepWithAbort(
  delayMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (delayMs <= 0) return;
  if (abortSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isClientTool(value: unknown): value is ClientTool {
  return isRecord(value) && typeof value.name === "string";
}

/**
 * Project a frozen `client_tools` declaration set to pi-ai tools.
 *
 * Exported for F-04's compaction summarizer: it must send the *same* tool
 * declarations a turn sends, so both paths share this one projection
 * (requirement §5.2.2) instead of keeping two copies in sync.
 */
export function toPiTools(clientTools: unknown[]): Tool[] | undefined {
  const tools: Tool[] = [];
  for (const value of clientTools) {
    if (!isClientTool(value)) continue;
    const schema = isRecord(value.parameters)
      ? (value.parameters as unknown as TSchema)
      : Type.Object({});
    tools.push({
      name: value.name,
      description: value.description ?? "",
      parameters: schema,
    });
  }
  return tools.length > 0 ? tools : undefined;
}

const EMPTY_TOOL_RESULT_PLACEHOLDER = "No result provided";

type LocalUserContent = Extract<LocalMessage, { role: "user" }>["content"];
type LocalAssistantContent = Extract<
  LocalMessage,
  { role: "assistant" }
>["content"];
type LocalToolResultContent = Extract<
  LocalMessage,
  { role: "toolResult" }
>["content"];

function isEmptyTextBlock(block: { type: string; text?: unknown }): boolean {
  return (
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim().length === 0
  );
}

function dropEmptyTextBlocks<T extends { type: string; text?: unknown }>(
  content: T[],
): T[] {
  return content.filter((block) => !isEmptyTextBlock(block));
}

function normalizeUserContent(
  content: LocalUserContent,
): LocalUserContent | undefined {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAssistantContent(
  content: LocalAssistantContent,
): LocalAssistantContent | undefined {
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeToolResultContent(
  content: LocalToolResultContent,
): LocalToolResultContent {
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0
    ? normalized
    : [{ type: "text", text: EMPTY_TOOL_RESULT_PLACEHOLDER }];
}

function toPiMessage(message: LocalMessage): Message | undefined {
  if (message.role === "user") {
    const content = normalizeUserContent(message.content);
    if (!content) return undefined;
    return {
      role: "user",
      content,
      timestamp: message.timestamp,
    } satisfies Message;
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: normalizeToolResultContent(message.content),
      details: message.details,
      isError: message.isError,
      timestamp: message.timestamp,
    } satisfies Message;
  }
  const content = normalizeAssistantContent(message.content);
  if (!content) return undefined;
  return {
    role: "assistant",
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
    usage: message.usage,
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
  } satisfies Message;
}

/**
 * Project stored local messages to the provider-facing pi-ai message list.
 *
 * Exported for F-04's compaction summarizer for the same reason as
 * {@link toPiTools}: the summarizer's context is the turn's context plus one
 * appended instruction, and "the same context" means this exact projection —
 * including orphan-tool-result removal and trailing-assistant stripping.
 */
export function toPiMessages(messages: readonly LocalMessage[]): Message[] {
  const providerSafeMessages = removeOrphanLocalToolResults(messages).messages;
  let normalized = providerSafeMessages.flatMap((message) => {
    const piMessage = toPiMessage(message);
    return piMessage ? [piMessage] : [];
  });

  // Strip trailing assistant messages after normalization. Providers like
  // Anthropic require the conversation to end with a user or tool-result
  // message, and dropping empty text-only user messages can expose a trailing
  // partial assistant response from a failed turn.
  while (normalized.length > 0 && normalized.at(-1)?.role === "assistant") {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function stripOpenAIResponsesReplayItemIds(
  payload: unknown,
): unknown | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;

  let changed = false;
  const input = payload.input.map((item) => {
    if (!isRecord(item) || !("id" in item)) return item;
    const type = item.type;
    if (
      type !== "reasoning" &&
      type !== "message" &&
      type !== "function_call"
    ) {
      return item;
    }

    changed = true;
    const next = { ...item };
    delete next.id;
    return next;
  });

  return changed ? { ...payload, input } : undefined;
}

function withOpenAIResponsesReplayIdSanitizer(
  existing: SimpleStreamOptions["onPayload"] | undefined,
): SimpleStreamOptions["onPayload"] {
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }

    const sanitized = stripOpenAIResponsesReplayItemIds(next);
    if (sanitized !== undefined) return sanitized;
    return upstreamChanged ? next : undefined;
  };
}

function withAnthropicOutputEffort(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  effort: string | undefined,
): SimpleStreamOptions["onPayload"] | undefined {
  if (!effort) return existing;
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }
    if (!isRecord(next)) return upstreamChanged ? next : undefined;
    const outputConfig = isRecord(next.output_config) ? next.output_config : {};
    return {
      ...next,
      output_config: {
        ...outputConfig,
        effort,
      },
    };
  };
}

/**
 * Reject a turn whose irreducible prompt cannot fit the serving context window.
 *
 * Local engines truncate oversized prompts silently rather than erroring, so
 * the failure mode is an agent that answers with its memory and persona
 * quietly missing. Compaction cannot help here — the system prompt and tool
 * definitions are not history — so surface it as an actionable error instead of
 * shipping a request we know will be clipped.
 */
function assertPromptFloorFitsContextWindow(
  input: ProviderTurnInput,
  model: { id: string; provider?: string; contextWindow?: number },
): void {
  const contextWindow = model.contextWindow;
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return;
  }
  const floorTokens = estimateProviderPromptFloorTokens(input);
  if (floorTokens <= contextWindow) return;

  const remedy =
    model.provider === "ollama"
      ? `Raise the served window (for example OLLAMA_CONTEXT_LENGTH=${nextPowerOfTwoAtLeast(floorTokens)} ollama serve)`
      : "Raise the engine's context window";
  throw new Error(
    `The system prompt and tool definitions need about ${floorTokens.toLocaleString()} tokens, ` +
      `but "${model.id}" is served with a ${contextWindow.toLocaleString()}-token context window. ` +
      `The engine would silently truncate the prompt, dropping memory and persona before the model sees them. ` +
      `${remedy}, or reduce what the prompt carries (fewer installed skills, a smaller toolset).`,
  );
}

function nextPowerOfTwoAtLeast(value: number): number {
  let size = 8192;
  while (size < value && size < 1_048_576) size *= 2;
  return size;
}

/**
 * Refuse a turn whose context already fills the serving window.
 *
 * The local backend no longer rewrites history to make room (D-105 / I1), and
 * past this boundary the engine either truncates the prompt or clamps the
 * completion to a useless one-token `length` stop. Failing loudly with the
 * numbers behind the decision is what lets the operator trim explicitly.
 */
function assertContextFitsContextWindow(
  input: ProviderTurnInput,
  model: { id: string; contextWindow?: number },
): void {
  const contextWindow = model.contextWindow;
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return;
  }
  const contextTokens = estimateProviderContextTokens(input);
  if (contextTokens === undefined) return;
  if (contextPressureLevel({ contextTokens, contextWindow }) !== "hard") return;

  throw new LocalContextOverflowError(
    `Context is at about ${contextTokens.toLocaleString()} of "${model.id}"'s ` +
      `${contextWindow.toLocaleString()}-token window, inside the output reserve ` +
      `this harness keeps free for a reply. ${CONTEXT_OVERFLOW_GUIDANCE}`,
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function anthropicEffortForSettings(
  modelSettings: Record<string, unknown>,
): string | undefined {
  const nestedReasoning = isRecord(modelSettings.reasoning)
    ? modelSettings.reasoning
    : undefined;
  return (
    stringValue(modelSettings.effort) ??
    stringValue(nestedReasoning?.reasoning_effort) ??
    stringValue(modelSettings.reasoning_effort)
  );
}

function maxTokensForSettings(
  modelSettings: Record<string, unknown>,
): number | undefined {
  const maxTokens = modelSettings.max_tokens;
  return typeof maxTokens === "number" && Number.isFinite(maxTokens)
    ? maxTokens
    : undefined;
}

function serviceTierForSettings(
  model: Model<string>,
  modelSettings: Record<string, unknown>,
): "priority" | undefined {
  if (model.api !== "openai-codex-responses") return undefined;
  return modelSettings.service_tier === "priority" ? "priority" : undefined;
}

/** The provider request a turn and an in-process single-shot call share. */
export interface AssembledPiProviderRequest {
  resolved: ResolvedPiModel;
  options: SimpleStreamOptions & Record<string, unknown>;
}

/**
 * Resolve the model and build the stream options for one provider request.
 *
 * F-04's compaction summarizer must send the *same bytes* the conversation's
 * own turn sends (requirement §5.2.2): system prompt, frozen tool set, model
 * and sampling settings all come from the same frozen snapshot. Building the
 * options once here — instead of duplicating the block in the summarizer — is
 * what makes that a property of the code rather than a promise. The gate that
 * proves it is `scripts/verify-compaction-prefix.ts`.
 *
 * The D-008 prefix probe is attached last, so it observes the payload before
 * the provider-specific rewrites below touch it, exactly like a turn does.
 */
export async function assemblePiProviderRequest(input: {
  agent: LocalAgentRecord;
  conversationId: string;
  storageDir?: string;
  modelsRuntime: LocalPiModelsRuntime;
  signal?: AbortSignal;
  onPayload?: SimpleStreamOptions["onPayload"];
}): Promise<AssembledPiProviderRequest> {
  const localModel = await resolveAvailableLocalModelForTurn({
    model: input.agent.model,
    modelSettings: input.agent.model_settings,
    storageDir: input.storageDir,
    modelsRuntime: input.modelsRuntime,
  });
  const resolved = await resolvePiModelForAgent(
    localModel.model,
    localModel.modelSettings,
    {
      localProviderAuthStorageDir: input.storageDir,
      modelsRuntime: input.modelsRuntime,
      ...(input.signal ? { abortSignal: input.signal } : {}),
    },
  );
  const reasoning = reasoningForSettings(
    input.agent.model_settings,
    input.agent.model,
    resolved.model,
  );
  const headers = resolvePiRequestHeaders({
    provider: resolved.model.provider,
    configuredHeaders: resolved.headers,
    conversationId: input.conversationId,
  });
  const options: SimpleStreamOptions & Record<string, unknown> = {
    ...resolved.providerOptions,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(resolved.timeout !== false ? { timeoutMs: resolved.timeout } : {}),
    ...(headers ? { headers } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    maxRetries: 0,
    sessionId: input.conversationId,
    // streamSimple drops provider-specific named options; samplingParams is
    // pi-ai's supported pass-through for explicit provider request overrides.
    ...(isRecord(input.agent.model_settings.sampling_params)
      ? { samplingParams: input.agent.model_settings.sampling_params }
      : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(maxTokensForSettings(input.agent.model_settings)
      ? { maxTokens: maxTokensForSettings(input.agent.model_settings) }
      : {}),
    ...(serviceTierForSettings(resolved.model, input.agent.model_settings)
      ? {
          serviceTier: serviceTierForSettings(
            resolved.model,
            input.agent.model_settings,
          ),
        }
      : {}),
    ...(boolValue(input.agent.model_settings.parallel_tool_calls) !== undefined
      ? {
          parallelToolCalls: boolValue(
            input.agent.model_settings.parallel_tool_calls,
          ),
        }
      : {}),
  };

  let onPayload = input.onPayload;
  if (resolved.model.api === "openai-responses") {
    // pi-ai replays OpenAI Responses output items from transcript history.
    // Those upstream item IDs (rs_*, msg_*, fc_*) are not retrievable when the
    // request uses store:false, so remove them and replay the full item bodies.
    onPayload = withOpenAIResponsesReplayIdSanitizer(onPayload);
  }
  if (resolved.model.api === "anthropic-messages") {
    if (
      resolved.model.id.includes("claude-fable-5") &&
      anthropicEffortForSettings(input.agent.model_settings) === "max"
    ) {
      // pi-ai's public ThinkingLevel type currently tops out at xhigh, but
      // Anthropic accepts Fable's max effort through output_config.effort.
      onPayload = withAnthropicOutputEffort(onPayload, "max");
    }
  }

  // Prefix-freeze payload probe (D-008): wraps the provider-specific onPayload
  // hooks above so the exact bytes sent are captured last. No-op unless
  // HARUYUKI_PREFIX_PROBE_DIR is set.
  onPayload = withPrefixProbe(onPayload, {
    conversationId: input.conversationId,
    modelId: resolved.model.id,
  });
  if (onPayload) options.onPayload = onPayload;

  return { resolved, options };
}

function toLocalAssistantMessage(
  message: AssistantMessage,
  input: ProviderTurnInput,
): LocalAssistantMessage {
  return {
    id: message.responseId ?? `local-assistant-${Date.now()}`,
    role: "assistant",
    content: message.content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
    usage: message.usage ?? emptyLocalUsage(),
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
    metadata: {
      agent_id: input.agentId,
      conversation_id: input.conversationId,
      provider: {
        provider_id: message.provider,
        model_id: message.model,
        ...(message.responseId ? { response_id: message.responseId } : {}),
        usage: message.usage,
      },
    },
  };
}

function llmEndErrorFromError(error: unknown): {
  error: LlmEndErrorInfo;
  stopReason: string;
} {
  const info = normalizeLocalProviderError(error);
  return {
    error: {
      message: info.message,
      detail: info.detail,
      errorType: info.error_type,
      retryable: info.retryable,
    },
    stopReason: info.stop_reason,
  };
}

function isOverflowError(error: unknown, contextWindow?: number): boolean {
  if (error instanceof PiProviderError) {
    return isContextOverflow(error.assistant, contextWindow);
  }
  return isContextWindowOverflowError(error);
}

export class PiStreamAdapter implements ProviderStreamAdapter {
  private readonly runStream: PiStreamFunction;
  private readonly abortSignal?: AbortSignal;
  private readonly localProviderAuthStorageDir?: string;
  private readonly modelsRuntime: LocalPiModelsRuntime;
  private readonly onLlmStart?: PiStreamAdapterOptions["onLlmStart"];
  private readonly onLlmEnd?: PiStreamAdapterOptions["onLlmEnd"];

  constructor(options: PiStreamAdapterOptions = {}) {
    this.modelsRuntime =
      options.modelsRuntime ??
      new LocalPiModelsRuntime({
        storageDir: options.localProviderAuthStorageDir,
      });
    // Stream dispatch goes through the pi-ai Models runtime so the provider
    // that published the model owns the request; no global compat dispatch.
    this.runStream =
      options.stream ??
      ((model, context, streamOptions) =>
        model.api === "bedrock-converse-stream"
          ? this.modelsRuntime.stream(model, context, streamOptions as never)
          : this.modelsRuntime.streamSimple(model, context, streamOptions));
    this.abortSignal = options.abortSignal;
    this.localProviderAuthStorageDir = options.localProviderAuthStorageDir;
    this.onLlmStart = options.onLlmStart;
    this.onLlmEnd = options.onLlmEnd;
  }

  private async *streamOnce(
    input: ProviderTurnInput,
  ): AsyncIterable<ProviderStreamEvent> {
    const tools = toPiTools(input.clientTools);
    const { resolved, options } = await assemblePiProviderRequest({
      agent: input.agent,
      conversationId: input.conversationId,
      ...(this.localProviderAuthStorageDir
        ? { storageDir: this.localProviderAuthStorageDir }
        : {}),
      modelsRuntime: this.modelsRuntime,
      ...(this.abortSignal ? { signal: this.abortSignal } : {}),
    });
    assertPromptFloorFitsContextWindow(input, resolved.model);
    assertContextFitsContextWindow(input, resolved.model);
    const messages = toPiMessages(input.uiMessages);
    const context: Context = {
      systemPrompt: input.systemPrompt ?? input.agent.system,
      messages,
      ...(tools ? { tools } : {}),
    };

    const restoreEnv = applyPiEnvOverrides(resolved.envOverrides);
    const llmStartedAt = Date.now();
    let llmEnded = false;
    const emitLlmEnd = async (
      info: Omit<
        LlmEndInfo,
        "agentId" | "conversationId" | "durationMs" | "model"
      >,
    ): Promise<void> => {
      llmEnded = true;
      await this.onLlmEnd?.({
        agentId: input.agentId,
        conversationId: input.conversationId,
        model: input.agent.model,
        durationMs: Date.now() - llmStartedAt,
        ...info,
      });
    };
    try {
      await this.onLlmStart?.({
        agentId: input.agentId,
        conversationId: input.conversationId,
        model: input.agent.model,
        messageCount: context.messages.length,
        contextWindow: resolved.model.contextWindow,
      });
      const result = this.runStream(
        resolved.model as Model<string>,
        context,
        options,
      );

      let streamError: unknown;
      let finalMessage: AssistantMessage | undefined;
      let finalLocalMessage: LocalAssistantMessage | undefined;
      for await (const part of result) {
        if (part.type === "error") {
          const error = new PiProviderError(part.error);
          if (
            isOverflowError(error, resolved.model.contextWindow) ||
            isRetryableLocalProviderError(error)
          ) {
            streamError = error;
            break;
          }
          if (part.error.content.length > 0) {
            yield providerLocalMessage(
              toLocalAssistantMessage(part.error, input),
            );
          }
        }
        if (part.type === "done") {
          finalMessage = part.message;
          finalLocalMessage = toLocalAssistantMessage(part.message, input);
          yield providerLocalMessage(finalLocalMessage);
        }
        yield providerStreamPart(part);
      }

      if (streamError) throw streamError;
      finalMessage ??= await result.result();
      const finalMessageError =
        finalMessage.stopReason === "error" ||
        finalMessage.stopReason === "aborted"
          ? llmEndErrorFromError(new PiProviderError(finalMessage)).error
          : undefined;
      await emitLlmEnd({
        stopReason: finalMessage.stopReason,
        usage: {
          promptTokens: finalMessage.usage.input,
          completionTokens: finalMessage.usage.output,
          totalTokens: finalMessage.usage.totalTokens,
        },
        ...(finalMessageError ? { error: finalMessageError } : {}),
      });
      if (
        finalMessage.stopReason === "error" ||
        finalMessage.stopReason === "aborted"
      ) {
        throw new PiProviderError(finalMessage);
      }
    } catch (error) {
      if (!llmEnded) {
        const endError = llmEndErrorFromError(error);
        await emitLlmEnd({
          stopReason: endError.stopReason,
          usage: null,
          error: endError.error,
        });
      }
      throw error;
    } finally {
      restoreEnv();
    }
  }

  async *stream(input: ProviderTurnInput): AsyncIterable<ProviderStreamEvent> {
    let activeInput = input;
    let transientRetries = 0;

    while (true) {
      let emittedModelOutput = false;
      let emittedLocalMessage = false;
      try {
        for await (const event of this.streamOnce(activeInput)) {
          if (isPiModelOutputEvent(event)) emittedModelOutput = true;
          if (event.type === "local-message") emittedLocalMessage = true;
          yield event;
        }
        return;
      } catch (error) {
        // A context overflow is terminal (D-105 / I1): the local backend no
        // longer rewrites history to make room, and no transport retry can
        // shrink the request. Classify it here rather than leaning on the
        // retryable-transport check, because pi-ai reports overflow through the
        // assistant message as well as through error text.
        if (isOverflowError(error)) throw error;

        const retryableTransportError = isRetryableLocalProviderError(error);

        // Oversized-payload classification: a retryable transport failure on a
        // payload we can measure as oversized will keep failing, so shed the
        // provider-only image bytes before retrying the same tokens. This
        // rewrites the request for one retry, never the stored context.
        if (
          retryableTransportError &&
          !emittedModelOutput &&
          isOversizedPayloadTransportFailure(activeInput)
        ) {
          const imageElision = elideImagePayloadsForProviderRetry(activeInput);
          if (imageElision) {
            debugLog(
              "pi-stream",
              "oversized payload transport failure: elided %d image(s) (%d -> %d bytes, limit %d, target %d) from provider retry context",
              imageElision.elidedImages,
              imageElision.beforeBytes,
              imageElision.afterBytes,
              imageElision.requestByteLimit,
              imageElision.requestByteTarget,
            );
            activeInput = imageElision.input;
            transientRetries = 0;
            continue;
          }
        }

        // Adaptive image elision: a fixed byte limit cannot capture a user's
        // current uplink. If a retryable transport error repeats before any
        // model output, shed provider-context-only image bytes even when the
        // request is below the configured classifier threshold.
        if (
          retryableTransportError &&
          !emittedModelOutput &&
          transientRetries >=
            LOCAL_PROVIDER_ADAPTIVE_IMAGE_ELISION_AFTER_RETRIES
        ) {
          const imageElision = elideImagePayloadsForProviderRetry(activeInput, {
            allowUnderLimit: true,
          });
          if (imageElision) {
            debugLog(
              "pi-stream",
              "retryable transport failures persisted: adaptively elided %d image(s) (%d -> %d bytes, limit %d, target %d) from provider retry context",
              imageElision.elidedImages,
              imageElision.beforeBytes,
              imageElision.afterBytes,
              imageElision.requestByteLimit,
              imageElision.requestByteTarget,
            );
            activeInput = imageElision.input;
            transientRetries = 0;
            continue;
          }
        }

        if (
          emittedModelOutput ||
          transientRetries >= LOCAL_PROVIDER_MAX_RETRIES ||
          !retryableTransportError
        ) {
          if (
            emittedModelOutput &&
            !emittedLocalMessage &&
            error instanceof PiProviderError &&
            error.assistant.content.length > 0
          ) {
            yield providerLocalMessage(
              toLocalAssistantMessage(error.assistant, activeInput),
            );
          }
          throw error;
        }

        transientRetries += 1;
        const delayMs = localProviderRetryDelayMs(error, transientRetries);
        yield providerLettaChunk({
          message_type: "event_message",
          event_type: "retry",
          event_data: {
            attempt: transientRetries,
            max_attempts: LOCAL_PROVIDER_MAX_RETRIES,
            delay_ms: delayMs,
            message: localProviderRetryMessage(error),
          },
        } as never);
        await sleepWithAbort(delayMs, this.abortSignal);
      }
    }
  }
}
