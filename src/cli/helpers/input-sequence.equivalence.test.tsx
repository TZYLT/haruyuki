import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Key, render, useInput } from "ink";
import {
  shieldKeyEvent,
  terminalWorkaroundSequences,
} from "@/cli/helpers/input-sequence";

/**
 * The shield reads raw sequences itself so it can run before Ink's handlers and
 * swallow the keys the table owns. Ink does not export its parser, so the shield
 * covers a deliberately small set (`input-sequence.ts`) and hands everything
 * else to Ink's own `useInput`. That makes one property load-bearing:
 *
 *   for every sequence the shield *does* claim, its `(input, key)` pair must be
 *   exactly what a real `useInput` handler receives for that sequence.
 *
 * This test pins that against Ink itself, and separately asserts that the
 * sequences the app's shortcuts arrive as are in fact covered by the shield
 * (otherwise they would silently stop being shielded).
 */

class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];

  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  read(): string | null {
    return this.queue.length > 0 ? (this.queue.shift() as string) : null;
  }

  push(data: string): void {
    this.queue.push(data);
    this.emit("readable");
  }
}

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

const ESC = "\u001b";

/**
 * Every shortcut the app registers, in the encodings a terminal may send, plus
 * the shapes the shield must *not* claim (an unknown escape sequence, a paste
 * without bracketed-paste markers, an SGR mouse report Ink cannot recognize).
 */
const CORPUS = [
  "a",
  "A",
  "1",
  "!",
  " ",
  "hello",
  "\n",
  "\u0001",
  "\u0003",
  "\u0004",
  "\u0007",
  "\u000f",
  "\u0012",
  "\u0014",
  "\u0016",
  "\u0017",
  "\u001a",
  "\r",
  "\t",
  "\u007f",
  "\b",
  ESC,
  `${ESC}${ESC}`,
  `${ESC}[A`,
  `${ESC}[B`,
  `${ESC}[C`,
  `${ESC}[D`,
  `${ESC}[5~`,
  `${ESC}[6~`,
  `${ESC}[5;2~`,
  `${ESC}[6;2~`,
  `${ESC}[H`,
  `${ESC}[F`,
  `${ESC}[1~`,
  `${ESC}[4~`,
  `${ESC}OH`,
  `${ESC}OF`,
  `${ESC}[3~`,
  `${ESC}[Z`,
  `${ESC}b`,
  `${ESC}f`,
  `${ESC}\r`,
  `${ESC}\u007f`,
  `${ESC}[1;3D`,
  `${ESC}[1;3C`,
  `${ESC}[111;6u`,
  `${ESC}[13;2u`,
  `${ESC}[27u`,
  `${ESC}[<0;10;5M`,
];

/**
 * Sequences whose shortcuts must be shielded, i.e. the raw layer has to read
 * them on its own for the key to be kept away from legacy handlers.
 */
const MUST_BE_SHIELDED = [
  "\u0003", // Ctrl+C
  "\u0007", // Ctrl+G (subagent group)
  "\u000f", // Ctrl+O (shell output)
  "\u0012", // Ctrl+R
  "\u0014", // Ctrl+T
  "\u0018", // Ctrl+X (leader prefix)
  "\u001a", // Ctrl+Z
  "\t", // Tab
  `${ESC}[3~`, // fn+Delete
  `${ESC}[5~`, // PageUp
  `${ESC}[6~`, // PageDown
  `${ESC}[5;2~`, // Shift+PageUp (jump to the oldest row)
  `${ESC}[6;2~`, // Shift+PageDown (jump to the newest row)
  "\u007f", // Backspace
  `${ESC}`, // Escape
];

/** Field-by-field projection, so `undefined` versus missing cannot mask a diff. */
const KEY_FIELDS = [
  "upArrow",
  "downArrow",
  "leftArrow",
  "rightArrow",
  "pageDown",
  "pageUp",
  "home",
  "end",
  "return",
  "escape",
  "ctrl",
  "shift",
  "tab",
  "backspace",
  "delete",
  "meta",
  "super",
  "hyper",
  "capsLock",
  "numLock",
  "eventType",
] as const;

function canonical(event: { input: string; key: Key }): string {
  const projected: Record<string, unknown> = { input: event.input };
  for (const field of KEY_FIELDS) projected[field] = event.key[field];
  return JSON.stringify(projected);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

describe("input sequence shield", () => {
  test("never reads a sequence differently than Ink's useInput", async () => {
    const seen: { input: string; key: Key }[] = [];

    function Probe() {
      useInput((input, key) => {
        seen.push({ input, key });
      });
      return null;
    }

    const stdin = new FakeStdin();
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    const instance = render(<Probe />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout,
      stderr: stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    const mismatches: string[] = [];
    try {
      await tick();
      for (const sequence of CORPUS) {
        const before = seen.length;
        stdin.push(sequence);
        // Longer than Ink's 20ms pending-escape flush, so a bare Escape is
        // delivered before the next sequence is pushed.
        await tick();
        const delivered = seen.length - before;
        if (delivered !== 1) {
          mismatches.push(
            `${JSON.stringify(sequence)} produced ${delivered} input events`,
          );
          continue;
        }
        const actual = seen[seen.length - 1];
        if (!actual) continue;
        const shielded = shieldKeyEvent(sequence);
        if (!shielded) continue; // not claimed: Ink's own parse routes it
        if (canonical(shielded) !== canonical(actual)) {
          mismatches.push(
            `${JSON.stringify(sequence)}: ink=${canonical(actual)} shield=${canonical(shielded)}`,
          );
        }
      }
    } finally {
      instance.unmount();
    }

    expect(mismatches).toEqual([]);
  });

  test("covers the sequences the app's shortcuts arrive as", () => {
    const uncovered = MUST_BE_SHIELDED.filter(
      (sequence) => shieldKeyEvent(sequence) === undefined,
    );
    expect(uncovered).toEqual([]);
  });

  test("does not claim shapes that are not keys", () => {
    // A paste and an SGR mouse report must fall through to Ink's parse: the
    // shield claiming them would swallow real text input.
    expect(shieldKeyEvent("hello")).toBeUndefined();
    expect(shieldKeyEvent(`${ESC}[<0;10;5M`)).toBeUndefined();
    expect(shieldKeyEvent(`${ESC}[111;6u`)).toBeUndefined();
  });

  test("keeps the terminal workarounds explicit, each with a reason", () => {
    // These are the entries the shield reads *differently* from Ink on purpose,
    // because the fork already treated them as a key. They are allowed to exist;
    // they are not allowed to be silent or unreachable.
    const workarounds = terminalWorkaroundSequences();
    expect(workarounds.length).toBeGreaterThan(0);
    for (const entry of workarounds) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(shieldKeyEvent(entry.sequence)).toBeDefined();
      expect(entry.sequence.length).toBeGreaterThan(1);
    }
  });

  test("each workaround is read as the key it stands for", () => {
    // Both entries in the table mean "modified Enter" -- Option+Enter on
    // terminals that send ESC LF, and the literal backslash-r a VS Code
    // keybinding is commonly configured to send for Shift+Enter.
    for (const entry of terminalWorkaroundSequences()) {
      const event = shieldKeyEvent(entry.sequence);
      expect(event?.key.return).toBe(true);
      expect(event?.key.meta).toBe(true);
    }
  });
});
