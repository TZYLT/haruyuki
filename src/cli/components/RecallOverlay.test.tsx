/**
 * The `/recall` picker's pure half: the rows it offers and the sub-pickers behind
 * the two enum rows. Rendering is Ink's business; what matters here is that every
 * knob appears exactly once and that the sub-pickers mark the current value, since
 * that marker is the only thing telling the user what they are changing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EMBEDDING_CONFIG_KEYS } from "@/cli/commands/embedding-command-parser";
import {
  buildDisplayRows,
  buildDiversityRows,
  buildEmbeddingBuildRows,
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
  type ResolvedEmbeddingSettings,
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

    // The nine numeric knobs (seven lexical, then the two vector-only ones),
    // plus the toggle, display, embedding block and diversity.
    expect(keys).toHaveLength(13);
    expect(keys).toContain(RECALL_EMBEDDING_ROW_KEY);
    for (const key of [
      "recallLimit",
      "recallTimeoutMs",
      "recallDedupTurns",
      "recallExcerptLines",
      "recallExcerptCharacters",
      "recallTotalCharacters",
      "recallMinScoreRatio",
      "recallEmbeddingWeight",
      "recallEmbeddingCandidateDepth",
    ]) {
      expect(keys).toContain(key);
    }
  });

  test("shows the current value next to each row", () => {
    const rows = buildRecallPickerRows(
      {
        ...RECALL_SETTING_DEFAULTS,
        limit: 7,
        timeoutMs: 0,
        display: "full",
      },
      { ...EMBEDDING_SETTING_DEFAULTS, weight: 0.25, candidateDepth: 12 },
    );
    const byKey = new Map(rows.map((row) => [row.key, row.description ?? ""]));
    expect(byKey.get("recallLimit")).toContain("7");
    // `0` reads as the setting it is, not as "unset".
    expect(byKey.get("recallTimeoutMs")).toContain("0 ms");
    expect(byKey.get(RECALL_DISPLAY_ROW_KEY)).toContain("full");
    // The vector-only knobs come from the embedding record, not the recall one.
    expect(byKey.get("recallEmbeddingWeight")).toContain("0.25");
    expect(byKey.get("recallEmbeddingCandidateDepth")).toContain("12");
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
      "reset",
      "connect",
      "model",
      "build-settings",
    ]);
    expect(on[0]?.label).toContain("off");
    expect(on[0]?.description).toContain("builtin");

    const off = buildEmbeddingRows({
      ...EMBEDDING_SETTING_DEFAULTS,
      enabled: false,
    });
    expect(off[0]?.label).toContain("on");
  });

  test("the build-settings row says what it edits", () => {
    const rows = buildEmbeddingRows(EMBEDDING_SETTING_DEFAULTS);
    const row = rows.find((item) => item.key === "build-settings");
    expect(row?.label).toBe("Build settings");
    expect(row?.description).toContain("chunk window");
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

describe("the build-settings page", () => {
  test("lists the six keys with the values the config table prints", () => {
    const rows = buildEmbeddingBuildRows({
      ...EMBEDDING_SETTING_DEFAULTS,
      chunkTarget: 256,
      chunkMax: 1_024,
      chunkOverlap: 32,
      maxChunksPerMessage: 4,
      threads: 0,
      gpu: "off",
    });
    expect(rows.map((row) => row.key)).toEqual([...EMBEDDING_CONFIG_KEYS]);
    const byKey = new Map(rows.map((row) => [row.key, row.description ?? ""]));
    expect(byKey.get("chunk-target")).toContain("256 tokens (new space)");
    expect(byKey.get("chunk-max")).toContain("1024 tokens (new space)");
    expect(byKey.get("max-chunks")).toContain("4 /message (new space)");
    expect(byKey.get("threads")).toContain("auto");
    expect(byKey.get("gpu")).toContain("off");
    expect(rows.every((row) => (row.description ?? "").length > 0)).toBe(true);
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

/** `count` cursor-down presses: the rows are a list, so a test counts them. */
function downs(count: number): string[] {
  return Array.from({ length: count }, () => DOWN);
}

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
      // The block sits after the nine numeric rows, plus the toggle at 0 and
      // display at 1: `list` index 11.
      await pressKeysSlowly(tty, HOME, ...downs(11), ENTER);
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
      // Toggle, display, nine numbers → embedding (index 11); then toggle,
      // status, build, reset, connect → model (index 5).
      await pressKeysSlowly(tty, HOME, ...downs(11), ENTER);
      expect(await tty.text()).toContain("Turn vector recall off");
      await pressKeysSlowly(tty, HOME, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
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

  test("the vector-weight row reads the embedding record and writes its key", async () => {
    const { tty, saved } = mountOverlay({
      embeddingSettings: {
        ...EMBEDDING_SETTING_DEFAULTS,
        weight: 0.5,
        candidateDepth: 50,
      },
    });
    try {
      // Toggle, display, seven lexical knobs → row 9 is the weight.
      await pressKeysSlowly(tty, HOME, ...downs(9), ENTER);
      expect(await tty.text()).toContain("Vector arm weight");
      // The draft opens at 0.5, so one key appends to it.
      await pressKeysSlowly(tty, "4", ENTER);
      expect(saved).toEqual([{ recallEmbeddingWeight: 0.54 }]);
    } finally {
      tty.stop();
    }
  });

  test("the candidate-depth row accepts a whole number", async () => {
    const { tty, saved } = mountOverlay({
      embeddingSettings: {
        ...EMBEDDING_SETTING_DEFAULTS,
        weight: 0.5,
        candidateDepth: 50,
      },
    });
    try {
      await pressKeysSlowly(tty, HOME, ...downs(10), ENTER);
      expect(await tty.text()).toContain("Vector candidate depth");
      await pressKeysSlowly(tty, "0", ENTER);
      expect(saved).toEqual([{ recallEmbeddingCandidateDepth: 500 }]);
    } finally {
      tty.stop();
    }
  });
});

/**
 * The build-keys page (48-4 D-16): six rows read from the embedding record, one
 * editor per key, the write goes through `/recall embedding config <key>
 * <value>`, and a refusal is the handler's own sentence rather than a second
 * message the typed command would not say.
 */
describe("the build-settings page keys", () => {
  test("a direct landing lists the six keys and their values", async () => {
    const { tty } = mountOverlay({
      initialPage: "embedding-build",
      embeddingSettings: {
        ...EMBEDDING_SETTING_DEFAULTS,
        chunkTarget: 256,
        threads: 0,
      },
    });
    try {
      const painted = await tty.text();
      expect(painted).toContain("Build settings");
      expect(painted).toContain("chunk-target");
      expect(painted).toContain("256 tokens (new space)");
      expect(painted).toContain("threads");
      expect(painted).toContain("auto");
    } finally {
      tty.stop();
    }
  });

  test("a saved value goes through the command and the page re-reads it", async () => {
    const calls: string[][] = [];
    let current: ResolvedEmbeddingSettings = {
      ...EMBEDDING_SETTING_DEFAULTS,
      chunkTarget: 256,
    };
    const { tty } = mountOverlay({
      initialPage: "embedding-build",
      embeddingSettings: current,
      reloadEmbeddingSettings: () => current,
      runEmbeddingCommand: async (args) => {
        calls.push(args);
        current = { ...current, chunkTarget: Number(args[2]) };
        return `Updated ${args[1]}.\n  target ${args[2]} tokens`;
      },
    });
    try {
      // The first row is `chunk-target`.
      await pressKeysSlowly(tty, ENTER);
      expect(await tty.text()).toContain("Config · chunk-target");

      // The draft opens at the current value (256), so the key appends.
      await pressKeysSlowly(tty, "0", ENTER);
      await settle();
      expect(calls).toEqual([["config", "chunk-target", "2560"]]);
      expect(await tty.text()).toContain("Updated chunk-target.");

      // Escape walks back to the page, which now reads the refreshed settings.
      await pressKeysSlowly(tty, ESC);
      const refreshed = await tty.text();
      expect(refreshed).toContain("Build settings");
      expect(refreshed).toContain("2560 tokens (new space)");
    } finally {
      tty.stop();
    }
  });

  test("a refused value stays in the editor with the handler's sentence", async () => {
    let reloads = 0;
    const { tty } = mountOverlay({
      initialPage: "embedding-build",
      embeddingSettings: { ...EMBEDDING_SETTING_DEFAULTS, chunkTarget: 256 },
      reloadEmbeddingSettings: () => {
        reloads += 1;
        return EMBEDDING_SETTING_DEFAULTS;
      },
      runEmbeddingCommand: async () =>
        "Not saved: chunk target must be between 1 and 4096.",
    });
    try {
      await pressKeysSlowly(tty, ENTER);
      expect(await tty.text()).toContain("Config · chunk-target");
      await pressKeysSlowly(tty, "x", ENTER);
      await settle();
      const painted = await tty.text();
      expect(painted).toContain(
        "Not saved: chunk target must be between 1 and 4096.",
      );
      // Still the editor, and nothing was re-read: the write did not happen.
      expect(painted).toContain("Config · chunk-target");
      expect(reloads).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("a parser syntax error keeps the editor open as well", async () => {
    let reloads = 0;
    const { tty } = mountOverlay({
      initialPage: "embedding-build",
      embeddingSettings: { ...EMBEDDING_SETTING_DEFAULTS, chunkTarget: 256 },
      reloadEmbeddingSettings: () => {
        reloads += 1;
        return EMBEDDING_SETTING_DEFAULTS;
      },
      runEmbeddingCommand: async () =>
        "`/recall embedding config chunk-target` needs a whole number: /recall embedding config chunk-target <n>.\n\nUSAGE",
    });
    try {
      await pressKeysSlowly(tty, ENTER);
      expect(await tty.text()).toContain("Config · chunk-target");
      await pressKeysSlowly(tty, "x", ENTER);
      await settle();
      const painted = await tty.text();
      // The parser's message is a refusal too: the editor keeps it and no
      // settings re-read happens, exactly like the validator's "Not saved".
      expect(painted).toContain("needs a whole number");
      expect(painted).toContain("Config · chunk-target");
      expect(reloads).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("Escape from the editor returns to the page; at the root it closes", async () => {
    const { tty, cancels } = mountOverlay({
      initialPage: "embedding-build",
      embeddingSettings: EMBEDDING_SETTING_DEFAULTS,
    });
    try {
      await pressKeysSlowly(tty, ENTER);
      expect(await tty.text()).toContain("Config · chunk-target");
      await pressKeysSlowly(tty, ESC);
      expect(await tty.text()).toContain("chunk-target");
      expect(cancels).toEqual([]);

      // The page was raised as the root, so Escape there is the close.
      await pressKeysSlowly(tty, ESC);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });

  test("the block's row opens the page and Escape returns to the block", async () => {
    const { tty, cancels } = mountOverlay({
      embeddingSettings: EMBEDDING_SETTING_DEFAULTS,
      runEmbeddingCommand: async (args) => `RESULT:${args.join(" ")}`,
    });
    try {
      await pressKeysSlowly(tty, HOME, ...downs(11), ENTER);
      expect(await tty.text()).toContain("Turn vector recall on");

      // The block's rows: toggle, status, build, reset, connect, model, settings.
      await pressKeysSlowly(tty, HOME, ...downs(6), ENTER);
      expect(await tty.text()).toContain("chunk-target");

      await pressKeysSlowly(tty, ESC);
      const painted = await tty.text();
      expect(painted).toContain("Turn vector recall on");
      expect(cancels).toEqual([]);
    } finally {
      tty.stop();
    }
  });
});
