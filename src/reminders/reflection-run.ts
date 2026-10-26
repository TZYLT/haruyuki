/**
 * The two soft reminders that bracket a reflection run (F-03 §5.7.1): one
 * "start" when the run takes the memory repository, one "end" when it releases
 * it. Never more than those two per run — the notice is a one-shot slot on the
 * shared reminder state, and the provider clears it while building the turn.
 *
 * This module only formats. The decision (is a notice due, and which run does it
 * describe) stays split between the frozen seam
 * (`types/reflection-run-notice.ts`, filled by the post-turn trigger and the
 * completion callbacks) and the run controller, which knows the outcome.
 */
import type { ReflectionRunState } from "@/agent/reflection-run";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import type { PendingReflectionRunNotice } from "@/types/reflection-run-notice";

export interface ReflectionRunNoticeInput {
  notice: PendingReflectionRunNotice;
  /** The run the notice is about, live or recently finished; absent when unknown. */
  run?: ReflectionRunState;
  /** The agent's memory checkout, when it can be resolved. */
  memoryDir?: string;
}

function remainingLabel(run: ReflectionRunState | undefined): string | null {
  if (!run) return null;
  if (!Number.isFinite(run.deadlineAt)) return "no fixed time limit";
  const remainingMs = Math.max(0, run.deadlineAt - Date.now());
  return `about ${Math.ceil(remainingMs / 60_000)} minute(s) remaining`;
}

function startText(input: ReflectionRunNoticeInput): string {
  const { run, notice, memoryDir } = input;
  const lines = [
    `${SYSTEM_REMINDER_OPEN}\nREFLECTION RUNNING: a reflection run is writing this agent's memory repository now.`,
  ];
  if (memoryDir) lines.push(`\nMemory directory: ${memoryDir}`);
  const runId = notice.runId ?? run?.runId;
  if (runId) lines.push(`Run: ${runId}`);
  const remaining = remainingLabel(run);
  if (remaining) lines.push(`Time limit: ${remaining}`);
  lines.push(
    "\nDo not edit, write or patch memory files while it runs: those file-tool writes are rejected until the end-of-run reminder. Reading memory files and shell commands are not blocked. If a memory change is truly needed now, tell the user and wait for the run to end; if runs keep hitting their limit, the user can raise it.",
  );
  lines.push(SYSTEM_REMINDER_CLOSE);
  return lines.join("\n");
}

function endOutcome(input: ReflectionRunNoticeInput): string {
  if (input.notice.timedOut) return "timed out";
  const status = input.run?.status;
  if (status === "timeout") return "timed out";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

function endDetail(input: ReflectionRunNoticeInput, outcome: string): string {
  const { run } = input;
  if (outcome === "timed out") {
    const coordinates: string[] = [];
    if (run?.backupRef) coordinates.push(`ref ${run.backupRef}`);
    if (run?.backupPatch) coordinates.push(`patch ${run.backupPatch}`);
    const backedUp =
      coordinates.length > 0
        ? `Uncommitted memory changes were backed up and then discarded (${coordinates.join(", ")}); committed changes were kept.`
        : "Uncommitted memory changes were discarded; no backup coordinates were recorded, so the work tree was probably clean. Committed changes were kept.";
    return `${backedUp} If reflection keeps hitting its time limit, ask the user to raise reflectionTimeoutMinutes.`;
  }
  if (outcome === "failed") {
    return "The run failed. Uncommitted work may still be in the memory repository: check the repository state before editing it, and report the failure to the user.";
  }
  if (outcome === "cancelled") {
    return "The run was cancelled. Uncommitted work may still be in the memory repository: check the repository state before editing it.";
  }
  return "The run completed; its committed memory changes are in the repository. Memory file writes are allowed again.";
}

/**
 * Render the start or end notice. A notice with no matching run still renders:
 * the phase alone is enough to tell the parent whether it may write memory.
 */
export function formatReflectionRunNotice(
  input: ReflectionRunNoticeInput,
): string {
  if (input.notice.phase === "start") return startText(input);

  const outcome = endOutcome(input);
  const lines = [
    `${SYSTEM_REMINDER_OPEN}\nREFLECTION FINISHED: the reflection run on this agent's memory repository has ended (${outcome}). Memory file writes are allowed again.`,
  ];
  if (input.memoryDir) lines.push(`\nMemory directory: ${input.memoryDir}`);
  const runId = input.notice.runId ?? input.run?.runId;
  if (runId) lines.push(`Run: ${runId}`);
  lines.push(`\n${endDetail(input, outcome)}`);
  lines.push(SYSTEM_REMINDER_CLOSE);
  return lines.join("\n");
}
