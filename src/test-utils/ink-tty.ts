import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";

/**
 * Mounting an overlay against a fake TTY and reading back the frame it painted.
 *
 * Overlay work in this tree is judged on the frame, not on the state a handler
 * set: `src/cli/AGENTS.md` records the class of bug where a key path is wired
 * perfectly, the state is exactly what the test asserts, and the screen is
 * empty, because a later step in the same keystroke undid it. Judging the frame
 * needs three things every time — a TTY-shaped stdout Ink can lay out against, a
 * stdin the test pushes keys into, and the captured frame — plus the same three
 * resets between tests, because the input scopes, the binding owners and the
 * frame capture are all module-level state. This is that harness once, so a test
 * file can be its assertions.
 *
 * Three details are load-bearing:
 *
 * - **Both widths are pinned.** Ink wraps against the stream it was handed, while
 *   `useTerminalWidth` reads `process.stdout` (`getStdout()` returns that). A
 *   test that pinned only one would assert wrapping against a width the
 *   component never used.
 * - **The frame is read from the terminal capture, not from the chunk stream.**
 *   Ink writes a frame per write; the capture is what turns those bytes into
 *   rows. Joining the chunks would re-assert Ink's own diffing instead of what
 *   is on screen.
 * - **Trailing blank rows are dropped.** A frame pads to the stream height, so
 *   without this every row assertion would trail a dozen empties. Only trailing
 *   ones: a blank row *inside* the frame is a reserved indicator row in a
 *   windowed list, and dropping it would hide the thing under test.
 */

class TtyStream extends Writable {
  columns: number;
  rows: number;
  isTTY = true;

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

/** How long to let Ink flush a frame — or a keystroke's re-render. */
const TICK_MS = 30;

const tick = (ms = TICK_MS) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface InkTtyOptions {
  /** Terminal width, pinned on the stream and on `process.stdout`. */
  columns?: number;
  rows?: number;
}

export interface InkTty {
  /** The rows painted, with the frame's unused trailing rows dropped. */
  rows(): Promise<string[]>;
  /** The rows painted, joined — for the `toContain` assertions. */
  text(): Promise<string>;
  /** Push raw key bytes, one tick apart. */
  press(...keys: string[]): Promise<void>;
  /**
   * Re-render the same mount with new props.
   *
   * A prop change is not a second mount: React updates in place, and the
   * module-level claims a component holds are released by the effect that owns
   * them. That is the only way to tell "the approval came back when the overlay
   * closed" from "a second shell was mounted without an overlay, which of course
   * had no overlay" — a test that unmounts and mounts again asserts the second
   * and calls it the first.
   */
  rerender(element: ReactElement): Promise<void>;
  /** Unmount, release the capture, restore the pinned terminal size. */
  stop(): void;
}

export function mountInkTty(
  element: ReactElement,
  options: InkTtyOptions = {},
): InkTty {
  const columns = options.columns ?? 80;
  const rows = options.rows ?? 24;

  const stdout = new TtyStream(columns, rows) as unknown as NodeJS.WriteStream;
  const releaseCapture = installTerminalFrameCapture(stdout);
  const restoreSize = pinProcessStdout(columns, rows);

  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const instance = render(element, {
    stdin,
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  async function readRows(): Promise<string[]> {
    await tick();
    const painted = [...(getTerminalFrame()?.text ?? [])];
    while (painted.length > 0 && painted.at(-1) === "") painted.pop();
    return painted;
  }

  let stopped = false;

  return {
    rows: readRows,
    async text() {
      return (await readRows()).join("\n");
    },
    async press(...keys) {
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    async rerender(element) {
      instance.rerender(element);
      await tick();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      instance.unmount();
      instance.cleanup();
      releaseCapture();
      restoreSize();
    },
  };
}

/**
 * The module-level stores the router and the frame capture keep. Call this in
 * `afterEach`: a scope claimed by one test is otherwise still claimed by the
 * next, and a leaked owner makes routing assert against the wrong table.
 */
export function resetInkTtyState(): void {
  resetInputScopes();
  resetBindingOwners();
  resetTerminalFrameForTests();
}

function pinProcessStdout(columns: number, rows: number): () => void {
  const saved = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
    rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
  };
  for (const [key, value] of [
    ["columns", columns],
    ["rows", rows],
  ] as const) {
    Object.defineProperty(process.stdout, key, { configurable: true, value });
  }
  return () => {
    for (const key of ["columns", "rows"] as const) {
      const descriptor = saved[key];
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      } else {
        delete (process.stdout as { columns?: number; rows?: number })[key];
      }
    }
  };
}
