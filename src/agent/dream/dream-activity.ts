/**
 * Interactive-turn activity markers for dream runs (F-06 M2, route §2.3.5 S2).
 *
 * **Semantics (user ruling, F-06):** activity means *an interactive user turn
 * actually dispatched a request to the model* — not that the user typed, ran a
 * slash command, answered an approval or touched a file. This is the only signal
 * that resets the dream silence window (`user_active`) and the only thing that
 * aborts a running dream ("the user came back", R-5.8.2).
 *
 * Background work must never count: a dream run's own child turns, reflection,
 * scheduler/cron and subagent children, compaction. {@link
 * shouldRecordDreamActivity} is that rule as a pure predicate; the dispatch
 * seam (`agent/message.ts`) feeds it what it knows about the turn's source and
 * only then writes a marker.
 *
 * **Long turns.** A turn is active for as long as its request is in flight: a
 * tool can keep the turn open far longer than `silenceMinutes`, and a silence
 * window that expires mid-turn would let a dream start while the user is still
 * there. The record therefore carries the dispatching process and its dispatch
 * time; {@link readDreamActivity} answers "now" while that owner is alive and
 * the stamp is fresh ({@link DREAM_TURN_IN_FLIGHT_STALE_MS}), and the stream
 * wrapper clears the marker when the turn's request ends.
 *
 * Storage is one tiny JSON file per agent under `<harness home>/dream/activity/`
 * (never the memory repo, never `<repo>/.haruyuki`). Writes are atomic
 * (temp + rename) so a tick that reads concurrently with a dispatch sees either
 * the old or the new stamp, not a torn file. The marker functions never throw:
 * a read-only or full disk must not break a user turn.
 *
 * The three original exports (`markDreamActivity`, `readDreamActivity`,
 * `hasDreamActivitySince`) keep their frozen signatures; everything else here
 * is additive.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appHomePath } from "@/utils/app-paths";
import { isProcessAlive } from "@/utils/process-liveness";

const ACTIVITY_FILE_VERSION = 2;

/**
 * How long a dispatched request may stay "in flight" before the marker stops
 * counting as activity. A live turn keeps the marker fresh (each model request
 * re-stamps it); this bound only matters when the owning process died, or a
 * consumer abandoned its stream without draining it.
 */
export const DREAM_TURN_IN_FLIGHT_STALE_MS = 2 * 60 * 60_000;

/**
 * Agent ids are opaque strings; the filename only needs to round-trip, not be
 * reversible. Restricting to a safe alphabet keeps Windows paths valid without
 * a url-encoding dependency.
 */
function activityFileSegment(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "unknown-agent";
}

/** `<harness home>/dream/activity/<agent>.json` — never a literal `.haruyuki`. */
export function getDreamActivityPath(agentId: string): string {
  return appHomePath([
    "dream",
    "activity",
    `${activityFileSegment(agentId)}.json`,
  ]);
}

/**
 * One dispatched request that has not finished yet. `pid` is the process that
 * dispatched it, so a crashed owner cannot pin the silence window; `startedAt`
 * is the dispatch time, used for the stale bound; `depth` counts overlapping
 * requests from the same process (a mod sending during a turn must not clear
 * the turn's marker when its own request finishes first).
 */
interface DreamTurnInFlight {
  pid: number;
  startedAt: number;
  depth: number;
}

interface DreamActivityRecord {
  version: 1 | 2;
  agentId: string;
  /** Epoch ms of the last interactive request (or its completion). */
  lastActiveAt: number;
  /** Present only while an interactive request is in flight. */
  inFlight?: DreamTurnInFlight;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeInFlight(value: unknown): DreamTurnInFlight | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const pid = positiveFinite(record.pid);
  const startedAt = positiveFinite(record.startedAt);
  if (pid === undefined || startedAt === undefined || !Number.isInteger(pid)) {
    return undefined;
  }
  const depth = positiveFinite(record.depth);
  return { pid, startedAt, depth: depth === undefined ? 1 : Math.round(depth) };
}

function readActivityRecord(agentId: string): DreamActivityRecord | undefined {
  try {
    const raw = readFileSync(getDreamActivityPath(agentId), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const lastActiveAt = positiveFinite(record.lastActiveAt);
    if (lastActiveAt === undefined) return undefined;
    const inFlight =
      record.version === 2 ? normalizeInFlight(record.inFlight) : undefined;
    return {
      version: record.version === 2 ? 2 : 1,
      agentId:
        typeof record.agentId === "string" && record.agentId.length > 0
          ? record.agentId
          : agentId,
      lastActiveAt,
      ...(inFlight ? { inFlight } : {}),
    };
  } catch {
    // Missing file is the normal first-run case; a corrupt one is the same as
    // "no activity recorded" — the signal then simply does not fire early.
    return undefined;
  }
}

function writeActivityRecord(record: DreamActivityRecord): void {
  const path = getDreamActivityPath(record.agentId);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`);
  // Atomic rename: a concurrent reader sees a complete record either way.
  renameSync(temp, path);
}

/** Whether the recorded owner is still alive and not past the stale bound. */
function inFlightIsLive(
  inFlight: DreamTurnInFlight | undefined,
  now: number,
): boolean {
  if (!inFlight) return false;
  if (now - inFlight.startedAt > DREAM_TURN_IN_FLIGHT_STALE_MS) return false;
  return isProcessAlive(inFlight.pid);
}

/**
 * Record that an interactive user turn dispatched a model request. Never
 * throws. Kept for callers that only need the timestamp; the dispatch seam uses
 * {@link markDreamTurnInFlight}, which stamps both fields in one write.
 */
export function markDreamActivity(
  agentId: string,
  at: number = Date.now(),
): void {
  if (typeof agentId !== "string" || agentId.length === 0) return;
  if (!Number.isFinite(at) || at <= 0) return;
  try {
    // One submit is one write; avoid a pointless rewrite when a later caller
    // already stamped this exact millisecond. Keep a foreign in-flight marker:
    // another request of the same agent may still be running.
    const existing = readActivityRecord(agentId);
    if (existing && existing.lastActiveAt >= at) return;
    const path = getDreamActivityPath(agentId);
    mkdirSync(dirname(path), { recursive: true });
    const payload: DreamActivityRecord = {
      version: ACTIVITY_FILE_VERSION,
      agentId,
      lastActiveAt: Math.round(at),
      ...(existing?.inFlight ? { inFlight: existing.inFlight } : {}),
    };
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(payload)}\n`);
    // Atomic rename: a concurrent read sees a complete record either way.
    renameSync(temp, path);
  } catch {
    // Best effort by contract: the turn path must keep working.
  }
}

/**
 * Mark an interactive turn's request as dispatched. Until
 * {@link finishDreamTurn}, {@link readDreamActivity} keeps answering "now", so
 * the silence window cannot expire mid-turn. Never throws.
 */
export function markDreamTurnInFlight(
  agentId: string,
  at: number = Date.now(),
): void {
  if (typeof agentId !== "string" || agentId.length === 0) return;
  if (!Number.isFinite(at) || at <= 0) return;
  try {
    const existing = readActivityRecord(agentId);
    const stamp = Math.round(at);
    const previous = existing?.inFlight;
    const depth =
      previous && previous.pid === process.pid ? previous.depth + 1 : 1;
    writeActivityRecord({
      version: ACTIVITY_FILE_VERSION,
      agentId,
      lastActiveAt: Math.max(existing?.lastActiveAt ?? 0, stamp),
      inFlight: { pid: process.pid, startedAt: stamp, depth },
    });
  } catch {
    // Best effort.
  }
}

/**
 * The interactive turn's request finished (success, error, abort or abandoned
 * stream). The silence window starts from here — the user just saw the result —
 * and this process's in-flight marker is cleared. Never throws.
 */
export function finishDreamTurn(
  agentId: string,
  at: number = Date.now(),
): void {
  if (typeof agentId !== "string" || agentId.length === 0) return;
  if (!Number.isFinite(at) || at <= 0) return;
  try {
    const existing = readActivityRecord(agentId);
    const stamp = Math.round(at);
    const previous = existing?.inFlight;
    const foreignInFlight =
      previous && previous.pid !== process.pid ? previous : undefined;
    const remaining =
      previous && previous.pid === process.pid ? previous.depth - 1 : 0;
    const ownInFlight =
      remaining > 0
        ? { pid: process.pid, startedAt: stamp, depth: remaining }
        : undefined;
    writeActivityRecord({
      version: ACTIVITY_FILE_VERSION,
      agentId,
      lastActiveAt: Math.max(existing?.lastActiveAt ?? 0, stamp),
      // Another process may still be running a request for this agent, and
      // another request of this process may still be running too; neither
      // marker may be cleared by this one.
      ...(foreignInFlight
        ? { inFlight: foreignInFlight }
        : ownInFlight
          ? { inFlight: ownInFlight }
          : {}),
    });
  } catch {
    // Best effort.
  }
}

/**
 * The last interactive request time in ms, or `null` when the agent has never
 * been active. While a request is in flight the answer is "now": the user's
 * turn is still running and must not be mistaken for silence.
 */
export function readDreamActivity(agentId: string): number | null {
  const record = readActivityRecord(agentId);
  if (!record) return null;
  if (inFlightIsLive(record.inFlight, Date.now())) {
    return Math.max(record.lastActiveAt, Date.now());
  }
  return record.lastActiveAt;
}

/**
 * True when the user interacted after `sinceMs`. The run controller uses this
 * to decide "the user came back" (R-5.8.2); `null` activity is "nobody has
 * spoken yet", never "the user came back".
 */
export function hasDreamActivitySince(
  agentId: string,
  sinceMs: number,
): boolean {
  const last = readDreamActivity(agentId);
  return last !== null && last >= sinceMs;
}

// ── Turn-source classification ─────────────────────────────────────

/**
 * Everything the dispatch seam knows about who is sending a turn. Plain data on
 * purpose: the rule stays testable without a backend, a child process or the TUI.
 */
export interface DreamActivityTurnSource {
  /** `runtimeContext.dreamRun`: this turn belongs to a dream-run conversation. */
  dreamRun?: boolean;
  /** `HARUYUKI_CODE_AGENT_ROLE`; a non-empty value marks an agent child process. */
  agentRole?: string | null;
  /** `HARUYUKI_USAGE_SOURCE` of a harness-launched child (reflection/dream/cron/…). */
  automatedUsageSource?: string | null;
  /** The caller already classified this turn as scheduler/task-notification. */
  automatedTurn?: boolean;
}

/**
 * The user ruling in one predicate: only an interactive user turn counts as
 * dream activity. Every background source above is explicitly excluded.
 */
export function shouldRecordDreamActivity(
  source: DreamActivityTurnSource,
): boolean {
  if (source.dreamRun === true) return false;
  const role = source.agentRole?.trim();
  if (role !== undefined && role.length > 0) return false;
  const usageSource = source.automatedUsageSource?.trim();
  if (usageSource !== undefined && usageSource.length > 0) return false;
  if (source.automatedTurn === true) return false;
  return true;
}
