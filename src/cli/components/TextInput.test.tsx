import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { useState } from "react";
import { TextInput } from "./TextInput";

/**
 * The leaf text editor, on its own.
 *
 * It is the component every composer edit ends in, and it owns three things nothing
 * else can check: what a key does when it is declined (`onChange` returning false restores
 * the parent's value, or the next keystroke builds on text the parent rejected), that a
 * modified letter never becomes text, and the kill-buffer yank. This file renders the real
 * component against a fake TTY and reads the frame it paints.
 *
 * The caret is covered *behaviourally* (where an insert lands after Ctrl+A) rather than by
 * its inverse-video glyph: chalk resolves its level at import time from a non-TTY test
 * stdout, so the highlight is simply absent from the frame these tests read.
 */

const ESCAPE = "\u001B";

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

  /** The last frame as written, ANSI included. */
  frame(): string {
    return this.chunks.join("");
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

interface ProbeHandle {
  stdin: FakeStdin;
  stdout: CaptureStream;
  stop: () => void;
  /** What the leaf has reported, in order. */
  edits: string[];
  /** The value the parent is holding. */
  current: () => string;
}

/**
 * A controlled parent, so a refused edit and a parent-driven value are both real: the
 * leaf only sees what this component passes down.
 */
function mountProbe(
  initial: string,
  options: { mask?: string; refuse?: boolean; wrapWidth?: number } = {},
): ProbeHandle {
  const stdin = new FakeStdin();
  const stdout = new CaptureStream();
  const edits: string[] = [];
  let read: () => string = () => initial;

  function Probe() {
    const [value, setValue] = useState(initial);
    read = () => value;
    return (
      <TextInput
        value={value}
        mask={options.mask}
        wrapWidth={options.wrapWidth}
        onChange={(next) => {
          edits.push(next);
          if (options.refuse) return false;
          setValue(next);
          return undefined;
        }}
      />
    );
  }

  const instance = render(<Probe />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    stdin,
    stdout,
    edits,
    current: () => read(),
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

async function press(probe: ProbeHandle, sequence: string): Promise<void> {
  const mark = probe.stdout.chunks.length;
  probe.stdin.push(sequence);
  await tick();
  void mark;
}

afterEach(() => {
  // Nothing global: each probe owns its streams.
});

describe("TextInput", () => {
  test("draws the mask, not the value", async () => {
    const probe = mountProbe("ab", { mask: "*" });
    try {
      await press(probe, "");
      const frame = probe.stdout.frame();
      // One glyph per character, and the value itself must not reach the frame: that is
      // what the mask is for.
      expect(frame).toContain("**");
      expect(frame).not.toContain("ab");
    } finally {
      probe.stop();
    }
  });

  test("Ctrl+A, then a letter, inserts at the start", async () => {
    const probe = mountProbe("bc");
    try {
      await press(probe, "\u0001"); // Ctrl+A: caret to the start
      await press(probe, "a");
      expect(probe.current()).toBe("abc");
    } finally {
      probe.stop();
    }
  });

  test("Ctrl+K cuts to the kill buffer and Ctrl+Y pastes it back", async () => {
    const probe = mountProbe("hello");
    try {
      await press(probe, "\u0001"); // caret to the start
      await press(probe, "\u000b"); // Ctrl+K: cut "hello"
      expect(probe.current()).toBe("");
      await press(probe, "\u0019"); // Ctrl+Y: yank it back
      expect(probe.current()).toBe("hello");
    } finally {
      probe.stop();
    }
  });

  test("a modified letter is not text", async () => {
    const probe = mountProbe("x");
    try {
      // Option+p: Ink parses it as meta+p, which the editor must not insert.
      await press(probe, `${ESCAPE}p`);
      expect(probe.edits).toEqual([]);
      expect(probe.current()).toBe("x");
    } finally {
      probe.stop();
    }
  });

  test("a refused edit goes back to the parent's value", async () => {
    const probe = mountProbe("x", { refuse: true });
    try {
      await press(probe, "y");
      // The parent said no, so the leaf must go on displaying what the parent holds —
      // otherwise the next keystroke builds on a rejection.
      expect(probe.edits).toEqual(["xy"]);
      expect(probe.current()).toBe("x");
      await press(probe, "z");
      expect(probe.edits).toEqual(["xy", "xz"]);
      expect(probe.current()).toBe("x");
    } finally {
      probe.stop();
    }
  });

  test("lays the draft out at the width the parent gives it", async () => {
    // The composer hands its own content width down so the editor can place the
    // terminal cursor on the caret's cell (an IME opens there). That is only sound
    // if the editor wraps at exactly that width, so the break has to be its own.
    const probe = mountProbe("abcdef", { wrapWidth: 4 });
    try {
      await press(probe, "");
      expect(probe.stdout.frame()).toContain("abcd\nef");
    } finally {
      probe.stop();
    }
  });

  test("counts a CJK character as two columns when it wraps", async () => {
    const probe = mountProbe("中文中", { wrapWidth: 4 });
    try {
      await press(probe, "");
      // Two per row, not four: the terminal draws each of them two columns wide.
      expect(probe.stdout.frame()).toContain("中文\n中");
    } finally {
      probe.stop();
    }
  });

  test("wraps nothing without a width", async () => {
    const probe = mountProbe("abcdef");
    try {
      await press(probe, "");
      expect(probe.stdout.frame()).not.toContain("abcd\nef");
    } finally {
      probe.stop();
    }
  });
});
