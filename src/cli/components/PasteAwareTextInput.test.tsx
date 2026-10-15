import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import chalk from "chalk";
import { render } from "ink";
import { type ReactNode, useState } from "react";
import stripAnsi from "strip-ansi";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

/**
 * Regression coverage for letta-code #4493: an IME (Input Method Editor)
 * commit — or any terminal write — can reach the process as several stdin
 * reads inside one `'readable'` tick. Ink emits one `input` event per read, so
 * the composer sees multiple `useInput` events before React flushes the
 * passive effects of the first render. The value-sync effect in
 * `PasteAwareTextInput` then ran with an older `value`, clamped the caret to
 * that shorter length and re-applied the older display value over the newer
 * one — caret one short, middle chunks dropped.
 *
 * The fake stdin below reproduces the read pattern deterministically without
 * an IME or a TTY: `read()` yields the queued chunks one at a time within a
 * single `'readable'` emission.
 */
class MultiReadStdin extends EventEmitter {
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

  /** Deliver `chunks` so that `read()` yields them one at a time in one tick. */
  pushReads(chunks: string[]): void {
    this.queue.push(...chunks);
    this.emit("readable");
  }
}

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  frames: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.frames.push(String(chunk));
    callback();
  }
}

const INVERSE_ON = "\u001b[7m";

/**
 * Caret position as the user sees it: the text input renders the character
 * under the caret (or a trailing space) in inverse video. Returns the number
 * of characters before that span in the last frame that drew the input.
 */
function renderedCaret(frames: string[]): number | null {
  const frame = [...frames].reverse().find((f) => f.includes(INVERSE_ON));
  if (!frame) return null;
  return Array.from(
    stripAnsi(frame.slice(0, frame.indexOf(INVERSE_ON))).replace(/\r?\n/g, ""),
  ).length;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

interface Observed {
  value: string;
  /** Caret offset the input reported to the parent (`onCursorMove`). */
  caret: number | null;
  /** Caret offset actually drawn in the last frame. */
  renderedCaret: number | null;
  /** Times the input handed a value to the submit handler. */
  submits: number;
}

function Harness({ observed }: { observed: Observed }) {
  const [value, setValue] = useState("");
  return (
    <PasteAwareTextInput
      value={value}
      onChange={(next) => {
        observed.value = next;
        setValue(next);
      }}
      onSubmit={() => {
        observed.submits += 1;
      }}
      onCursorMove={(offset) => {
        observed.caret = offset;
      }}
      focus
    />
  );
}

/**
 * Renders the real composer input under Ink and feeds `groups` of stdin reads,
 * one group per tick. Returns the parent-observed value and caret.
 */
async function typeInReads(
  groups: string[][],
  harness: (observed: Observed) => ReactNode = (observed) => (
    <Harness observed={observed} />
  ),
): Promise<Observed> {
  const observed: Observed = {
    value: "",
    caret: null,
    renderedCaret: null,
    submits: 0,
  };
  const stdin = new MultiReadStdin();
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  // Force styled output so the inverse-video caret is visible in captured frames.
  const previousLevel = chalk.level;
  chalk.level = 1;
  const instance = render(harness(observed), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    stderr: stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  try {
    await tick();
    for (const group of groups) {
      stdin.pushReads(group);
      await tick();
    }
    await tick();
  } finally {
    // Under CI (`is-in-ci`) Ink buffers frames and writes the last one only at
    // unmount, so read the drawn caret after unmounting.
    instance.unmount();
    chalk.level = previousLevel;
  }
  observed.renderedCaret = renderedCaret(stdout.frames);
  return observed;
}

/**
 * The composer's other half of bash-mode entry: `handleChange` takes `!` on an
 * empty draft, enters bash mode and **keeps its own value**, so the `!` must not
 * survive in the input.
 */
function BangEntryHarness({ observed }: { observed: Observed }) {
  const [value, setValue] = useState("");
  return (
    <PasteAwareTextInput
      value={value}
      onChange={(next) => {
        observed.value = next;
        setValue(next);
      }}
      onSubmit={() => {
        observed.submits += 1;
      }}
      onBangAtEmpty={() => true}
      focus
    />
  );
}

function TwoInputHarness({
  composer,
  overlay,
}: {
  composer: Observed;
  overlay: Observed;
}) {
  const [composerValue, setComposerValue] = useState("");
  const [overlayValue, setOverlayValue] = useState("");
  return (
    <>
      <PasteAwareTextInput
        value={composerValue}
        onChange={(next) => {
          composer.value = next;
          setComposerValue(next);
        }}
        onSubmit={() => {}}
        focus={false}
      />
      <PasteAwareTextInput
        value={overlayValue}
        onChange={(next) => {
          overlay.value = next;
          setOverlayValue(next);
        }}
        onSubmit={() => {}}
        focus
      />
    </>
  );
}

async function pasteIntoTwo(chunks: string[]): Promise<{
  composer: Observed;
  overlay: Observed;
}> {
  const composer: Observed = {
    value: "",
    caret: null,
    renderedCaret: null,
    submits: 0,
  };
  const overlay: Observed = {
    value: "",
    caret: null,
    renderedCaret: null,
    submits: 0,
  };
  const stdin = new MultiReadStdin();
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const previousLevel = chalk.level;
  chalk.level = 1;
  const instance = render(
    <TwoInputHarness composer={composer} overlay={overlay} />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout,
      stderr: stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  try {
    await tick();
    stdin.pushReads(chunks);
    await tick();
    await tick();
  } finally {
    instance.unmount();
    chalk.level = previousLevel;
  }
  return { composer, overlay };
}

describe("PasteAwareTextInput multi-read input commits (#4493)", () => {
  test("keeps the caret at the end when one commit arrives as two reads in one tick", async () => {
    // Reporter's first log: 日本語 delivered as 日本 + 語 within one tick.
    const observed = await typeInReads([["日本", "語"]]);
    expect(observed.value).toBe("日本語");
    expect(observed.caret).toBe(3);
    expect(observed.renderedCaret).toBe(3);
  });

  test("preserves every chunk when one commit arrives as three reads in one tick", async () => {
    // Reporter's second log: the middle chunk used to be dropped.
    const chunks = ["日本", "語の", "入力中に変換がおかしくなるのが問題だ"];
    const observed = await typeInReads([chunks]);
    expect(observed.value).toBe(chunks.join(""));
    expect(observed.caret).toBe(chunks.join("").length);
    expect(observed.renderedCaret).toBe(chunks.join("").length);
  });

  test("is independent of IME/CJK input: ASCII split across two reads in one tick", async () => {
    const observed = await typeInReads([["ab", "c"]]);
    expect(observed.value).toBe("abc");
    expect(observed.caret).toBe(3);
    expect(observed.renderedCaret).toBe(3);
  });

  test("control: the same chunks in separate ticks were always intact", async () => {
    const observed = await typeInReads([["日本"], ["語"]]);
    expect(observed.value).toBe("日本語");
    expect(observed.caret).toBe(3);
    expect(observed.renderedCaret).toBe(3);
  });

  test("keeps both large pastes when two arrive in one tick", async () => {
    const first = Array.from({ length: 8 }, (_, i) => `first-${i}`).join("\n");
    const second = Array.from({ length: 8 }, (_, i) => `second-${i}`).join(
      "\n",
    );
    const observed = await typeInReads([
      [`\u001b[200~${first}\u001b[201~`, `\u001b[200~${second}\u001b[201~`],
    ]);
    const placeholders =
      observed.value.match(/\[Pasted text #\d+ \+\d+ lines\]/g) ?? [];
    expect(placeholders).toHaveLength(2);
    // Order is preserved: the first paste sits before the second.
    expect(observed.value.indexOf("[Pasted text")).toBeLessThan(
      observed.value.lastIndexOf("[Pasted text"),
    );
  });
});

describe("PasteAwareTextInput paste delivery", () => {
  test("folds a markerless paste split across reads into one placeholder", async () => {
    // A terminal that does not wrap the paste in bracketed-paste markers sends
    // it as many small stdin reads. Each read is well under the single-change
    // placeholder threshold, so without aggregation the raw text lands inline.
    const text = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 40) {
      chunks.push(text.slice(i, i + 40));
    }
    const observed = await typeInReads([chunks]);
    expect(observed.value).toMatch(/^\[Pasted text #\d+ \+12 lines\]$/);
  });

  test("does not duplicate a paste when the composer is unfocused under an overlay", async () => {
    const text = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
    const { composer, overlay } = await pasteIntoTwo([
      `\u001b[200~${text}\u001b[201~`,
    ]);
    // The focused overlay input owns the paste; the always-mounted composer
    // must not also forward it as a raw input event.
    expect(
      overlay.value.match(/\[Pasted text #\d+ \+\d+ lines\]/g),
    ).toHaveLength(1);
    expect(composer.value).toBe("");
  });
});

/**
 * The composer's editing keys used to be handled by a raw `prependListener` on
 * Ink's emitter, next to a `useInput` handler for the rest. Both are gone: the
 * keys are chords in the input router's table now. These cases pin the readings
 * that only the raw layer used to get right.
 */
describe("PasteAwareTextInput editing keys", () => {
  const CTRL_W = "\u0017";
  const HOME = "\u001b[H";
  const END = "\u001b[F";
  const FORWARD_DELETE = "\u001b[3~";
  const SHIFT_ENTER = "\u001b[13;2u";
  const OPTION_LEFT = "\u001b[1;3D";
  // Older xterm modifier encodings the raw handler accepted as Option+Arrow:
  // 7 is ctrl+alt, 4 is shift+alt.
  const OPTION_LEFT_CTRL = "\u001b[7D";
  const OPTION_LEFT_SHIFT = "\u001b[1;4D";
  const OPTION_DELETE = "\u001b\u007f";

  test("Shift+Enter inserts a newline instead of submitting", async () => {
    const observed = await typeInReads([["ab"], [SHIFT_ENTER], ["cd"]]);
    expect(observed.value).toBe("ab\ncd");
    expect(observed.caret).toBe(5);
  });

  test("Option+Left and Option+Right move by word", async () => {
    const back = await typeInReads([["one two"], [OPTION_LEFT]]);
    expect(back.caret).toBe(4);
    const forward = await typeInReads([
      ["one two"],
      [OPTION_LEFT],
      [OPTION_LEFT],
      ["\u001b[1;3C"],
    ]);
    expect(forward.caret).toBe(4);
  });

  test("accepts the older Option+Arrow encodings", async () => {
    const ctrlAlt = await typeInReads([["one two"], [OPTION_LEFT_CTRL]]);
    expect(ctrlAlt.caret).toBe(4);
    const shiftAlt = await typeInReads([["one two"], [OPTION_LEFT_SHIFT]]);
    expect(shiftAlt.caret).toBe(4);
  });

  test("Home and End move the caret to the draft's ends", async () => {
    const atStart = await typeInReads([["abc"], [HOME]]);
    expect(atStart.caret).toBe(0);
    const atEnd = await typeInReads([["abc"], [HOME], [END]]);
    expect(atEnd.caret).toBe(3);
  });

  test("Ctrl+W and Option+Delete delete the previous word", async () => {
    const ctrlW = await typeInReads([["one two"], [CTRL_W]]);
    expect(ctrlW.value).toBe("one ");
    const optionDelete = await typeInReads([["one two"], [OPTION_DELETE]]);
    expect(optionDelete.value).toBe("one ");
  });

  test("fn+Delete deletes the character after the caret, not before it", async () => {
    const observed = await typeInReads([["abc"], [HOME], [FORWARD_DELETE]]);
    expect(observed.value).toBe("bc");
    expect(observed.caret).toBe(0);
  });

  test("Option+Enter inserts a newline", async () => {
    const observed = await typeInReads([["ab"], ["\u001b\r"], ["cd"]]);
    expect(observed.value).toBe("ab\ncd");
  });

  test("honours the terminal workarounds the raw layer carried", async () => {
    // VS Code/Cursor keybindings send a literal backslash-r for Shift+Enter.
    const literal = await typeInReads([["ab"], ["\\r"], ["cd"]]);
    expect(literal.value).toBe("ab\ncd");
    // Some terminals send ESC LF for Option+Enter.
    const escLf = await typeInReads([["ab"], ["\u001b\n"], ["cd"]]);
    expect(escLf.value).toBe("ab\ncd");
  });

  test("leaves a plain Enter to the submit handler", async () => {
    const observed = await typeInReads([["ab"], ["\r"]]);
    // The draft stays and the newline was not inserted into it...
    expect(observed.value).toBe("ab");
    // ...because Enter is the submit handler's key. Asserting the hand-off is the
    // point: without the count this passed even when Enter stopped submitting.
    expect(observed.submits).toBe(1);
  });

  test("a refused edit is not the base for the next keystroke", async () => {
    // The composer keeps its own value when it takes `!` for bash-mode entry. The
    // leaf input had already applied the `!` optimistically, so before the refusal
    // was reported back the next keystroke built on it and the first bash command
    // came out as `!cmd`.
    const observed = await typeInReads([["!"], ["l"], ["s"]], (o) => (
      <BangEntryHarness observed={o} />
    ));
    expect(observed.value).toBe("ls");
  });
});
