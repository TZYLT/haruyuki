import { afterEach, describe, expect, test } from "bun:test";
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

afterEach(resetInkTtyState);

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
