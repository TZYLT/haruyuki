/**
 * Prompt text for a dream run's tier turns (F-06 M2, T3-owned templates).
 *
 * The wording lives in `src/agent/prompts/dream-task.md` and
 * `src/agent/prompts/dream-tiers.md` (T3). This module only fills the
 * `{{placeholder}}` slots, drops lines whose placeholder has no value (the
 * templates say so explicitly), and adds the three things the run controller
 * knows and the templates cannot:
 *
 * - **which tier this turn is** — the controller runs one tier per child turn
 *   so the budget gate and the 40/80/100 reminders have a boundary to act on;
 * - **the run's permission tier** — the same templates serve a read-only run
 *   and an `unrestricted` one, so what the run can actually use is generated
 *   from `permissionMode` instead of being hardcoded;
 * - **the current budget state and the newly crossed reminder text**.
 *
 * Splitting it out of `dream-run.ts` keeps the controller under the 1,000-line
 * ceiling and gives the prompt wording one home.
 */

import dreamTaskTemplate from "@/agent/prompts/dream-task.md";
import dreamTiersTemplate from "@/agent/prompts/dream-tiers.md";
import type { PermissionTier } from "@/cron/cron-types";
import type { DreamUsageParts } from "@/dream-budget-math";
import type { DreamRunStatus, DreamTier } from "@/types/dream-run-metadata";
import type { DreamBudgetTracker } from "./dream-budget";

/** One line of what this tier is for, above the shared disciplines. */
const DREAM_TIER_FOCUS: Record<DreamTier, string> = {
  tidy: "Tidy: merge duplicates, fix indexes and links, rebuild timelines, and commit the result in small coherent commits.",
  think:
    "Think: turn recent experience into durable conclusions, corrections and next steps, and commit them as memory files.",
  task: "Task: work through small maintenance items covered by an explicit authorization entry. No entry means no work — skip it and say so.",
  wander:
    "Wander: explore freely — develop ideas, draft documents, follow curiosity — and keep what is worth keeping as memory notes.",
};

/** Replace filled placeholders; an unknown placeholder is reported as such. */
function fillPlaceholders(
  template: string,
  values: Record<string, string | null | undefined>,
): string {
  const filled = template.replaceAll(
    /\{\{([a-z_]+)\}\}/g,
    (_match, name: string) => {
      const value = values[name];
      return typeof value === "string" ? value : `{{${name}}}`;
    },
  );
  if (!filled.includes("{{")) return filled.trim();
  // "Drop any line whose placeholder has no value rather than leaving the
  // braces in the message" — that is the template's own instruction.
  return filled
    .split("\n")
    .filter((line) => !line.includes("{{"))
    .join("\n")
    .trim();
}

export interface DreamPromptRunInfo {
  runId: string;
  baselineSha: string;
  budgetTokens: number;
  timeLimitMinutes: number | null;
  tierPlan: DreamTier[];
  tier: DreamTier;
  tierIndex: number;
  tierCount: number;
  /**
   * The run's permission tier, from `ResolvedDreamSettings.permissionMode`. The
   * prompt has to describe this tier honestly: the same template is used for a
   * read-only run and for an `unrestricted` one.
   */
  permissionMode: PermissionTier;
  handoffFromPrevious?: string | null;
}

const DREAM_PERMISSION_TIER_LABELS: Record<PermissionTier, string> = {
  standard: "read-only",
  acceptEdits: "memory writes",
  unrestricted: "full permission",
};

/**
 * The one generated permission section shared by every tier turn.
 *
 * The templates deliberately say nothing about shell/network/write access:
 * whether those exist is a property of the run's permission tier, not of the
 * dream workflow, so it is generated here from `permissionMode`. The
 * `unrestricted` text states what the permission layer allows, and also that
 * the harness's own run guard may still refuse a call — a refusal is final.
 * That keeps the prompt true without inviting the agent to retry a guarded
 * path.
 */
export function buildDreamPermissionSection(mode: PermissionTier): string {
  const lines = [
    "## Permissions in this run",
    "",
    `Permission tier: \`${mode}\` (${DREAM_PERMISSION_TIER_LABELS[mode]}). This run is unattended: every approval request is a denial, and there is no one to answer a question. Do not ask, do not request approval, and never retry a refused call.`,
    "",
  ];
  if (mode === "standard") {
    lines.push(
      "- Available: `Read`, `Glob`, `Grep`, `TopicQuery`, `SessionRead`, `DreamStatus`, `DreamAuthorization` and `DreamDone`.",
      "- Read-only contract: only read and retrieve. Do not call `Write`, `Edit` or `MemoryCommit` in this tier. `Write` and `Edit` are rejected outside the memory repository; shell (`Bash` / `exec_command`) and network tools are not available.",
      "- Inside your own memory repository the permission checker's own-memory allowance may auto-allow a `Write`, `Edit` or `MemoryCommit` even in this tier. That allowance is a checker detail, not permission for this run: treat `Write`, `Edit` and `MemoryCommit` as rejected in this tier — do not use it, do not test it, and do not treat a successful write or commit as authorization.",
      "- A tier that needs a write or any other denied action is blocked: say in the report that the permission tier blocked it, record the work as unfinished, and end that tier. Do not attempt a workaround, a different tool, or the same call again.",
    );
  } else if (mode === "acceptEdits") {
    lines.push(
      "- Available: `Read`, `Glob`, `Grep`, `TopicQuery`, `SessionRead`, `Write`, `Edit`, `MemoryCommit`, and the run's own `DreamStatus` / `DreamAuthorization` / `DreamDone` tools.",
      "- Not available: shell (`Bash` / `exec_command`) and network tools. This tier has no approval path, so an `ask` is a denial; do not try to work around it.",
      "- Write only inside the memory repository and only to paths the current tier covers. Writes outside it are out of scope for this run and may be refused. `MemoryCommit` is the only way to make a change durable: commit small, coherent changes as you go.",
    );
  } else {
    // `unrestricted` is a statement about the permission layer. The dream host
    // still starts the child with the harness shell guard
    // (`disallowed_tools: ["Bash"]`, C-20), so the prompt must not promise a
    // working shell; it says a refusal is final instead.
    lines.push(
      "- The permission layer allows shell (`Bash` / `exec_command`), network tools, and writes outside the memory repository. The harness may still refuse a shell call or a path through its own run guard (a dream child is normally started with shell disallowed); a refusal is final, so do not retry it or look for another route.",
      "- Default scope stays the memory repository. Use the wider permissions only when the tier genuinely needs them and, in the task tier, an authorization entry covers that exact work. Do not use them for convenience, speed, or idle exploration, and do not widen the scope beyond what the work requires.",
      "- Any irreversible external side effect (publishing, sending, deleting files outside memory, rewriting git history) must not happen without an explicit authorization entry. No entry means no action.",
      "- The memory-repository boundary and the cross-agent guard still apply: never read or write another agent's memory, credentials, or export files.",
    );
  }
  return lines.join("\n");
}

/** A short permission restatement for the later (deliberately short) turns. */
function permissionReminder(mode: PermissionTier): string {
  switch (mode) {
    case "standard":
      return "Permission tier `standard` (read-only): `Read` / `Glob` / `Grep` / `TopicQuery` / `SessionRead` only. `Write` and `Edit` are rejected outside the memory repository; the checker's own-memory allowance is not permission to write. Shell and network are unavailable. A tier that needs a write is blocked: report it and end the tier.";
    case "acceptEdits":
      return "Permission tier `acceptEdits`: read/write/edit inside the memory repository plus `MemoryCommit`; shell and network are unavailable (no approver).";
    case "unrestricted":
      return "Permission tier `unrestricted`: the permission layer allows shell, network and writes outside the memory repository, but the run's own guard may still refuse a call (a refusal is final), and the default scope is still the memory repository; use wider permissions only when the tier needs them and is authorized, never for convenience, and no irreversible external side effect without an authorization entry.";
  }
}

function timeLimitLabel(minutes: number | null): string {
  return minutes === null
    ? "none (run until done or budget stops)"
    : `${minutes} minutes`;
}

function budgetLine(tracker: DreamBudgetTracker): string {
  const percent =
    tracker.baseBudgetTokens > 0 ? Math.round(tracker.ratio * 100) : 0;
  return `budget state: ${tracker.spentTokens} of ${tracker.baseBudgetTokens} budget tokens used (${percent}%), allowances left: ${tracker.extensionsRemaining} over-budget extension(s); allowance in force: ${tracker.allowanceTokens}.`;
}

/**
 * The first message of a run: the full task + tiers text, with the tier plan
 * narrowed to "this turn handles tier 1".
 */
export function buildFirstDreamTurnPrompt(
  input: DreamPromptRunInfo & { tracker: DreamBudgetTracker },
): string {
  const tierPlan = input.tierPlan
    .map((tier, index) => `${index + 1}. ${tier}`)
    .join(", ");
  const filledTask = fillPlaceholders(dreamTaskTemplate, {
    run_id: input.runId,
    baseline_sha: input.baselineSha,
    budget_tokens: String(input.budgetTokens),
    time_limit: timeLimitLabel(input.timeLimitMinutes),
    tier_plan: tierPlan,
    handoff_from_previous: input.handoffFromPrevious ?? null,
    permissions_section: buildDreamPermissionSection(input.permissionMode),
  });
  return [
    filledTask,
    "",
    "---",
    "",
    dreamTiersTemplate.trim(),
    "",
    "---",
    "",
    "## This turn",
    "",
    `This turn handles **one tier only**: ${input.tier} (tier ${input.tierIndex + 1} of ${input.tierCount}). Do not start the next tier — the harness starts it in a new turn, after checking the budget.`,
    "",
    DREAM_TIER_FOCUS[input.tier],
    "",
    budgetLine(input.tracker),
  ].join("\n");
}

/**
 * A later turn: short on purpose. The first message already carries the full
 * rules and it is still in the conversation history; repeating 158 lines of
 * template per tier would spend the run's budget on its own prompt.
 */
export function buildNextDreamTurnPrompt(
  input: DreamPromptRunInfo & {
    tracker: DreamBudgetTracker;
    reminders: string[];
  },
): string {
  const lines = [
    `<dream_run>`,
    `Dream run ${input.runId}, continuing. This turn handles one tier only: **${input.tier}** (tier ${input.tierIndex + 1} of ${input.tierCount}).`,
    `Follow the rules from the first message of this run. Do not start the next tier; the harness checks the budget between tiers.`,
    permissionReminder(input.permissionMode),
    "",
    DREAM_TIER_FOCUS[input.tier],
    "",
    budgetLine(input.tracker),
  ];
  if (input.reminders.length > 0) {
    lines.push("", ...input.reminders);
  }
  lines.push(
    "",
    "End this turn with the same report style as before: what changed, why, what is left. Call DreamDone only when the whole run should end now (nothing useful is left in any remaining tier); otherwise just finish the turn.",
    `</dream_run>`,
  );
  return lines.join("\n");
}

/** Report body: the agent's text plus the parent's handoff/status note. */
export function buildDreamReportBody(input: {
  status: DreamRunStatus;
  agentReport: string;
  handoff: string | null;
  error?: string;
  rollbackError?: string;
}): string {
  const sections: string[] = [];
  const agent = input.agentReport.trim();
  sections.push(
    agent.length > 0
      ? agent
      : `_No agent report was produced (run status: ${input.status})._`,
  );
  if (input.handoff && input.handoff.trim().length > 0) {
    sections.push(`## Where to continue\n\n${input.handoff.trim()}`);
  }
  if (input.status !== "succeeded") {
    sections.push(`## Run status\n\n- status: \`${input.status}\``);
    if (input.error) sections.push(`- error: ${input.error}`);
    if (input.rollbackError) {
      sections.push(
        `- rollback: FAILED (${input.rollbackError}); the memory checkout was left in place for manual repair`,
      );
    }
  }
  return `${sections.join("\n\n")}\n`;
}

/** `true` when the agent's usage parts are all zero (nothing to account). */
export function isEmptyUsage(parts: DreamUsageParts): boolean {
  return (
    parts.outputTokens === 0 &&
    parts.uncachedReadTokens === 0 &&
    parts.cachedReadTokens === 0
  );
}
