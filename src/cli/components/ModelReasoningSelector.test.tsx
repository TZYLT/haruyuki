import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireInputScope,
  resetInputScopes,
} from "@/cli/helpers/focus-ledger";
import { getHoverTarget, resetHoverForTests } from "@/cli/helpers/hover-store";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { ModelReasoningSelector } from "./ModelReasoningSelector";

/**
 * The reasoning-effort carousel, judged on the frame.
 *
 * Its header used to be hand-drawn (`> /model`, the rule, the title) beside a
 * dozen other overlays that drew the same chrome; it now renders inside
 * `OverlayFrame` like the rest of the toolkit's faces. The frames below were
 * captured from the hand-drawn version before the move and are unchanged, which
 * is what pins the move: the body, the blank rows and the footer's indent all
 * survive, and the footer keeps its own one-column indent by being passed as a
 * node rather than a string.
 */

const RULE = "─".repeat(60);

const NOTHING = () => {};

async function frame(
  options: { effort: string | null; modelId: string }[],
  initialModelId = "m",
): Promise<string[]> {
  const shell = mountInkTty(
    <ModelReasoningSelector
      modelLabel="anthropic/claude-opus-5"
      options={options as never}
      initialModelId={initialModelId}
      onSelect={NOTHING}
      onCancel={NOTHING}
    />,
    { columns: 60, rows: 30 },
  );
  try {
    return await shell.rows();
  } finally {
    shell.stop();
  }
}

const TIERS: { effort: string | null; modelId: string }[] = [
  { effort: null, modelId: "m" },
  { effort: "none", modelId: "m" },
  { effort: "low", modelId: "m" },
  { effort: "medium", modelId: "m" },
  { effort: "high", modelId: "m" },
  { effort: "xhigh", modelId: "m" },
  { effort: "max", modelId: "m" },
];

afterEach(() => {
  resetInkTtyState();
  resetMouseHandlers();
  resetMouseTrackingForTests();
  resetHoverForTests();
  resetInputScopes();
});

describe("ModelReasoningSelector", () => {
  test("a full tier list with a distinct max draws its own bar count", async () => {
    expect(await frame(TIERS, "m")).toEqual([
      "> /model",
      RULE,
      "",
      "Set your model's reasoning settings",
      "",
      " anthropic/claude-opus-5",
      "",
      " ▌▌▌▌▌ Default reasoning effort",
      "",
      " Enter select · ←→/Tab switch · Esc back",
    ]);
  });

  test("without a distinct max the bar count follows the tiers offered", async () => {
    expect(await frame(TIERS.slice(0, 6), "m")).toEqual([
      "> /model",
      RULE,
      "",
      "Set your model's reasoning settings",
      "",
      " anthropic/claude-opus-5",
      "",
      " ▌▌▌▌ Default reasoning effort",
      "",
      " Enter select · ←→/Tab switch · Esc back",
    ]);
  });

  test("a single-tier list still fills its one bar", async () => {
    expect(await frame(TIERS.slice(3, 4), "m")).toEqual([
      "> /model",
      RULE,
      "",
      "Set your model's reasoning settings",
      "",
      " anthropic/claude-opus-5",
      "",
      " ▌ Medium reasoning effort",
      "",
      " Enter select · ←→/Tab switch · Esc back",
    ]);
  });

  test("an empty tier list renders the empty frame instead of crashing", async () => {
    // The keys already handle it (Escape still cancels); the frame is the part
    // that would throw on `options[0]`.
    expect(await frame([], "m")).toEqual([
      "> /model",
      RULE,
      "",
      "Set your model's reasoning settings",
      "",
      " anthropic/claude-opus-5",
      "",
      " ▌ Medium reasoning effort",
      "",
      " Enter select · ←→/Tab switch · Esc back",
    ]);
  });

  test("the initial effort picks the tier, and the arrow keys walk the list", async () => {
    const shell = mountInkTty(
      <ModelReasoningSelector
        modelLabel="m"
        options={TIERS as never}
        initialModelId="m"
        initialEffort={"medium" as never}
        onSelect={NOTHING}
        onCancel={NOTHING}
      />,
      { columns: 60, rows: 30 },
    );
    try {
      expect((await shell.rows()).join("\n")).toContain(
        "▌▌ Medium reasoning effort",
      );
      await shell.press("\u001b[D");
      await shell.rows();
      expect((await shell.rows()).join("\n")).toContain(
        "▌ Low reasoning effort",
      );
      await shell.press("\t");
      await shell.rows();
      expect((await shell.rows()).join("\n")).toContain(
        "▌▌ Medium reasoning effort",
      );
    } finally {
      shell.stop();
    }
  });

  test("Escape and Ctrl+C cancel, Enter selects the tier at the cursor", async () => {
    const selected: string[] = [];
    const cancelled: string[] = [];
    const options = TIERS as never;
    for (const key of ["\u001b", "\u0003"]) {
      const shell = mountInkTty(
        <ModelReasoningSelector
          modelLabel="m"
          options={options}
          initialModelId="m"
          initialEffort={"low" as never}
          onSelect={(option) => selected.push(String(option.effort))}
          onCancel={() => cancelled.push(key)}
        />,
        { columns: 60, rows: 30 },
      );
      try {
        await shell.press(key);
        await shell.rows();
      } finally {
        shell.stop();
      }
    }
    expect(cancelled).toEqual(["\u001b", "\u0003"]);

    const shell = mountInkTty(
      <ModelReasoningSelector
        modelLabel="m"
        options={options}
        initialModelId="m"
        initialEffort={"low" as never}
        onSelect={(option) => selected.push(String(option.effort))}
        onCancel={NOTHING}
      />,
      { columns: 60, rows: 30 },
    );
    try {
      await shell.press("\r");
      await shell.rows();
    } finally {
      shell.stop();
    }
    expect(selected).toEqual(["low"]);
  });
});

// --- The pointer, through the shared primitives -----------------------------
//
// This face renders its own carousel rather than an `OverlayListView`, so it
// takes the hover store, the mouse router and the click tracker directly. The
// bar strip is screen row 8 (the frame draws the header, rule, title, model
// label and their blank rows above it), and the bars start at screen column 2:
// bar `i` is column `2 + i`. With `TIERS` the pickable tiers are
// low/medium/high/xhigh/max, so the third bar is `high` and the first is `low`.

const MOUSE_ESC = String.fromCharCode(27);
const pressAt = (column: number, row: number) =>
  `${MOUSE_ESC}[<0;${column};${row}M`;
const releaseAt = (column: number, row: number) =>
  `${MOUSE_ESC}[<0;${column};${row}m`;
/** Any-motion (`1003`): the pointer moved, no button down. */
const moveTo = (column: number, row: number) =>
  `${MOUSE_ESC}[<35;${column};${row}M`;
/** A wheel notch: 64 = up, 65 = down. */
const wheelAt = (direction: "up" | "down", column: number, row: number) =>
  `${MOUSE_ESC}[<${direction === "up" ? 64 : 65};${column};${row}M`;

const BAR_ROW = 8;
const FIRST_BAR_COLUMN = 2;

async function mountPointer(initialEffort: string | null = "medium") {
  const selected: string[] = [];
  const shell = mountInkTty(
    <ModelReasoningSelector
      modelLabel="m"
      options={TIERS as never}
      initialModelId="m"
      initialEffort={initialEffort as never}
      onSelect={(option) => selected.push(String(option.effort))}
      onCancel={NOTHING}
    />,
    { columns: 60, rows: 30 },
  );
  return { shell, selected };
}

describe("ModelReasoningSelector pointer", () => {
  test("a click on a bar is that tier's Enter", async () => {
    const { shell, selected } = await mountPointer();
    try {
      // Third bar = `high`, then the first = `low`.
      await shell.press(
        pressAt(FIRST_BAR_COLUMN + 2, BAR_ROW),
        releaseAt(FIRST_BAR_COLUMN + 2, BAR_ROW),
      );
      await shell.press(
        pressAt(FIRST_BAR_COLUMN, BAR_ROW),
        releaseAt(FIRST_BAR_COLUMN, BAR_ROW),
      );
      expect(selected).toEqual(["high", "low"]);
    } finally {
      shell.stop();
    }
  });

  test("hover lights the bar under the pointer and follows it away", async () => {
    const { shell } = await mountPointer();
    try {
      await shell.press(moveTo(FIRST_BAR_COLUMN + 1, BAR_ROW));
      expect(getHoverTarget()?.index).toBe(1);
      // Off the strip entirely: the highlight must not stay lit.
      await shell.press(moveTo(1, 2));
      expect(getHoverTarget()).toBeNull();
      // Inside the row but on the label: still not a bar.
      await shell.press(moveTo(FIRST_BAR_COLUMN + 6, BAR_ROW));
      expect(getHoverTarget()).toBeNull();
    } finally {
      shell.stop();
    }
  });

  test("a wheel notch is not this face's: it selects nothing", async () => {
    const { shell, selected } = await mountPointer();
    try {
      await shell.press(wheelAt("down", FIRST_BAR_COLUMN + 2, BAR_ROW));
      expect(selected).toEqual([]);
      expect(getHoverTarget()).toBeNull();
    } finally {
      shell.stop();
    }
  });

  test("a modal above the overlay owns the pointer: bars decline it", async () => {
    const { shell, selected } = await mountPointer();
    const releaseModal = acquireInputScope("modal");
    try {
      await shell.press(
        pressAt(FIRST_BAR_COLUMN + 2, BAR_ROW),
        releaseAt(FIRST_BAR_COLUMN + 2, BAR_ROW),
      );
      await shell.press(moveTo(FIRST_BAR_COLUMN + 1, BAR_ROW));
      expect(selected).toEqual([]);
      expect(getHoverTarget()).toBeNull();
    } finally {
      releaseModal();
      shell.stop();
    }
  });
});
