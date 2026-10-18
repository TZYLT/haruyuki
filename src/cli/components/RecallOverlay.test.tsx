/**
 * The `/recall` picker's pure half: the rows it offers and the sub-pickers behind
 * the two enum rows. Rendering is Ink's business; what matters here is that every
 * knob appears exactly once and that the sub-pickers mark the current value, since
 * that marker is the only thing telling the user what they are changing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildDisplayRows,
  buildDiversityRows,
  buildRecallPickerRows,
  RECALL_DISPLAY_ROW_KEY,
  RECALL_DIVERSITY_ROW_KEY,
  RECALL_TOGGLE_ROW_KEY,
  RecallOverlay,
} from "@/cli/components/RecallOverlay";
import { RECALL_SETTING_DEFAULTS } from "@/recall-settings";
import type { Settings } from "@/settings-manager";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

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

/**
 * The overlay's steps and the keys that walk them: the rows open a view of their
 * own, Escape returns to the list from there, and the numeric editor is a real
 * editor (it has the caret and the paste channel the composer has) whose value
 * only reaches `onSave` when the setting's own parser accepts it.
 */
const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";
const HOME = "\u001b[H";

afterEach(resetInkTtyState);

/** A frame's worth of settling, so a key lands on the render before it. */
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Press keys one at a time, letting each frame land.
 *
 * `mountInkTty.press` spaces keys by 30ms; that is enough for a single key and
 * not reliably enough for a *navigation* run, where the key after a cursor move
 * must be answered by the table that move produced. Pressed too close together
 * the same key has been observed to advance the cursor twice — the input
 * router's raw path and Ink's fallback both reading one dispatch — so these
 * tests wait a frame between keys and assert the migration, not the router's
 * timing. (Recorded as a finding in the batch's ledger: it reproduces on
 * pre-batch faces too, and predates this work.)
 */
async function pressKeysSlowly(
  tty: ReturnType<typeof mountInkTty>,
  ...keys: string[]
): Promise<void> {
  for (const key of keys) {
    await tty.press(key);
    await settle();
  }
}

function mountOverlay(): {
  tty: ReturnType<typeof mountInkTty>;
  saved: Partial<Settings>[];
  cancels: string[];
} {
  const saved: Partial<Settings>[] = [];
  const cancels: string[] = [];
  const tty = mountInkTty(
    <RecallOverlay
      settings={RECALL_SETTING_DEFAULTS}
      onSave={(updates) => saved.push(updates)}
      onCancel={() => cancels.push("cancel")}
    />,
    { columns: 90, rows: 30 },
  );
  return { tty, saved, cancels };
}

describe("the overlay's keys", () => {
  test("Escape at the list cancels", async () => {
    const { tty, cancels } = mountOverlay();
    try {
      expect(await tty.text()).toContain("Configure passive recall");
      await pressKeysSlowly(tty, ESC);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });

  test("Enter opens a row's own view, and Escape walks back to the list", async () => {
    const { tty, cancels } = mountOverlay();
    try {
      // Row 1 is the display tier; row 2 is the first numeric knob.
      await pressKeysSlowly(tty, DOWN, ENTER);
      expect(await tty.text()).toContain(
        "How much of a recalled block to show",
      );

      await pressKeysSlowly(tty, ESC);
      let painted = await tty.text();
      expect(painted).toContain("Configure passive recall");
      // A step's Escape is a step back, never a close.
      expect(cancels).toEqual([]);

      // Home first: the picker instance is reused across the step change, so its
      // cursor is wherever the display round trip left it rather than back at the
      // top. (That reuse is the pre-migration behaviour too — the same component
      // type in the same position.)
      await pressKeysSlowly(tty, HOME, DOWN, DOWN, ENTER);
      painted = await tty.text();
      expect(painted).toContain("Passages per turn");
      await pressKeysSlowly(tty, ESC);
      expect((await tty.text()).includes("Configure passive recall")).toBe(
        true,
      );
      expect(cancels).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("the numeric editor saves what the setting's parser accepts", async () => {
    const { tty, saved } = mountOverlay();
    try {
      await pressKeysSlowly(tty, DOWN, DOWN, ENTER);
      expect(await tty.text()).toContain("Passages per turn");

      // The draft opens at the current value with the caret at its end, so the
      // key appends — which is what the hand-rolled field did too.
      await pressKeysSlowly(tty, "7", ENTER);
      expect(saved).toEqual([{ recallLimit: 37 }]);
    } finally {
      tty.stop();
    }
  });

  test("the numeric editor refuses what it cannot parse, and says so", async () => {
    const { tty, saved } = mountOverlay();
    try {
      await pressKeysSlowly(tty, DOWN, DOWN, ENTER);
      await pressKeysSlowly(tty, "x", ENTER);
      const painted = await tty.text();
      expect(painted).toContain("Enter a number the setting accepts.");
      expect(saved).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("Ctrl+C closes the overlay from the editor", async () => {
    const { tty, cancels } = mountOverlay();
    try {
      await pressKeysSlowly(tty, DOWN, DOWN, ENTER);
      expect(await tty.text()).toContain("Passages per turn");
      await tty.press(CTRL_C);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });
});
