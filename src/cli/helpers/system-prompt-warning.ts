/**
 * Startup warnings for the opening status block.
 *
 * The system-prompt size warning reuses the context-doctor heuristic; the
 * experiment-toggle warning explains an env var that asks for "on" with a
 * spelling the experiments manager rejects (see `buildStartupWarnings`).
 */
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { isActiveMemfsEnabled } from "@/agent/memory-runtime";
import {
  estimateSystemPromptTokensFromMemoryDir,
  estimateSystemTokens,
} from "@/agent/system-prompt-size";
import { isLocalBackendEnvEnabled } from "@/backend/local/paths";
import { findRejectedEnvToggles } from "@/experiments/manager";
import { debugWarn } from "@/utils/debug";

export { estimateSystemPromptTokensFromMemoryDir, estimateSystemTokens };

export function estimateActiveMemorySystemPromptTokens(
  memoryDir: string,
): number {
  return estimateSystemPromptTokensFromMemoryDir(
    memoryDir,
    isLocalBackendEnvEnabled(),
  );
}

const STARTUP_SYSTEM_PROMPT_WARNING_THRESHOLD_TOKENS = 30000;

export interface SystemPromptDoctorState {
  estimated_tokens: number;
  should_doctor: boolean;
  updated_at_ms: number;
}

const systemPromptDoctorStateByAgent = new Map<
  string,
  SystemPromptDoctorState
>();

export function setSystemPromptDoctorState(
  agentId: string,
  estimatedTokens: number,
): SystemPromptDoctorState {
  const nextState: SystemPromptDoctorState = {
    estimated_tokens: estimatedTokens,
    should_doctor:
      estimatedTokens >= STARTUP_SYSTEM_PROMPT_WARNING_THRESHOLD_TOKENS,
    updated_at_ms: Date.now(),
  };
  systemPromptDoctorStateByAgent.set(agentId, nextState);
  return nextState;
}

export function getSystemPromptDoctorState(
  agentId: string,
): SystemPromptDoctorState | null {
  return systemPromptDoctorStateByAgent.get(agentId) ?? null;
}

export function refreshSystemPromptDoctorState(
  agentId: string,
  agentState: AgentState | null | undefined,
): SystemPromptDoctorState | null {
  try {
    let estimatedSystemPromptTokens = 0;

    if (isActiveMemfsEnabled(agentId)) {
      const memoryDir = getScopedMemoryFilesystemRoot(agentId);
      estimatedSystemPromptTokens =
        estimateActiveMemorySystemPromptTokens(memoryDir);
    } else {
      // non-memfs
      const systemPrompt = (
        agentState as { system?: string | null } | null | undefined
      )?.system;
      if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
        estimatedSystemPromptTokens = estimateSystemTokens(systemPrompt);
      }
    }

    return setSystemPromptDoctorState(agentId, estimatedSystemPromptTokens);
  } catch (error) {
    debugWarn(
      "startup",
      `Failed to estimate system prompt tokens for startup warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}

/** On LC CLI startup, display a warning if the system prompt is large. */
export function buildStartupSystemPromptWarning(
  agentState: AgentState | null | undefined,
): string | null {
  const startupAgentId = agentState?.id;
  if (!startupAgentId) {
    return null;
  }

  const state = refreshSystemPromptDoctorState(startupAgentId, agentState);
  if (state?.should_doctor) {
    return "⚠ **Warning:** System prompt is large. Consider running **/doctor** to clean up memory.\n";
  }

  return null;
}

/**
 * Env vars whose rejected toggle spelling has already been reported. The
 * warning is a one-off explanation, not a per-conversation banner.
 */
const reportedRejectedEnvToggles = new Set<string>();

/** Test seam: forget which env vars have already been reported. */
export function resetRejectedEnvToggleReporting(): void {
  reportedRejectedEnvToggles.clear();
}

function buildRejectedEnvToggleWarnings(): string[] {
  const warnings: string[] = [];

  for (const toggle of findRejectedEnvToggles()) {
    if (reportedRejectedEnvToggles.has(toggle.envVar)) {
      continue;
    }
    reportedRejectedEnvToggles.add(toggle.envVar);

    debugWarn(
      "experiments",
      `${toggle.envVar}="${toggle.value}" is not an accepted toggle value, so "${toggle.id}" stays off (use 1, true or yes)`,
    );
    warnings.push(
      `⚠ **Warning:** \`${toggle.envVar}=${toggle.value}\` is ignored — \`${toggle.id}\` stays off. Use \`1\`, \`true\` or \`yes\`.`,
    );
  }

  return warnings;
}

/**
 * Every startup warning to show in the opening status block. Add warnings here
 * rather than at the call site: one list keeps their order and the one-off
 * bookkeeping in one place.
 */
export function buildStartupWarnings(
  agentState: AgentState | null | undefined,
): string[] {
  const warnings: string[] = [];

  const systemPromptWarning = buildStartupSystemPromptWarning(agentState);
  if (systemPromptWarning) {
    warnings.push(systemPromptWarning);
  }

  warnings.push(...buildRejectedEnvToggleWarnings());

  return warnings;
}
