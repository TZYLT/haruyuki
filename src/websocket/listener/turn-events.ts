import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";
import type { PostTurnReflectionTrigger } from "@/cli/helpers/post-turn-reflection";
import { launchReflectionSubagent } from "@/cli/helpers/reflection-launcher";
import { getTurnStartCancel } from "@/mods/turn-start-cancel";
import { settingsManager } from "@/settings-manager";
import {
  createListenerModContext,
  createListenerModEvents,
  ensureListenerModAdaptersForAgent,
} from "./mod-adapter";
import type { ListenerTransport } from "./transport";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export function escapeTaskNotificationSummary(summary: string): string {
  return summary
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isTurnInputArray(
  value: unknown,
): value is Array<MessageCreate | ApprovalCreate> {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

export type ListenerTurnStartEmission =
  | {
      cancelled: false;
      handlerCount: number;
      input: Array<MessageCreate | ApprovalCreate>;
    }
  | { cancelled: true; reason: string };

export async function emitListenerTurnStart(options: {
  agentId: string;
  conversationId: string;
  input: Array<MessageCreate | ApprovalCreate>;
  runtime: ListenerRuntime;
  workingDirectory: string;
  permissionMode?: string | null;
  cachedAgent?: AgentState | null;
}): Promise<ListenerTurnStartEmission> {
  try {
    const modAdapters = await ensureListenerModAdaptersForAgent(
      options.runtime,
      options.agentId,
    );
    const context = createListenerModContext({
      sessionId: options.conversationId,
      workingDirectory: options.workingDirectory,
      permissionMode: options.permissionMode ?? null,
      agent: options.cachedAgent ?? { id: options.agentId },
    });
    const event = {
      agentId: options.agentId,
      conversationId: options.conversationId,
      input: options.input,
    };
    const emission = await createListenerModEvents(modAdapters).emit(
      "turn_start",
      event,
      context,
    );
    const cancel = getTurnStartCancel(event);
    if (cancel) {
      return { cancelled: true, reason: cancel.reason };
    }
    return {
      cancelled: false,
      handlerCount: emission.handlerCount,
      input: isTurnInputArray(event.input) ? event.input : options.input,
    };
  } catch {
    // Mod turn_start handlers should not block sending the turn.
    return { cancelled: false, handlerCount: 0, input: options.input };
  }
}

export async function emitListenerTurnEnd(options: {
  agentId: string;
  conversationId: string;
  stopReason: string;
  assistantMessage?: string;
  runtime: ListenerRuntime;
  workingDirectory: string;
  permissionMode?: string | null;
  cachedAgent?: AgentState | null;
}): Promise<string | undefined> {
  try {
    const modAdapters = await ensureListenerModAdaptersForAgent(
      options.runtime,
      options.agentId,
    );
    const context = createListenerModContext({
      sessionId: options.conversationId,
      workingDirectory: options.workingDirectory,
      permissionMode: options.permissionMode ?? null,
      agent: options.cachedAgent ?? { id: options.agentId },
    });
    const event: {
      agentId: string;
      conversationId: string;
      stopReason: string;
      assistantMessage?: string;
      continue?: string;
    } = {
      agentId: options.agentId,
      conversationId: options.conversationId,
      stopReason: options.stopReason,
      assistantMessage: options.assistantMessage,
    };
    await createListenerModEvents(modAdapters).emit("turn_end", event, context);
    return typeof event.continue === "string" && event.continue.length > 0
      ? event.continue
      : undefined;
  } catch {
    // Mod turn_end handlers should not block turn completion.
    return undefined;
  }
}

export function buildMaybeLaunchReflectionSubagent(params: {
  runtime: ConversationRuntime;
  socket: ListenerTransport;
  agentId: string;
  conversationId: string;
  reflectionSettings?: ReflectionSettings;
}): (
  triggerSource: PostTurnReflectionTrigger,
  launchSettings: Pick<ReflectionSettings, "timeoutMinutes">,
) => Promise<boolean> {
  return async (triggerSource, launchSettings) => {
    const { agentId, conversationId } = params;

    if (!agentId) {
      return false;
    }

    // The completion notification is not sent from here: the listener registers
    // one subscription on the run controller's terminal seam (app-server
    // `getStartupReady`) and emits it to the subscribed clients there.
    const result = await launchReflectionSubagent({
      agentId,
      conversationId,
      memfsEnabled: settingsManager.isMemfsEnabled(agentId),
      triggerSource,
      reflectionSettings: launchSettings,
    });
    return result.launched;
  };
}
