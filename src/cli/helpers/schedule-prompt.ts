/**
 * TUI-side task runner for the F-05 scheduler core (M2).
 *
 * The TUI keeps no scheduler of its own any more (`19ced59e`); the core decides
 * what is due and this port puts a scheduled prompt into the TUI's existing
 * message queue (C-6), or runs a `command` task through the shared bodies.
 *
 * Ledger ownership differs from the listener on purpose: the TUI's own turn
 * writer (`cli/app/usage-record.ts`) records the row, tagged `source: "cron"`
 * and the run id via `@/usage/scheduled-run-context`. This module therefore
 * writes the run log, not a second ledger row — two rows for one turn would
 * double the reported cost.
 *
 * `runPrompt` waits for the turn's real ending: it enqueues, leaves a context
 * for the turn writer, and resolves on `awaitScheduledRunTurn` — the writer's
 * `consume` (with its outcome), a `clear` (cancelled) or the run's own timeout
 * aborting the signal. So a scheduled run reports what the turn did, not that
 * "the prompt was queued" (R-5.9). The wait (R-5.7.3), timeout (R-5.7.4) and
 * cancellation (R-5.6.5) envelopes stay shared with the listener through
 * `@/cron/task-run`.
 */

import { legacyRunOutcomeFor } from "@/cron/cron-file";
import type {
  RunOutcome,
  ScheduleTaskV2,
  TaskRunnerPort,
} from "@/cron/cron-types";
import { safeAppendCronRunLogForTask } from "@/cron/run-log";
import { formatScheduledTaskPrompt } from "@/cron/scheduled-task-prompt";
import {
  isScheduledTaskPreflightError,
  runScheduledTaskWithHost,
  type ScheduledTaskHostPort,
  ScheduledTaskPreflightError,
  TARGET_BUSY_POLL_MS,
} from "@/cron/task-run";
import {
  awaitScheduledRunTurn,
  clearScheduledRunContext,
  peekScheduledRunContext,
  setScheduledRunContext,
} from "@/usage/scheduled-run-context";
import { debugWarn } from "@/utils/debug";
import { addToMessageQueue } from "@/utils/message-queue-bridge";

export interface TuiCronPromptQueueInput {
  /** XML-wrapped scheduled prompt (`formatScheduledTaskPrompt`). */
  text: string;
  runId: string;
  task: ScheduleTaskV2;
  agentId: string;
  conversationId: string;
}

export interface TuiCronRunnerDeps {
  /** Queue the scheduled prompt into the TUI message queue (defaults to the bridge). */
  enqueuePrompt?: (input: TuiCronPromptQueueInput) => void;
  /** True while a turn is running or queued work is waiting (R-5.7.3). */
  isConversationBusy?: () => boolean;
  /**
   * Which host this runner is, for the run log and the task lease.
   * Defaults to `"long-lived"` (the TUI itself); the short-lived
   * `schedule tick` host passes `"short-lived"`.
   */
  host?: "long-lived" | "short-lived";
  /** Clock seam (defaults to `Date.now`), used by the wait/timeout policy. */
  now?: () => number;
  /** Poll interval for the busy wait. Defaults to 30s. */
  pollIntervalMs?: number;
}

const RUNNING = new Map<string, AbortController>();

function defaultEnqueuePrompt(input: TuiCronPromptQueueInput): void {
  addToMessageQueue({
    kind: "user",
    text: input.text,
    source: "cron",
    agentId: input.agentId,
    conversationId: input.conversationId,
  });
}

function runLogStatusOf(outcome: RunOutcome): "ok" | "error" | "skipped" {
  switch (outcome) {
    case "success":
      return "ok";
    case "skipped":
      return "skipped";
    default:
      return "error";
  }
}

function taskRef(task: ScheduleTaskV2, conversationId: string | null) {
  return {
    id: task.id,
    agent_id: task.agentId,
    conversation_id:
      conversationId ??
      (task.target.kind === "existing" ? task.target.conversation_id : "new"),
  };
}

function wrapPrompt(
  task: ScheduleTaskV2,
  occurrence: string,
  nowMs: number,
): string {
  const intended = new Date(occurrence);
  const scheduledFor = Number.isFinite(intended.getTime())
    ? intended
    : new Date(nowMs);
  return formatScheduledTaskPrompt({
    name: task.name,
    description: task.description,
    timezone: task.timezone,
    scheduledFor,
    currentTime: new Date(nowMs),
    recurrence: task.recurring
      ? { type: "recurring", cron: task.cron, fireNumber: 1 }
      : { type: "one-off" },
    prompt: task.payload,
  });
}

export function createTuiCronRunner(
  deps: TuiCronRunnerDeps = {},
): TaskRunnerPort {
  const enqueuePrompt = deps.enqueuePrompt ?? defaultEnqueuePrompt;
  const isConversationBusy = deps.isConversationBusy ?? (() => false);
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? TARGET_BUSY_POLL_MS;
  const runnerHost = deps.host ?? "long-lived";

  const host: ScheduledTaskHostPort = {
    isTargetBusy: () => isConversationBusy(),
    runPrompt: async ({ task, runId, occurrence, signal }) => {
      const conversationId =
        task.target.kind === "existing" ? task.target.conversation_id : "new";
      try {
        enqueuePrompt({
          text: wrapPrompt(task, occurrence, now()),
          runId,
          task,
          agentId: task.agentId,
          conversationId,
        });
      } catch (error) {
        debugWarn(
          "Cron",
          `failed to enqueue scheduled prompt for task ${task.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Nothing started: the TUI queue is not accepting work (no mounted App),
        // which is a pre-start failure (F1) rather than a failed turn.
        throw new ScheduledTaskPreflightError(
          error instanceof Error ? error.message : "enqueue failed",
        );
      }
      if (signal.aborted) {
        clearScheduledRunContext();
        return {
          outcome: "cancelled" as const,
          conversationId,
          error: "cancelled",
        };
      }
      // The turn writer consumes this once, tags its ledger row (Q-55) and, with
      // its own outcome, is what ends the wait below (R-5.9).
      setScheduledRunContext({
        runId,
        taskId: task.id,
        source: "cron",
        agentId: task.agentId,
        conversationId,
      });

      // Not `success` on enqueue: the turn has not run yet. The run's own
      // `timeout_minutes` (enforced by `runScheduledTaskWithHost`) aborts the
      // signal, which settles this wait as `cancelled` → the policy reports
      // `timeout`; nothing in this module arms a timer.
      const terminal = await awaitScheduledRunTurn({ runId, signal });
      if (terminal.outcome === "cancelled" || terminal.outcome === "timeout") {
        // The wait ended without the writer consuming the context (an abort, or
        // the run's deadline). Drop it so it cannot tag a later, unrelated turn.
        if (peekScheduledRunContext()?.runId === runId) {
          clearScheduledRunContext();
        }
      }
      const outcome =
        terminal.outcome === "completed"
          ? ("success" as const)
          : terminal.outcome;
      return {
        outcome,
        conversationId,
        ...(outcome === "success"
          ? {}
          : { error: `scheduled turn ${terminal.outcome}` }),
      };
    },
  };

  return {
    host: runnerHost,
    async run({ task, runId, occurrence, signal }) {
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
      RUNNING.set(runId, controller);

      const startedAt = now();
      let result: {
        outcome: RunOutcome;
        conversationId?: string;
        error?: string;
      };
      try {
        result = await runScheduledTaskWithHost({
          task,
          runId,
          occurrence,
          signal: controller.signal,
          host,
          now,
          pollIntervalMs,
        });
      } catch (error) {
        // A pre-start failure reaches the core as a thrown typed error (F1).
        if (isScheduledTaskPreflightError(error)) {
          RUNNING.delete(runId);
          signal.removeEventListener("abort", onOuterAbort);
          throw error;
        }
        result = {
          outcome: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        RUNNING.delete(runId);
        signal.removeEventListener("abort", onOuterAbort);
      }

      appendRunLog(task, {
        result,
        runId,
        host: runnerHost,
        durationMs: Math.max(0, now() - startedAt),
      });
      return result;
    },
    cancel(runId) {
      RUNNING.get(runId)?.abort();
    },
  };
}

function appendRunLog(
  task: ScheduleTaskV2,
  input: {
    result: { outcome: RunOutcome; conversationId?: string; error?: string };
    runId: string;
    host: "long-lived" | "short-lived";
    durationMs: number;
  },
): void {
  const legacyOutcome = legacyRunOutcomeFor(input.result.outcome);
  safeAppendCronRunLogForTask(
    taskRef(task, input.result.conversationId ?? null),
    {
      status: runLogStatusOf(input.result.outcome),
      runOutcome: input.result.outcome,
      ...(legacyOutcome ? { outcome: legacyOutcome } : {}),
      ...(input.result.error ? { error: input.result.error } : {}),
      runId: input.runId,
      host: input.host,
      durationMs: Math.round(input.durationMs),
      runAtMs: Date.now(),
      conversationId: input.result.conversationId ?? undefined,
      scheduledFor: task.scheduledFor,
    },
  );
}
