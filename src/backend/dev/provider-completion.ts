/**
 * F-04: the one provider call the compaction summarizer makes.
 *
 * The summarizer is not a subagent and not a hidden conversation — it is a
 * single in-process completion on the conversation's own frozen prefix
 * (requirement §5.2.1). This module owns the call itself: resolve the model,
 * assemble the request (shared with the turn path, so the bytes match), abort
 * and overflow classification, and the usage numbers the calling layer records.
 * It never parses the answer — the summarizer's own contract does that.
 *
 * Failure taxonomy (requirement §5.9.3) is expressed as exceptions, not as a
 * result union:
 *
 * - `ProviderCompletionOverflowError` — the request itself cannot fit the
 *   window; the summarizer's truncation ladder owns the retry decision.
 * - `ProviderCompletionError` — the provider ended the request with an error
 *   (auth/network/process). The caller aborts the compaction with zero writes.
 * - a thrown transport error (including an abort) propagates unchanged; a
 *   `stopReason: "aborted"` message is returned as a normal result so the
 *   caller can map it to "user cancelled" rather than to a failure (route C-13).
 *
 * Deliberately missing: a wall-clock timeout (requirement §5.2.6, Q-38). The
 * only way out of a hung call is the caller's `signal`.
 */
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";

import type { CompactUsage } from "@/backend/local/compaction-preview";
import type { LocalAgentRecord } from "@/backend/local/local-store";
import {
  isContextWindowOverflowError,
  LocalContextOverflowError,
} from "./context-window-overflow";
import { applyPiEnvOverrides } from "./pi-model-factory";
import { LocalPiModelsRuntime } from "./pi-models-runtime";
import { assemblePiProviderRequest } from "./pi-stream-adapter";

/** What the summarizer needs to make its one call. Frozen at M0 (route §2.3). */
export interface ProviderCompletionInput {
  /** The agent as the frozen prefix pinned it (`applyFrozenAgentOverrides`). */
  agent: LocalAgentRecord;
  /**
   * The request context: the turn's `systemPrompt` bytes, the turn's projected
   * messages, plus the one appended instruction, and the frozen tool set.
   */
  context: Context;
  /** The conversation the request belongs to; also the provider session id. */
  conversationId: string;
  storageDir?: string;
  modelsRuntime?: LocalPiModelsRuntime;
  /** Per-request cancellation. The summarizer passes the user's Esc here. */
  signal?: AbortSignal;
  /** Optional observer, composed under the D-008 prefix probe. */
  onPayload?: SimpleStreamOptions["onPayload"];
}

export interface ProviderCompletionResult {
  message: AssistantMessage;
  usage: CompactUsage;
}

/**
 * The provider ended the request with an error (auth, network, process). Not a
 * format problem: the compaction must abort with no writes (requirement
 * §5.9.3 ③). `usage` is carried because failed spend is still spend (§5.14).
 */
export class ProviderCompletionError extends Error {
  readonly stopReason: AssistantMessage["stopReason"];
  readonly usage: CompactUsage;

  constructor(message: AssistantMessage, usage: CompactUsage) {
    super(
      message.errorMessage ??
        "The provider ended the compaction summarizer request with an error.",
    );
    this.name = "ProviderCompletionError";
    this.stopReason = message.stopReason;
    this.usage = usage;
  }
}

/**
 * The request itself overflowed the model window.
 *
 * Extends the backend's existing overflow error, so every classifier that
 * already treats a local overflow as terminal-and-actionable keeps working.
 */
export class ProviderCompletionOverflowError extends LocalContextOverflowError {
  readonly usage: CompactUsage;

  constructor(message: string, usage: CompactUsage) {
    super(message);
    this.name = "ProviderCompletionOverflowError";
    this.usage = usage;
  }
}

function usageOf(message: AssistantMessage, wallMs: number): CompactUsage {
  return {
    promptTokens: message.usage.input,
    cachedInputTokens: message.usage.cacheRead,
    completionTokens: message.usage.output,
    wallMs,
  };
}

/**
 * Run one completion and classify its ending.
 *
 * `signal` is passed per request, not held by a shared adapter: the summarizer
 * owns its own cancellation and must never inherit the turn path's controller
 * (route C-13).
 */
export async function completeProviderOnce(
  input: ProviderCompletionInput,
): Promise<ProviderCompletionResult> {
  const startedAt = Date.now();
  const modelsRuntime =
    input.modelsRuntime ??
    new LocalPiModelsRuntime({
      ...(input.storageDir ? { storageDir: input.storageDir } : {}),
    });
  const { resolved, options } = await assemblePiProviderRequest({
    agent: input.agent,
    conversationId: input.conversationId,
    ...(input.storageDir ? { storageDir: input.storageDir } : {}),
    modelsRuntime,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onPayload ? { onPayload: input.onPayload } : {}),
  });

  const restoreEnv = applyPiEnvOverrides(resolved.envOverrides);
  try {
    // Same dispatch rule as a turn: the provider that published the model owns
    // the request, and bedrock needs the api-specific stream entry.
    const stream =
      resolved.model.api === "bedrock-converse-stream"
        ? modelsRuntime.stream(
            resolved.model as Model<string>,
            input.context,
            options as never,
          )
        : modelsRuntime.streamSimple(resolved.model, input.context, options);
    const message = await stream.result();
    const usage = usageOf(message, Date.now() - startedAt);
    if (isContextOverflow(message, resolved.model.contextWindow)) {
      throw new ProviderCompletionOverflowError(
        `The compaction summarizer request overflows "${resolved.model.id}"'s context window. ` +
          "Shorten the context it reads and retry.",
        usage,
      );
    }
    if (message.stopReason === "error") {
      throw new ProviderCompletionError(message, usage);
    }
    return { message, usage };
  } catch (error) {
    if (
      error instanceof ProviderCompletionError ||
      error instanceof ProviderCompletionOverflowError
    ) {
      throw error;
    }
    if (isContextWindowOverflowError(error)) {
      throw new ProviderCompletionOverflowError(
        error instanceof Error
          ? error.message
          : "The compaction summarizer request overflows the context window.",
        {
          promptTokens: 0,
          cachedInputTokens: 0,
          completionTokens: 0,
          wallMs: Date.now() - startedAt,
        },
      );
    }
    throw error;
  } finally {
    restoreEnv();
  }
}
