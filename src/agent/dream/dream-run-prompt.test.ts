/**
 * Dream prompt assembly contract (F-06 / 46-6-Fix-A W11).
 *
 * The manuals are model-facing contract text and the assembler slices them by
 * fixed `## ` anchors, so these cases pin:
 *
 * - the three generated permission sections (the manuals never claim a tool
 *   surface of their own),
 * - the first turn: shared manual + run facts + whole tier manual + budget,
 * - the later turns: only the tier's `## This turn` / `## Checklist` sections,
 *   the previous report excerpt, a one-line permission reminder and the budget,
 * - the seed is injected in the first turn and never repeated,
 * - a missing anchor degrades to the whole manual instead of failing.
 */
import { describe, expect, test } from "bun:test";
import { DreamBudgetTracker } from "@/agent/dream/dream-budget";
import {
  buildDreamPermissionSection,
  buildFirstDreamTurnPrompt,
  buildNextDreamTurnPrompt,
  DREAM_FULL_TIER_MANUAL_MAX_LINES,
  DREAM_LATER_TURN_SECTIONS,
  DREAM_PREVIOUS_REPORT_MAX_LINES,
  type DreamPromptRunInfo,
  extractSections,
  renderSharedManual,
  renderTierManual,
  summarizePreviousReport,
} from "@/agent/dream/dream-run-prompt";
import type { DreamSeed } from "@/agent/dream/dream-seed";
import type { PermissionTier } from "@/cron/cron-types";
import type { DreamTier } from "@/types/dream-run-metadata";

const MODES: readonly PermissionTier[] = [
  "standard",
  "acceptEdits",
  "unrestricted",
];

const TIERS: readonly DreamTier[] = ["tidy", "think", "task", "wander"];

function tracker(): DreamBudgetTracker {
  return new DreamBudgetTracker({
    budgetTokens: 10_000,
    overBudgetApprovals: 1,
  });
}

function runInfo(
  mode: PermissionTier,
  tier: DreamTier = "tidy",
): DreamPromptRunInfo {
  return {
    runId: "run-1",
    baselineSha: "baseline-sha",
    budgetTokens: 10_000,
    timeLimitMinutes: null,
    tierPlan: ["tidy", "think"],
    tier,
    tierIndex: tier === "tidy" ? 0 : 1,
    tierCount: 2,
    permissionMode: mode,
  };
}

/** Minimal seed with one distinctive note, so "the seed rode along" is testable. */
function seed(marker = "seed-marker"): DreamSeed {
  return {
    layout: null,
    manifest: null,
    changes: null,
    decay: null,
    coreCost: null,
    deferred: null,
    notes: [
      {
        version: 1,
        id: `note-${marker}`,
        createdAt: Date.UTC(2026, 9, 31, 12, 0),
        author: "user",
        text: `remember ${marker}`,
        source: {},
      },
    ],
    degraded: [],
  };
}

function firstPrompt(
  mode: PermissionTier,
  tier: DreamTier = "tidy",
  seedValue: DreamSeed | null = seed(),
): string {
  return buildFirstDreamTurnPrompt({
    ...runInfo(mode, tier),
    tracker: tracker(),
    seed: seedValue,
  });
}

function nextPrompt(mode: PermissionTier, tier: DreamTier = "think"): string {
  return buildNextDreamTurnPrompt({
    ...runInfo(mode, tier),
    tracker: tracker(),
    reminders: [],
    previousReport: "Tidy finished: split system/human.md, index updated.",
  });
}

function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

describe("dream permission section", () => {
  test("standard is read-only and names the run's own mark/note tools", () => {
    const text = buildDreamPermissionSection("standard");
    expect(text).toContain("Permission tier: `standard` (read-only)");
    expect(text).toContain("`Write` and `Edit` are rejected");
    expect(text).toContain("Do not call `Write`, `Edit` or `MemoryCommit`");
    expect(text).toContain("shell (`Bash` / `exec_command`) and network tools");
    expect(text).toContain("A tier that needs a write");
    expect(text).toContain("blocked");
    expect(text).toContain("end that tier");
    // The checker's own-memory allowance is real; the prompt must not pretend
    // it is a grant for a read-only run.
    expect(text).toContain("own-memory allowance");
    expect(text).toContain("do not use it");
    expect(text).toContain(
      "treat `Write`, `Edit` and `MemoryCommit` as rejected",
    );
    expect(text).not.toContain("`MemoryCommit` is permitted");
    // W6/W15 tools write only the harness home: available at every tier.
    expect(text).toContain("`DreamReviewMark`, `DreamNote`");
  });

  test("acceptEdits grants memory writes and denies shell/network", () => {
    const text = buildDreamPermissionSection("acceptEdits");
    expect(text).toContain("Permission tier: `acceptEdits` (memory writes)");
    expect(text).toContain("`Write`, `Edit`, `MemoryCommit`");
    expect(text).toContain("`DreamReviewMark`");
    expect(text).toContain("`DreamNote`");
    expect(text).toContain("Not available: shell (`Bash` / `exec_command`)");
    expect(text).toContain("network tools");
    expect(text).toContain("memory repository");
    // No shell promise in a tier with nobody to approve it.
    expect(text).not.toContain("allows shell");
    expect(text).not.toContain("you can use shell");
  });

  test("unrestricted names the wider powers but forbids abusing them", () => {
    const text = buildDreamPermissionSection("unrestricted");
    expect(text).toContain("Permission tier: `unrestricted`");
    expect(text).toContain("allows shell (`Bash` / `exec_command`)");
    expect(text).toContain("network tools");
    expect(text).toContain("writes outside the memory repository");
    // User ruling: do not widen usage for convenience; only when necessary.
    expect(text).toContain("only when the tier genuinely needs them");
    expect(text).toContain("Do not use them for convenience");
    expect(text).toContain("irreversible external side effect");
    expect(text).toContain("authorization entry");
    // The harness guard is stated as final, not as an invitation to retry.
    expect(text).toContain("harness may still refuse a shell call");
    expect(text).toContain("a refusal is final");
    expect(text).toContain("`DreamReviewMark`");
    expect(text).toContain("`DreamNote`");
  });

  test("all tiers keep the unattended/no-approval rule", () => {
    for (const mode of MODES) {
      const text = buildDreamPermissionSection(mode);
      expect(text).toContain("This run is unattended");
      expect(text).toContain("Do not ask");
      expect(text).toContain("do not request approval");
      expect(text).toContain("never retry a refused call");
    }
  });
});

describe("dream shared manual", () => {
  test("the two placeholders are filled and nothing is left unfilled", () => {
    const text = renderSharedManual({
      permissionMode: "acceptEdits",
      seed: seed("run-seed-x"),
    });
    expect(text).not.toContain("{{");
    expect(text).toContain("## Permissions in this run");
    expect(text).toContain("note-run-seed-x");
    expect(text).toContain("## Report template");
  });

  test("a missing seed degrades to one explanatory line, not an empty block", () => {
    const text = renderSharedManual({ permissionMode: "standard", seed: null });
    expect(text).toContain("could not prepare this run's seed");
    expect(text).not.toContain("{{");
  });

  test("the manual is sent verbatim by renderTierManual", () => {
    for (const tier of TIERS) {
      const manual = renderTierManual(tier);
      expect(manual.startsWith("# ")).toBe(true);
      expect(manual).toContain(`# ${tier} — dream work manual`);
      expect(manual).toContain("## This turn");
    }
  });
});

describe("extractSections", () => {
  test("the later-turn anchors are the manuals' English headings, verbatim", () => {
    expect(DREAM_LATER_TURN_SECTIONS).toEqual(["This turn", "Checklist"]);
    for (const tier of TIERS) {
      for (const anchor of DREAM_LATER_TURN_SECTIONS) {
        expect(renderTierManual(tier).split(`## ${anchor}`).length - 1).toBe(1);
      }
    }
  });

  const sample = [
    "# sample manual",
    "## Goal and boundaries",
    "goals",
    "## Checklist",
    "check one",
    "## Example",
    "example",
    "## This turn",
    "do the work",
    "",
  ].join("\n");

  test("returns exactly the requested sections, headings included", () => {
    const text = extractSections(sample, ["This turn", "Checklist"]);
    expect(text).toContain("## This turn");
    expect(text).toContain("do the work");
    expect(text).toContain("## Checklist");
    expect(text).toContain("check one");
    expect(text).not.toContain("## Example");
    expect(text).not.toContain("## Goal and boundaries");
  });

  test("a missing anchor sends the whole text instead of failing", () => {
    const text = extractSections(sample, ["This turn", "No such section"]);
    expect(text).toBe(sample.trim());
  });
});

describe("first turn", () => {
  test("is shared manual + run facts + whole tier manual + budget", () => {
    const prompt = firstPrompt("acceptEdits", "tidy");
    expect(prompt).toContain("## Permissions in this run");
    expect(prompt.match(/^## Permissions in this run$/gm)).toHaveLength(1);
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("## This turn");
    expect(prompt).toContain("run id: `run-1`");
    expect(prompt).toContain("baseline commit: `baseline-sha`");
    expect(prompt).toContain("budget: 10000 budget tokens");
    expect(prompt).toContain("tiers planned, in this order: 1. tidy, 2. think");
    expect(prompt).toContain("**one tier only**: tidy (tier 1 of 2)");
    // The whole tier manual, including sections later turns drop.
    expect(prompt).toContain("## Goal and boundaries");
    expect(prompt).toContain("## Example");
    expect(prompt).toContain("## This turn");
    expect(prompt).toContain("budget state: 0 of 10000 budget tokens used");
  });

  test("the retired templates are no longer part of the first message", () => {
    const prompt = firstPrompt("acceptEdits");
    expect(prompt).not.toContain("Dream tiers — discipline and output");
    expect(prompt).not.toContain("Dream run — first task message template");
    expect(prompt).not.toContain("no shell");
  });

  test("fits the design's line budget (250–370 lines) for every tier", () => {
    for (const tier of TIERS) {
      const lines = lineCount(firstPrompt("acceptEdits", tier, null));
      expect(lines).toBeGreaterThanOrEqual(250);
      expect(lines).toBeLessThanOrEqual(370);
    }
  });
});

describe("later turns", () => {
  test("carry only the tier's This turn/Checklist sections, not the whole manual", () => {
    const prompt = nextPrompt("acceptEdits", "think");
    expect(prompt.startsWith("<dream_run>")).toBe(true);
    expect(prompt.endsWith("</dream_run>")).toBe(true);
    expect(prompt).toContain("Dream run run-1, continuing");
    expect(prompt).toContain("**think** (tier 2 of 2)");
    expect(prompt).toContain("## This turn");
    expect(prompt).toContain("## Checklist");
    // The sliced sections' own prose is present ...
    expect(prompt).toContain("This turn you handle **think only**");
    expect(prompt).toContain("Does each claim say something the records");
    // ... while the manual's other sections stay in the first message.
    expect(prompt).not.toContain("## Goal and boundaries");
    expect(prompt).not.toContain("## Work levels");
    expect(prompt).not.toContain("## Voice and closing");
    expect(prompt).not.toContain("## Common traps");
    expect(prompt).not.toContain("## Example");
    // The shared manual is not re-sent either.
    expect(prompt).not.toContain("## Report template");
    expect(prompt).not.toContain("## Hard rules for an unattended run");
  });

  test("the seed rides in the first turn and is never repeated", () => {
    const first = firstPrompt("standard", "tidy", seed("only-once"));
    expect(first).toContain("note-only-once");
    const later = nextPrompt("standard", "think");
    expect(later).not.toContain("note-only-once");
    expect(later).toContain("not re-sent");
  });

  test("include a short previous-report excerpt, permission reminder and budget", () => {
    const prompt = nextPrompt("standard", "think");
    expect(prompt).toContain("## Previous tier's report (excerpt)");
    expect(prompt).toContain("Tidy finished: split system/human.md");
    expect(prompt).toContain("Permission tier `standard` (read-only)");
    expect(prompt).toContain("`DreamReviewMark`");
    expect(prompt).toContain("budget state: 0 of 10000 budget tokens used");
    expect(prompt).toContain("finish the turn");
  });

  test("carry crossed-threshold reminders inside the wrapper", () => {
    const prompt = buildNextDreamTurnPrompt({
      ...runInfo("acceptEdits", "think"),
      tracker: tracker(),
      reminders: [
        "<system-reminder>Dream run budget reminder: 4,500/10,000 (45%).</system-reminder>",
      ],
      previousReport: null,
    });
    expect(prompt).toContain("Dream run budget reminder");
    expect(prompt).not.toContain("## Previous tier's report");
  });

  test("a full short manual is sent whole instead of sliced", () => {
    // All shipped tier manuals currently exceed the threshold; the rule itself
    // is pinned by the exported constant and the slice behaviour above.
    for (const tier of TIERS) {
      expect(
        renderTierManual(tier).replace(/\n$/, "").split("\n").length,
      ).toBeGreaterThan(DREAM_FULL_TIER_MANUAL_MAX_LINES);
    }
  });
});

describe("summarizePreviousReport", () => {
  test("keeps short reports untouched", () => {
    const report = "line one\nline two\nline three";
    expect(summarizePreviousReport(report)).toBe(report);
  });

  test("cuts long reports to the configured maximum, head and tail", () => {
    const report = Array.from(
      { length: 40 },
      (_value, index) => `line-${index + 1}`,
    ).join("\n");
    const summary = summarizePreviousReport(report);
    expect(summary.replace(/\n$/, "").split("\n")).toHaveLength(
      DREAM_PREVIOUS_REPORT_MAX_LINES,
    );
    expect(summary.startsWith("line-1")).toBe(true);
    expect(summary.endsWith("line-40")).toBe(true);
    expect(summary).toContain("...");
  });

  test("no report means no excerpt", () => {
    expect(summarizePreviousReport(null)).toBe("");
    expect(summarizePreviousReport("   ")).toBe("");
  });
});
