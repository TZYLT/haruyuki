/**
 * Dream prompt/permission contract (F-06).
 *
 * The same templates serve all three dream permission tiers, so the permission
 * text must be generated from `permissionMode` and must match what the
 * permission layer actually does. These cases pin the three tier sections, the
 * abuse constraint on `unrestricted`, and the common unattended rules that must
 * survive every tier.
 */
import { describe, expect, test } from "bun:test";
import { DreamBudgetTracker } from "@/agent/dream/dream-budget";
import {
  buildDreamPermissionSection,
  buildFirstDreamTurnPrompt,
  buildNextDreamTurnPrompt,
  type DreamPromptRunInfo,
} from "@/agent/dream/dream-run-prompt";
import type { PermissionTier } from "@/cron/cron-types";

const MODES: readonly PermissionTier[] = [
  "standard",
  "acceptEdits",
  "unrestricted",
];

function tracker(): DreamBudgetTracker {
  return new DreamBudgetTracker({
    budgetTokens: 10_000,
    overBudgetApprovals: 1,
  });
}

function runInfo(mode: PermissionTier): DreamPromptRunInfo {
  return {
    runId: "run-1",
    baselineSha: "baseline-sha",
    budgetTokens: 10_000,
    timeLimitMinutes: null,
    tierPlan: ["tidy", "think"],
    tier: "tidy",
    tierIndex: 0,
    tierCount: 2,
    permissionMode: mode,
  };
}

function firstPrompt(mode: PermissionTier): string {
  return buildFirstDreamTurnPrompt({
    ...runInfo(mode),
    tracker: tracker(),
  });
}

describe("dream permission section", () => {
  test("standard is read-only and says writes are rejected", () => {
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
  });

  test("acceptEdits grants memory writes and denies shell/network", () => {
    const text = buildDreamPermissionSection("acceptEdits");
    expect(text).toContain("Permission tier: `acceptEdits` (memory writes)");
    expect(text).toContain("`Write`, `Edit`, `MemoryCommit`");
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

describe("dream turn prompts", () => {
  test("the first message injects exactly one generated permission section", () => {
    for (const mode of MODES) {
      const prompt = firstPrompt(mode);
      expect(prompt).toContain("## Permissions in this run");
      expect(prompt).toContain(`Permission tier: \`${mode}\``);
      // Only the injected section is a heading; the templates refer to it by
      // name inline, so match the heading at the start of a line.
      expect(prompt.match(/^## Permissions in this run$/gm)).toHaveLength(1);
      expect(prompt).not.toContain("{{");
    }
  });

  test("the first message keeps the run-wide dream rules", () => {
    const prompt = firstPrompt("acceptEdits");
    expect(prompt).toContain("You are a **dream run**");
    expect(prompt).toContain("Each turn handles **exactly one tier**");
    expect(prompt).toContain(
      "**Do not call `DreamDone` at the end of a turn unless the whole run must stop",
    );
    expect(prompt).toContain(
      "There is no automatic handoff message between runs",
    );
    expect(prompt).toContain("Commit small");
    expect(prompt).toContain("maintenance/dream-report.md");
    expect(prompt).toContain("## This turn");
    expect(prompt).toContain("tidy");
  });

  test("later turns restate the tier-specific permission briefly", () => {
    const standard = buildNextDreamTurnPrompt({
      ...runInfo("standard"),
      tracker: tracker(),
      reminders: [],
    });
    expect(standard).toContain("Permission tier `standard` (read-only)");
    expect(standard).toContain("`Write` and `Edit` are rejected");

    const acceptEdits = buildNextDreamTurnPrompt({
      ...runInfo("acceptEdits"),
      tracker: tracker(),
      reminders: [],
    });
    expect(acceptEdits).toContain("Permission tier `acceptEdits`");
    expect(acceptEdits).toContain("shell and network are unavailable");

    const unrestricted = buildNextDreamTurnPrompt({
      ...runInfo("unrestricted"),
      tracker: tracker(),
      reminders: [],
    });
    expect(unrestricted).toContain("Permission tier `unrestricted`");
    expect(unrestricted).toContain("never for convenience");
    // The short turn keeps the report / DreamDone contract.
    expect(unrestricted).toContain("Call DreamDone only when the whole run");
    expect(unrestricted).toContain("what changed, why, what is left");
  });
});
