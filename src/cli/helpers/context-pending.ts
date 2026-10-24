import { getBackend } from "@/backend";
import type { ContextPendingReport } from "@/backend/local/prefix-freeze";

/**
 * `/context pending` — show the prefix changes that have been registered but not
 * yet applied. Read-only: it never rewrites the frozen prefix. Local-backend
 * only (cloud backends have no applied client-side snapshot to compare).
 */
interface ContextPendingCapable {
  getContextPending(
    conversationId: string,
    agentId: string,
    options?: { full?: boolean },
  ): Promise<ContextPendingReport>;
}

function isContextPendingCapable(
  backend: unknown,
): backend is ContextPendingCapable {
  return (
    typeof backend === "object" &&
    backend !== null &&
    typeof (backend as { getContextPending?: unknown }).getContextPending ===
      "function"
  );
}

/**
 * Read the pending report for a scope, best-effort. `undefined` means "this
 * backend has no prefix freeze" (cloud) or the read failed — callers must stay
 * silent rather than claim anything about the prefix.
 */
export async function readContextPendingReport(input: {
  conversationId: string | null;
  agentId: string | null | undefined;
  full?: boolean;
}): Promise<ContextPendingReport | undefined> {
  if (!input.agentId) return undefined;
  try {
    const backend = getBackend();
    if (!isContextPendingCapable(backend)) return undefined;
    return await backend.getContextPending(
      input.conversationId ?? "default",
      input.agentId,
      { full: input.full === true },
    );
  } catch {
    return undefined;
  }
}

/**
 * What `/recompile` just applied, counted from the report taken immediately
 * before it. Uncommitted working-tree changes are not applied by a recompile,
 * so they are never counted here.
 */
export function formatAppliedPendingSummary(
  report: ContextPendingReport | undefined,
): string | undefined {
  if (!report) return undefined;
  const parts: string[] = [];
  const commits = report.memory.unappliedCommits.length;
  if (commits > 0) parts.push(`${commits} memory commit(s)`);
  if (report.systemChanged) parts.push("agent.system change");
  if (report.skillsChanged) parts.push("skills change");
  if (report.tools.changed) {
    parts.push(
      `tool declarations (+${report.tools.added.length}/-${report.tools.removed.length})`,
    );
  }
  if (report.model.changed) parts.push("model change");
  if (report.modelSettingsChanged) parts.push("model settings change");
  if (parts.length === 0) return "Nothing was pending.";
  return `Applied: ${parts.join(", ")}.`;
}

/**
 * A model switch inside a frozen conversation is only REGISTERED: the prefix
 * keeps the model it was compiled with until the next application point. Say so
 * at the switch instead of leaving the user to discover it.
 */
export function formatModelRegistrationNotice(
  report: ContextPendingReport | undefined,
): string | undefined {
  if (!report?.hasSnapshot) return undefined;
  if (!report.model.changed && !report.modelSettingsChanged) return undefined;
  return "Model change registered — run `/recompile` to apply it now (it also applies at the next compaction or new conversation).";
}

function indentBlock(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatContextPendingReport(
  report: ContextPendingReport,
  options: { full?: boolean } = {},
): string {
  if (!report.hasSnapshot) {
    return [
      "No frozen prefix snapshot for this conversation.",
      "The next turn will compile one from the latest committed state.",
    ].join("\n");
  }

  const sections: string[] = [];

  if (report.memory.unappliedCommits.length > 0) {
    const memoryLines = [
      `memory: ${report.memory.unappliedCommits.length} unapplied commit(s)`,
    ];
    if (report.memory.diffStat) memoryLines.push(report.memory.diffStat);
    memoryLines.push("commits:");
    for (const commit of report.memory.unappliedCommits) {
      memoryLines.push(`  ${commit}`);
    }
    if (options.full && report.memory.fullDiff) {
      memoryLines.push("diff:", report.memory.fullDiff);
    } else if (!options.full) {
      memoryLines.push("(run /context-pending full for the full diff)");
    }
    sections.push(memoryLines.join("\n"));
  }

  if (report.systemChanged) sections.push("agent.system: changed");
  if (report.skillsChanged) sections.push("skills: changed");
  if (report.tools.changed) {
    const parts = [
      `tools: changed (+${report.tools.added.length}/-${report.tools.removed.length})`,
    ];
    if (report.tools.added.length > 0) {
      parts.push(`  added: ${report.tools.added.join(", ")}`);
    }
    if (report.tools.removed.length > 0) {
      parts.push(`  removed: ${report.tools.removed.join(", ")}`);
    }
    sections.push(parts.join("\n"));
  }
  if (report.model.changed) {
    sections.push(`model: ${report.model.applied} -> ${report.model.live}`);
  }
  if (report.modelSettingsChanged) sections.push("model settings: changed");

  const dirtyNotice = report.dirty
    ? "Working tree has uncommitted memory changes (not applied until committed)."
    : undefined;
  const unreachableNotice =
    report.memory.reachable === false
      ? "memory repo unreachable — pending memory changes are unknown (the frozen prefix is unchanged)."
      : undefined;
  const notices = [dirtyNotice, unreachableNotice].filter(
    (notice): notice is string => notice !== undefined,
  );

  if (!report.hasPending) {
    // No pending flag is set, so no section was pushed: this is the only text.
    return ["No pending prefix changes.", ...notices].join("\n");
  }

  const output = [
    "Pending prefix changes (not yet applied):",
    indentBlock(sections.join("\n")),
    "",
    "Run /recompile to apply now (evicts cache), or wait for compaction / a new conversation.",
    ...notices,
  ];
  return output.join("\n");
}

export async function runContextPendingCommand(input: {
  conversationId: string | null;
  agentId: string;
  full: boolean;
}): Promise<string> {
  const backend = getBackend();
  if (!isContextPendingCapable(backend)) {
    return "Context prefix freeze is only available on the local backend.";
  }
  const report = await backend.getContextPending(
    input.conversationId ?? "default",
    input.agentId,
    { full: input.full },
  );
  return formatContextPendingReport(report, { full: input.full });
}
