/**
 * Dream status reads for the app-server listener (M5-A stage 2, B2).
 *
 * The listener cannot reuse the TUI's status face: `cli/commands/dream.ts` owns
 * the interactive rendering, and the listener's layer rules keep this module
 * free of Ink. This file therefore re-implements the two reads that face does —
 * the hidden-conversation run records and the app-server snapshot — from the
 * same owners (`getBackend` + `readConversationProvenance`, the signal-state
 * file, the lease and `isDreamRunLive`), so both surfaces answer from one truth
 * and cannot drift.
 *
 * Every field is sourced, never invented:
 *
 * - `enabled` is the resolved master switch (`readDreamSettings`);
 * - `running` needs a *live* run (`isDreamRunLive`), and its spend/tier come
 *   from the run record the parent writes after every turn; a live lease whose
 *   record cannot be read yet reports `0 / 0 / null` (the wire has no "unknown"
 *   for those numbers) rather than computing a budget that was never used;
 * - `nextEligibleAt` comes from the signal source's own window/cooldown rules
 *   (`cron/dream-signal`), not from a second implementation;
 * - `lastRun` is the newest hidden conversation carrying a dream record.
 *
 * `readDreamDeviceSummary` is the cheap projection `device_status` carries; the
 * caller (`device-status-cache`) caches it because the status broadcast runs far
 * more often than a dream run changes state.
 */

import { readDreamLease } from "@/agent/dream/dream-lease";
import { isDreamRunLive } from "@/agent/dream/dream-liveness";
import { getBackend } from "@/backend";
import { findDreamTask } from "@/cli/helpers/dream-launcher";
import {
  DREAM_MAX_ATTEMPTS_PER_DAY,
  isWithinDreamIdleWindow,
  nextDreamWindowStart,
  readDreamSignalState,
  rollDreamStateForDay,
} from "@/cron/dream-signal";
import {
  type ResolvedDreamSettings,
  readDreamSettings,
} from "@/dream-settings";
import { readConversationProvenance } from "@/types/conversation-provenance";
import type {
  DreamDeviceSummary,
  DreamLastRunSnapshot,
  DreamRunningRunSnapshot,
  DreamStatusSnapshot,
} from "@/types/dream-protocol";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

/**
 * How many hidden conversations the status read scans. Same cap the TUI's
 * status face uses; a dream run is one conversation, so the newest record is
 * always inside this window unless the agent accumulated 50 newer hidden runs.
 */
export const DREAM_RUN_SCAN_LIMIT = 50;

/**
 * The hidden conversations that carry a dream run record, newest run first.
 *
 * `getBackend().listConversations` is the same read the hidden-session viewer
 * uses; the record lives on the conversation (no sidecar), so this needs no
 * protocol command. A backend that cannot be read is "no runs", never an error:
 * the settings half of the answer is still true and worth returning.
 */
export async function readDreamRunRecords(
  agentId: string,
  limit: number = DREAM_RUN_SCAN_LIMIT,
): Promise<readonly DreamRunMetadata[]> {
  try {
    const listed = await getBackend().listConversations({
      agent_id: agentId,
      hidden_only: true,
      limit,
    });
    const records: DreamRunMetadata[] = [];
    for (const conversation of listed) {
      const dream = readConversationProvenance(conversation).dream;
      if (!dream) continue;
      records.push(dream);
    }
    records.sort((left, right) => right.startedAt - left.startedAt);
    return records;
  } catch {
    return [];
  }
}

/**
 * The newest *finished* run record, projected onto the wire shape.
 *
 * A `running` record is not "finished": the live one is reported by `running`
 * below, and a crash remnant keeps that durable status until recovery rewrites
 * it — inventing an outcome would make the status line lie.
 */
export function readDreamLastRunSnapshot(
  records: readonly DreamRunMetadata[],
): DreamLastRunSnapshot | null {
  const latest = records.find((record) => record.status !== "running");
  if (!latest) return null;
  return {
    runId: latest.runId,
    status: latest.status,
    triggerSource: latest.triggerSource,
    startedAt: latest.startedAt,
    endedAt: latest.endedAt,
  };
}

/**
 * The live run for this agent, or `null` when nothing is genuinely running.
 *
 * `isDreamRunLive` is the authority: a crashed host leaves both a `running`
 * marker and a lease behind, and only the lease-owner liveness plus the age
 * bound tells those apart from a real run.
 */
export function readDreamRunningSnapshot(
  agentId: string,
  records: readonly DreamRunMetadata[],
  now: Date = new Date(),
): DreamRunningRunSnapshot | null {
  let live = false;
  try {
    live = isDreamRunLive(agentId, now);
  } catch {
    live = false;
  }
  if (!live) return null;
  const lease = readDreamLease(agentId);
  if (!lease) return null;
  const record = records.find(
    (candidate) =>
      candidate.runId === lease.runId ||
      (lease.conversationId !== null &&
        candidate.conversationId === lease.conversationId),
  );
  // A live marker is written after the run record, so the record normally
  // exists. If the backend read failed, report the lease's own numbers and
  // zeros for the spend it could not observe — never a made-up budget.
  return {
    runId: record?.runId ?? lease.runId,
    startedAt: record?.startedAt ?? lease.startedAt,
    spentTokens: record?.spentTokens ?? 0,
    budgetTokens: record?.budgetTokens ?? 0,
    tier: record?.tierReached ?? null,
  };
}

/**
 * The earliest instant the signal source may produce the next occurrence, ISO.
 *
 * `null` means nothing is scheduled: the trigger is off, no tier is enabled, or
 * the agent has no live dream task. Inside a window with no cooldown left the
 * next tick may fire, which is also `null` — the wire comment documents that
 * reading. Everything here mirrors `evaluateDreamEligibility`'s gates; the
 * eligibility function itself needs a task/pressure pair this read does not.
 */
export function computeDreamNextEligibleAt(
  settings: ResolvedDreamSettings,
  state: ReturnType<typeof readDreamSignalState>,
  now: Date,
): string | null {
  if (!settings.enabled) return null;
  if (!settings.autoTrigger) return null;
  if (!Object.values(settings.tiers).some(Boolean)) return null;

  const nowMs = now.getTime();
  const nextWindow = nextDreamWindowStart(settings.idleWindows, now);
  if (!isWithinDreamIdleWindow(settings.idleWindows, now)) {
    return nextWindow === null ? null : new Date(nextWindow).toISOString();
  }
  const rolled = rollDreamStateForDay(state, now);
  if (rolled.dayCount >= DREAM_MAX_ATTEMPTS_PER_DAY) {
    // R-5.2.5: the six daily self-advances are spent; the next one is the next
    // window start.
    return nextWindow === null ? null : new Date(nextWindow).toISOString();
  }
  if (rolled.nextEligibleAt !== null && rolled.nextEligibleAt > nowMs) {
    return new Date(rolled.nextEligibleAt).toISOString();
  }
  return null;
}

/** The whole `dream_status` snapshot for one agent. */
export async function readDreamStatusSnapshot(
  agentId: string,
  now: Date = new Date(),
): Promise<DreamStatusSnapshot> {
  const settings = readDreamSettings(agentId);
  const records = await readDreamRunRecords(agentId);
  const state = readDreamSignalState(agentId);
  // The signal source only evaluates agents that own a dream carrier task; a
  // configured agent whose task was deleted has no automatic next evaluation.
  const hasTask = findDreamTask(agentId) !== null;
  return {
    enabled: settings.enabled,
    running: readDreamRunningSnapshot(agentId, records, now),
    nextEligibleAt: hasTask
      ? computeDreamNextEligibleAt(settings, state, now)
      : null,
    lastRun: readDreamLastRunSnapshot(records),
  };
}

/**
 * The `device_status.dream` summary: the master switch and the live run id.
 *
 * Deliberately cheap and synchronous. A disabled agent answers from the
 * settings object alone (no disk, no process probe); an enabled one pays the
 * liveness check, which the caller caches. `null` only when the status has no
 * agent scope at all.
 */
export function readDreamDeviceSummary(
  agentId: string | null,
  now: Date = new Date(),
): DreamDeviceSummary | null {
  if (!agentId) return null;
  const enabled = readDreamSettings(agentId).enabled;
  if (!enabled) return { enabled: false, runningRunId: null };
  let runningRunId: string | null = null;
  try {
    if (isDreamRunLive(agentId, now)) {
      runningRunId = readDreamLease(agentId)?.runId ?? null;
    }
  } catch {
    runningRunId = null;
  }
  return { enabled: true, runningRunId };
}
