/**
 * Dream run controller (F-06 M2, route §2.3.5 S1).
 *
 * The short-lived `haruyuki dream run --task <id>` host (T1) resolves the task
 * and delegates the whole lifecycle here; the host stays thin wiring.
 *
 * Lifecycle (route §2.4):
 *
 * ```text
 * starting → locked(dream) → locked(memory) → baselined → session
 *          → spawning → tier[tidy → think → task → wander] → finishing
 * ```
 *
 * Design constraints this module is written against, in order of authority:
 *
 * - **Lock order is fixed**: dream lock → memory lock, released in reverse in
 *   `finally`. Child completion callbacks are never trusted to release (C-24).
 * - **One child turn per tier.** Finishing a turn is the only moment the parent
 *   can see that turn's usage, carry the 40/80/100 reminder into the next turn
 *   and notice a come-back/time-limit/budget stop. G-2 found no
 *   `--token-budget` equivalent in the child and no per-call channel outside the
 *   stream events, so the hard gate enforces *between* turns — a documented
 *   degradation of R-5.3.2's "per model call" wording.
 * - **Failure classes** are expressed to the scheduler core, not counted here:
 *   a pre-start failure throws `ScheduledTaskPreflightError` (F1), every other
 *   non-success outcome is a plain result (F2), `skipped` is F3 and changes no
 *   counter. The core owns the three-strike auto-pause (`cron/scheduler-run.ts`).
 * - **Rollback is the harness's** (R-5.8.7): timeout and crash go back to the
 *   baseline with `reset --hard`; the harness never judges which edits to keep.
 * - **DreamDone ends the plan, not the process.** T3's tool records the agent's
 *   handoff in the run record; the controller notices it between turns and goes
 *   straight to finishing instead of starting another tier.
 */

import type { RunOutcome } from "@/cron/cron-types";
import { parseDreamTaskPayload } from "@/cron/dream-task";
import { ScheduledTaskPreflightError } from "@/cron/task-run";
import type { ResolvedDreamSettings } from "@/dream-settings";
import type {
  DreamRunMetadata,
  DreamRunStatus,
  DreamTier,
} from "@/types/dream-run-metadata";
import { DREAM_TIERS } from "@/types/dream-run-metadata";
import { debugLog, debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import {
  buildDreamBudgetReminder,
  type DreamBudgetCrossing,
  DreamBudgetTracker,
  describeDreamBudgetStop,
  resolveDreamRunBudgetTokens,
} from "./dream-budget";
import {
  buildDreamReportBody,
  buildFirstDreamTurnPrompt,
  buildNextDreamTurnPrompt,
} from "./dream-run-prompt";
import type {
  DreamRunDeps,
  DreamRunTaskInput,
  DreamRunTaskResult,
  DreamTurnResult,
} from "./dream-run-types";
import { createDefaultDreamRunDeps } from "./dream-run-wiring";

export type {
  DreamRunDeps,
  DreamRunTaskInput,
  DreamRunTaskResult,
  DreamTurnInput,
  DreamTurnResult,
} from "./dream-run-types";

/** How often the run controller checks whether the user came back. */
export const DREAM_ACTIVITY_POLL_MS = 10_000;

function enabledTierPlan(settings: ResolvedDreamSettings): DreamTier[] {
  return DREAM_TIERS.filter((tier) => settings.tiers[tier] === true);
}

function statusToMarkerOutcome(
  status: DreamRunStatus,
): "failed" | "timeout" | "cancelled" | "budget_exhausted" | null {
  if (
    status === "succeeded" ||
    status === "unfinished" ||
    status === "running"
  ) {
    return null;
  }
  return status;
}

function statusToRunOutcome(status: DreamRunStatus): RunOutcome {
  switch (status) {
    case "succeeded":
    case "budget_exhausted":
      // Budget exhaustion is a designed stop, not a failure (R-5.3.3): the run
      // finished its work and wrote a handoff. The precise status stays on the
      // conversation record for T4; the scheduler's five-value enum only needs
      // "this was not a failure".
      return "success";
    case "cancelled":
      return "cancelled";
    case "timeout":
      return "timeout";
    default:
      return "failed";
  }
}

interface RunProgress {
  metadata: DreamRunMetadata;
  tracker: DreamBudgetTracker;
  tierPlan: DreamTier[];
  tierReached: DreamTier | null;
  lastReport: string;
  reminders: string[];
  model: string;
}

interface TierLoopState {
  spawnedOnce(): boolean;
  timeoutHit(): boolean;
  userBack(): boolean;
  externalAbort(): boolean;
  terminalStatus(): DreamRunStatus | null;
  markSpawned(): void;
  markTerminalError(error: string): void;
  markHandoff(value: string | null): void;
}

/**
 * The state machine. Throws `ScheduledTaskPreflightError` for pre-start (F1)
 * failures; every other ending is returned as an outcome.
 */
export async function executeDreamRun(
  input: DreamRunTaskInput,
  deps: DreamRunDeps,
): Promise<DreamRunTaskResult> {
  const { task, runId, signal } = input;
  const startedAtDate = deps.now();
  const startedAt = startedAtDate.getTime();

  if (task.type !== "dream") {
    throw new ScheduledTaskPreflightError(
      `runDreamTask received a non-dream task (${task.type})`,
    );
  }
  const payload = parseDreamTaskPayload(task.payload);
  if (!payload) {
    throw new ScheduledTaskPreflightError(
      "dream task payload is malformed; refusing to guess a budget",
    );
  }
  const agentId = task.agentId;
  const settings = deps.resolveSettings(agentId);
  if (!settings.enabled) {
    throw new ScheduledTaskPreflightError(
      "dream is not enabled for this agent; the explicit-configuration gate blocks the run",
    );
  }
  const tierPlan = enabledTierPlan(settings);
  if (tierPlan.length === 0) {
    throw new ScheduledTaskPreflightError(
      "dream has no tiers enabled; there is nothing a run could do",
    );
  }

  // ── Locks: dream → memory (route §2.4) ─────────────────────────────
  const releaseDreamLock = await deps.tryAcquireDreamLock(agentId);
  if (!releaseDreamLock) {
    // A live run owns this agent: F3, skip, no counter changes.
    return { outcome: "skipped" };
  }

  let releaseMemoryLock: (() => Promise<void>) | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let leaseCreated = false;
  let leaseKeptForRepair = false;
  let conversationId: string | undefined;
  let baselineSha: string | undefined;
  let memoryDir = "";
  let tracker: DreamBudgetTracker | null = null;
  let progress: RunProgress | null = null;
  let terminalStatus: DreamRunStatus | null = null;
  let terminalError: string | undefined;
  let handoff: string | null = null;
  let spawnedOnce = false;
  let timeoutHit = false;
  let userBack = false;
  let externalAbort = false;
  let rollbackError: string | undefined;
  const turnAbort = new AbortController();

  const onExternalAbort = (): void => {
    externalAbort = true;
    turnAbort.abort();
  };

  try {
    memoryDir = deps.memoryDir(agentId);
    releaseMemoryLock = await deps.acquireMemoryLock(memoryDir);
    if (!releaseMemoryLock) {
      // Reflection or a memory worker holds the checkout: F3, skip.
      return { outcome: "skipped" };
    }

    deps.createLease({ agentId, runId, taskId: task.id });
    leaseCreated = true;
    stopHeartbeat = deps.startLeaseHeartbeat(agentId);

    // ── Baseline, before the conversation exists (C-23) ──────────────
    try {
      const baseline = await deps.createBaseline({ memoryDir, runId, agentId });
      baselineSha = baseline.sha;
      deps.updateLease({ agentId, patch: { baselineSha } });
    } catch (error) {
      throw new ScheduledTaskPreflightError(
        `dream baseline failed: ${getErrorMessage(error)}`,
      );
    }

    // ── Hidden session for the main agent (Q-37/Q-53) ────────────────
    try {
      const session = await deps.createSession({ agentId, runId });
      conversationId = session.conversationId;
      deps.updateLease({ agentId, patch: { conversationId } });
    } catch (error) {
      throw new ScheduledTaskPreflightError(
        `could not create the dream session: ${getErrorMessage(error)}`,
      );
    }

    const pressure = deps.readPressure(agentId);
    const budgetTokens = resolveDreamRunBudgetTokens({
      settings,
      pressure,
      ...(payload.budgetOverrideTokens !== undefined
        ? { overrideTokens: payload.budgetOverrideTokens }
        : {}),
    });
    tracker = new DreamBudgetTracker({
      budgetTokens,
      overBudgetApprovals: settings.overBudgetApprovals,
    });

    const initialMetadata: DreamRunMetadata = {
      runId,
      triggerSource: input.occurrence.length > 0 ? "scheduled" : "manual",
      agentId,
      conversationId,
      tierPlan,
      tierReached: null,
      startedAt,
      endedAt: null,
      baselineSha: baselineSha ?? "",
      budgetTokens,
      spentTokens: 0,
      timeLimitMinutes: settings.timeLimitMinutes,
      status: "running",
      reportPath: null,
      handoff: null,
    };
    try {
      await deps.writeMetadata({ conversationId, metadata: initialMetadata });
    } catch (error) {
      throw new ScheduledTaskPreflightError(
        `could not record the run metadata: ${getErrorMessage(error)}`,
      );
    }

    progress = {
      metadata: initialMetadata,
      tracker,
      tierPlan,
      tierReached: null,
      lastReport: "",
      reminders: [],
      model: "unknown",
    };

    deps.markRunActive(agentId, runId, startedAtDate);
    signal.addEventListener("abort", onExternalAbort, { once: true });
    if (signal.aborted) externalAbort = true;

    const timeLimitMs =
      settings.timeLimitMinutes !== null
        ? settings.timeLimitMinutes * 60_000
        : null;
    const deadline = timeLimitMs === null ? null : startedAt + timeLimitMs;
    const deadlineTimer =
      deadline === null
        ? null
        : setTimeout(
            () => {
              timeoutHit = true;
              turnAbort.abort();
            },
            Math.max(0, deadline - deps.now().getTime()),
          );
    // Deliberately NOT unref'd: the timer is the only thing keeping the host
    // process alive while the child turn runs, and an unref'd timer in Bun can
    // let the process exit before the abort fires. The terminal `finally`
    // clears it. (Heartbeat/activity intervals are unref'd — they must not hold
    // the process open.)
    const activityTimer = setInterval(() => {
      const last = deps.readActivity(agentId);
      if (last !== null && last >= startedAt) {
        userBack = true;
        turnAbort.abort();
      }
    }, DREAM_ACTIVITY_POLL_MS);
    activityTimer.unref?.();

    try {
      terminalStatus = await runTierLoop({
        agentId,
        conversationId,
        memoryDir,
        runId,
        startedAt,
        baselineSha: baselineSha ?? "",
        budgetTokens,
        settings,
        tracker,
        progress,
        signal: turnAbort.signal,
        deps,
        state: {
          spawnedOnce: () => spawnedOnce,
          timeoutHit: () => timeoutHit,
          userBack: () => userBack,
          externalAbort: () => externalAbort,
          terminalStatus: () => terminalStatus,
          markSpawned: () => {
            spawnedOnce = true;
          },
          markTerminalError: (error: string) => {
            terminalError = error;
          },
          markHandoff: (value: string | null) => {
            handoff = value;
          },
        },
      });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      clearInterval(activityTimer);
    }

    // The loop reports a stop reason through the status; time/come-back wins
    // over whatever tier had just finished.
    if (timeoutHit) terminalStatus = "timeout";
    else if (userBack) terminalStatus = "cancelled";
    else if (externalAbort && !terminalStatus) terminalStatus = "cancelled";
    else if (!terminalStatus) terminalStatus = "succeeded";

    if (terminalStatus === "cancelled" && handoff === null) {
      handoff =
        "The user came back while the run was in progress. Committed work was kept; continue from the next unfinished tier on the next run.";
    }
    if (terminalStatus === "timeout" && handoff === null) {
      handoff =
        "The configured time limit was reached; the memory checkout was rolled back to the run baseline. The next run should start over from the same plan.";
    }
    if (terminalStatus === "budget_exhausted" && handoff === null) {
      handoff = describeDreamBudgetStop(
        tracker,
        progress.tierReached ?? undefined,
      );
    }

    // ── Rollback: timeout only. Crash rollback lives in dream-recovery. ──
    if (terminalStatus === "timeout" && baselineSha) {
      try {
        await deps.rollbackBaseline({ memoryDir, baselineSha });
      } catch (error) {
        rollbackError = getErrorMessage(error);
        terminalStatus = "failed";
        terminalError = `rollback failed: ${rollbackError}`;
        // Keep the lease so recovery/an operator can see what needs repair.
        leaseKeptForRepair = true;
      }
    }

    // ── Finishing: report + terminal record + ledger ─────────────────
    const finishedAtDate = deps.now();
    const finishedAt = finishedAtDate.getTime();
    const finalStatus: DreamRunStatus = terminalStatus ?? "failed";
    const reportBody = buildDreamReportBody({
      status: finalStatus,
      agentReport: progress.lastReport,
      handoff,
      ...(terminalError !== undefined ? { error: terminalError } : {}),
      ...(rollbackError !== undefined ? { rollbackError } : {}),
    });

    const finishingMetadata: DreamRunMetadata = {
      ...progress.metadata,
      status: finalStatus,
      endedAt: finishedAt,
      tierReached: progress.tierReached,
      spentTokens: tracker.spentTokens,
      handoff,
      reportPath: null,
    };

    try {
      deps.updateLease({
        agentId,
        patch: { status: "finishing", conversationId, baselineSha },
      });
    } catch {
      // Best effort: the lease is a breadcrumb, not the authority.
    }

    try {
      const report = await deps.writeReport({
        agentId,
        conversationId,
        metadata: finishingMetadata,
        body: reportBody,
      });
      finishingMetadata.reportPath = report.reportPath;
    } catch (error) {
      // A report failure must not lose the terminal record or the lock release.
      debugWarn(
        "memory",
        `dream report write failed (run ${runId}): ${getErrorMessage(error)}`,
      );
      handoff = [handoff, `report write failed: ${getErrorMessage(error)}`]
        .filter((part): part is string => typeof part === "string")
        .join(" ");
      finishingMetadata.handoff = handoff;
    }

    try {
      await deps.writeMetadata({ conversationId, metadata: finishingMetadata });
    } catch (error) {
      debugWarn(
        "memory",
        `dream terminal metadata write failed (run ${runId}): ${getErrorMessage(error)}`,
      );
    }

    if (finalStatus === "succeeded" || finalStatus === "budget_exhausted") {
      deps.recordPressureBaseline(agentId, finishedAt);
    }

    const markerOutcome = statusToMarkerOutcome(finalStatus);
    if (markerOutcome) {
      try {
        await deps.recordLedgerMarker({
          outcome: markerOutcome,
          runId,
          agentId,
          sessionId: conversationId,
          model: progress.model,
          wallMs: Math.max(0, finishedAt - startedAt),
        });
      } catch (error) {
        debugWarn(
          "usage",
          `dream ledger marker failed (run ${runId}): ${getErrorMessage(error)}`,
        );
      }
    }

    deps.markRunFinished(agentId, finalStatus, finishedAtDate);

    const outcome = statusToRunOutcome(finalStatus);
    const error =
      outcome === "success"
        ? undefined
        : (terminalError ??
          (finalStatus === "timeout"
            ? `dream run exceeded its ${settings.timeLimitMinutes ?? 0}-minute time limit; rolled back to the baseline`
            : undefined));
    return {
      outcome,
      ...(conversationId ? { conversationId } : {}),
      ...(error ? { error } : {}),
    };
  } finally {
    signal.removeEventListener("abort", onExternalAbort);
    try {
      turnAbort.abort();
    } catch {
      // Already aborted.
    }
    stopHeartbeat?.();
    if (leaseCreated && !leaseKeptForRepair) deps.deleteLease(agentId);
    // Reverse lock order: memory first, then dream (route §2.4).
    if (releaseMemoryLock) {
      try {
        await releaseMemoryLock();
      } catch (error) {
        debugWarn(
          "memory",
          `dream memory lock release failed: ${getErrorMessage(error)}`,
        );
      }
    }
    if (releaseDreamLock) {
      try {
        await releaseDreamLock();
      } catch (error) {
        debugWarn(
          "memory",
          `dream lock release failed: ${getErrorMessage(error)}`,
        );
      }
    }
    debugLog(
      "memory",
      `dream run ${runId} finished: ${terminalStatus ?? "unknown"}${
        progress
          ? ` (spent ${progress.tracker.spentTokens}/${progress.tracker.baseBudgetTokens})`
          : ""
      }`,
    );
  }
}

async function runTierLoop(input: {
  agentId: string;
  conversationId: string;
  memoryDir: string;
  runId: string;
  startedAt: number;
  baselineSha: string;
  budgetTokens: number;
  settings: ResolvedDreamSettings;
  tracker: DreamBudgetTracker;
  progress: RunProgress;
  signal: AbortSignal;
  deps: DreamRunDeps;
  state: TierLoopState;
}): Promise<DreamRunStatus | null> {
  const { tracker, progress, state, deps } = input;
  for (let index = 0; index < progress.tierPlan.length; index += 1) {
    const tier = progress.tierPlan[index];
    if (!tier) continue;
    if (state.timeoutHit()) return "timeout";
    if (state.userBack()) return "cancelled";
    if (state.externalAbort()) return "cancelled";
    if (state.terminalStatus() !== null) return state.terminalStatus();
    // Between turns the 10s poll may not have fired yet; read the marker
    // directly so a user who came back during the last turn stops the next one.
    const lastActivity = deps.readActivity(input.agentId);
    if (lastActivity !== null && lastActivity >= input.startedAt) {
      return "cancelled";
    }
    // Budget hard gate: stop *between* turns when the allowance is spent.
    if (tracker.isExhausted()) {
      // One automatic +50 % extension only helps when spend is inside the
      // extended allowance; otherwise the run still stops here.
      if (!tracker.requestExtension() || tracker.isExhausted()) {
        return "budget_exhausted";
      }
      debugLog(
        "memory",
        `dream run ${input.runId}: auto-approved one over-budget extension (allowance ${tracker.allowanceTokens})`,
      );
    }

    const promptInfo = {
      runId: input.runId,
      baselineSha: input.baselineSha,
      budgetTokens: input.budgetTokens,
      timeLimitMinutes: input.settings.timeLimitMinutes,
      tierPlan: progress.tierPlan,
      tier,
      tierIndex: index,
      tierCount: progress.tierPlan.length,
    };
    const prompt =
      index === 0
        ? buildFirstDreamTurnPrompt({ ...promptInfo, tracker })
        : buildNextDreamTurnPrompt({
            ...promptInfo,
            tracker,
            reminders: progress.reminders,
          });
    progress.reminders = [];

    let turn: DreamTurnResult;
    try {
      turn = await deps.spawnTurn({
        agentId: input.agentId,
        conversationId: input.conversationId,
        memoryDir: input.memoryDir,
        runId: input.runId,
        tier,
        tierIndex: index,
        tierCount: progress.tierPlan.length,
        prompt,
        permissionMode: input.settings.permissionMode,
        signal: input.signal,
      });
      state.markSpawned();
    } catch (error) {
      if (!state.spawnedOnce()) {
        // Nothing ran yet: this is a pre-start failure (F1).
        throw new ScheduledTaskPreflightError(
          `could not start the dream child: ${getErrorMessage(error)}`,
        );
      }
      state.markTerminalError(
        `dream child spawn failed: ${getErrorMessage(error)}`,
      );
      return "failed";
    }

    const crossings: DreamBudgetCrossing[] = tracker.addTurn(turn.usage);
    if (crossings.length > 0) {
      progress.reminders = crossings.map((crossing) =>
        buildDreamBudgetReminder({
          crossing,
          allowanceTokens: tracker.allowanceTokens,
        }),
      );
    }
    if (turn.model && turn.model.trim().length > 0) {
      progress.model = turn.model;
    }

    // T3's DreamDone tool writes the handoff onto the run record from the child
    // process; pick it up here and preserve it across this turn's spend update.
    let agentHandoff: string | null = null;
    try {
      const record = await deps.readMetadata(input.conversationId);
      if (record?.handoff && record.handoff.trim().length > 0) {
        agentHandoff = record.handoff.trim();
      }
    } catch {
      // A read failure must not decide the run; the turn ending still counts.
    }

    progress.metadata = {
      ...progress.metadata,
      spentTokens: tracker.spentTokens,
      handoff: agentHandoff ?? progress.metadata.handoff,
    };
    try {
      await deps.writeMetadata({
        conversationId: input.conversationId,
        metadata: progress.metadata,
      });
    } catch {
      // Spend telemetry is advisory; the in-process tracker is the gate.
    }

    if (turn.aborted) {
      if (state.timeoutHit()) return "timeout";
      if (state.userBack() || state.externalAbort()) return "cancelled";
      state.markTerminalError(
        "dream child was aborted without a known stop reason",
      );
      return "failed";
    }
    if (!turn.success) {
      state.markTerminalError(turn.error ?? "dream child failed");
      return "failed";
    }
    if (turn.report) progress.lastReport = turn.report;
    progress.tierReached = tier;

    if (agentHandoff) {
      state.markHandoff(agentHandoff);
      // The agent decided the run is done; skip the remaining tiers.
      return "succeeded";
    }
  }
  return null;
}

/** S1 entry point: the host hands the whole lifecycle to this function. */
export async function runDreamTask(
  input: DreamRunTaskInput,
): Promise<DreamRunTaskResult> {
  return executeDreamRun(input, createDefaultDreamRunDeps());
}
