import type { Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import type {
  ConversationContextMode,
  ConversationOrigin,
} from "@/types/conversation-provenance";
import type { SubagentConfig } from ".";

export async function inheritForkToolset(
  agentId: string,
  parentConversationId: string,
  forkConversationId: string,
): Promise<void> {
  const parentToolset = settingsManager.getToolsetPreference(
    agentId,
    parentConversationId,
  );
  if (parentToolset === "auto") return;

  settingsManager.setToolsetPreference(
    agentId,
    parentToolset,
    forkConversationId,
  );
  await settingsManager.flush();
}

export interface ForkParentConversationParams {
  backend: Backend;
  parentAgentId: string;
  parentConversationId: string;
  /** The subagent being deployed; unused by the fork itself. */
  config?: SubagentConfig;
  signal?: AbortSignal;
  /** Producer recorded on the fork; task/recall forks default to `background`. */
  origin?: ConversationOrigin;
  /** What the fork copies; omitted leaves the backend's default (full history). */
  contextMode?: ConversationContextMode;
  /**
   * Provenance parent when it is not the conversation being forked. Defaults to
   * the source conversation, which is what every fork currently wants.
   */
  provenanceParentConversationId?: string;
}

interface ForkParentConversationDependencies {
  inheritToolset?: typeof inheritForkToolset;
}

/**
 * Fork the parent conversation, then apply fork-only runtime configuration.
 *
 * A fork inherits everything: the conversation copy carries the parent's
 * applied prefix snapshot and model, and nothing recompiles or re-pins it here.
 * Only client-side preferences that are keyed by conversation ID (the toolset)
 * are copied explicitly.
 *
 * Task/recall forks clone the full history (`origin: "background"`); a
 * reflection fork passes `origin: "reflection"` plus
 * `contextMode: "inherited-context"` so it copies only the current window
 * (requirement §5.1.7).
 */
export async function forkParentConversation(
  params: ForkParentConversationParams,
  dependencies: ForkParentConversationDependencies = {},
) {
  const forkedConversation = await params.backend.forkConversation(
    params.parentConversationId,
    {
      ...(params.parentConversationId === "default"
        ? { agentId: params.parentAgentId }
        : {}),
      hidden: true,
      origin: params.origin ?? "background",
      ...(params.contextMode ? { contextMode: params.contextMode } : {}),
      ...(params.provenanceParentConversationId
        ? { parentConversationId: params.provenanceParentConversationId }
        : {}),
      signal: params.signal,
    },
  );

  try {
    await (dependencies.inheritToolset ?? inheritForkToolset)(
      params.parentAgentId,
      params.parentConversationId,
      forkedConversation.id,
    );
  } catch (error) {
    await params.backend
      .deleteConversation?.(forkedConversation.id)
      .catch(() => undefined);
    throw error;
  }

  return forkedConversation;
}
