import type { Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
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

interface ForkParentConversationParams {
  backend: Backend;
  parentAgentId: string;
  parentConversationId: string;
  config: SubagentConfig;
  signal?: AbortSignal;
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
      // Task/recall subagents own their context: the fork is a background
      // producer and copied the full history (§5.5.2 write matrix).
      origin: "background",
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
