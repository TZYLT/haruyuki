import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import {
  pushToast,
  resetToastsForTests,
} from "@/cli/notifications/toast-store";
import { Toasts } from "./Toasts";

/**
 * What the band *looks like*: the rows, their order, and the fold count.
 *
 * Rendered against a fake TTY for the reason `src/cli/AGENTS.md` gives — a store
 * assertion cannot see whether anything reached the frame — and the store is the
 * same module the app writes, so pushing here is the app's own path.
 */

class FakeStdin extends EventEmitter {
  isTTY = true;
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
}

class CaptureStream extends Writable {
  columns = 60;
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(): Promise<{
  stdout: CaptureStream;
  frame: () => string;
  clear: () => void;
  unmount: () => void;
}> {
  const stdout = new CaptureStream();
  const instance = render(<Toasts />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await tick();
  return {
    stdout,
    frame: () => stdout.frame(),
    clear: () => {
      stdout.chunks = [];
    },
    unmount: () => instance.unmount(),
  };
}

afterEach(() => {
  resetToastsForTests();
});

describe("the toast band's rows", () => {
  test("an empty band paints no rows at all", async () => {
    const view = await mount();

    expect(view.frame().trim()).toBe("");
    view.unmount();
  });

  test("paints the marker and the text", async () => {
    pushToast("turn done", 0);
    const view = await mount();

    expect(view.frame()).toContain("! turn done");
    view.unmount();
  });

  test("the newest toast is the bottom row", async () => {
    pushToast("first", 0);
    pushToast("second", 0);
    const view = await mount();

    expect(view.frame().indexOf("second")).toBeGreaterThan(
      view.frame().indexOf("first"),
    );
    view.unmount();
  });

  test("a fourth toast folds into the oldest row instead of a fourth line", async () => {
    for (let index = 0; index < 4; index += 1) {
      pushToast(`toast ${index}`, 0);
    }
    const view = await mount();
    const frame = view.frame();

    expect(frame).toContain("+1");
    expect(frame).not.toContain("toast 0");
    expect(frame.split("\n").filter((line) => line.includes("!"))).toHaveLength(
      3,
    );
    view.unmount();
  });

  test("a toast leaves the frame when its deadline passes", async () => {
    pushToast("turn done", 20);
    const view = await mount();
    expect(view.frame()).toContain("turn done");

    view.clear();
    await wait(60);

    expect(view.frame()).not.toContain("turn done");
    view.unmount();
  });
});
