/**
 * Prompt assembly for a dream run's tier turns (F-06 M2 / 46-6-Fix-A W11).
 *
 * The wording lives in `src/agent/prompts/dream/`: one shared manual plus one
 * manual per tier. This module only assembles them:
 *
 * - **first turn** — the shared manual with `{{permissions_section}}` and
 *   `{{run_seed}}` filled, a `## This turn` fact block, the whole tier manual,
 *   and the budget line;
 * - **later turns** — a short `<dream_run>` block: the tier manual's
 *   `## 本轮执行` + `## 检查清单` sections (the whole manual when it is short
 *   enough), an excerpt of the previous tier's report, a one-line permission
 *   reminder, the budget line and any crossed-threshold reminders.
 *
 * Section slicing is plain text selection, not a gate: a manual whose anchors
 * are missing is sent whole with a debug line, because sending too much is
 * always better than failing a run over a heading.
 *
 * Splitting it out of `dream-run.ts` keeps the controller under the 1,000-line
 * ceiling and gives the prompt assembly one home.
 */

import { type DreamSeed, renderSeed } from "@/agent/dream/dream-seed";
import manualShared from "@/agent/prompts/dream/manual-shared.md";
import manualTask from "@/agent/prompts/dream/manual-task.md";
import manualThink from "@/agent/prompts/dream/manual-think.md";
import manualTidy from "@/agent/prompts/dream/manual-tidy.md";
import manualWander from "@/agent/prompts/dream/manual-wander.md";
import type { PermissionTier } from "@/cron/cron-types";
import type { DreamUsageParts } from "@/dream-budget-math";
import type { DreamRunStatus, DreamTier } from "@/types/dream-run-metadata";
import { debugWarn } from "@/utils/debug";
import type { DreamBudgetTracker } from "./dream-budget";

/** The manual sections a later turn re-sends (design §5.3.3). */
export const DREAM_LATER_TURN_SECTIONS: readonly string[] = [
  "本轮执行",
  "检查清单",
];

/**
 * A tier manual at or below this many lines is re-sent whole on later turns;
 * slicing a manual that short would save nothing worth the risk of a missing
 * anchor.
 */
export const DREAM_FULL_TIER_MANUAL_MAX_LINES = 100;

/** Keep the previous tier's report excerpt small: it rides in every later turn. */
export const DREAM_PREVIOUS_REPORT_MAX_LINES = 8;

const TIER_MANUALS: Record<DreamTier, string> = {
  tidy: manualTidy,
  think: manualThink,
  task: manualTask,
  wander: manualWander,
};

/**
 * One line used when the harness could not build the run seed at all. The
 * manual is still sent: a seed failure must degrade the data block, not the run.
 */
export const DREAM_SEED_UNAVAILABLE_LINE =
  "The harness could not prepare this run's seed (layout, manifest, changes, decay, deferred items). Work from what you can read directly in the memory repository, and say so in the report.";

/** Replace filled placeholders; an unfilled placeholder drops its line. */
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
  // braces in the message" — that is the shared manual's own instruction.
  return filled
    .split("\n")
    .filter((line) => !line.includes("{{"))
    .join("\n")
    .trim();
}

/** Lines as an editor counts them: a trailing newline is not a line. */
function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/**
 * Select `## <heading>` sections from a manual by plain text slicing.
 *
 * A missing anchor returns the whole manual and logs a debug line: the
 * assembler must never fail a run because a heading drifted. The returned
 * blocks keep their headings and are separated by one blank line.
 */
export function extractSections(
  text: string,
  headings: readonly string[],
): string {
  const blocks = text.split(/\n(?=## )/);
  const selected: string[] = [];
  const missing: string[] = [];
  for (const heading of headings) {
    const block = blocks.find((candidate) =>
      candidate.startsWith(`## ${heading}`),
    );
    if (block === undefined) missing.push(heading);
    else selected.push(block.trim());
  }
  if (missing.length > 0) {
    debugWarn(
      "dream-prompt",
      `tier manual is missing the section(s) ${missing
        .map((heading) => `## ${heading}`)
        .join(", ")}; sending the whole manual instead`,
    );
    return text.trim();
  }
  return selected.join("\n\n");
}

/** The tier's manual verbatim (trimmed), from the statically imported set. */
export function renderTierManual(tier: DreamTier): string {
  return TIER_MANUALS[tier].trim();
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
   * prompt has to describe this tier honestly: the same manuals are used for a
   * read-only run and for an `unrestricted` one.
   */
  permissionMode: PermissionTier;
}

const DREAM_PERMISSION_TIER_LABELS: Record<PermissionTier, string> = {
  standard: "read-only",
  acceptEdits: "memory writes",
  unrestricted: "full permission",
};

/**
 * The one generated permission section shared by every tier turn.
 *
 * The manuals deliberately say nothing about shell/network/write access:
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
      "- Available: `Read`, `Glob`, `Grep`, `TopicQuery`, `SessionRead`, `DreamStatus`, `DreamAuthorization`, `DreamReviewMark`, `DreamNote` and `DreamDone`.",
      "- Read-only contract: only read and retrieve. Do not call `Write`, `Edit` or `MemoryCommit` in this tier. `Write` and `Edit` are rejected outside the memory repository; shell (`Bash` / `exec_command`) and network tools are not available.",
      "- Inside your own memory repository the permission checker's own-memory allowance may auto-allow a `Write`, `Edit` or `MemoryCommit` even in this tier. That allowance is a checker detail, not permission for this run: treat `Write`, `Edit` and `MemoryCommit` as rejected in this tier — do not use it, do not test it, and do not treat a successful write or commit as authorization.",
      "- `DreamReviewMark` records that you reviewed a file (it writes only the harness's own per-run mark file) and `DreamNote` leaves a note for a later run; neither changes memory content, so both are available in this tier.",
      "- A tier that needs a write or any other denied action is blocked: say in the report that the permission tier blocked it, record the work as unfinished, and end that tier. Do not attempt a workaround, a different tool, or the same call again.",
    );
  } else if (mode === "acceptEdits") {
    lines.push(
      "- Available: `Read`, `Glob`, `Grep`, `TopicQuery`, `SessionRead`, `Write`, `Edit`, `MemoryCommit`, and the run's own `DreamStatus` / `DreamAuthorization` / `DreamReviewMark` / `DreamNote` / `DreamDone` tools.",
      "- Not available: shell (`Bash` / `exec_command`) and network tools. This tier has no approval path, so an `ask` is a denial; do not try to work around it.",
      "- Write only inside the memory repository and only to paths the current tier covers. Writes outside it are out of scope for this run and may be refused. `MemoryCommit` is the only way to make a change durable: commit small, coherent changes as you go.",
    );
  } else {
    // `unrestricted` is a statement about the permission layer. The dream host
    // still starts the child with the harness shell guard
    // (`disallowed_tools: ["Bash"]`, C-20), so the prompt must not promise a
    // working shell; it says a refusal is final instead.
    lines.push(
      "- Available: `Read`, `Glob`, `Grep`, `TopicQuery`, `SessionRead`, `Write`, `Edit`, `MemoryCommit`, and the run's own `DreamStatus` / `DreamAuthorization` / `DreamReviewMark` / `DreamNote` / `DreamDone` tools.",
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
  const ownTools =
    "The run's own `DreamStatus` / `DreamAuthorization` / `DreamReviewMark` / `DreamNote` / `DreamDone` tools stay available in every tier.";
  switch (mode) {
    case "standard":
      return `Permission tier \`standard\` (read-only): \`Read\` / \`Glob\` / \`Grep\` / \`TopicQuery\` / \`SessionRead\` only. \`Write\` and \`Edit\` are rejected outside the memory repository; the checker's own-memory allowance is not permission to write. Shell and network are unavailable. A tier that needs a write is blocked: report it and end the tier. ${ownTools}`;
    case "acceptEdits":
      return `Permission tier \`acceptEdits\`: read/write/edit inside the memory repository plus \`MemoryCommit\`; shell and network are unavailable (no approver). ${ownTools}`;
    case "unrestricted":
      return `Permission tier \`unrestricted\`: the permission layer allows shell, network and writes outside the memory repository, but the run's own guard may still refuse a call (a refusal is final), and the default scope is still the memory repository; use wider permissions only when the tier needs them and is authorized, never for convenience, and no irreversible external side effect without an authorization entry. ${ownTools}`;
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

/** Fill the shared manual's two placeholders; everything else is static text. */
export function renderSharedManual(input: {
  permissionMode: PermissionTier;
  seed: DreamSeed | null;
}): string {
  return fillPlaceholders(manualShared, {
    permissions_section: buildDreamPermissionSection(input.permissionMode),
    run_seed:
      input.seed === null
        ? DREAM_SEED_UNAVAILABLE_LINE
        : renderSeed(input.seed),
  });
}

/**
 * The first message of a run: the filled shared manual, this turn's facts, the
 * whole tier manual and the budget line. The seed is injected here — once per
 * run, never again.
 */
export function buildFirstDreamTurnPrompt(
  input: DreamPromptRunInfo & {
    tracker: DreamBudgetTracker;
    seed: DreamSeed | null;
  },
): string {
  const tierPlan = input.tierPlan
    .map((tier, index) => `${index + 1}. ${tier}`)
    .join(", ");
  return [
    renderSharedManual({
      permissionMode: input.permissionMode,
      seed: input.seed,
    }),
    "",
    "## This turn",
    "",
    `- run id: \`${input.runId}\``,
    `- baseline commit: \`${input.baselineSha}\``,
    `- budget: ${input.budgetTokens} budget tokens`,
    `- time limit: ${timeLimitLabel(input.timeLimitMinutes)}`,
    `- tiers planned, in this order: ${tierPlan}`,
    `- this turn handles **one tier only**: ${input.tier} (tier ${input.tierIndex + 1} of ${input.tierCount})`,
    "",
    "Tiers run in priority order. The harness starts the next tier in a new turn after checking the budget: do not start it yourself, and do not call `DreamDone` unless the whole run must stop now.",
    "",
    renderTierManual(input.tier),
    "",
    budgetLine(input.tracker),
  ].join("\n");
}

/**
 * The previous tier's report, cut to at most
 * {@link DREAM_PREVIOUS_REPORT_MAX_LINES} lines: the head of the report (what
 * the tier concluded) and its tail (what is left).
 */
export function summarizePreviousReport(
  report: string | null | undefined,
  maxLines: number = DREAM_PREVIOUS_REPORT_MAX_LINES,
): string {
  const text = typeof report === "string" ? report.trim() : "";
  if (text.length === 0) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const headCount = Math.max(1, Math.floor((maxLines - 1) / 2) + 1);
  const tailCount = Math.max(1, maxLines - 1 - headCount);
  return [
    ...lines.slice(0, headCount),
    "...",
    ...lines.slice(lines.length - tailCount),
  ].join("\n");
}

/**
 * A later turn: short on purpose. The first message already carries the shared
 * manual and the run seed, and it is still in the conversation history;
 * repeating them per tier would spend the run's budget on its own prompt.
 */
export function buildNextDreamTurnPrompt(
  input: DreamPromptRunInfo & {
    tracker: DreamBudgetTracker;
    reminders: string[];
    /** The previous tier's report; the excerpt is cut to 8 lines. */
    previousReport?: string | null;
  },
): string {
  const manual = renderTierManual(input.tier);
  const tierBlock =
    lineCount(manual) <= DREAM_FULL_TIER_MANUAL_MAX_LINES
      ? manual
      : extractSections(manual, DREAM_LATER_TURN_SECTIONS);
  const previousExcerpt = summarizePreviousReport(input.previousReport);
  const lines = [
    "<dream_run>",
    `Dream run ${input.runId}, continuing. This turn handles one tier only: **${input.tier}** (tier ${input.tierIndex + 1} of ${input.tierCount}).`,
    "",
    tierBlock,
  ];
  if (previousExcerpt.length > 0) {
    lines.push("", "## Previous tier's report (excerpt)", "", previousExcerpt);
  }
  lines.push("", permissionReminder(input.permissionMode), "");
  lines.push(budgetLine(input.tracker));
  if (input.reminders.length > 0) {
    lines.push("", ...input.reminders);
  }
  lines.push(
    "",
    "The run seed and the shared manual from the first message are still in this conversation; they are not re-sent. End this turn with the report body in the shared manual's report template (what changed, why, what is left). Call DreamDone only when the whole run should end now; otherwise just finish the turn.",
    "</dream_run>",
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
