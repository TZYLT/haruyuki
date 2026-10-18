/**
 * D-108: `/compaction` offers only what the local backend can run, and shows the
 * compression rate that `sliding_window` depends on.
 *
 * The rate is a real setting (every `/compact` compresses that fraction of the
 * transcript), so the overlay also lets the user change it — rows are built by
 * pure functions and asserted here, and the mount suite at the end covers what
 * pure functions cannot see.
 *
 * That suite is on the frame, and it walks the keys. Both halves were missing: the
 * overlay is a two-step wizard (a picker, then the rate editor) whose only mount
 * test asserted on Ink's *chunk stream* — which re-asserts Ink's own diffing
 * rather than what is on screen — and pressed nothing, so "Enter on the rate row
 * opens the editor", "Escape goes back a step instead of closing", and "the typed
 * percent is what gets saved" had no coverage at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  buildCompactionModeItems,
  buildCompactionPickerRows,
  COMPRESSION_RATE_ROW_KEY,
  type CompactionSelection,
  CompactionSelector,
  compressionPercentageFor,
  compressionPercentFor,
  parseCompressionRateInput,
} from "@/cli/components/CompactionSelector";
import {
  assertCompactionModeForBackend,
  availableCompactionModes,
  isCompactionMode,
} from "@/cli/helpers/compaction-mode";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

describe("availableCompactionModes", () => {
  test("offers sliding_window only", () => {
    expect(availableCompactionModes()).toEqual(["sliding_window"]);
  });
});

describe("assertCompactionModeForBackend", () => {
  test("accepts sliding_window", () => {
    expect(assertCompactionModeForBackend("sliding_window")).toBe(
      "sliding_window",
    );
  });

  test("rejects a mode this backend cannot run", () => {
    expect(() => assertCompactionModeForBackend("all")).toThrow(
      'only runs the "sliding_window" compaction mode',
    );
    expect(() => assertCompactionModeForBackend("self_compact_all")).toThrow();
  });

  test("rejects an unknown mode", () => {
    expect(() => assertCompactionModeForBackend("bogus")).toThrow(
      "Unknown compaction mode",
    );
    expect(isCompactionMode("bogus")).toBe(false);
  });
});

describe("buildCompactionModeItems", () => {
  test("renders one row locally, with the compression rate", () => {
    const items = buildCompactionModeItems({
      modes: ["sliding_window"],
      currentMode: "sliding_window",
      compressionPercentage: 0.3,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("Sliding Window");
    expect(items[0]?.description).toContain("Compresses about 30%");
    expect(items[0]?.description).toContain("keeps about 70%");
    expect(items[0]?.isCurrent).toBe(true);
  });

  test("renders every mode it is given", () => {
    const items = buildCompactionModeItems({
      modes: [
        "all",
        "sliding_window",
        "self_compact_all",
        "self_compact_sliding_window",
      ],
      currentMode: "all",
      compressionPercentage: 0.3,
    });
    expect(items.map((item) => item.key)).toEqual([
      "all",
      "sliding_window",
      "self_compact_all",
      "self_compact_sliding_window",
    ]);
    expect(items.filter((item) => item.isCurrent)).toHaveLength(1);
    // Only the sliding-window row explains the compression rate.
    expect(items[0]?.description).not.toContain("Compresses");
  });

  test("rounds a custom rate for display", () => {
    const items = buildCompactionModeItems({
      modes: ["sliding_window"],
      currentMode: "sliding_window",
      compressionPercentage: 0.45,
    });
    expect(items[0]?.description).toContain("Compresses about 45%");
    expect(items[0]?.description).toContain("keeps about 55%");
  });
});

describe("buildCompactionPickerRows", () => {
  test("appends the rate editor after the modes, keeping the cursor on the mode", () => {
    const rows = buildCompactionPickerRows({
      modes: ["sliding_window"],
      currentMode: "sliding_window",
      compressionPercentage: 0.3,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).toBe("sliding_window");
    expect(rows[1]?.key).toBe(COMPRESSION_RATE_ROW_KEY);
    // The editor row is not the current *mode*, so it must not claim "(current)".
    expect(rows[1]?.isCurrent).toBe(false);
    // It still has to state the value it would change.
    expect(rows[1]?.label).toBe("Compression rate");
    expect(rows[1]?.description).toContain("Compresses about 30%");
    expect(rows[1]?.description).toContain("keeps about 70%");
    expect(rows[1]?.description).toContain("Enter to change it");
  });
});

describe("parseCompressionRateInput", () => {
  test("accepts a whole percent and stores it as a fraction", () => {
    expect(parseCompressionRateInput("30")).toEqual({
      ok: true,
      percentage: 0.3,
    });
    expect(parseCompressionRateInput(" 5 ")).toEqual({
      ok: true,
      percentage: 0.05,
    });
    // People type the sign.
    expect(parseCompressionRateInput("70%")).toEqual({
      ok: true,
      percentage: 0.7,
    });
    expect(parseCompressionRateInput("1")).toEqual({
      ok: true,
      percentage: 0.01,
    });
    expect(parseCompressionRateInput("100")).toEqual({
      ok: true,
      percentage: 1,
    });
  });

  test("rejects what the backend would otherwise silently clamp", () => {
    // ≤0 would become 0.1 and >1 would become 1 in the store, so the editor
    // refuses them instead of showing a value the user never asked for.
    for (const bad of ["0", "-10", "101", "0.5", "abc", "", "   ", "%"]) {
      const result = parseCompressionRateInput(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0);
      }
    }
    const zero = parseCompressionRateInput("0");
    expect(zero.ok === false && zero.error).toContain("1 to 100");
    const decimal = parseCompressionRateInput("0.5");
    expect(decimal.ok === false && decimal.error).toContain("whole number");
  });
});

describe("compressionPercentFor", () => {
  test("rounds the stored fraction to the percent the UI shows", () => {
    expect(compressionPercentFor(0.3)).toBe(30);
    expect(compressionPercentFor(0.456)).toBe(46);
    expect(compressionPercentFor(1)).toBe(100);
  });
});

describe("compressionPercentageFor", () => {
  test("uses the configured rate, falling back to the backend default", () => {
    expect(compressionPercentageFor({ sliding_window_percentage: 0.5 })).toBe(
      0.5,
    );
    expect(compressionPercentageFor({})).toBe(0.3);
    expect(compressionPercentageFor(null)).toBe(0.3);
    expect(compressionPercentageFor(undefined)).toBe(0.3);
  });
});

const DOWN = "\u001b[B";
const ENTER = "\r";
const ESCAPE = "\u001b";
const BACKSPACE = "\u007f";
const CTRL_C = "\u0003";

const RULE_100 = "─".repeat(100);
const RULE_60 = "─".repeat(60);

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(resetInkTtyState);

function mountSelector(options: {
  columns?: number;
  settings?: AgentState["compaction_settings"];
  onSave?: (selection: CompactionSelection) => void;
  onCancel?: () => void;
}): InkTty {
  return mountInkTty(
    <CompactionSelector
      settings={
        options.settings ?? {
          mode: "sliding_window",
          sliding_window_percentage: 0.3,
        }
      }
      onSave={options.onSave ?? (() => {})}
      onCancel={options.onCancel ?? (() => {})}
    />,
    { columns: options.columns ?? 100, rows: 40 },
  );
}

/** `↓` onto the rate row and `Enter` into the second step. */
async function openRateEditor(tty: InkTty): Promise<void> {
  await tty.press(DOWN);
  await tty.press(ENTER);
  await settle();
}

describe("CompactionSelector on the frame", () => {
  test("the picker opens on the current mode and lists the rate row last", async () => {
    // The `>` marker is the only on-screen carrier of the cursor: the item's own
    // colour is invisible in a frame (docs/37 §8 item 14). It is also what makes
    // "the last row edits the rate" checkable — that row must not be the cursor's
    // start and must not claim `(current)`, because it is not a mode.
    const tty = mountSelector({});
    try {
      expect(await tty.rows()).toEqual([
        "> /compaction",
        RULE_100,
        "",
        "Configure compaction mode",
        "",
        ">Sliding Window       · Compact older messages to stay within a token limit. Compresses about 30% of",
        " (current)            the conversation each time (keeps about 70%).",
        "  Compression rate · Compresses about 30% each time (keeps about 70%). Enter to change it.",
        " Enter select · ↑↓/jk navigate · Esc cancel · the last row edits the compression rate",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("the cursor moves onto the rate row", async () => {
    const tty = mountSelector({});
    try {
      await tty.press(DOWN);
      const rows = await tty.rows();

      // Only the marker moved: the rate row is the tail of the picker, and the
      // frame keeps its shape while the cursor walks between the two rows.
      expect(rows[5]?.startsWith(" Sliding Window")).toBe(true);
      expect(rows[6]?.trimStart()).toStartWith("(current)");
      expect(rows[7]?.startsWith("> Compression rate ·")).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("Enter on the rate row opens the editor", async () => {
    const tty = mountSelector({});
    try {
      await openRateEditor(tty);

      expect(await tty.rows()).toEqual([
        "> /compaction",
        RULE_100,
        "",
        "Compression rate",
        "",
        "Compress what percent of the conversation on each /compact? Currently 30% (keeps 70%).",
        "",
        "> 30",
        "",
        "Enter to save (1-100) · Esc back · Ctrl-C cancel",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("Enter on a mode row saves the mode alone", async () => {
    const saved: CompactionSelection[] = [];
    const tty = mountSelector({ onSave: (selection) => saved.push(selection) });
    try {
      await tty.press(ENTER);
      await settle();

      // No `compressionPercentage` key at all: picking a mode has always meant
      // "leave the stored rate alone", and an explicit `undefined` would be a
      // different thing to whoever writes it back.
      expect(saved).toEqual([{ mode: "sliding_window" }]);
      expect("compressionPercentage" in (saved[0] ?? {})).toBe(false);
    } finally {
      tty.stop();
    }
  });

  test("the editor saves the percent the user typed", async () => {
    const saved: CompactionSelection[] = [];
    const tty = mountSelector({ onSave: (selection) => saved.push(selection) });
    try {
      await openRateEditor(tty);
      // The field opens pre-filled with the stored rate and the caret at its end,
      // so a new value is typed over it rather than appended to it.
      await tty.press(BACKSPACE, BACKSPACE, "4", "5");
      expect((await tty.rows())[7]).toBe("> 45");

      await tty.press(ENTER);
      await settle();

      expect(saved).toEqual([
        { mode: "sliding_window", compressionPercentage: 0.45 },
      ]);
    } finally {
      tty.stop();
    }
  });

  test("a rate the store would silently clamp is refused on screen", async () => {
    const saved: CompactionSelection[] = [];
    const tty = mountSelector({ onSave: (selection) => saved.push(selection) });
    try {
      await openRateEditor(tty);
      await tty.press(BACKSPACE, BACKSPACE, "1", "0", "1");
      await tty.press(ENTER);
      await settle();

      // The editor stays open with the value still typed and the reason under it.
      // The alternative — letting it through — is what the backend turns into `1`
      // without telling anyone.
      expect(saved).toEqual([]);
      expect(await tty.rows()).toEqual([
        "> /compaction",
        RULE_100,
        "",
        "Compression rate",
        "",
        "Compress what percent of the conversation on each /compact? Currently 30% (keeps 70%).",
        "",
        "> 101",
        "",
        "Enter a percentage from 1 to 100.",
        "",
        "Enter to save (1-100) · Esc back · Ctrl-C cancel",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("Escape goes back a step, and only the second one closes", async () => {
    const saved: CompactionSelection[] = [];
    let cancelled = 0;
    const tty = mountSelector({
      onSave: (selection) => saved.push(selection),
      onCancel: () => {
        cancelled += 1;
      },
    });
    try {
      await openRateEditor(tty);

      await tty.press(ESCAPE);
      await settle();
      // Back to the picker, not out of the overlay: Escape in a text step is the
      // wizard's (`text-view.tsx` states the rule), and a step that could not be
      // left would be a trap in the other direction.
      expect((await tty.rows())[3]).toBe("Configure compaction mode");
      expect(cancelled).toBe(0);
      expect(saved).toEqual([]);

      await tty.press(ESCAPE);
      await settle();
      expect(cancelled).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("Ctrl-C closes from the editor", async () => {
    let cancelled = 0;
    const tty = mountSelector({
      onCancel: () => {
        cancelled += 1;
      },
    });
    try {
      await openRateEditor(tty);

      await tty.press(CTRL_C);
      await settle();

      expect(cancelled).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("nothing is dropped when the rows wrap in a narrow terminal", async () => {
    // The label itself wraps at 60 columns ("Compression" / "rate") and the mode
    // row takes three lines — expected Ink behaviour for wide labels, not a
    // defect. What is asserted is that the wrap loses nothing: the rate row is
    // still complete, the footer is still all there, and nothing threw on the way.
    const tty = mountSelector({ columns: 60 });
    try {
      expect(await tty.rows()).toEqual([
        "> /compaction",
        RULE_60,
        "",
        "Configure compaction mode",
        "",
        ">Sliding Window    · Compact older messages to stay within a",
        " (current)         token limit. Compresses about 30% of the",
        "                  conversation each time (keeps about 70%).",
        "",
        " Compression   · Compresses about 30% each time (keeps about",
        " rate          70%). Enter to change it.",
        " Enter select · ↑↓/jk navigate · Esc cancel · the last row",
        "edits the compression rate",
      ]);
    } finally {
      tty.stop();
    }
  });
});
