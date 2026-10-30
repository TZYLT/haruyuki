/**
 * Prompt text for a dream run's tier turns (F-06 M2, T3-owned templates).
 *
 * The wording lives in `src/agent/prompts/dream-task.md` and
 * `src/agent/prompts/dream-tiers.md` (T3). This module only fills the
 * `{{placeholder}}` slots, drops lines whose placeholder has no value (the
 * templates say so explicitly), and adds the two things the run controller
 * knows and the templates cannot:
 *
 * - **which tier this turn is** — the controller runs one tier per child turn
 *   so the budget gate and the 40/80/100 reminders have a boundary to act on;
 * - **the current budget state and the newly crossed reminder text**.
 *
 * Splitting it out of `dream-run.ts` keeps the controller under the 1,000-line
 * ceiling and gives the prompt wording one home.
 */

import dreamTaskTemplate from "@/agent/prompts/dream-task.md";
import dreamTiersTemplate from "@/agent/prompts/dream-tiers.md";
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
  handoffFromPrevious?: string | null;
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
