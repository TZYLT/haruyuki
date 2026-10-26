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

const SETTINGS: ReflectionSettings = {
  onCompaction: true,
  everyUserMessages: 10,
  timeoutMinutes: 3,
  deleteSessionOnSuccess: true,
};

test("SleeptimeSelector renders the two switches and the run policy", async () => {
  const output = await renderSleeptimeSelector(SETTINGS);

  expect(output).toContain("Dream Settings");
  expect(output).toContain("On compaction");
  expect(output).toContain("Every [10]");
  expect(output).toContain("user messages (0 = off");
  expect(output).toContain("Timeout [3]");
  expect(output).toContain("Delete session on success");
  // The retired merge block is gone.
  expect(output).not.toContain("Memory updates");
  expect(output).not.toContain("Apply automatically");
  expect(output).not.toContain("Review instructions");
});

/**
 * The form's keys: the two numeric fields are edited **in place**, so the
 * arrows belong to the caret while a field has the cursor, while ←/→ and Space
 * toggle the switch rows, and ↑↓/Tab walk the form.
 */
const ENTER = "\r";
const ESC = "\u001b";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";
const BACKSPACE = "\u007f";

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
      initialSettings={SETTINGS}
      memfsEnabled={memfsEnabled}
      onSave={(settings) => saved.push(settings)}
      onCancel={() => cancels.push("cancel")}
    />,
    { columns: 100, rows: 30 },
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

test("the user-message counter is edited in place and saved when Enter confirms it", async () => {
  const { tty, saved } = mountForm();
  try {
    // The cursor starts on the first switch row.
    expect(await tty.text()).toContain(">  On compaction");
    await pressSlowly(tty, DOWN);
    expect(await tty.text()).toContain(">  Every [");

    await pressSlowly(tty, BACKSPACE, BACKSPACE, "2", "5");
    expect(await tty.text()).toContain("Every [25 ");

    await pressSlowly(tty, ENTER);
    expect(saved).toEqual([
      {
        onCompaction: true,
        everyUserMessages: 25,
        timeoutMinutes: 3,
        deleteSessionOnSuccess: true,
      },
    ]);
  } finally {
    tty.stop();
  }
});

test("a counter the parser rejects paints the error and saves nothing", async () => {
  const { tty, saved } = mountForm();
  try {
    await pressSlowly(tty, DOWN, "x", ENTER);
    expect(await tty.text()).toContain("Error: must be a non-negative integer");
    expect(saved).toEqual([]);
  } finally {
    tty.stop();
  }
});

test("Space toggles the switch row the cursor is on", async () => {
  const { tty, saved } = mountForm();
  try {
    await pressSlowly(tty, " ");
    await pressSlowly(tty, ENTER);
    expect(saved).toEqual([
      {
        onCompaction: false,
        everyUserMessages: 10,
        timeoutMinutes: 3,
        deleteSessionOnSuccess: true,
      },
    ]);
  } finally {
    tty.stop();
  }
});

test("←/→ toggle switch rows but decline while a field has the cursor", async () => {
  const { tty, saved } = mountForm();
  try {
    // On a switch row the horizontal arrows toggle.
    await pressSlowly(tty, RIGHT);
    await pressSlowly(tty, ENTER);
    expect(saved[0]?.onCompaction).toBe(false);

    // On the counter field the arrows are the caret's: no toggle.
    await pressSlowly(tty, DOWN, RIGHT, ENTER);
    expect(saved[1]?.onCompaction).toBe(false);
    expect(saved[1]?.everyUserMessages).toBe(10);
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
