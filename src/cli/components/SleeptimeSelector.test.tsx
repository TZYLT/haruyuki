import { afterEach, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { SleeptimeSelector } from "./SleeptimeSelector";

class CaptureStream extends Writable {
  columns = 100;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

async function renderSleeptimeSelector(
  initialSettings: ReflectionSettings,
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const instance = render(
    <SleeptimeSelector
      initialSettings={initialSettings}
      memfsEnabled
      onSave={() => {}}
      onCancel={() => {}}
    />,
    {
      stdout,
      stdin,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();
  return stripAnsi(stdout.chunks.join(""));
}

const STEP_COUNT_SETTINGS: ReflectionSettings = {
  trigger: "step-count",
  stepCount: 10,
  merge: "auto",
  mergeInstructions: "",
};

test("SleeptimeSelector renders the step count inline", async () => {
  const output = await renderSleeptimeSelector(STEP_COUNT_SETTINGS);

  expect(output).toContain("Dream Settings");
  // The count sits in place, as it always did — but the block that used to mark
  // the cursor is the editor's caret now, and with colour off a caret is a space.
  expect(output).toContain("Every [10 ] steps");
  expect(output).toContain("On compaction");
  expect(output).toContain("Memory updates");
  expect(output).toContain("Apply automatically");
  expect(output).toContain("Agent reviews before applying");
  expect(output).not.toContain("Review instructions");
});

test("SleeptimeSelector shows review instructions only in explicit mode", async () => {
  const output = await renderSleeptimeSelector({
    trigger: "off",
    stepCount: 10,
    merge: "explicit",
    mergeInstructions: "Preserve exact wording.",
  });

  expect(output).toContain("Agent reviews before applying");
  expect(output).toContain("Review instructions");
  expect(output).toContain("[Preserve exact wording.]");
});

/**
 * The form's keys, which are the part the tree has nowhere else: the two fields
 * are edited **in place** rather than in a sub-view, so the arrows have to be
 * split between the caret and the option cycling, and ↑↓/Tab still walk the form.
 */
const ENTER = "\r";
const ESC = "\u001b";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";
const UP = "\u001b[A";
const RIGHT = "\u001b[C";
const BACKSPACE = "\u007f";
const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~`;

afterEach(resetInkTtyState);

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function mountForm(memfsEnabled = true): {
  tty: ReturnType<typeof mountInkTty>;
  saved: ReflectionSettings[];
  cancels: string[];
} {
  const saved: ReflectionSettings[] = [];
  const cancels: string[] = [];
  const tty = mountInkTty(
    <SleeptimeSelector
      initialSettings={STEP_COUNT_SETTINGS}
      memfsEnabled={memfsEnabled}
      onSave={(settings) => saved.push(settings)}
      onCancel={() => cancels.push("cancel")}
    />,
    { columns: 90, rows: 30 },
  );
  return { tty, saved, cancels };
}

async function pressSlowly(
  tty: ReturnType<typeof mountInkTty>,
  ...keys: string[]
): Promise<void> {
  for (const key of keys) {
    await tty.press(key);
    await settle();
  }
}

test("the step count is edited in place and saved when Enter confirms it", async () => {
  const { tty, saved } = mountForm();
  try {
    // The cursor starts on the step-count row (that is the trigger in force).
    expect(await tty.text()).toContain(">  Every [10");

    await pressSlowly(tty, "1");
    expect(await tty.text()).toContain("Every [101");
    await pressSlowly(tty, BACKSPACE);
    expect(await tty.text()).toContain("Every [10 ");
    await pressSlowly(tty, BACKSPACE, BACKSPACE, "2", "5");
    expect(await tty.text()).toContain("Every [25");

    await pressSlowly(tty, ENTER);
    expect(saved).toEqual([
      {
        trigger: "step-count",
        stepCount: 25,
        merge: "auto",
        mergeInstructions: "",
      },
    ]);
  } finally {
    tty.stop();
  }
});

test("a step count the parser rejects paints the error and saves nothing", async () => {
  const { tty, saved } = mountForm();
  try {
    await pressSlowly(tty, "x", ENTER);
    expect(await tty.text()).toContain("Error: must be a positive integer");
    expect(saved).toEqual([]);
  } finally {
    tty.stop();
  }
});

test("a pasted step count lands in the field", async () => {
  const { tty } = mountForm();
  try {
    await tty.press(PASTE("40"));
    await settle();
    expect(await tty.text()).toContain("1040");
  } finally {
    tty.stop();
  }
});

test("↑↓ and Tab walk the form, and Space picks the row the cursor is on", async () => {
  const { tty, saved } = mountForm();
  try {
    // One row down from the step count is "On compaction"; Space selects it and
    // Enter saves it (Space is not a space here: the count is a number).
    await pressSlowly(tty, DOWN);
    const rows = await tty.rows();
    expect(rows.some((row) => row.startsWith(">  On compaction"))).toBe(true);

    await pressSlowly(tty, " ");
    await pressSlowly(tty, ENTER);
    expect(saved).toEqual([
      {
        trigger: "compaction-event",
        stepCount: 10,
        merge: "auto",
        mergeInstructions: "",
      },
    ]);

    // Tab keeps walking down the form and wraps to the top.
    await pressSlowly(tty, "\t", "\t", "\t");
    expect((await tty.rows()).some((row) => row.startsWith(">  Off"))).toBe(
      true,
    );
  } finally {
    tty.stop();
  }
});

test("←/→ cycle the option, but decline while a field has the cursor", async () => {
  const { tty, saved } = mountForm();
  try {
    // On the step-count row the arrows are the caret's: no trigger change.
    await pressSlowly(tty, RIGHT, ENTER);
    expect(saved).toEqual([
      {
        trigger: "step-count",
        stepCount: 10,
        merge: "auto",
        mergeInstructions: "",
      },
    ]);

    // On a choice row they cycle the trigger, which Enter then saves.
    await pressSlowly(tty, UP);
    await pressSlowly(tty, RIGHT);
    await pressSlowly(tty, ENTER);
    expect(saved[1]?.trigger).toBe("compaction-event");
  } finally {
    tty.stop();
  }
});

test("Escape and Ctrl+C close the form, and Enter closes it with MemFS off", async () => {
  const { tty, cancels } = mountForm();
  try {
    await pressSlowly(tty, ESC);
    expect(cancels).toEqual(["cancel"]);
    await pressSlowly(tty, CTRL_C);
    expect(cancels).toEqual(["cancel", "cancel"]);
  } finally {
    tty.stop();
  }

  const off = mountForm(false);
  try {
    expect(await off.tty.text()).toContain("require the memory filesystem");
    await pressSlowly(off.tty, ENTER);
    expect(off.cancels).toEqual(["cancel"]);
  } finally {
    off.tty.stop();
  }
});
