/**
 * The `/recall` picker's pure half: the rows it offers and the sub-pickers behind
 * the two enum rows. Rendering is Ink's business; what matters here is that every
 * knob appears exactly once and that the sub-pickers mark the current value, since
 * that marker is the only thing telling the user what they are changing.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDisplayRows,
  buildDiversityRows,
  buildRecallPickerRows,
  RECALL_DISPLAY_ROW_KEY,
  RECALL_DIVERSITY_ROW_KEY,
  RECALL_TOGGLE_ROW_KEY,
} from "@/cli/components/RecallOverlay";
import { RECALL_SETTING_DEFAULTS } from "@/recall-settings";

describe("the picker rows", () => {
  test("names every knob once, in the order a person meets them", () => {
    const rows = buildRecallPickerRows(RECALL_SETTING_DEFAULTS);
    const keys = rows.map((row) => row.key);
    expect(keys[0]).toBe(RECALL_TOGGLE_ROW_KEY);
    expect(keys[1]).toBe(RECALL_DISPLAY_ROW_KEY);
    expect(keys.at(-1)).toBe(RECALL_DIVERSITY_ROW_KEY);
    expect(new Set(keys).size).toBe(keys.length);

    // The seven numeric knobs plus the toggle, the display and the diversity.
    expect(keys).toHaveLength(10);
    for (const key of [
      "recallLimit",
      "recallTimeoutMs",
      "recallDedupTurns",
      "recallExcerptLines",
      "recallExcerptCharacters",
      "recallTotalCharacters",
      "recallMinScoreRatio",
    ]) {
      expect(keys).toContain(key);
    }
  });

  test("shows the current value next to each row", () => {
    const rows = buildRecallPickerRows({
      ...RECALL_SETTING_DEFAULTS,
      limit: 7,
      timeoutMs: 0,
      display: "full",
    });
    const byKey = new Map(rows.map((row) => [row.key, row.description ?? ""]));
    expect(byKey.get("recallLimit")).toContain("7");
    // `0` reads as the setting it is, not as "unset".
    expect(byKey.get("recallTimeoutMs")).toContain("0 ms");
    expect(byKey.get(RECALL_DISPLAY_ROW_KEY)).toContain("full");
  });

  test("the toggle says which way it will go", () => {
    const on = buildRecallPickerRows({
      ...RECALL_SETTING_DEFAULTS,
      enabled: true,
    });
    const off = buildRecallPickerRows({
      ...RECALL_SETTING_DEFAULTS,
      enabled: false,
    });
    expect(on[0]?.description).toContain("Enter to turn off");
    expect(off[0]?.description).toContain("Enter to turn on");
  });
});

describe("the sub-pickers", () => {
  test("mark the current display tier", () => {
    const rows = buildDisplayRows("summary");
    expect(rows.map((row) => row.key)).toEqual(["summary", "silent", "full"]);
    expect(rows.filter((row) => row.isCurrent).map((row) => row.key)).toEqual([
      "summary",
    ]);
    expect(rows.every((row) => (row.description ?? "").length > 0)).toBe(true);
  });

  test("mark the current diversity", () => {
    const rows = buildDiversityRows("file");
    expect(rows.map((row) => row.key)).toEqual(["none", "file", "split"]);
    expect(rows.filter((row) => row.isCurrent).map((row) => row.key)).toEqual([
      "file",
    ]);
  });
});
