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
  buildEmbeddingRows,
  buildRecallPickerRows,
  RECALL_DISPLAY_ROW_KEY,
  RECALL_DIVERSITY_ROW_KEY,
  RECALL_EMBEDDING_ROW_KEY,
  RECALL_TOGGLE_ROW_KEY,
  RecallOverlay,
  type RecallOverlayProps,
} from "@/cli/components/RecallOverlay";
import type { EmbeddingModelRow } from "@/cli/helpers/embedding-models";
import {
  EMBEDDING_SETTING_DEFAULTS,
  RECALL_SETTING_DEFAULTS,
} from "@/recall-settings";
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

    // The seven numeric knobs plus the toggle, display, embedding block and
    // diversity.
    expect(keys).toHaveLength(11);
    expect(keys).toContain(RECALL_EMBEDDING_ROW_KEY);
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

describe("the embedding block", () => {
  test("offers the action set and names the direction of the toggle", () => {
    const on = buildEmbeddingRows({
      ...EMBEDDING_SETTING_DEFAULTS,
      enabled: true,
    });
    expect(on.map((row) => row.key)).toEqual([
      "toggle",
      "status",
      "build",
      "connect",
      "model",
    ]);
    expect(on[0]?.label).toContain("off");
    expect(on[0]?.description).toContain("builtin");

    const off = buildEmbeddingRows({
      ...EMBEDDING_SETTING_DEFAULTS,
      enabled: false,
    });
    expect(off[0]?.label).toContain("on");
  });

  test("the picker row shows whether the vector arm is on", () => {
    const rows = buildRecallPickerRows(RECALL_SETTING_DEFAULTS, {
      ...EMBEDDING_SETTING_DEFAULTS,
      enabled: true,
      model: "bge-small-zh-v1.5",
    });
    const row = rows.find((item) => item.key === RECALL_EMBEDDING_ROW_KEY);
    expect(row?.description).toContain("on ·");
    expect(row?.description).toContain("bge-small-zh-v1.5");
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

function mountOverlay(overrides: Partial<RecallOverlayProps> = {}): {
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
      {...overrides}
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

  test("the embedding block runs the command and shows its receipt", async () => {
    const calls: string[][] = [];
    const { tty } = mountOverlay({
      embeddingSettings: { ...EMBEDDING_SETTING_DEFAULTS, enabled: false },
      agentId: "agent-1",
      conversationId: "conv-1",
      runEmbeddingCommand: async (args) => {
        calls.push(args);
        return `RESULT:${args.join(" ")}`;
      },
    });
    try {
      // The block sits after the seven numeric rows (toggle, display = 0..1).
      await pressKeysSlowly(
        tty,
        HOME,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        ENTER,
      );
      expect(await tty.text()).toContain("Turn vector recall on");

      // The sub-picker reuses the list's picker instance, so its cursor is
      // wherever the list left it; Home pins the first action before moving.
      await pressKeysSlowly(tty, HOME, DOWN, ENTER);
      expect(await tty.text()).toContain("RESULT:status");
      expect(calls).toEqual([["status"]]);

      // Escape walks back to the block, not out of the overlay.
      await pressKeysSlowly(tty, ESC);
      expect(await tty.text()).toContain("Index status");
    } finally {
      tty.stop();
    }
  });

  test("the model row opens the picker and Enter/D/P run the command", async () => {
    const calls: string[][] = [];
    const rows: EmbeddingModelRow[] = [
      {
        index: 1,
        spaceId: "space-1",
        model: "bge-m3",
        dimensions: 1024,
        quantization: "int8",
        chunks: 5_618,
        builtAt: "2026-11-05T10:00:00.000Z",
        bytes: 23 * 1024 * 1024,
        active: false,
        pinned: false,
        legacy: false,
      },
      {
        index: 2,
        spaceId: "space-2",
        model: "bge-small-zh-v1.5",
        dimensions: 512,
        quantization: "float32",
        chunks: 1_200,
        builtAt: null,
        bytes: null,
        active: true,
        pinned: true,
        legacy: false,
      },
    ];
    const { tty } = mountOverlay({
      embeddingSettings: { ...EMBEDDING_SETTING_DEFAULTS, enabled: true },
      agentId: "agent-1",
      runEmbeddingCommand: async (args) => {
        calls.push(args);
        return `RESULT:${args.join(" ")}`;
      },
      loadEmbeddingModels: async () => rows,
    });
    try {
      // Toggle, display, seven numbers → embedding; then toggle, status, build,
      // connect → model.
      await pressKeysSlowly(
        tty,
        HOME,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        ENTER,
      );
      expect(await tty.text()).toContain("Turn vector recall off");
      await pressKeysSlowly(tty, HOME, DOWN, DOWN, DOWN, DOWN, ENTER);
      const frame = await tty.text();
      expect(frame).toContain("Stored vector models");
      expect(frame).toContain("#1 bge-m3");
      expect(frame).toContain("D delete");

      await pressKeysSlowly(tty, ENTER);
      await settle();
      expect(calls).toEqual([["model", "--select", "1"]]);

      await pressKeysSlowly(tty, "p");
      await settle();
      expect(calls.at(-1)).toEqual(["model", "--pin", "1"]);

      // D previews once; the second D confirms. Nothing is deleted before it.
      await pressKeysSlowly(tty, "d");
      expect(calls.filter((args) => args[1] === "--delete")).toHaveLength(0);
      expect(await tty.text()).toContain("Press D again");
      await pressKeysSlowly(tty, "d");
      await settle();
      expect(calls.at(-1)).toEqual(["model", "--delete", "1", "--confirm"]);
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
