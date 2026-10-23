import { describe, expect, test } from "bun:test";
import { isExperimentsSelectorRequest } from "./experiments-command";

/**
 * `/experiments` and its one sub-command.
 *
 * The reported defect (2026-10-23) was a receipt without an action:
 * `/experiments ui_v2` printed "Opening experiments selector..." and opened
 * nothing, because the handler matched only the bare command and the rest fell
 * through to the registry. The selector is where the `ui_v2` switch lives, so the
 * input that names it opens the selector; `diffs` keeps its own face.
 */
describe("isExperimentsSelectorRequest", () => {
  test("the bare command opens the selector", () => {
    expect(isExperimentsSelectorRequest("/experiments")).toBe(true);
  });

  test("an experiment name opens it too", () => {
    // The exact input from the report.
    expect(isExperimentsSelectorRequest("/experiments ui_v2")).toBe(true);
    expect(isExperimentsSelectorRequest("/experiments  ui_v2")).toBe(true);
    expect(isExperimentsSelectorRequest("/experiments ui_v2 on")).toBe(true);
  });

  test("diffs is not the selector", () => {
    expect(isExperimentsSelectorRequest("/experiments diffs")).toBe(false);
    expect(isExperimentsSelectorRequest("/experiments diffs src/cli")).toBe(
      false,
    );
  });

  test("anything else is not this command", () => {
    expect(isExperimentsSelectorRequest("/help")).toBe(false);
    expect(isExperimentsSelectorRequest("/experimentsx")).toBe(false);
    expect(isExperimentsSelectorRequest("experiments")).toBe(false);
  });
});
