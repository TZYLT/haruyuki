import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import type { StaticItem } from "@/cli/app/types";
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
import { LeaderHint } from "@/cli/components/LeaderHint";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { armLeader, resetLeader } from "@/cli/helpers/leader";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { getNotice, resetNoticeForTests } from "@/cli/helpers/notice";
import {
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalSelection } from "./use-terminal-selection";

/**
 * Drag selection, driven through the **real** router and the **real** rendered
 * frame.
 *
 * This is the level the pieces cannot be tested at separately: one test has to
 * prove that a mouse report becomes a selection, that the selection reads the
 * text Ink actually drew, that the highlight is written to the terminal, and that
 * `Ctrl+X y` copies exactly what was dragged over. The frame is produced by Ink
 * here, not hand-written, so the whole path is the production one.
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
const CTRL_X = "\u0018";
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

function mountSelection(options: {
  items: () => readonly StaticItem[];
  copied: string[];
}): Harness {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new Capture();

  function Probe() {
    useTerminalSelection({
      stream: stdout,
      items: options.items,
      // The real command would overwrite this machine's clipboard.
      copyLocally: (text) => {
        options.copied.push(text);
        return true;
      },
    });
    // The composer's prefix binding, which the app registers elsewhere.
    useKeyBindings("test-leader-prefix", [
      {
        scope: "app",
        bindings: [
          {
            id: "leader.activate",
            chords: LEADER_KEY_CHORDS.activate,
            run: () => {
              armLeader();
            },
          },
        ],
      },
    ]);
    return (
      <Box flexDirection="column">
        <Text>alpha bravo</Text>
        <Text>charlie delta</Text>
        <Text>echo</Text>
        <LeaderHint />
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

const ANSWER: StaticItem = {
  kind: "assistant",
  id: "assistant-1",
  text: "the last answer",
  phase: "finished",
};

afterEach(() => {
  resetViewportSelectionForTests();
  resetTerminalFrameForTests();
  resetViewportScroll();
  resetNoticeForTests();
  resetLeader();
  resetMouseHandlers();
  resetBindingOwners();
  resetInputScopes();
});

describe("terminal selection", () => {
  test("a drag selects the rows it crossed, and the highlight is written", async () => {
    const copied: string[] = [];
    const shell = mountSelection({ items: () => [ANSWER], copied });
    try {
      // The viewport owns rows 1..3 of this frame.
      setViewportRows(3);
      await shell.press(LEFT_PRESS(1, 1));
      await shell.send(LEFT_DRAG(3, 2), LEFT_RELEASE(3, 2));

      expect(getSelection()).toEqual({
        anchor: { row: 1, column: 1 },
        head: { row: 2, column: 3 },
      });

      const out = shell.output();
      // Row 1 whole, row 2 up to the dragged column: the highlight is spliced
      // into the rows Ink drew.
      expect(out).toContain(`${INVERSE_ON}alpha bravo`);
      expect(out).toContain(`${INVERSE_ON}cha${ESC}[27mrlie delta`);
    } finally {
      shell.unmount();
    }
  });

  test("Ctrl+X y copies exactly what the drag covered", async () => {
    const copied: string[] = [];
    const shell = mountSelection({ items: () => [ANSWER], copied });
    try {
      setViewportRows(3);
      await shell.press(LEFT_PRESS(1, 1));
      await shell.send(LEFT_DRAG(3, 2), LEFT_RELEASE(3, 2));

      expect(getSelectedText()).toBe("alpha bravo\ncha");

      await shell.press(CTRL_X);
      const frame = await shell.press("y");

      expect(copied).toEqual(["alpha bravo\ncha"]);
      // Reported where the user can see it.
      expect(getNotice()).toContain("已复制选区");
      expect(frame).toContain("已复制选区");
    } finally {
      shell.unmount();
    }
  });

  test("with nothing selected, y copies the last answer", async () => {
    const copied: string[] = [];
    const shell = mountSelection({ items: () => [ANSWER], copied });
    try {
      setViewportRows(3);
      await shell.press(CTRL_X);
      await shell.press("y");

      expect(copied).toEqual(["the last answer"]);
      expect(getNotice()).toContain("最后一条回答");
    } finally {
      shell.unmount();
    }
  });

  test("clicking outside the transcript drops the selection and restores the rows", async () => {
    const copied: string[] = [];
    const shell = mountSelection({ items: () => [ANSWER], copied });
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

  test("a band that shrinks under the selection keeps the drag that was made", async () => {
    const copied: string[] = [];
    const shell = mountSelection({ items: () => [ANSWER], copied });
    try {
      setViewportRows(3);
      await shell.press(LEFT_PRESS(1, 1));
      await shell.send(LEFT_DRAG(11, 3), LEFT_RELEASE(11, 3));
      expect(getSelectedText()).toBe("alpha bravo\ncharlie delta\necho");

      // The band shrinks under the standing drag — in the app that is what the
      // leader's own hint line does when `ctrl+x` is pressed, the key press right
      // before the copy. What gets copied is the drag, not whatever the rows hold
      // by then, and no highlight may be drawn over a row that has left the band.
      setViewportRows(2);
      const frame = await shell.press(CTRL_X);

      // No highlight is drawn over a row that has left the band: the relocation
      // cannot place the drag on this frame, and refusing is the point (the frame
      // itself repainted those rows, so there is nothing to put back).
      expect(frame).not.toContain(INVERSE_ON);
      expect(getSelectedText()).toBe("alpha bravo\ncharlie delta\necho");

      await shell.press("y");
      expect(copied).toEqual(["alpha bravo\ncharlie delta\necho"]);
    } finally {
      shell.unmount();
    }
  });

  test("a release alone commits nothing to the clipboard", async () => {
    const copied: string[] = [];
    const shell = mountSelection({ items: () => [ANSWER], copied });
    try {
      setViewportRows(3);
      await shell.press(LEFT_PRESS(1, 1));
      await shell.send(LEFT_DRAG(5, 1), LEFT_RELEASE(5, 1));

      // A stray drag must not silently overwrite the clipboard.
      expect(copied).toEqual([]);
      expect(hasSelection()).toBe(true);
    } finally {
      shell.unmount();
    }
  });

  test("a drag past the band edge stays inside the transcript", async () => {
    const copied: string[] = [];
    const shell = mountSelection({ items: () => [ANSWER], copied });
    try {
      // Only three rows belong to the transcript; the row below them is chrome.
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
});
