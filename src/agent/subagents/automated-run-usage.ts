/**
 * Automated-run usage tagging for launched subagents (F-03 §5.16.2, extended to
 * dreams by F-06 M2).
 *
 * The child records its own ledger row, so it must know which automated run it
 * belongs to. That tag is injected into the child's environment at launch time
 * by `manager.ts`, which used to resolve it for reflection inline. Keeping the
 * resolution in one module keeps `manager.ts` at its size ceiling and gives the
 * dream track a place to register its run without touching the reflection
 * controller.
 *
 * A dream run is discovered from the F-06 signal state: the run controller
 * marks the agent as running before it spawns the first tier turn, and clears
 * the marker in its terminal path. One agent cannot have two dream runs (the
 * dream lock guarantees it), so "running marker present" is exactly "this
 * child belongs to that run".
 */

import { getActiveReflectionRun } from "@/agent/reflection-run";
import { readDreamSignalState } from "@/cron/dream-signal";

export interface AutomatedRunUsageTag {
  usageSource: "reflection" | "dream";
  usageRunId: string;
}

/**
 * Resolve the automated-run tag for a child about to be launched.
 *
 * Only the two subagent types that represent a harness-owned automated run are
 * tagged; an ordinary subagent (or a nested launch inside one) gets `undefined`
 * and records nothing, which is the privacy/attribution contract of
 * `usage/automated.ts`.
 */
export function resolveAutomatedRunUsageTag(
  subagentType: string,
  parentAgentId: string | null | undefined,
): AutomatedRunUsageTag | undefined {
  if (!parentAgentId) return undefined;

  if (subagentType === "reflection") {
    const run = getActiveReflectionRun(parentAgentId);
    if (!run) return undefined;
    return { usageSource: "reflection", usageRunId: run.runId };
  }

  if (subagentType === "dream") {
    const runId = readDreamSignalState(parentAgentId).running?.runId;
    if (!runId) return undefined;
    return { usageSource: "dream", usageRunId: runId };
  }

  return undefined;
}
