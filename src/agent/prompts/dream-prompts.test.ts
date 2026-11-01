/**
 * Dream prompt contract (F-06 M3 / 46-6-Fix-A W10).
 *
 * The five working manuals are model-facing contract text. Their fixed `## `
 * headings are a code anchor as much as prose — `dream-run-prompt.ts` slices
 * later turns on `## 本轮执行` and `## 检查清单` — and their line budgets keep
 * the first turn of a run at the size the design measured (250–370 lines). The
 * placeholders are filled by the harness, never by the manual.
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

const TIER_MANUAL_ANCHORS = [
  "## 目标与边界",
  "## 工作分级（各档自己的名字）",
  "## 工作流（S1…S5 或等价）",
  "## 检查清单",
  "## 常见陷阱",
  "## 示例",
  "## 本轮执行",
] as const;

const TIER_MANUALS: Record<string, string> = {
  tidy: manualTidy,
  think: manualThink,
  task: manualTask,
  wander: manualWander,
};

describe("dream tier manuals", () => {
  for (const [tier, text] of Object.entries(TIER_MANUALS)) {
    test(`${tier}: every fixed section anchor is present once and in order`, () => {
      const positions = TIER_MANUAL_ANCHORS.map((anchor) => {
        expect(text.split(anchor).length - 1).toBe(1);
        return text.indexOf(anchor);
      });
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    test(`${tier}: the manual has no unfilled placeholder`, () => {
      expect(text).not.toContain("{{");
    });
  }

  test("the line budgets match the design", () => {
    expect(manualLineCount(manualShared)).toBeGreaterThanOrEqual(100);
    expect(manualLineCount(manualShared)).toBeLessThanOrEqual(140);
    expect(manualLineCount(manualTidy)).toBeGreaterThanOrEqual(120);
    expect(manualLineCount(manualTidy)).toBeLessThanOrEqual(180);
    expect(manualLineCount(manualThink)).toBeGreaterThanOrEqual(100);
    expect(manualLineCount(manualThink)).toBeLessThanOrEqual(160);
    expect(manualLineCount(manualTask)).toBeGreaterThanOrEqual(85);
    expect(manualLineCount(manualTask)).toBeLessThanOrEqual(125);
    expect(manualLineCount(manualWander)).toBeGreaterThanOrEqual(85);
    expect(manualLineCount(manualWander)).toBeLessThanOrEqual(125);
  });
});

describe("dream shared manual", () => {
  test("carries its own section anchors", () => {
    for (const anchor of [
      "## 你是谁、这次 run 是什么",
      "## 无人值守的硬规矩",
      "## 工具面",
      "## 提交规范",
      "## 报告模板",
      "## 什么时候停",
      "## 质量自检总则",
      "## 跨 tier 的常见陷阱",
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

  test("carries the report template's nine sections", () => {
    for (const heading of [
      "## 概览",
      "## 工作流与结果",
      "## 改动",
      "## 验收证据",
      "## 下轮计划",
      "## 质量自检",
      "## Parked ideas",
      "## Notes 回应",
      "## 遗留与风险",
    ]) {
      expect(manualShared).toContain(heading);
    }
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
  test("keeps the three states, the confidence rule and the user-only channel", () => {
    for (const pin of [
      "事实",
      "猜想",
      "未解",
      "置信度",
      'roles: ["user"]',
      "≤200",
      "≤10k",
      "梦游数据总结",
      "## 需要商讨",
    ]) {
      expect(manualThink).toContain(pin);
    }
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
