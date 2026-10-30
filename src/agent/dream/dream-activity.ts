/**
 * User-activity markers for dream runs (F-06 M2, route §2.3.5 S2).
 *
 * A dream run aborts when the user comes back: the TUI submit path and the
 * listener turn path stamp the agent's activity, and the run controller
 * compares that stamp with the run's start time.
 *
 * Both functions are synchronous on purpose — `DreamSignalDeps.readLastActiveAt`
 * is called inside a scheduler tick, and the submit path must not await disk
 * I/O before sending.
 *
 * Storage is one tiny JSON file per agent under `<harness home>/dream/activity/`
 * (never the memory repo, never `<repo>/.haruyuki`). Writes are atomic
 * (temp + rename) so a tick that reads concurrently with a submit sees either
 * the old or the new stamp, not a torn file. `markDreamActivity` never throws:
 * a read-only or full disk must not break a user turn.
 *
 * M2 replaces the L0 no-op bodies; the two exported signatures are frozen.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appHomePath } from "@/utils/app-paths";

const ACTIVITY_FILE_VERSION = 1;

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

interface DreamActivityRecord {
  version: 1;
  agentId: string;
  lastActiveAt: number;
}

function readActivityRecord(agentId: string): DreamActivityRecord | undefined {
  try {
    const raw = readFileSync(getDreamActivityPath(agentId), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.lastActiveAt !== "number") return undefined;
    if (!Number.isFinite(record.lastActiveAt) || record.lastActiveAt <= 0) {
      return undefined;
    }
    return {
      version: ACTIVITY_FILE_VERSION,
      agentId:
        typeof record.agentId === "string" && record.agentId.length > 0
          ? record.agentId
          : agentId,
      lastActiveAt: record.lastActiveAt,
    };
  } catch {
    // Missing file is the normal first-run case; a corrupt one is the same as
    // "no activity recorded" — the signal then simply does not fire early.
    return undefined;
  }
}

/** Record that the user just interacted with this agent. Never throws. */
export function markDreamActivity(
  agentId: string,
  at: number = Date.now(),
): void {
  if (typeof agentId !== "string" || agentId.length === 0) return;
  if (!Number.isFinite(at) || at <= 0) return;
  try {
    // One submit is one write; avoid a pointless rewrite when a later caller
    // already stamped this exact millisecond.
    const existing = readActivityRecord(agentId);
    if (existing && existing.lastActiveAt >= at) return;
    const path = getDreamActivityPath(agentId);
    mkdirSync(dirname(path), { recursive: true });
    const payload: DreamActivityRecord = {
      version: ACTIVITY_FILE_VERSION,
      agentId,
      lastActiveAt: Math.round(at),
    };
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(payload)}\n`);
    // Atomic rename: a concurrent read sees a complete record either way.
    renameSync(temp, path);
  } catch {
    // Best effort by contract: the submit path must keep working.
  }
}

/** The last recorded interaction time in ms, or `null` when there is none. */
export function readDreamActivity(agentId: string): number | null {
  const record = readActivityRecord(agentId);
  return record ? record.lastActiveAt : null;
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
