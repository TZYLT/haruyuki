/**
 * Hard stop for the parent conversation's file-write tools while a reflection
 * run holds the memory repository (F-03 §5.7.2).
 *
 * The guard answers one synchronous question: "is this write target inside the
 * memory repository that an active reflection run is currently writing?" It
 * does not read the disk beyond path canonicalisation, does not take the memory
 * lock and does not prompt — `checkPermission` is synchronous, so the on-disk
 * lock cannot be consulted here (route §5.7.4). The cross-process case stays
 * best-effort by design.
 *
 * Decision sources, cheapest first:
 * 1. Only {@link MEMORY_FILE_WRITE_TOOLS} (Write/Edit/ApplyPatch) are ever
 *    blocked. `Read` and the other read tools are never blocked (§5.7.3), and
 *    neither is `Bash`: the requirement accepts concurrent shell writes as a
 *    known loss rather than narrowing the tool block the child inherits.
 * 2. The agent must have an active run in *this* process
 *    (`isReflectionRunActive`), because that is the only synchronous answer
 *    available.
 * 3. At least one write target must resolve inside the agent's memory roots,
 *    using the same path helpers `isOwnMemoryWrite` uses, including the
 *    realpath form so a symlink planted in the checkout cannot escape.
 *
 * Every failure of the path resolution answers "not blocked": the guard runs
 * inside `checkPermission`, and a throw there would break tool dispatch.
 */
import { getCurrentAgentId } from "@/agent/context";
import {
  getActiveReflectionRun,
  isReflectionRunActive,
} from "@/agent/reflection-run";
import { canonicalToolName } from "./canonical";
import { extractApplyPatchPaths, extractFilePath } from "./cross-agent-guard";
import {
  isPathWithinRoots,
  resolveAllowedMemoryRoots,
  resolveMemoryTargetPath,
} from "./memory-paths";
import { MEMORY_FILE_WRITE_TOOLS } from "./memory-write-allowance";
import { canonicalizeRoot } from "./sandbox-policy";

export interface ReflectionWriteGuardInput {
  /** Canonical tool name, as the permission checker sees it. */
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** Agent whose memory may be under reflection; null when no agent is active. */
  agentId: string | null;
  workingDirectory: string;
}

export interface ReflectionWriteBlock {
  blocked: true;
  /** Full rejection text, already starting with `Permission denied:`. */
  message: string;
}

type ToolArgs = Record<string, unknown>;

/** Every path a file-write tool touches; a patch may carry several. */
function writeTargets(canonicalTool: string, toolArgs: ToolArgs): string[] {
  if (canonicalTool === "ApplyPatch") {
    return typeof toolArgs.input === "string"
      ? extractApplyPatchPaths(toolArgs.input)
      : [];
  }
  const filePath = extractFilePath(toolArgs);
  return filePath ? [filePath] : [];
}

function resolveAgentId(explicit: string | null): string | null {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  try {
    return getCurrentAgentId().trim() || null;
  } catch {
    return null;
  }
}

function describeRemaining(run: {
  deadlineAt: number;
  startedAt: number;
}): string {
  if (!Number.isFinite(run.deadlineAt)) return "no fixed time limit";
  const remainingMs = Math.max(0, run.deadlineAt - Date.now());
  const minutes = Math.ceil(remainingMs / 60_000);
  return `about ${minutes} minute(s) remaining`;
}

/**
 * Returns the rejection when the write must not proceed, `null` when it may.
 *
 * Reads, non-file tools and Bash are never blocked (§5.7.3): the requirement
 * deliberately accepts concurrent shell writes rather than narrowing the tool
 * block, which must stay byte-identical to the parent's.
 */
export function checkReflectionWriteBlock(
  input: ReflectionWriteGuardInput,
): ReflectionWriteBlock | null {
  const canonicalTool = canonicalToolName(input.toolName);
  if (!MEMORY_FILE_WRITE_TOOLS.has(canonicalTool)) return null;

  const targets = writeTargets(canonicalTool, input.toolArgs);
  if (targets.length === 0) return null;

  const agentId = resolveAgentId(input.agentId);
  if (!agentId) return null;
  if (!isReflectionRunActive(agentId)) return null;

  const run = getActiveReflectionRun(agentId);
  let roots: string[];
  let realRoots: string[];
  try {
    const resolved = resolveAllowedMemoryRoots({ currentAgentId: agentId });
    roots = resolved.roots;
    if (roots.length === 0) return null;
    realRoots = roots.map(canonicalizeRoot);
  } catch {
    return null;
  }

  const hits = targets.filter((target) => {
    const resolved = resolveMemoryTargetPath(target, input.workingDirectory);
    if (resolved === null) return false;
    try {
      return (
        isPathWithinRoots(resolved, roots) ||
        isPathWithinRoots(canonicalizeRoot(resolved), realRoots)
      );
    } catch {
      return false;
    }
  });
  if (hits.length === 0) return null;

  const runLabel = run ? `run ${run.runId}` : "a reflection run";
  const remaining = run ? describeRemaining(run) : "no fixed time limit";
  const paths = hits.slice(0, 3).join(", ");
  return {
    blocked: true,
    message: [
      `Permission denied: ${runLabel} is writing this agent's memory repository right now (${remaining}).`,
      `Blocked path(s): ${paths}`,
      "Memory file writes are blocked until the reflection run ends; the end-of-run reminder announces it. Wait and retry then, or ask the user to retry later or to raise the reflection time limit.",
      "Reading memory files and shell commands are not blocked.",
    ].join("\n"),
  };
}
