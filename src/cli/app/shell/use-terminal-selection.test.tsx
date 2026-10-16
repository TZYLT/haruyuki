import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import {
  resetViewportScroll,
  setViewportRows,
} from "@/cli/app/viewport-scroll";
import {
  getSelectedText,
  getSelection,
  hasSelection,
  resetViewportSelectionForTests,
} from "@/cli/app/viewport-selection";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetLeader } from "@/cli/helpers/leader";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import {
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";
import { useInputRouter } from "@/cli/hooks/use-input-router";
import { useTerminalSelection } from "./use-terminal-selection";

/**
 * Drag selection, driven through the **real** router and the **real** frame.
 *
 * This is the level the pieces cannot be tested at separately: one test has to
 * prove that a mouse report becomes a selection, that the selection reads the
 * text Ink actually drew, and that the highlight is written into the terminal.
 * The frame is produced by Ink here, not hand-written, so the whole path is the
 * production one.
 */

class Capture extends Writable {
  columns = 40;
  rows = 12;
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

const ESC = "\u001B";
const INVERSE_ON = `${ESC}[7m`;

function mouse(
  kind: "M" | "m",
  code: number,
  column: number,
  row: number,
): string {
  return `${ESC}[<${code};${column};${row}${kind}`;
}

const LEFT_PRESS = (column: number, row: number) => mouse("M", 0, column, row);
const LEFT_DRAG = (column: number, row: number) => mouse("M", 32, column, row);
const LEFT_RELEASE = (column: number, row: number) =>
  mouse("m", 0, column, row);

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

interface Harness {
  press(...keys: string[]): Promise<string>;
  send(...keys: string[]): Promise<void>;
  output(): string;
  unmount(): void;
}

function mountSelection(): Harness {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new Capture();

  function Probe() {
    // The shell mounts the app's input router (`ShellFrame`); a component rendered
    // on its own has to install it, or no mouse report would be read at all.
    useInputRouter();
    useTerminalSelection();
    return (
      <Box flexDirection="column">
        <Text>alpha bravo</Text>
        <Text>charlie delta</Text>
        <Text>echo</Text>
      </Box>
    );
  }

  // The capture is installed before Ink's first write, exactly as the process
  // entry does it: Ink writes that frame inside `render()`.
  installTerminalFrameCapture(stdout);
  const instance = render(<Probe />, {
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
    alternateScreen: true,
  });

  return {
    async press(...keys: string[]): Promise<string> {
      await tick();
      const mark = stdout.chunks.length;
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
      const deadline = Date.now() + 1_000;
      while (stdout.chunks.length === mark && Date.now() < deadline)
        await tick();
      await tick();
      return stdout.chunks.slice(mark).join("");
    },
    async send(...keys: string[]): Promise<void> {
      await tick();
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    output(): string {
      return stdout.chunks.join("");
    },
    unmount() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

afterEach(() => {
  resetViewportSelectionForTests();
  resetTerminalFrameForTests();
  resetViewportScroll();
  resetLeader();
  resetMouseHandlers();
  resetBindingOwners();
  resetInputScopes();
});

describe("terminal selection", () => {
  test("a drag selects the rows it crossed, and the highlight is written", async () => {
    const shell = mountSelection();
    try {
      // The viewport owns rows 1..3 of this frame.
      setViewportRows(3);
      await shell.press(LEFT_PRESS(1, 1));
      await shell.send(LEFT_DRAG(3, 2), LEFT_RELEASE(3, 2));

      expect(getSelection()).toEqual({
        anchor: { row: 1, column: 1 },
        head: { row: 2, column: 3 },
      });
      expect(getSelectedText()).toBe("alpha bravo\ncha");

      const out = shell.output();
      // Row 1 whole, row 2 up to the dragged column: the highlight is spliced
      // into the rows Ink drew.
      expect(out).toContain(`${INVERSE_ON}alpha bravo`);
      expect(out).toContain(`${INVERSE_ON}cha${ESC}[27mrlie delta`);
    } finally {
      shell.unmount();
    }
  });

  test("clicking outside the transcript drops the selection and restores the rows", async () => {
    const shell = mountSelection();
    try {
      setViewportRows(3);
      await shell.press(LEFT_PRESS(1, 1));
      await shell.send(LEFT_DRAG(11, 1), LEFT_RELEASE(11, 1));
      expect(hasSelection()).toBe(true);

      // Row 5 is the input area, not the band.
      const out = await shell.press(LEFT_PRESS(1, 5));

      expect(getSelection()).toBeNull();
      // The marked row is put back as it was: no inverse sequence around it.
      expect(out).toContain(`${ESC}[1;1Halpha bravo`);
      expect(out).not.toContain(`${INVERSE_ON}alpha bravo`);
    } finally {
      shell.unmount();
    }
  });

  test("a release keeps what was dragged", async () => {
    const shell = mountSelection();
    try {
      setViewportRows(3);
      await shell.press(LEFT_PRESS(1, 1));
      await shell.send(LEFT_DRAG(5, 1), LEFT_RELEASE(5, 1));

      // The selection survives the release; copying it is a key of its own, so a
      // stray drag never overwrites the clipboard on its own.
      expect(hasSelection()).toBe(true);
      expect(getSelectedText()).toBe("alpha");
    } finally {
      shell.unmount();
    }
  });

  test("a drag past the band edge stays inside the transcript", async () => {
    const shell = mountSelection();
    try {
      // Only three rows belong to the transcript.
      setViewportRows(3);
      await shell.press(LEFT_PRESS(1, 3));
      await shell.send(LEFT_DRAG(4, 9), LEFT_RELEASE(4, 9));

      expect(getSelection()).toEqual({
        anchor: { row: 3, column: 1 },
        head: { row: 3, column: 4 },
      });
      expect(getSelectedText()).toBe("echo");
    } finally {
      shell.unmount();
    }
  });

  test("a right-click is not a selection gesture", async () => {
    const shell = mountSelection();
    try {
      setViewportRows(3);
      await shell.send(mouse("M", 2, 4, 1), mouse("m", 2, 4, 1));

      expect(hasSelection()).toBe(false);
    } finally {
      shell.unmount();
    }
  });
});
