/**
 * Dream prompt contract (F-06 M3).
 *
 * The templates are model-facing contract text, so their promises must match
 * what the controller actually does: one tier per turn, and `DreamDone` ends the
 * **whole run**. The handoff is carried by the run record and the report — there
 * is no automatic handoff message between runs.
 *
 * The five working manuals (46-6-Fix-A W10) carry fixed `## ` headings that the
 * prompt assembler slices on, so the headings are a code anchor as much as
 * prose. Their line budgets keep the first turn of a run at the size the design
 * measured (250–370 lines), and the placeholders are filled by the harness,
 * never by the manual.
 */
import { describe, expect, test } from "bun:test";
import manualShared from "@/agent/prompts/dream/manual-shared.md";
import manualTask from "@/agent/prompts/dream/manual-task.md";
import manualThink from "@/agent/prompts/dream/manual-think.md";
import manualTidy from "@/agent/prompts/dream/manual-tidy.md";
import manualWander from "@/agent/prompts/dream/manual-wander.md";
import dreamTaskTemplate from "@/agent/prompts/dream-task.md";
import dreamTiersTemplate from "@/agent/prompts/dream-tiers.md";

describe("dream prompt contract", () => {
  test("the first message forbids DreamDone at a tier boundary", () => {
    expect(dreamTaskTemplate).toContain(
      "Each turn handles **exactly one tier**",
    );
    expect(dreamTaskTemplate).toContain(
      "**Do not call `DreamDone` at the end of a turn unless the whole run must stop",
    );
    expect(dreamTaskTemplate).toContain("skips every remaining tier");
    expect(dreamTaskTemplate).not.toContain("{{handoff_from_previous}}");
  });

  test("handoff wording promises a report, not a cross-run message", () => {
    expect(dreamTaskTemplate).toContain(
      "There is no automatic handoff message between runs",
    );
    expect(dreamTaskTemplate).toContain("maintenance/dream-report.md");
    expect(dreamTaskTemplate).not.toContain("next run will read");
    expect(dreamTaskTemplate).not.toContain("next run should start");
  });

  test("the tiers file marks Finishing as whole-run only", () => {
    expect(dreamTiersTemplate).toContain(
      "## Finishing the whole run (not each tier)",
    );
    expect(dreamTiersTemplate).toContain(
      "Do not run this procedure at the end of every tier",
    );
    expect(dreamTiersTemplate).not.toContain("next run should do first");
  });

  test("permission claims are generated, not hardcoded in the templates", () => {
    // F-06: the same template serves a read-only and an `unrestricted` run, so
    // no template may claim a tool surface of its own.
    expect(dreamTaskTemplate).toContain("{{permissions_section}}");
    expect(dreamTaskTemplate).not.toContain("no shell");
    expect(dreamTaskTemplate).not.toContain("No shell");
    expect(dreamTiersTemplate).not.toContain("No shell");
    expect(dreamTiersTemplate).not.toContain("Bash / exec_command are not");
    expect(dreamTiersTemplate).not.toContain("**Permissions:**");
  });

  test("the common unattended rules survive the permission rework", () => {
    for (const template of [dreamTaskTemplate, dreamTiersTemplate]) {
      expect(template).toContain("No user is present");
      expect(template).toContain("memory repository");
    }
    expect(dreamTiersTemplate).toContain("Do not ask questions");
    expect(dreamTiersTemplate).toContain("Commit as you go");
    expect(dreamTiersTemplate).toContain(
      "Do not commit `maintenance/dream-report.md`",
    );
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
