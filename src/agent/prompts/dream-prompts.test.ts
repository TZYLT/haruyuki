/**
 * Dream prompt contract (F-06 M3).
 *
 * The templates are model-facing contract text, so their promises must match
 * what the controller actually does: one tier per turn, and `DreamDone` ends the
 * **whole run**. The handoff is carried by the run record and the report — there
 * is no automatic handoff message between runs.
 */
import { describe, expect, test } from "bun:test";
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
});
