/**
 * Dream prompt contract (F-06 M3 / 46-6-Fix-A W10; T-09 P2 anchor update).
 *
 * The five working manuals are model-facing contract text. Their fixed `## `
 * headings are a code anchor as much as prose — `dream-run-prompt.ts` slices
 * later turns on `## This turn` and `## Checklist` — and their line budgets keep
 * the first turn of a run at the size the design measured (250–370 lines). The
 * placeholders are filled by the harness, never by the manual.
 *
 * The report template inside `manual-shared.md` keeps its original headings
 * (mostly Chinese, inside a fenced block); they are pinned as written and are
 * not part of the manual-heading English rework.
 *
 * The retired run-level templates (`dream-task.md`, `dream-tiers.md`) were
 * folded into `manual-shared.md` / the tier manuals in W11 and are deleted;
 * nothing here may reintroduce a second copy of the run-wide rules.
 */
import { describe, expect, test } from "bun:test";
import manualShared from "@/agent/prompts/dream/manual-shared.md";
import manualTask from "@/agent/prompts/dream/manual-task.md";
import manualThink from "@/agent/prompts/dream/manual-think.md";
import manualTidy from "@/agent/prompts/dream/manual-tidy.md";
import manualWander from "@/agent/prompts/dream/manual-wander.md";

const TIER_NAMES = ["tidy", "think", "task", "wander"] as const;
type TierName = (typeof TIER_NAMES)[number];

const TIER_MANUALS: Record<TierName, string> = {
  tidy: manualTidy,
  think: manualThink,
  task: manualTask,
  wander: manualWander,
};

const DREAM_MANUALS: Record<string, string> = {
  shared: manualShared,
  ...TIER_MANUALS,
};

/** Markdown wraps model-facing prose; match it as one line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("dream shared manual · run-wide rules", () => {
  test("the run is one hidden conversation, one tier per turn", () => {
    expect(manualShared).toContain("each turn handles exactly one tier");
    expect(manualShared).toContain("unattended maintenance session");
    expect(manualShared).toContain("The first message carries the run id");
  });

  test("DreamDone ends the whole run, not a tier", () => {
    expect(manualShared).toContain("`DreamDone` ends the **whole run**");
    expect(manualShared).toContain("never at the end of a normal tier");
  });

  test("handoff wording promises a report, not a cross-run message", () => {
    expect(manualShared).toContain("maintenance/dream-report.md");
    expect(manualShared).not.toContain("next run will read");
  });

  test("permission claims are generated, not hardcoded in the manual", () => {
    // The same manual serves a read-only and an `unrestricted` run, so it may
    // not claim a tool surface of its own.
    expect(manualShared).toContain("{{permissions_section}}");
    expect(manualShared).toContain("is authoritative about which of these");
    expect(manualShared).not.toContain("No shell");
    expect(manualShared).not.toContain("Bash / exec_command are not");
  });

  test("the common unattended rules survive the permission rework", () => {
    expect(manualShared).toContain("No user is present");
    expect(manualShared).toContain("memory repository");
    expect(manualShared).toContain("Do not ask questions");
    expect(manualShared).toContain("Commit as you go");
    expect(manualShared).toContain(
      "Do not commit `maintenance/dream-report.md`",
    );
  });

  test("the reminder thresholds match DREAM_BUDGET_THRESHOLDS (40/75/90/100)", () => {
    expect(manualShared).toContain("40 / 75 / 90 / 100 percent");
    expect(manualShared).not.toContain("40 / 80 / 100");
  });
});

/** Lines as an editor counts them: a trailing newline is not a line. */
function manualLineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/**
 * The tier manuals' fixed `## ` headings, in document order. The first two are
 * shared by every tier; the workflow heading names the tier's own steps, and
 * think has one extra section before the checklist.
 */
const TIER_MANUAL_ANCHORS: Record<TierName, readonly string[]> = {
  tidy: [
    "## Goal and boundaries",
    "## Work levels",
    "## Workflow (S0–S4 or equivalent)",
    "## Checklist",
    "## Common traps",
    "## Example",
    "## This turn",
  ],
  think: [
    "## Goal and boundaries",
    "## Work levels",
    "## Workflow (S0–S7 or equivalent)",
    "## Voice and closing",
    "## Checklist",
    "## Common traps",
    "## Example",
    "## This turn",
  ],
  task: [
    "## Goal and boundaries",
    "## Work levels",
    "## Workflow (S0–S5 or equivalent)",
    "## Checklist",
    "## Common traps",
    "## Example",
    "## This turn",
  ],
  wander: [
    "## Goal and boundaries",
    "## Work levels",
    "## Workflow (S0–S5 or equivalent)",
    "## Checklist",
    "## Common traps",
    "## Example",
    "## This turn",
  ],
};

describe("dream tier manuals", () => {
  for (const tier of TIER_NAMES) {
    const text = TIER_MANUALS[tier];
    test(`${tier}: every fixed section anchor is present once and in order`, () => {
      const positions = TIER_MANUAL_ANCHORS[tier].map((anchor) => {
        expect(text.split(anchor).length - 1).toBe(1);
        return text.indexOf(anchor);
      });
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    test(`${tier}: the manual has no unfilled placeholder`, () => {
      expect(text).not.toContain("{{");
    });
  }

  test("every tier manual carries both later-turn anchors exactly once", () => {
    for (const tier of TIER_NAMES) {
      const text = TIER_MANUALS[tier];
      for (const anchor of ["## This turn", "## Checklist"]) {
        expect({ tier, anchor, count: text.split(anchor).length - 1 }).toEqual({
          tier,
          anchor,
          count: 1,
        });
      }
    }
  });

  test("the line budgets match the design", () => {
    expect(manualLineCount(manualShared)).toBeGreaterThanOrEqual(125);
    expect(manualLineCount(manualShared)).toBeLessThanOrEqual(170);
    expect(manualLineCount(manualTidy)).toBeGreaterThanOrEqual(120);
    expect(manualLineCount(manualTidy)).toBeLessThanOrEqual(190);
    expect(manualLineCount(manualThink)).toBeGreaterThanOrEqual(100);
    expect(manualLineCount(manualThink)).toBeLessThanOrEqual(170);
    expect(manualLineCount(manualTask)).toBeGreaterThanOrEqual(85);
    expect(manualLineCount(manualTask)).toBeLessThanOrEqual(125);
    expect(manualLineCount(manualWander)).toBeGreaterThanOrEqual(85);
    expect(manualLineCount(manualWander)).toBeLessThanOrEqual(125);
  });
});

describe("dream shared manual", () => {
  test("carries its own section anchors", () => {
    for (const anchor of [
      "## Who you are and what this run is",
      "## Hard rules for an unattended run",
      "## Tool surface",
      "## Commit rules",
      "## Report template",
      "## When to stop",
      "## Self-check basics",
      "## Cross-tier traps",
    ]) {
      expect(manualShared.split(anchor).length - 1).toBe(1);
    }
  });

  test("the permission section is generated from the placeholder", () => {
    // `buildDreamPermissionSection` emits the `## Permissions in this run`
    // heading itself, so the manual holds the slot rather than a second copy.
    expect(manualShared.split("{{permissions_section}}").length - 1).toBe(1);
    // The heading itself is emitted by `buildDreamPermissionSection`; the
    // manual names it in prose so the contract is visible without duplicating
    // the rendered section.
    expect(manualShared).toContain("## Permissions in this run");
    expect(manualShared.split("{{run_seed}}").length - 1).toBe(1);
    expect(manualShared.match(/\{\{[a-z_]+\}\}/g)?.sort()).toEqual([
      "{{permissions_section}}",
      "{{run_seed}}",
    ]);
  });

  test("keeps the report template's nine headings verbatim, in order", () => {
    // The template is the one place that stays in its original language; it is
    // pinned as written so a formatting rewrite cannot silently change the
    // report the harness commits.
    const match = /```markdown\n([\s\S]*?)```/.exec(manualShared);
    expect(match).not.toBeNull();
    const template = match?.[1] ?? "";
    const headings = [
      "## 概览",
      "## 工作流与结果",
      "## 改动",
      "## 验收证据",
      "## 下轮计划",
      "## 质量自检",
      "## Parked ideas",
      "## Notes 回应",
      "## 遗留与风险",
    ];
    const positions = headings.map((heading) => {
      expect(template).toContain(heading);
      return template.indexOf(heading);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("the commit prefix belongs to the harness, not to the reason", () => {
    expect(manualShared).toContain("Do not write the commit prefix");
    expect(manualShared).toContain("dream(<tier>):");
  });

  test("carries the three cross-tier rules from the design", () => {
    // 1. Language: write in the user's language, not the manual's language.
    expect(manualShared).toContain(
      "Write into memory in the language the user uses with you",
    );
    expect(manualShared).toContain(
      "This manual is in English; that is not a reason to",
    );
    expect(manualShared).toContain("write English into memory");
    expect(manualShared).toContain("Do not mix languages inside one file");
    // 2. Persona: one identity, first person.
    expect(manualShared).toContain("first person");
    expect(manualShared).toContain("same identity, same persona");
    // 3. Core memory's dream rules outrank the manuals, except the layout
    //    invariants, which need the user's confirmation instead.
    expect(manualShared).toContain("follow it over this manual");
    expect(manualShared).toContain("layout invariants");
    expect(manualShared).toContain(
      "refuse, write down why, and wait for the user",
    );
  });

  test("the English-slug naming rule is a soft rule that yields to the user", () => {
    const flat = flatten(manualShared);
    expect(flat).toContain("English ASCII slug by default — a soft rule");
    expect(flat).toContain(
      "a naming requirement from the user or the project wins",
    );
    expect(flat).toContain(
      "Body text, headings and `description` follow the user's working language",
    );
    expect(flat).toContain("A file that already exists keeps the name it has");
  });
});

/**
 * Retired state markers from the old think/wander templates. The report
 * template's own vocabulary is not covered here; this is the memory-content
 * marking scheme the rewrite removed.
 */
const RETIRED_DREAM_MARKERS = /梦游猜想|【事实】|【未解】|置信度|DoD/;

describe("dream manuals · retired vocabulary", () => {
  test("no retired state marker survives in any dream manual", () => {
    const offenders = Object.entries(DREAM_MANUALS)
      .filter(([, text]) => RETIRED_DREAM_MARKERS.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test("the old three-state pins are gone", () => {
    const retiredPins = [
      "事实",
      "猜想",
      "未解",
      "置信度",
      "梦游数据总结",
      "## 需要商讨",
    ];
    const offenders = Object.entries(DREAM_MANUALS).flatMap(([name, text]) =>
      retiredPins
        .filter((pin) => text.includes(pin))
        .map((pin) => `${name}: ${pin}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("tidy manual", () => {
  test("keeps the S0–S4 workflow and its data contracts", () => {
    for (const pin of [
      "### S0",
      "### S1",
      "### S2",
      "### S3",
      "### S4",
      "path | decay | size | note",
      "65%",
      "85%",
      "60k",
      "DreamReviewMark",
      "maintenance/dream-plan.md",
      "still-deferred",
      "letta-memory-layout-policy",
      "[[path]]",
      "[text](path)",
    ]) {
      expect(manualTidy).toContain(pin);
    }
  });
});

describe("think manual", () => {
  test("opens C's scale and subject: event, timeline, people, whole timeline", () => {
    // The synthesis volume is deliberately unbounded in subject and scale; the
    // four cases are the user's approved wording and must survive verbatim.
    const flat = flatten(manualThink);
    for (const pin of [
      "an expanded reflection on one event",
      "a summarized timeline",
      "an organizing of relationships among people",
      "the perspective of the whole timeline and the people in it",
    ]) {
      expect(flat).toContain(pin);
    }
  });

  test("replaces state tags with the modality of the source", () => {
    const flat = flatten(manualThink);
    for (const pin of [
      "Do not tag lines as fact, conjecture or unresolved",
      "do not write confidence scores",
      "*modality of the source*",
      "A quote of someone's opinion stays an opinion",
    ]) {
      expect(flat).toContain(pin);
    }
  });

  test("keeps the user-only conversation channel and its caps", () => {
    for (const pin of [
      'roles: ["user"]',
      "≤200 messages and ≤10k tokens",
      "Strip automatic synthesis",
    ]) {
      expect(manualThink).toContain(pin);
    }
  });

  test("allows a run with no output", () => {
    expect(flatten(manualThink)).toContain(
      "writing nothing is the correct output",
    );
  });
});

describe("task manual", () => {
  test("keeps the single carrier, the required fields and the empty-slot rule", () => {
    for (const pin of [
      "system/authorization.md",
      "authorization.md",
      "quote",
      "expires",
      "Notes are not authorization",
      "at most 2 steps",
      "Do not delete or edit your own authorization entries",
    ]) {
      expect(manualTask).toContain(pin);
    }
  });
});

describe("wander manual", () => {
  test("keeps the semantic entry, the in-place marker and the budget rules", () => {
    for (const pin of [
      "keyword Grep",
      "梦游漫游",
      "1–2 directions",
      "≤3 items",
      "≤5 lines",
      "less than 5k tokens",
    ]) {
      expect(manualWander).toContain(pin);
    }
  });
});
