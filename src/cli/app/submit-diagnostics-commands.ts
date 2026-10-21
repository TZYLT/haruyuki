import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  applySetMaxContext,
  formatSetMaxContextResult,
} from "@/agent/max-context";
import { getAgentContextOverview } from "@/backend/api/agents";
import {
  type ContextWindowOverview,
  renderContextUsage,
} from "@/cli/helpers/context-chart";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import { resetContextHistory } from "@/cli/helpers/context-tracker";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import type { AppCommandRunner } from "./types";

type SubmitCommandResult = { submitted: boolean };

type DiagnosticsCommandContext = {
  agentId: string;
  agentIdRef: MutableRefObject<string>;
  commandRunner: AppCommandRunner;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  conversationIdRef: MutableRefObject<string>;
  currentModelHandle: string | null;
  currentModelId: string | null;
  effectiveContextWindowSize: number | undefined;
  llmConfigRef: MutableRefObject<LlmConfig | null>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setCommandRunning: (value: boolean) => void;
  setConversationOverrideContextWindowLimit: Dispatch<
    SetStateAction<number | null>
  >;
  setConversationOverrideModelSettings: Dispatch<
    SetStateAction<AgentState["model_settings"] | null>
  >;
  setHasConversationModelOverride: (value: boolean) => void;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
};

export async function handleDiagnosticsCommand(
  trimmed: string,
  ctx: DiagnosticsCommandContext,
): Promise<SubmitCommandResult | null> {
  const {
    agentId,
    agentIdRef,
    commandRunner,
    contextTrackerRef,
    conversationIdRef,
    currentModelHandle,
    currentModelId,
    effectiveContextWindowSize,
    llmConfigRef,
    setAgentState,
    setCommandRunning,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setHasConversationModelOverride,
    setLlmConfig,
  } = ctx;

  // `/usage` is no longer a diagnostic print: the M6 ruling moved it to the Usage
  // page tab (`《38》§3.2`, "/usage 切到 Usage 页"), and `use-submit-handler` focuses
  // the tab before this handler is reached. The balance/session-stat block that
  // lived here is gone with it — it is P5's data, printed on a page.

  if (trimmed === "/context") {
    const contextWindow = effectiveContextWindowSize ?? 0;
    const model = llmConfigRef.current?.model ?? "unknown";
    const usedTokens = contextTrackerRef.current.lastContextTokens;
    const history = contextTrackerRef.current.contextTokensHistory;

    const cmd = commandRunner.start(trimmed, "Fetching context breakdown...");

    let breakdown: ContextWindowOverview | undefined;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        breakdown = await getAgentContextOverview<ContextWindowOverview>(
          agentIdRef.current,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      // Timeout or network error: proceed without breakdown.
    }

    cmd.finish(
      renderContextUsage({
        usedTokens,
        contextWindow,
        model,
        history,
        ...(breakdown && { breakdown }),
      }),
      true,
      false,
      true,
    );

    return { submitted: true };
  }

  const contextLimitCommand = (() => {
    if (trimmed === "/context-limit" || trimmed.startsWith("/context-limit ")) {
      return "/context-limit";
    }
    if (
      trimmed === "/set-max-context" ||
      trimmed.startsWith("/set-max-context ")
    ) {
      return "/set-max-context";
    }
    return null;
  })();

  if (contextLimitCommand) {
    const args = trimmed.slice(contextLimitCommand.length).trim();
    const cmd = commandRunner.start(trimmed, "Setting max context window...");
    setCommandRunning(true);

    try {
      const result = await applySetMaxContext({
        agentId: agentIdRef.current,
        conversationId: conversationIdRef.current,
        args,
        currentModelId,
        currentModelHandle,
        currentLlmConfig: llmConfigRef.current,
        currentContextWindow: effectiveContextWindowSize ?? null,
      });

      if (result.updatedAgent) {
        setAgentState(result.updatedAgent);
        setHasConversationModelOverride(false);
        setConversationOverrideModelSettings(null);
        setConversationOverrideContextWindowLimit(null);
      } else {
        setHasConversationModelOverride(true);
        setConversationOverrideModelSettings(
          result.conversationModelSettings ?? null,
        );
        setConversationOverrideContextWindowLimit(result.contextWindow);
      }

      setLlmConfig({
        ...(llmConfigRef.current ?? ({} as LlmConfig)),
        context_window: result.contextWindow,
      } as LlmConfig);
      resetContextHistory(contextTrackerRef.current);
      cmd.finish(formatSetMaxContextResult(result), true);
    } catch (error) {
      const errorDetails = formatErrorDetails(error, agentId);
      cmd.fail(`Failed to set max context: ${errorDetails}`);
    } finally {
      setCommandRunning(false);
    }

    return { submitted: true };
  }

  return null;
}
