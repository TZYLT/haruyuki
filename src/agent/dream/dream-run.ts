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
 *   can see that turn's usage, carry the 40/75/90/100 reminder into the next
 *   turn and notice a come-back/time-limit/budget stop. G-2 found no
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
  DreamRunNotesMetadata,
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
import type { ConsumeDreamNotesResult, DreamNote } from "./dream-notes";
import {
  appendDreamNotesSection,
  buildDreamNotesSection,
  parseDreamNoteOutcomes,
} from "./dream-report";
import type { DreamReviewMark } from "./dream-review-marks";
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
import type { DreamSeed } from "./dream-seed";

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
  /** The last finished tier's report; the next turn gets an excerpt of it. */
  lastReport: string;
  /** Every finished tier's report, for the end-of-run note-answer parse. */
  reportLog: string[];
  reminders: string[];
  model: string;
}

interface RunNotesState {
  /** Notes this run claimed into its seed (may be empty). */
  claimed: DreamNote[];
  /** The run-start seed; `null` when the harness could not build one. */
  seed: DreamSeed | null;
}

const EMPTY_NOTES_STATE: RunNotesState = { claimed: [], seed: null };

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
  const manual = input.manual === true;
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
  let notesState: RunNotesState = EMPTY_NOTES_STATE;
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

    const measuredPressure = deps.readPressure(agentId);
    // A manual `/dream run` is the user asking right now; on a fresh ledger the
    // measured pressure is 0, which would resolve a 0 budget and make the run a
    // no-op. Use the configured threshold as the floor for manual runs only —
    // the automatic trigger keeps the measured value (R-5.3.1).
    const pressure = manual
      ? Math.max(measuredPressure, settings.pressureThreshold)
      : measuredPressure;
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

    // T-01: the TUI reads the run's tier and budget from the lease (the host is
    // a short-lived child process, so its subagent snapshot is unreachable).
    // Seed both before the first turn: the tier is the one about to run, not
    // `tierReached`. Best effort — the status line must never fail a run.
    try {
      deps.updateLease({
        agentId,
        patch: { tier: tierPlan[0] ?? null, budgetTokens },
      });
    } catch {
      // The lease is a breadcrumb; the in-process state is the authority.
    }

    const initialMetadata: DreamRunMetadata = {
      runId,
      triggerSource: manual ? "manual" : "scheduled",
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
      reportLog: [],
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

    // ── Notes + seed: read once, before the first turn (W11/W12) ─────
    // The claim is not a consumption: the notes stay queued in case the run
    // fails, and the seed renders them as the run's highest-priority input.
    notesState = await prepareNotesAndSeed({
      agentId,
      memoryDir,
      runId,
      now: startedAt,
      deps,
    });

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
        notes: notesState,
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
    else if (!terminalStatus) {
      // The tier loop finished its plan. If the last turn crossed the budget
      // and tiers are still unstarted (defensive: a turn may end the plan
      // early), the run is budget_exhausted; otherwise it succeeded, but the
      // 100 % reminder it crossed must not be dropped silently.
      const completedTiers = progress.tierReached
        ? progress.tierPlan.indexOf(progress.tierReached) + 1
        : 0;
      const remainingTiers = progress.tierPlan.slice(completedTiers);
      if (tracker.isExhausted() && remainingTiers.length > 0) {
        terminalStatus = "budget_exhausted";
        handoff = describeDreamBudgetStop(
          tracker,
          progress.tierReached ?? undefined,
          remainingTiers,
        );
      } else {
        terminalStatus = "succeeded";
      }
    }

    if (terminalStatus === "cancelled" && handoff === null) {
      handoff =
        "The user came back while the run was in progress. Committed work was kept; continue from the next unfinished tier on the next run.";
    }
    if (terminalStatus === "timeout" && handoff === null) {
      handoff =
        "The configured time limit was reached; the memory checkout was rolled back to the run baseline. The next run should start over from the same plan.";
    }
    if (terminalStatus === "budget_exhausted" && handoff === null) {
      const completedTiers = progress.tierReached
        ? progress.tierPlan.indexOf(progress.tierReached) + 1
        : 0;
      handoff = describeDreamBudgetStop(
        tracker,
        progress.tierReached ?? undefined,
        progress.tierPlan.slice(completedTiers),
      );
    }
    if (
      terminalStatus === "succeeded" &&
      tracker.isExhausted() &&
      progress.reminders.length > 0
    ) {
      // The final turn crossed 100 %: keep the reminder text with the report
      // instead of discarding it (there is no next turn to deliver it to).
      handoff = [handoff, ...progress.reminders]
        .filter((part): part is string => typeof part === "string")
        .join("\n\n");
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
    let reportBody = buildDreamReportBody({
      status: finalStatus,
      agentReport: progress.lastReport,
      handoff,
      ...(terminalError !== undefined ? { error: terminalError } : {}),
      ...(rollbackError !== undefined ? { rollbackError } : {}),
    });

    // ── Notes settlement (46-6-Fix-A W12 / design §2.6) ─────────────
    // Only a settled run consumes the queue; a failed, timed-out or cancelled
    // run keeps every note, because the work that would justify deleting them
    // may have been rolled back. Answers are parsed from every tier's report,
    // not just the last one, and an unparsed answer keeps its note.
    let notesMetadata: DreamRunNotesMetadata | undefined;
    if (notesState.claimed.length > 0) {
      const claimedIds = notesState.claimed.map((note) => note.id);
      const outcomes = parseDreamNoteOutcomes(
        progress.reportLog.join("\n\n"),
        claimedIds,
      );
      const settles =
        finalStatus === "succeeded" || finalStatus === "budget_exhausted";
      let settlement: ConsumeDreamNotesResult = { consumed: [], kept: [] };
      if (settles) {
        try {
          settlement = await deps.consumeNotes(agentId, runId, outcomes);
        } catch (error) {
          debugWarn(
            "memory",
            `dream note settlement failed (run ${runId}): ${getErrorMessage(error)}`,
          );
        }
      }
      notesMetadata = {
        consumed: settlement.consumed,
        kept: settlement.kept,
        outcomes,
      };
      reportBody = appendDreamNotesSection(
        reportBody,
        buildDreamNotesSection({
          notes: notesState.claimed,
          outcomes,
          settled: settles,
        }),
      );
    }

    const finishingMetadata: DreamRunMetadata = {
      ...progress.metadata,
      status: finalStatus,
      endedAt: finishedAt,
      tierReached: progress.tierReached,
      spentTokens: tracker.spentTokens,
      handoff,
      reportPath: null,
      ...(notesMetadata !== undefined ? { notes: notesMetadata } : {}),
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

    // ── Decay ledger: full run-end update, best-effort ───────────────
    // Never allowed to change the terminal state: the run's outcome was
    // decided above, and a ranking that cannot be written is not a failure.
    try {
      const marks: DreamReviewMark[] = await deps.readMarks(runId);
      if (notesState.seed === null) {
        debugWarn(
          "memory",
          `dream run ${runId}: no run seed, so the decay ledger was not updated`,
        );
      } else {
        await deps.applyDecay({
          agentId,
          memoryDir,
          runId,
          baselineSha: baselineSha ?? "",
          seed: notesState.seed,
          marks,
          now: finishedAt,
        });
      }
    } catch (error) {
      debugWarn(
        "memory",
        `dream decay update failed (run ${runId}): ${getErrorMessage(error)}`,
      );
    }

    try {
      await deps.writeMetadata({ conversationId, metadata: finishingMetadata });
    } catch (error) {
      debugWarn(
        "memory",
        `dream terminal metadata write failed (run ${runId}): ${getErrorMessage(error)}`,
      );
    }

    if (finalStatus === "succeeded") {
      // R-5.2.3: pressure is "since the last *successful* dream". A run that
      // stopped at its budget did not digest the backlog, so the marker stays
      // where it was and the remaining rot can trigger the next run.
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

async function prepareNotesAndSeed(input: {
  agentId: string;
  memoryDir: string;
  runId: string;
  now: number;
  deps: DreamRunDeps;
}): Promise<RunNotesState> {
  let claimed: DreamNote[] = [];
  try {
    claimed = await input.deps.claimNotes(
      input.agentId,
      input.runId,
      input.now,
    );
  } catch (error) {
    // A queue that cannot be read is not a reason to skip the run; the run just
    // starts without the notes block.
    debugWarn(
      "memory",
      `dream note claim failed (run ${input.runId}): ${getErrorMessage(error)}`,
    );
  }
  try {
    const seed = await input.deps.collectSeed({
      agentId: input.agentId,
      memoryDir: input.memoryDir,
      runId: input.runId,
      now: input.now,
      notes: claimed,
    });
    return { claimed, seed };
  } catch (error) {
    debugWarn(
      "memory",
      `dream seed collection failed (run ${input.runId}): ${getErrorMessage(error)}`,
    );
    return { claimed, seed: null };
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
  /** The run-start seed (first turn only) and the claimed notes. */
  notes: RunNotesState;
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

    // T-01: write the tier at the *top* of the loop — the one this turn is
    // about to run — so the status line shows the current/next tier and never
    // the last completed one (`tierReached` stays on the run metadata).
    try {
      deps.updateLease({ agentId: input.agentId, patch: { tier } });
    } catch {
      // Best effort, same as the run-start write.
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
      permissionMode: input.settings.permissionMode,
    };
    const prompt =
      index === 0
        ? buildFirstDreamTurnPrompt({
            ...promptInfo,
            tracker,
            seed: input.notes.seed,
          })
        : buildNextDreamTurnPrompt({
            ...promptInfo,
            tracker,
            reminders: progress.reminders,
            previousReport: progress.lastReport,
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

    // T-01: spend is only knowable at a turn boundary, so the lease's figure
    // (and the status line's percentage) steps once per tier (O-02).
    try {
      deps.updateLease({
        agentId: input.agentId,
        patch: { spentTokens: tracker.spentTokens },
      });
    } catch {
      // Best effort: the in-process tracker still gates the budget.
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
    if (turn.report) {
      progress.lastReport = turn.report;
      progress.reportLog.push(turn.report);
    }
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
