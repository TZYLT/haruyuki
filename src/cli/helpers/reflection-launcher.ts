/**
 * Launch one reflection run: a hidden fork of the current conversation, plus a
 * child process resumed on that fork through `--conv`.
 *
 * The order is fixed (F-03 §5.1.4, route §4 M1b):
 *
 *   cheap checks → reserve → register the run → non-blocking memory lock →
 *   fork → attach the fork → record `running` → spawn → attach the child.
 *
 * Everything expensive is after the cheap checks, so `end_turn` only pays for
 * the decision. A launch that cannot take the lock is skipped, never queued
 * (§5.5.6): a queued reflection would stack cost on a run that is already
 * writing memory.
 *
 * Old route retired here (§5.13.1): the transcript payload, the memory worktree
 * and its merge, the parent-repo dirty pre-check, the `explicit` integration
 * subagent and its archived conversation. The child writes the memory repo
 * directly and commits there; the memory lock is what serialises it.
 */
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  detectMemoryFormat,
  type LocalMemoryFormat,
} from "@/agent/memory-format";
import { claimMemoryOperation } from "@/agent/memory-operation";
import {
  attachReflectionFork,
  attachReflectionTask,
  finishReflectionRun,
  getReflectionRun,
  isReflectionRunActive,
  type ReflectionRunState,
  startReflectionRun,
} from "@/agent/reflection-run";
import {
  type WriteReflectionRunMetadataInput,
  writeReflectionRunMetadata,
} from "@/agent/reflection-run-metadata";
import { getSubagents } from "@/agent/subagent-state";
import {
  getAllSubagentConfigs,
  type SubagentConfig,
  type SubagentMemoryScope,
} from "@/agent/subagents";
import { forkParentConversation } from "@/agent/subagents/fork-conversation";
import { getBackend } from "@/backend";
import { classifyReflectionConfigurationError } from "@/cli/helpers/reflection-configuration-error";
import { buildReflectionTaskMessage } from "@/cli/helpers/reflection-prompt";
import {
  clearReflectionRetry,
  isReflectionRetryDeferred,
  recordReflectionFailure,
} from "@/cli/helpers/reflection-retry";
import { telemetry } from "@/telemetry";
import { maybeSendReflectionThresholdFeedback } from "@/telemetry/reflection-threshold-feedback";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import type {
  ReflectionRunMetadata,
  ReflectionRunTriggerSource,
} from "@/types/reflection-run-metadata";
import {
  recordTimedOutReflectionRun,
  type TimedOutReflectionRunInput,
} from "@/usage/automated";
import { debugLog, debugWarn } from "@/utils/debug";

export const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";

/** Requirement §5.8.1: one run is capped at 3 minutes unless configured. */
export const DEFAULT_REFLECTION_TIMEOUT_MINUTES = 3;

/**
 * Used only when the reflection subagent config cannot be discovered at all.
 * The child's persona comes from the appended task message, not the config, so
 * the fallback still has to pin `allowedTools: "all"` (see below).
 */
const FALLBACK_REFLECTION_CONFIG: SubagentConfig = {
  name: "reflection",
  description: AUTO_REFLECTION_DESCRIPTION,
  systemPrompt: "",
  allowedTools: "all",
  skills: [],
  fork: true,
  launchProfile: "memory-subagent",
};

/**
 * Per-run settings the launcher reads. Deliberately narrow: the launcher owns
 * the run, not the trigger policy, so it takes the deadline and nothing else
 * from the settings layer. The settings layer resolves the per-agent override
 * and passes it in (`ReflectionLaunchOptions.reflectionSettings`); a caller
 * that omits it gets the requirement's 3-minute default.
 */
export interface ReflectionLaunchSettings {
  timeoutMinutes?: number;
}

const reservedReflectionAgentIds = new Set<string>();
const suppressedAutomaticReflections = new Map<
  string,
  { model?: string; message: string }
>();

export type ReflectionLaunchTriggerSource = ReflectionRunTriggerSource;

export type ReflectionLaunchSkippedReason =
  | "memfs_disabled"
  | "lock_busy"
  | "already_active"
  | "retry_backoff"
  | "configuration_error"
  | "fork_failed"
  | "error";

export function getReflectionLaunchSkippedMessage(
  reason: ReflectionLaunchSkippedReason,
  surface: "cli" | "listener" = "cli",
): string | undefined {
  switch (reason) {
    case "already_active":
      return surface === "listener"
        ? "A reflection agent is already running for this conversation."
        : "A reflection agent is already running in the background.";
    case "configuration_error":
      return "Automatic reflection is paused because its model configuration is invalid. Fix the reflection model or provider, run /reload, then use /reflect to retry.";
    case "lock_busy":
      return surface === "listener"
        ? "Memory is being written by another process; skipped this reflection."
        : "Memory is being written by another process; skipped this reflection.";
    case "memfs_disabled":
      return surface === "listener"
        ? "Reflection needs the memory filesystem to be enabled for this agent."
        : "Memory filesystem is not enabled.";
    case "error":
    case "fork_failed":
    case "retry_backoff":
      return undefined;
  }
}

export interface ReflectionFeedbackContext {
  parentAgentName?: string | null;
  parentAgentDescription?: string | null;
  surface?: string;
}

/**
 * Telemetry still carries the pre-F-03 trigger names; the requirement's trigger
 * sources are mapped here instead of widening a shared telemetry contract.
 */
const TELEMETRY_TRIGGER_SOURCE: Record<
  ReflectionLaunchTriggerSource,
  "manual" | "step-count" | "compaction-event"
> = {
  manual: "manual",
  compaction: "compaction-event",
  "user-messages": "step-count",
};

export function emitReflectionRunStart(params: {
  triggerSource: ReflectionLaunchTriggerSource;
  subagentId?: string;
  conversationId: string;
}): void {
  telemetry.trackReflectionStart(
    TELEMETRY_TRIGGER_SOURCE[params.triggerSource],
    {
      subagentId: params.subagentId,
      conversationId: params.conversationId,
    },
  );
}

export function emitReflectionRunEnd(params: {
  parentAgentId: string;
  triggerSource: ReflectionLaunchTriggerSource;
  success: boolean;
  subagentId?: string;
  conversationId: string;
  error?: string;
  stepCount?: number;
  durationMs?: number;
  model?: string | null;
  feedbackContext?: ReflectionFeedbackContext;
}): void {
  telemetry.trackReflectionEnd(
    TELEMETRY_TRIGGER_SOURCE[params.triggerSource],
    params.success,
    {
      subagentId: params.subagentId,
      conversationId: params.conversationId,
      error: params.error,
      stepCount: params.stepCount,
      durationMs: params.durationMs,
      model: params.model,
    },
  );
  maybeSendReflectionThresholdFeedback({
    parentAgentId: params.parentAgentId,
    parentAgentName: params.feedbackContext?.parentAgentName,
    parentAgentDescription: params.feedbackContext?.parentAgentDescription,
    reflectionSubagentId: params.subagentId,
    conversationId: params.conversationId,
    triggerSource: TELEMETRY_TRIGGER_SOURCE[params.triggerSource],
    success: params.success,
    error: params.error,
    stepCount: params.stepCount,
    durationMs: params.durationMs,
    surface: params.feedbackContext?.surface,
    model: params.model,
  });
}

export type ReflectionLaunchResult =
  | {
      launched: true;
      runId: string;
      forkConversationId?: string;
      subagentId?: string;
    }
  | {
      launched: false;
      reason: ReflectionLaunchSkippedReason;
      error?: unknown;
    };

/** Frozen entry shape (route §3.4): M1h depends on it, not on the internals. */
export interface ReflectionLaunchOptions {
  agentId: string;
  conversationId: string;
  memfsEnabled: boolean;
  triggerSource: ReflectionLaunchTriggerSource;
  reflectionSettings?: ReflectionLaunchSettings;
  /** `/reflect --instruction`: user text appended to the task message. */
  instruction?: string;
}

/**
 * Seams for tests and for callers that already hold these resources. Production
 * callers pass options only; every default here is the real implementation.
 */
export interface ReflectionLaunchDependencies {
  claimMemoryLock?(memoryDir: string): Promise<(() => Promise<void>) | null>;
  forkConversation?(
    params: Parameters<typeof forkParentConversation>[0],
  ): Promise<{ id: string }>;
  spawnTask?(args: SpawnBackgroundSubagentTaskArgs): ReflectionSpawnedTask;
  resolveConfig?(): Promise<SubagentConfig | undefined>;
  memoryRoot?(agentId: string): string;
  memoryFormat?(agentId: string): LocalMemoryFormat;
  deleteConversation?(conversationId: string): Promise<void>;
  writeRunMetadata?(input: WriteReflectionRunMetadataInput): Promise<void>;
  /**
   * Test seam for the one row the parent owns: the zero-token marker written
   * when a run is killed at its deadline (§5.16.4).
   */
  recordTimeoutUsage?(input: TimedOutReflectionRunInput): Promise<boolean>;
}

/**
 * The slice of the spawn result the launcher uses. The child's abort handle is
 * optional here because the launcher must keep compiling against a spawn layer
 * that has not grown one yet; `spawnedTaskAbortHandle` degrades loudly.
 */
export interface ReflectionSpawnedTask {
  taskId: string;
  subagentId: string;
  outputFile?: string;
  abort?: () => void;
}

function isReflectionSubagentActiveForAgent(agentId: string): boolean {
  return getSubagents().some((agent) => {
    if (agent.type.toLowerCase() !== "reflection") {
      return false;
    }
    if (agent.status !== "pending" && agent.status !== "running") {
      return false;
    }
    return agent.parentAgentId === agentId;
  });
}

export function tryReserveReflectionLaunch(agentId: string): boolean {
  if (reservedReflectionAgentIds.has(agentId)) {
    return false;
  }
  if (isReflectionRunActive(agentId)) {
    return false;
  }
  if (isReflectionSubagentActiveForAgent(agentId)) {
    return false;
  }
  reservedReflectionAgentIds.add(agentId);
  return true;
}

export function isAutomaticReflectionSuppressed(agentId: string): boolean {
  return suppressedAutomaticReflections.has(agentId);
}

export function shouldSuppressReflectionLaunch(
  agentId: string,
  triggerSource: ReflectionLaunchTriggerSource,
): boolean {
  return triggerSource !== "manual" && isAutomaticReflectionSuppressed(agentId);
}

export function clearAutomaticReflectionSuppression(agentId: string): void {
  suppressedAutomaticReflections.delete(agentId);
}

export function recordReflectionConfigurationFailure(params: {
  agentId: string;
  model?: string;
  error?: string;
}): boolean {
  const configurationError = classifyReflectionConfigurationError(params.error);
  if (!configurationError) return false;

  suppressedAutomaticReflections.set(params.agentId, {
    model: params.model,
    message: configurationError.message,
  });
  debugWarn(
    "memory",
    `Pausing automatic reflection for ${params.agentId}: ${configurationError.message}`,
  );
  return true;
}

export function releaseReflectionLaunch(agentId: string): void {
  reservedReflectionAgentIds.delete(agentId);
}

function resolveTimeoutMinutes(
  settings: ReflectionLaunchSettings | undefined,
): number {
  const requested = settings?.timeoutMinutes;
  return typeof requested === "number" && Number.isFinite(requested)
    ? requested
    : DEFAULT_REFLECTION_TIMEOUT_MINUTES;
}

async function resolveReflectionConfig(): Promise<SubagentConfig | undefined> {
  const configs = await getAllSubagentConfigs();
  return configs.reflection;
}

async function deleteBackendConversation(
  conversationId: string,
): Promise<void> {
  await getBackend().deleteConversation?.(conversationId);
}

/**
 * Write `running` on the fork. A failure is a warning, never a launch failure:
 * the in-process run is what the gate trusts, the record is the durable copy
 * (§5.3.4).
 */
async function recordRunningMetadata(input: {
  forkConversationId: string;
  metadata: ReflectionRunMetadata;
  writer?: (input: WriteReflectionRunMetadataInput) => Promise<void>;
}): Promise<void> {
  try {
    await (input.writer ?? writeReflectionRunMetadata)({
      conversationId: input.forkConversationId,
      metadata: input.metadata,
    });
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to record reflection run metadata for ${input.metadata.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * The abort handle arrives with the run controller work item; until then the
 * attach still records the task id so a later step can find the child.
 */
function spawnedTaskAbortHandle(spawned: ReflectionSpawnedTask): () => void {
  if (typeof spawned.abort === "function") return spawned.abort;
  return () => {
    debugWarn(
      "memory",
      `Task ${spawned.taskId} has no abort handle yet; the reflection run cannot be stopped from here`,
    );
  };
}

async function deleteHalfBuiltFork(
  forkConversationId: string,
  remove: (conversationId: string) => Promise<void> = deleteBackendConversation,
): Promise<void> {
  try {
    await remove(forkConversationId);
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to delete half-built reflection fork ${forkConversationId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function launchReflectionSubagent(
  options: ReflectionLaunchOptions,
  dependencies: ReflectionLaunchDependencies = {},
): Promise<ReflectionLaunchResult> {
  const { agentId, conversationId, memfsEnabled, triggerSource } = options;

  // ── Cheap checks: no repository, no fork, no spawn ──────────────────────
  if (!memfsEnabled) {
    return { launched: false, reason: "memfs_disabled" };
  }
  if (isReflectionRetryDeferred(agentId, triggerSource)) {
    return { launched: false, reason: "retry_backoff" };
  }
  if (shouldSuppressReflectionLaunch(agentId, triggerSource)) {
    const suppressed = suppressedAutomaticReflections.get(agentId);
    debugLog(
      "memory",
      `Skipping automatic reflection (${triggerSource}) because model configuration is invalid${suppressed?.model ? ` for ${suppressed.model}` : ""}`,
    );
    return { launched: false, reason: "configuration_error" };
  }
  if (isReflectionRunActive(agentId) || !tryReserveReflectionLaunch(agentId)) {
    debugLog(
      "memory",
      `Skipping reflection launch (${triggerSource}) because one is already active`,
    );
    return { launched: false, reason: "already_active" };
  }

  const reflectionSettings = options.reflectionSettings;
  const timeoutMinutes = resolveTimeoutMinutes(reflectionSettings);

  let run: ReflectionRunState;
  try {
    run = startReflectionRun({
      agentId,
      parentConversationId: conversationId,
      triggerSource,
      timeoutMinutes,
    });
  } catch (error) {
    // Another path registered a run between the check and here.
    releaseReflectionLaunch(agentId);
    debugLog(
      "memory",
      `Skipping reflection launch (${triggerSource}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { launched: false, reason: "already_active", error };
  }

  let releaseMemoryLock: (() => Promise<void>) | undefined;
  try {
    const memoryRoot = dependencies.memoryRoot ?? getScopedMemoryFilesystemRoot;
    const memoryDir = memoryRoot(agentId);

    // ── Single writer: one non-blocking attempt, no queue (§5.5.6) ───────
    const claimedLock = await (
      dependencies.claimMemoryLock ?? claimMemoryOperation
    )(memoryDir);
    if (!claimedLock) {
      debugLog(
        "memory",
        `Skipping reflection launch (${triggerSource}) because the memory checkout is held by another process`,
      );
      await finishReflectionRun(run.runId, "cancelled");
      releaseReflectionLaunch(agentId);
      return { launched: false, reason: "lock_busy" };
    }
    releaseMemoryLock = claimedLock;
    const releaseLock = claimedLock;

    // ── Fork: context-only, hidden, from this conversation (§5.2) ────────
    const reflectionConfig = await (
      dependencies.resolveConfig ?? resolveReflectionConfig
    )();
    let forkConversationId: string;
    try {
      const forked = await (
        dependencies.forkConversation ?? forkParentConversation
      )({
        backend: getBackend(),
        parentAgentId: agentId,
        parentConversationId: conversationId,
        config: reflectionConfig,
        origin: "reflection",
        contextMode: "inherited-context",
        provenanceParentConversationId: conversationId,
      });
      forkConversationId = forked.id;
    } catch (error) {
      debugWarn(
        "memory",
        `Failed to fork the conversation for reflection (${triggerSource}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await finishReflectionRun(run.runId, "failed");
      await releaseLock();
      releaseReflectionLaunch(agentId);
      return { launched: false, reason: "fork_failed", error };
    }

    attachReflectionFork(run.runId, forkConversationId);

    // ── Spawn the child on the fork; the task message is stdin ───────────
    const memoryFormat =
      dependencies.memoryFormat?.(agentId) ??
      detectMemoryFormat(memoryDir, getBackend().capabilities.localMemfs);
    const memoryScope: SubagentMemoryScope = {
      primaryRoot: memoryDir,
      writableRoots: [memoryDir],
    };
    const spawnTask =
      dependencies.spawnTask ??
      (await import("@/tools/impl/task")).spawnBackgroundSubagentTask;
    const taskMessage = buildReflectionTaskMessage({
      runId: run.runId,
      instruction: options.instruction,
      memoryFormat,
    });

    let spawned: ReflectionSpawnedTask;
    try {
      spawned = spawnTask({
        subagentType: "reflection",
        // The existing-conversation branch still adds `--tools` unconditionally
        // when the config narrows the set, which would leave the child's local
        // registry short of the tools its frozen `client_tools` advertises
        // (§5.1.8). "all" is the only value that suppresses the flag.
        config: {
          ...(reflectionConfig ?? FALLBACK_REFLECTION_CONFIG),
          allowedTools: "all",
        },
        prompt: taskMessage,
        description: AUTO_REFLECTION_DESCRIPTION,
        existingConversationId: forkConversationId,
        memoryScope,
        parentScope: { agentId, conversationId },
        silentCompletion: true,
        onComplete: async ({
          success,
          error,
          model,
          stepCount,
          durationMs,
        }) => {
          try {
            emitReflectionRunEnd({
              parentAgentId: agentId,
              triggerSource,
              success,
              subagentId: spawned.subagentId,
              conversationId: forkConversationId,
              error,
              stepCount,
              durationMs,
              model,
            });
            if (success) {
              clearAutomaticReflectionSuppression(agentId);
              clearReflectionRetry(agentId);
            } else {
              // §5.1.6: a failed child must leave a trace of why, not just a
              // status transition — the notification alone does not say it.
              debugWarn(
                "memory",
                `reflection run ${run.runId} failed: ${error ?? "unknown error"}`,
              );
              recordReflectionConfigurationFailure({
                agentId,
                model,
                error,
              });
            }
            // A timed-out run was already finished by the controller; only a
            // still-running one is ours to finish (§2.4 state machine).
            const current = getReflectionRun(run.runId);
            // The one row the parent owns: a run killed at its deadline never
            // ends a child turn, so only this side can put its ending in the
            // ledger (§5.16.4). Zero tokens by construction — see
            // `recordTimedOutReflectionRun`.
            if (current?.status === "timeout") {
              await writeTimeoutUsage({
                input: {
                  runId: run.runId,
                  agentId,
                  sessionId: forkConversationId,
                  parentSessionId: conversationId,
                  model: model?.trim() || "unknown",
                  wallMs: Math.max(0, Math.round(durationMs ?? 0)),
                },
                writer:
                  dependencies.recordTimeoutUsage ??
                  recordTimedOutReflectionRun,
              });
            }
            if (
              current?.status === "running" ||
              current?.status === "starting"
            ) {
              await finishReflectionRun(
                run.runId,
                success ? "succeeded" : "failed",
              );
            }
            // §5.5.7: only startup/settlement failures back off. A timeout or an
            // interruption already surfaced to the user, and backing off from it
            // would starve a healthy channel.
            if (
              !success &&
              current?.status !== "timeout" &&
              current?.status !== "cancelled"
            ) {
              recordReflectionFailure(agentId);
            }
          } finally {
            await releaseLock();
            releaseReflectionLaunch(agentId);
          }
        },
      });
    } catch (error) {
      // The fork exists but nothing will ever run on it: remove the half-built
      // conversation instead of leaving an empty hidden session behind (§5.1.4).
      debugWarn(
        "memory",
        `Failed to spawn the reflection subagent (${triggerSource}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await deleteHalfBuiltFork(
        forkConversationId,
        dependencies.deleteConversation,
      );
      await finishReflectionRun(run.runId, "failed");
      await releaseLock();
      recordReflectionFailure(agentId);
      releaseReflectionLaunch(agentId);
      return { launched: false, reason: "error", error };
    }

    attachReflectionTask(run.runId, {
      taskId: spawned.taskId,
      abort: spawnedTaskAbortHandle(spawned),
    });

    // ── Durable copy of the run (best effort) ────────────────────────────
    // Read the run back: attaching the child is the point where the run
    // controller re-anchors the deadline on the successful spawn, so the value
    // recorded here is the one the user will actually be held to.
    const attachedRun = getReflectionRun(run.runId) ?? run;
    await recordRunningMetadata({
      forkConversationId,
      metadata: {
        runId: attachedRun.runId,
        triggerSource,
        parentConversationId: conversationId,
        startedAt: attachedRun.startedAt,
        deadlineAt: Number.isFinite(attachedRun.deadlineAt)
          ? attachedRun.deadlineAt
          : null,
        status: "running",
      },
      writer: dependencies.writeRunMetadata,
    });

    emitReflectionRunStart({
      triggerSource,
      subagentId: spawned.subagentId,
      conversationId: forkConversationId,
    });
    debugLog(
      "memory",
      `run ${run.runId} launched (${triggerSource}) on fork ${forkConversationId}; timeout ${timeoutMinutes}m`,
    );
    return {
      launched: true,
      runId: run.runId,
      forkConversationId,
      subagentId: spawned.subagentId,
    };
  } catch (error) {
    // Anything unexpected after the reservation (memory-dir resolution, task
    // module import) releases every resource it may hold.
    await releaseMemoryLock?.();
    await finishReflectionRun(run.runId, "failed");
    recordReflectionFailure(agentId);
    releaseReflectionLaunch(agentId);
    debugWarn(
      "memory",
      `Failed to launch reflection subagent (${triggerSource}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { launched: false, reason: "error", error };
  }
}

/**
 * Put a killed run's ending in the ledger. Never throws: the ledger must not be
 * able to change what a completed reflection reports (§5.16.2).
 */
async function writeTimeoutUsage(input: {
  input: TimedOutReflectionRunInput;
  writer: (input: TimedOutReflectionRunInput) => Promise<boolean>;
}): Promise<void> {
  try {
    const written = await input.writer(input.input);
    if (!written) {
      debugLog(
        "usage",
        `dropped timeout row for reflection run ${input.input.runId}`,
      );
    }
  } catch (error) {
    debugWarn(
      "usage",
      `failed to record timeout usage for reflection run ${input.input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
