/**
 * Production wiring for the dream run controller (F-06 M2).
 *
 * `dream-run.ts` owns the state machine and takes every side effect through
 * `DreamRunDeps`; this module supplies the real ones: locks, git baseline,
 * backend session and metadata, the child spawn, the report writer and the
 * ledger marker. Keeping it separate is what lets `dream-run.ts` stay under the
 * 1,000-line ceiling and keeps the spawn details (which reach into `tools/`)
 * out of the state machine.
 */

import { writeDreamRunMetadata } from "@/agent/dream-run-metadata";
import { createDreamSession } from "@/agent/dream-session";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { claimMemoryOperation } from "@/agent/memory-operation";
import { getBackend } from "@/backend";
import { markDreamRunActive, markDreamRunFinished } from "@/cron/dream-signal";
import type { DreamUsageParts } from "@/dream-budget-math";
import { readDreamSettings } from "@/dream-settings";
import { readDreamRunMetadata } from "@/types/dream-run-metadata";
import { readDreamActivity } from "./dream-activity";
import { createDreamBaseline, rollbackDreamBaseline } from "./dream-baseline";
import {
  createDreamLease,
  deleteDreamLease,
  startDreamLeaseHeartbeat,
  updateDreamLease,
} from "./dream-lease";
import { tryAcquireDreamLock } from "./dream-lock";
import {
  readDreamPressure,
  recordDreamPressureBaseline,
} from "./dream-pressure";
import { writeDreamReport } from "./dream-report";
import { getAgentDisplayName } from "./dream-run-agent";
import type {
  DreamRunDeps,
  DreamTurnInput,
  DreamTurnResult,
} from "./dream-run-types";
import {
  dreamUsagePartsFromBuckets,
  mergeDreamUsageParts,
} from "./dream-usage";

const DREAM_SUBAGENT_TYPE = "dream";

/** Conservative child config: an existing conversation, no tool narrowing. */
export function dreamSubagentConfig() {
  return {
    name: "dream",
    description: "Unattended dream-run maintenance",
    systemPrompt: "",
    allowedTools: "all" as const,
    skills: [] as string[],
    fork: false,
    launchProfile: "memory-subagent" as const,
  };
}

/**
 * Spawn one tier turn on the hidden conversation and wait for it.
 *
 * Usage comes from the child's `usage_statistics` stream events (per model call)
 * merged with the result envelope's token split (fallback when the stream does
 * not carry it). The state machine treats a zero-usage turn as zero spend, which
 * is what an offline deterministic executor honestly reports.
 */
export async function spawnDreamTurnWithSubagent(
  input: DreamTurnInput,
): Promise<DreamTurnResult> {
  const { spawnBackgroundSubagentTask } = await import("@/tools/impl/task");
  const { subscribeToStreamEvents } = await import("@/agent/subagent-state");
  const { runWithRuntimeContext } = await import("@/runtime-context");

  let streamUsage: DreamUsageParts = {
    outputTokens: 0,
    uncachedReadTokens: 0,
    cachedReadTokens: 0,
  };

  let settle: (value: {
    success: boolean;
    error?: string;
    report?: string;
    model?: string;
    usage?: DreamUsageParts;
  }) => void = () => {};
  let settled = false;
  const completion = new Promise<{
    success: boolean;
    error?: string;
    report?: string;
    model?: string;
    usage?: DreamUsageParts;
  }>((resolve) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  let unsubscribe: (() => void) | null = null;
  const spawned = runWithRuntimeContext(
    {
      agentId: input.agentId,
      conversationId: input.conversationId,
      subagentPermissionMode: input.permissionMode,
      executionSettings: {
        // C-20: no shell in a dream child, even if the parent CLI allowed it.
        allowed_tools: [],
        disallowed_tools: ["Bash"],
        disable_memory_guard: false,
      },
    },
    (): ReturnType<typeof spawnBackgroundSubagentTask> | null => {
      try {
        return spawnBackgroundSubagentTask({
          subagentType: DREAM_SUBAGENT_TYPE,
          config: dreamSubagentConfig(),
          prompt: input.prompt,
          description: `Dream run ${input.runId} · ${input.tier}`,
          existingAgentId: input.agentId,
          existingConversationId: input.conversationId,
          memoryScope: {
            primaryRoot: input.memoryDir,
            writableRoots: [input.memoryDir],
          },
          parentScope: {
            agentId: input.agentId,
            conversationId: input.conversationId,
          },
          silentCompletion: true,
          onComplete: (result) => {
            const parts = result.usage
              ? dreamUsagePartsFromBuckets(result.usage)
              : undefined;
            settle({
              success: result.success,
              ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.report !== undefined ? { report: result.report } : {}),
              ...(result.model !== undefined ? { model: result.model } : {}),
              ...(parts !== undefined ? { usage: parts } : {}),
            });
          },
        });
      } catch (error) {
        settle({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  );

  if (!spawned) {
    return { success: false, aborted: false, usage: streamUsage };
  }

  // Subscribe after the task exists so events from other subagents cannot be
  // attributed to this turn.
  unsubscribe = subscribeToStreamEvents((subagentId, event) => {
    if (subagentId !== spawned.subagentId) return;
    const record = event as unknown as Record<string, unknown>;
    if (record.message_type !== "usage_statistics") return;
    const number = (key: string): number => {
      const value = record[key];
      return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : 0;
    };
    streamUsage = mergeDreamUsageParts(streamUsage, {
      outputTokens: number("completion_tokens"),
      uncachedReadTokens:
        number("prompt_tokens") + number("cache_write_tokens"),
      cachedReadTokens: number("cached_input_tokens"),
    });
  });

  const abortTurn = (): void => {
    try {
      spawned.abort();
    } catch {
      // Already gone.
    }
  };
  if (input.signal.aborted) abortTurn();
  else input.signal.addEventListener("abort", abortTurn, { once: true });

  const result = await completion;
  unsubscribe?.();
  input.signal.removeEventListener("abort", abortTurn);
  return {
    ...result,
    // The stream sees every model call; the result envelope is the fallback.
    usage:
      result.usage &&
      streamUsage.outputTokens +
        streamUsage.uncachedReadTokens +
        streamUsage.cachedReadTokens >
        0
        ? streamUsage
        : (result.usage ?? streamUsage),
    aborted: input.signal.aborted,
  };
}

/** Default deps: real locks, real backend, real child, real report. */
export function createDefaultDreamRunDeps(): DreamRunDeps {
  return {
    now: () => new Date(),
    resolveSettings: (agentId) => readDreamSettings(agentId),
    memoryDir: (agentId) => getScopedMemoryFilesystemRoot(agentId),
    tryAcquireDreamLock: (agentId) => tryAcquireDreamLock(agentId),
    acquireMemoryLock: (memoryDir) => claimMemoryOperation(memoryDir),
    async createBaseline({ memoryDir, runId, agentId }) {
      const agentName = await getAgentDisplayName(agentId);
      const baseline = await createDreamBaseline({
        memoryDir,
        runId,
        author: { agentId, authorName: agentName ?? agentId },
      });
      return { sha: baseline.sha };
    },
    async rollbackBaseline({ memoryDir, baselineSha }) {
      const result = await rollbackDreamBaseline({ memoryDir, baselineSha });
      return { changed: result.changed };
    },
    createSession: ({ agentId, runId }) =>
      createDreamSession({ agentId, runId }),
    writeMetadata: ({ conversationId, metadata }) =>
      writeDreamRunMetadata({ conversationId, metadata }),
    async readMetadata(conversationId) {
      const conversation = (await getBackend().retrieveConversation(
        conversationId,
      )) as unknown as { dream?: unknown };
      return readDreamRunMetadata(conversation.dream);
    },
    createLease: ({ agentId, runId, taskId }) => {
      createDreamLease({ agentId, runId, taskId });
    },
    updateLease: ({ agentId, patch }) => {
      updateDreamLease(agentId, patch);
    },
    startLeaseHeartbeat: (agentId) => startDreamLeaseHeartbeat(agentId),
    deleteLease: (agentId) => deleteDreamLease(agentId),
    markRunActive: (agentId, runId, at) =>
      markDreamRunActive(agentId, runId, at),
    markRunFinished: (agentId, outcome, at) =>
      markDreamRunFinished(agentId, outcome, at),
    readActivity: (agentId) => readDreamActivity(agentId),
    readPressure: (agentId) => readDreamPressure(agentId),
    recordPressureBaseline: (agentId, endedAt) =>
      recordDreamPressureBaseline(agentId, endedAt),
    spawnTurn: (turnInput) => spawnDreamTurnWithSubagent(turnInput),
    writeReport: ({ agentId, conversationId, metadata, body }) =>
      writeDreamReport({ agentId, conversationId, metadata, body }),
    async recordLedgerMarker(marker) {
      const { recordAutomatedRunMarker } = await import("@/usage/automated");
      await recordAutomatedRunMarker({
        source: "dream",
        outcome: marker.outcome,
        runId: marker.runId,
        agentId: marker.agentId,
        sessionId: marker.sessionId,
        model: marker.model,
        wallMs: marker.wallMs,
      });
    },
    retrieveAgentName: (agentId) => getAgentDisplayName(agentId),
  };
}

export { DREAM_SUBAGENT_TYPE };
