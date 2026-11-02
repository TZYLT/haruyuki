/**
 * T-01 · the pure dream half of the product-status line (47-1 R-01.2–R-01.5,
 * 47-2 §1.1 G-1).
 *
 * The renderer is the seam between the poller and the panel, so this file pins
 * the two things a frame test cannot see through a merged line: the exact
 * duration/percentage formatting, and R-01.4's degradation order (budget
 * percentage → duration → tier → the bare `dreaming` label, then nothing).
 */
import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import {
  DREAM_SEGMENT_SEPARATOR,
  type DreamStatusSnapshot,
  formatDreamBudgetPercent,
  formatDreamElapsedMs,
  renderDreamSegment,
} from "./dream";

function snapshot(
  overrides: Partial<DreamStatusSnapshot> = {},
): DreamStatusSnapshot {
  return {
    runId: "run-1",
    agentId: "agent-1",
    phase: "running",
    tier: "tidy",
    elapsedMs: 12 * 60_000,
    spentTokens: 504,
    budgetTokens: 1200,
    ...overrides,
  };
}

describe("formatDreamElapsedMs", () => {
  test("seconds under a minute, minutes under an hour, then h + m", () => {
    expect(formatDreamElapsedMs(0)).toBe("0s");
    expect(formatDreamElapsedMs(999)).toBe("0s");
    expect(formatDreamElapsedMs(59_000)).toBe("59s");
    expect(formatDreamElapsedMs(60_000)).toBe("1m");
    expect(formatDreamElapsedMs(65_000)).toBe("1m");
    expect(formatDreamElapsedMs(720_000)).toBe("12m");
    expect(formatDreamElapsedMs(90 * 60_000)).toBe("1h 30m");
  });

  test("negative time (a clock that moved backwards) clamps to zero", () => {
    expect(formatDreamElapsedMs(-5_000)).toBe("0s");
  });
});

describe("formatDreamBudgetPercent", () => {
  test("rounds spent/budget and reports over-budget extensions", () => {
    expect(formatDreamBudgetPercent(504, 1200)).toBe("42%");
    expect(formatDreamBudgetPercent(0, 1200)).toBe("0%");
    expect(formatDreamBudgetPercent(1800, 1200)).toBe("150%");
  });

  test("a missing figure or a non-positive budget drops the field", () => {
    expect(formatDreamBudgetPercent(null, 1200)).toBeNull();
    expect(formatDreamBudgetPercent(504, null)).toBeNull();
    expect(formatDreamBudgetPercent(504, 0)).toBeNull();
    expect(formatDreamBudgetPercent(Number.NaN, 1200)).toBeNull();
  });
});

describe("renderDreamSegment", () => {
  test("running: dreaming · tier · elapsed · percentage", () => {
    expect(stripAnsi(renderDreamSegment(snapshot(), 80, "⠋", chalk))).toBe(
      "⠋ dreaming · tidy · 12m · 42%",
    );
  });

  test("done: a tick instead of the spinner, and no percentage", () => {
    const done = snapshot({
      phase: "done",
      endedAtMs: 1_700_000_000_000,
      spentTokens: 504,
    });
    expect(stripAnsi(renderDreamSegment(done, 80, "⠋", chalk))).toBe(
      "✓ dreaming · tidy · 12m",
    );
  });

  test("an empty spinner means the line already carries one (merged reflection)", () => {
    expect(stripAnsi(renderDreamSegment(snapshot(), 80, "", chalk))).toBe(
      "dreaming · tidy · 12m · 42%",
    );
  });

  test("an old lease without tier/spend degrades to what it knows", () => {
    const legacy = snapshot({
      tier: null,
      spentTokens: null,
      budgetTokens: null,
    });
    expect(stripAnsi(renderDreamSegment(legacy, 80, "⠋", chalk))).toBe(
      "⠋ dreaming · 12m",
    );
  });

  test("R-01.4: budget percentage, then duration, then tier, then nothing", () => {
    // Widths are measured on the rendered string; 29 is the full segment
    // (with this spinner frame), 23 its no-percentage form, 17 its
    // no-duration/no-percentage form, 10 the bare `⠋ dreaming`.
    const full = renderDreamSegment(snapshot(), 29, "⠋", chalk);
    expect(stripAnsi(full)).toBe("⠋ dreaming · tidy · 12m · 42%");

    const noPercent = renderDreamSegment(snapshot(), 28, "⠋", chalk);
    expect(stripAnsi(noPercent)).toBe("⠋ dreaming · tidy · 12m");

    const noDuration = renderDreamSegment(snapshot(), 22, "⠋", chalk);
    expect(stripAnsi(noDuration)).toBe("⠋ dreaming · tidy");

    const bare = renderDreamSegment(snapshot(), 16, "⠋", chalk);
    expect(stripAnsi(bare)).toBe("⠋ dreaming");

    // The label alone does not fit: the whole segment gives way.
    expect(renderDreamSegment(snapshot(), 9, "⠋", chalk)).toBe("");
    expect(renderDreamSegment(snapshot(), 0, "⠋", chalk)).toBe("");
  });

  test("done degrades in the same order (duration, then tier, then bare)", () => {
    const done = snapshot({ phase: "done", endedAtMs: 1_700_000_000_000 });
    expect(stripAnsi(renderDreamSegment(done, 23, "⠋", chalk))).toBe(
      "✓ dreaming · tidy · 12m",
    );
    expect(stripAnsi(renderDreamSegment(done, 22, "⠋", chalk))).toBe(
      "✓ dreaming · tidy",
    );
    expect(stripAnsi(renderDreamSegment(done, 16, "⠋", chalk))).toBe(
      "✓ dreaming",
    );
    expect(renderDreamSegment(done, 9, "⠋", chalk)).toBe("");
  });

  test("the separator is exported so the caller can price the merged line", () => {
    expect(DREAM_SEGMENT_SEPARATOR).toBe(" · ");
  });
});
