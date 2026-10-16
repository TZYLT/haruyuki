import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, Text } from "ink";
import { useEffect, useState } from "react";
import {
  getTerminalFrame,
  getTerminalFrameVersion,
  installTerminalFrameCapture,
  isCapturingTerminalFrame,
  resetTerminalFrameForTests,
  subscribeToTerminalFrame,
  writeToTerminal,
} from "@/cli/helpers/terminal-frame";

/**
 * The frame capture, judged against **real Ink output**.
 *
 * Everything the selection does is expressed in screen rows, so the capture has
 * to be right about where a frame's rows sit — and that depends on how Ink
 * writes the frame, not on anything this repo controls. A test with hand-written
 * chunks would pass even if Ink changed shape, which is exactly the failure that
 * would silently paint a highlight over the wrong rows. The first two tests
 * therefore render Ink and read what it wrote.
 */

class Capture extends Writable {
  columns = 40;
  rows = 10;
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
const CLEAR = `${ESC}[2J`;

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

/** A stream that skips the terminal: what a frame looks like there is not read. */
function probeStream(): Capture {
  return new Capture();
}

afterEach(() => {
  resetTerminalFrameForTests();
});

describe("terminal frame capture", () => {
  test("reads the rows Ink drew for a frame that does not fill the screen", async () => {
    const stdout = probeStream();
    installTerminalFrameCapture(stdout);

    function Probe() {
      const [label, setLabel] = useState("first");
      useEffect(() => {
        const timer = setTimeout(() => setLabel("second"), 40);
        return () => clearTimeout(timer);
      }, []);
      return (
        <Box flexDirection="column" height={4}>
          <Text>{label}</Text>
          <Text color="green">coloured</Text>
        </Box>
      );
    }

    const instance = render(<Probe />, {
      stdin: fakeStdin(),
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
      alternateScreen: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    instance.unmount();
    instance.cleanup();

    const frame = getTerminalFrame();
    expect(frame).not.toBeNull();
    // Rows are screen rows: the box is four rows tall, so two carry text and two
    // are blank — and none of them is the row the cursor ends on.
    expect(frame?.text).toEqual(["second", "coloured", "", ""]);
    expect(frame?.widths).toEqual([6, 8, 0, 0]);
    // The first row carries no erase prefix: it can be repainted on its own
    // without moving the cursor or erasing the row above it.
    expect(frame?.lines[0]?.startsWith(ESC)).toBe(false);
    // A frame shorter than the terminal is not cleared by Ink, and the capture
    // still anchors it — the alternate-screen entry put the cursor at row 1 and
    // this was the first frame drawn there.
    const frameWrite = stdout.chunks.find((chunk) => chunk.includes("\n"));
    expect(frameWrite).not.toContain(CLEAR);
    expect(frame?.anchored).toBe(true);
    expect(getTerminalFrameVersion()).toBeGreaterThan(1);
    expect(isCapturingTerminalFrame()).toBe(true);
  });

  test("pins the shape of a cleared frame, which is the Windows full-height path", async () => {
    const stdout = probeStream();
    installTerminalFrameCapture(stdout);

    const instance = render(
      <Box flexDirection="column" height={10}>
        <Text>only</Text>
      </Box>,
      {
        stdin: fakeStdin(),
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: false,
        patchConsole: false,
        exitOnCtrlC: false,
        alternateScreen: true,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    instance.unmount();
    instance.cleanup();

    // A frame that fills the terminal is cleared on Windows, and a cleared frame
    // is one write that homes the cursor: that is what makes "row 1 of the write
    // is row 1 of the screen" true without emulating a terminal.
    const cleared = stdout.chunks.find((chunk) => chunk.includes(CLEAR));
    expect(cleared).toBeDefined();
    expect(cleared).toContain(`${ESC}[H`);
    expect(getTerminalFrame()?.anchored).toBe(true);
  });

  test("anchors a frame that neither clears nor follows a fresh screen", () => {
    const stdout = probeStream();
    installTerminalFrameCapture(stdout);

    // First frame: cleared, so anchored.
    stdout.write(`${CLEAR}${ESC}[3J${ESC}[Hone\ntwo\n`);
    expect(getTerminalFrame()?.anchored).toBe(true);

    // Same height, no clear: Ink erased the previous frame first, which walks the
    // cursor back to the row this frame starts at.
    stdout.write(`${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[Gthree\nfour\n`);
    const same = getTerminalFrame();
    expect(same?.anchored).toBe(true);
    expect(same?.text).toEqual(["three", "four"]);
    expect(same?.lines[0]).toBe("three");

    // A different height without a clear has no known origin: refuse to place it
    // rather than paint a highlight over the wrong rows.
    stdout.write(`${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[Gfive\n`);
    expect(getTerminalFrame()?.anchored).toBe(false);
    expect(getTerminalFrame()?.text).toEqual(["five"]);
  });

  test("ignores writes that are not frames", () => {
    const stdout = probeStream();
    installTerminalFrameCapture(stdout);
    const notifications: number[] = [];
    subscribeToTerminalFrame(() => {
      notifications.push(getTerminalFrameVersion());
    });

    stdout.write(`${ESC}]0;title\u0007`);
    stdout.write("\u0007");
    stdout.write(`${ESC}[?25l`);

    expect(getTerminalFrame()).toBeNull();
    expect(notifications).toEqual([]);
  });

  test("a paint is written but never read back as a frame", () => {
    const stdout = probeStream();
    installTerminalFrameCapture(stdout);
    stdout.write(`${CLEAR}${ESC}[Hreal row\n`);

    expect(getTerminalFrame()?.text).toEqual(["real row"]);

    // The highlight writes with the same clear marker; if it were captured, the
    // selection would start copying its own decoration.
    expect(writeToTerminal(`${CLEAR}${ESC}[Hdecoration\n`)).toBe(true);

    expect(stdout.chunks.join("")).toContain("decoration");
    expect(getTerminalFrame()?.text).toEqual(["real row"]);
  });

  test("installs once per stream and restores the stream's own write", () => {
    const stdout = probeStream();
    const first = installTerminalFrameCapture(stdout);
    const second = installTerminalFrameCapture(stdout);
    const wrapped = stdout.write;

    first();
    // Still one user left: the wrapper stays.
    expect(stdout.write).toBe(wrapped);

    second();
    expect(Object.hasOwn(stdout, "write")).toBe(false);
    expect(isCapturingTerminalFrame()).toBe(false);
  });

  test("leaves a stream that is not a terminal alone", () => {
    const stdout = probeStream();
    stdout.isTTY = false;

    const release = installTerminalFrameCapture(stdout);

    expect(Object.hasOwn(stdout, "write")).toBe(false);
    expect(isCapturingTerminalFrame()).toBe(false);
    release();
  });
});
