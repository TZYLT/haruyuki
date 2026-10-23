import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import { useState } from "react";
import { Input } from "@/cli/components/InputRich";
import { TextInput } from "@/cli/components/TextInput";
import { caretScreenCell } from "@/cli/helpers/caret-position";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetLeader } from "@/cli/helpers/leader";
import { resetTerminalCaretForTests } from "@/cli/helpers/use-terminal-caret";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { buildModInvocationContext } from "@/mods/context";
import { settingsManager } from "@/settings-manager";

/**
 * The terminal's real cursor, on the composer's caret.
 *
 * This is the half of the IME fix that cannot be judged from a painted row: the
 * terminal cursor is an escape sequence, and a frame that *looks* right can still
 * leave the cursor at the bottom of the screen. So these tests read the bytes Ink
 * wrote and decode the anchor it appends to a frame.
 *
 * `buildCursorSuffix` encodes the position as **moves up from the bottom of the
 * frame** (`ESC[<frameRows - y>A`) plus a column (`ESC[<x + 1>G`) plus show-cursor
 * (`ESC[?25h`). The up-count is therefore the assertion for `y`: with a fixed frame
 * height, one more wrapped row means one less move up.
 *
 * The harness is the composer's own shape — a prompt box beside the text box — and
 * the real `TextInput`, so the cell under test is the one a user would type in.
 */

const ESC = "\u001B";
const SHOW_CURSOR = `${ESC}[?25h`;

class FakeStdin extends Readable {
  isTTY = true;
  columns = 80;
  rows = 24;
  override _read() {}
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

class CaptureStream extends Writable {
  columns = 80;
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

  frame(): string {
    return this.chunks.join("");
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

/** The prompt is two columns wide, so the text box starts at frame column 2. */
const PROMPT_COLUMNS = 2;

interface CursorAnchor {
  /** Rows Ink moved up from the frame's bottom (`frameRows - y`). */
  up: number;
  /** The `x` in `cursorTo`'s 1-based column. */
  column: number;
}

/** Every cursor anchor Ink wrote, in order. */
function cursorAnchors(frame: string): CursorAnchor[] {
  // `[<n>A` (move up, absent when y is the frame's last row) then `[<n>G` (column)
  // then show-cursor — the shape `cursor-helpers.ts` builds. The escape byte is
  // built rather than written: a literal control character in a regex literal is
  // what `noControlCharactersInRegex` exists to reject.
  const esc = String.fromCharCode(0x1b);
  const pattern = new RegExp(
    `${esc}\\[(\\d+)A${esc}\\[(\\d+)G${esc}\\[\\?25h|${esc}\\[(\\d+)G${esc}\\[\\?25h`,
    "g",
  );
  const anchors: CursorAnchor[] = [];
  for (const match of frame.matchAll(pattern)) {
    anchors.push({
      up: match[1] ? Number(match[1]) : 0,
      column: Number(match[2] ?? match[3]),
    });
  }
  return anchors;
}

function mountComposer(options: {
  value: string;
  /** Caret offset applied on mount (the editor's default is the end). */
  caret?: number;
  /** Columns the text box gives the draft. */
  wrapWidth: number;
  focus?: boolean;
}): { stdout: CaptureStream; stop: () => void } {
  const stdin = new FakeStdin();
  const stdout = new CaptureStream();
  const instance = render(
    <Box flexDirection="row">
      <Box width={PROMPT_COLUMNS} flexShrink={0}>
        <Text>{"> "}</Text>
      </Box>
      <Box flexGrow={1} width={options.wrapWidth}>
        <TextInput
          value={options.value}
          onChange={() => undefined}
          focus={options.focus ?? true}
          wrapWidth={options.wrapWidth}
          externalCursorOffset={options.caret}
        />
      </Box>
    </Box>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  return {
    stdout,
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

afterEach(resetTerminalCaretForTests);

describe("the composer's terminal cursor", () => {
  test("sits on the caret at the start of the first row", async () => {
    const { stdout, stop } = mountComposer({
      value: "abc",
      caret: 0,
      wrapWidth: 20,
    });
    try {
      await tick();
      const anchors = cursorAnchors(stdout.frame());
      // The frame is one row: a single move up from its bottom is y = 0, and the
      // column is the prompt (2) plus the caret's cell (0).
      expect(anchors.at(-1)).toEqual({ up: 1, column: PROMPT_COLUMNS + 0 + 1 });
    } finally {
      stop();
    }
  });

  test("counts a CJK character as two columns", async () => {
    const { stdout, stop } = mountComposer({ value: "中文", wrapWidth: 20 });
    try {
      await tick();
      // Caret after two wide characters: four columns, not two.
      expect(cursorAnchors(stdout.frame()).at(-1)).toEqual({
        up: 1,
        column: PROMPT_COLUMNS + 4 + 1,
      });
    } finally {
      stop();
    }
  });

  test("moves down a row when the draft wraps", async () => {
    const { stdout, stop } = mountComposer({ value: "abcdef", wrapWidth: 4 });
    try {
      await tick();
      // "abcdef" wraps to two rows; the caret is at the end, so it is on the second.
      // The frame is two rows, so one move up is y = 1 (and two would be y = 0).
      expect(cursorAnchors(stdout.frame()).at(-1)).toEqual({
        up: 1,
        column: PROMPT_COLUMNS + 2 + 1,
      });
    } finally {
      stop();
    }
  });

  test("stays on the first row while the caret is above the wrap", async () => {
    const { stdout, stop } = mountComposer({
      value: "abcdef",
      caret: 1,
      wrapWidth: 4,
    });
    try {
      await tick();
      expect(cursorAnchors(stdout.frame()).at(-1)).toEqual({
        up: 2,
        column: PROMPT_COLUMNS + 1 + 1,
      });
    } finally {
      stop();
    }
  });

  test("a soft wrap puts an end-of-row caret on the next row", async () => {
    const { stdout, stop } = mountComposer({
      value: "abcdef",
      caret: 4,
      wrapWidth: 4,
    });
    try {
      await tick();
      // Offset 4 is the first character of the second row, not column 4 of the first.
      expect(cursorAnchors(stdout.frame()).at(-1)).toEqual({
        up: 1,
        column: PROMPT_COLUMNS + 0 + 1,
      });
    } finally {
      stop();
    }
  });

  test("publishes nothing while the input does not own the keyboard", async () => {
    const { stdout, stop } = mountComposer({
      value: "abc",
      wrapWidth: 20,
      focus: false,
    });
    try {
      await tick();
      const frame = stdout.frame();
      // The draft is still drawn; no cursor is placed and none is shown.
      expect(frame).toContain("abc");
      expect(frame).not.toContain(SHOW_CURSOR);
      expect(cursorAnchors(frame)).toHaveLength(0);
    } finally {
      stop();
    }
  });

  test("a keystroke's own frame carries the cursor", async () => {
    // The failing shape this guards: if the position were published from an effect
    // instead of during render, every keystroke would draw with the *previous*
    // caret and only the next commit would catch up — an IME window one character
    // behind what the user just composed. The anchor has to be in the same write as
    // the character it belongs to.
    const stdin = new FakeStdin();
    const stdout = new CaptureStream();

    function Typing() {
      const [value, setValue] = useState("");
      return (
        <Box flexDirection="row">
          <Box width={PROMPT_COLUMNS} flexShrink={0}>
            <Text>{"> "}</Text>
          </Box>
          <Box flexGrow={1} width={20}>
            <TextInput value={value} onChange={setValue} wrapWidth={20} />
          </Box>
        </Box>
      );
    }

    const instance = render(<Typing />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    try {
      await tick();
      stdin.push("a");
      await tick();
      const written = stdout.chunks.filter((chunk) =>
        chunk.includes(SHOW_CURSOR),
      );
      const typed = written.at(-1) ?? "";
      // The character and the anchor are in one write, and the caret is past it.
      expect(typed).toContain("a");
      expect(cursorAnchors(typed).at(-1)).toEqual({
        up: 1,
        column: PROMPT_COLUMNS + 1 + 1,
      });
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });
});

describe("the real composer", () => {
  /**
   * `InputRich` is the only place that knows the width the draft has, and it hands
   * it down as `wrapWidth`. These cases mount the real composer so that wiring is
   * judged, not just the leaf editor: a prop that stopped arriving would leave the
   * screen looking right and the IME window at the bottom of the terminal.
   */
  let previousHome: string | undefined;
  let tempHome: string;

  beforeAll(async () => {
    previousHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "letta-terminal-caret-"));
    process.env.HOME = tempHome;
    await settingsManager.reset();
    await settingsManager.initialize();
  });

  afterAll(async () => {
    await settingsManager.reset();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  afterEach(() => {
    resetLeader();
    resetBindingOwners();
    resetInputScopes();
  });

  const COMPOSER_COLUMNS = 40;
  /** `InputRich` draws the prompt glyph and a space before the draft. */
  const COMPOSER_PROMPT = 2;

  function mountInput(options: { inputEnabled?: boolean } = {}) {
    const stdin = new FakeStdin();
    const stdout = new CaptureStream();
    const instance = render(
      <Input
        streaming={false}
        tokenCount={0}
        thinkingMessage=""
        terminalWidth={COMPOSER_COLUMNS}
        shouldAnimate={false}
        inputEnabled={options.inputEnabled ?? true}
        onSubmit={async () => ({ submitted: true })}
        modContext={buildModInvocationContext({
          agent: { id: "agent-terminal-caret" },
        })}
        modAdapter={
          {
            hadModPanels: false,
            hasModSources: false,
            isLoading: false,
          } as unknown as LocalModAdapter
        }
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: false,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    return {
      stdout,
      async press(keys: string): Promise<void> {
        await tick();
        stdin.push(keys);
        await tick();
      },
      unmount() {
        instance.unmount();
        instance.cleanup();
      },
    };
  }

  test("the composer places the cursor on its own caret", async () => {
    const composer = mountInput();
    try {
      await composer.press("ab");
      expect(cursorAnchors(composer.stdout.frame()).at(-1)).toEqual({
        up: expect.any(Number),
        column: COMPOSER_PROMPT + 2 + 1,
      });
    } finally {
      composer.unmount();
    }
  });

  test("the composer counts a CJK draft in columns", async () => {
    const composer = mountInput();
    try {
      await composer.press("\u4e2d\u6587");
      expect(cursorAnchors(composer.stdout.frame()).at(-1)).toEqual({
        up: expect.any(Number),
        column: COMPOSER_PROMPT + 4 + 1,
      });
    } finally {
      composer.unmount();
    }
  });

  test("a draft that fills the composer's width puts the caret on the next row", async () => {
    const composer = mountInput();
    try {
      // The draft box is `terminalWidth - prompt`: exactly filling it leaves the
      // trailing caret cell nowhere to sit but the row below, in column 0.
      await composer.press("x".repeat(COMPOSER_COLUMNS - COMPOSER_PROMPT));
      expect(cursorAnchors(composer.stdout.frame()).at(-1)).toEqual({
        up: expect.any(Number),
        column: COMPOSER_PROMPT + 0 + 1,
      });
    } finally {
      composer.unmount();
    }
  });

  test("a disabled composer publishes no cursor", async () => {
    const composer = mountInput({ inputEnabled: false });
    try {
      await tick();
      expect(composer.stdout.frame()).not.toContain(SHOW_CURSOR);
    } finally {
      composer.unmount();
    }
  });
});

describe("caretScreenCell", () => {
  test("adds the text box's origin to the caret's cell", () => {
    expect(
      caretScreenCell({
        text: "中文abc",
        caretOffset: 2,
        wrapWidth: 20,
        originX: 2,
        originY: 5,
      }),
    ).toEqual({ x: 6, y: 5 });
  });

  test("wraps the row, not just the column", () => {
    expect(
      caretScreenCell({
        text: "abcdef",
        caretOffset: 5,
        wrapWidth: 4,
        originX: 2,
        originY: 0,
      }),
    ).toEqual({ x: 3, y: 1 });
  });

  test("no width, no cell", () => {
    // A collapsed or not-yet-laid-out input must not publish a guessed position.
    expect(
      caretScreenCell({
        text: "abc",
        caretOffset: 1,
        wrapWidth: 0,
        originX: 0,
        originY: 0,
      }),
    ).toBeNull();
  });
});
