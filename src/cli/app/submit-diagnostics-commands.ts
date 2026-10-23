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
import { withDeadline } from "@/cli/helpers/with-deadline";
import type { AppCommandRunner } from "./types";

/**
 * How long `/context` waits for the backend's composition before answering with
 * what it has locally.
 *
 * This fork's backend has no `/v1/agents/:id/context` route, so the honest budget
 * is short: the number under it (window, occupancy, history) is already known, and
 * a status row that hangs is worse than a report without the breakdown.
 */
const CONTEXT_BREAKDOWN_BUDGET_MS = 1500;

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

    // The local report never waits on the network: the breakdown is a bonus, and
    // `withDeadline` is what makes that true. Awaiting the request directly (with
    // an `AbortController` as the only bound) left the row on "Fetching…" for good
    // whenever the request hung before `fetch` — the machine saw "no output" and
    // then saw it work again on its own (2026-10-23).
    const controller = new AbortController();
    let breakdown: ContextWindowOverview | undefined;
    try {
      breakdown = await withDeadline(
        getAgentContextOverview<ContextWindowOverview>(agentIdRef.current, {
          signal: controller.signal,
        }),
        CONTEXT_BREAKDOWN_BUDGET_MS,
      );
    } catch {
      // Timeout, 404 from a backend without the endpoint, network error: the
      // report below is the part that always exists.
    } finally {
      // Only meaningful when the deadline won; a settled request ignores it.
      controller.abort();
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
