import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render, useInput } from "ink";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import {
  registerBindingOwner,
  resetBindingOwners,
} from "@/cli/helpers/input-router";
import { armLeader, resetLeader } from "@/cli/helpers/leader";
import { BtwPane, type BtwState } from "./BtwPane";

/**
 * The `/btw` pane reports a finished side answer; it must not take the keyboard
 * with it. Two properties are pinned here:
 *
 * 1. Its own keys are only the ones that cannot be someone typing — `Esc` closes
 *    it, and switching to the fork is behind the leader prefix — so the draft
 *    keeps accepting ordinary letters while the pane is up.
 * 2. Its keys actually reach it, through the router, while the composer is
 *    mounted behind it. The previous implementation disabled the composer, which
 *    unmounted its text input: the input area became a blank spacer and typing
 *    did nothing.
 *
 * A second `useInput` observer stands in for the composer: a key the router
 * swallows never reaches it, so "did the pane consume this key?" is observable.
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

afterEach(() => {
  resetLeader();
  resetInputScopes();
  resetBindingOwners();
});

const COMPLETE: BtwState = {
  status: "complete",
  question: "为什么",
  responseText: "因为",
  forkedConversationId: "local-conv-fork",
};

async function withPane(
  state: BtwState,
  run: (input: {
    send: (sequence: string) => Promise<void>;
    seen: string[];
    dismissed: string[];
    jumped: string[];
    frame: () => string;
  }) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const dismissed: string[] = [];
  const jumped: string[] = [];

  function Observer() {
    useInput((input, key) => {
      seen.push(key.escape ? "<esc>" : input);
    });
    return null;
  }

  const stdin = new FakeStdin();
  const stdout = new CaptureStream();
  const instance = render(
    <>
      <Observer />
      <BtwPane
        state={state}
        onDismiss={() => dismissed.push("dismiss")}
        onJumpToConversation={(id) => jumped.push(id)}
      />
    </>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  try {
    await tick();
    await run({
      send: async (sequence) => {
        stdin.push(sequence);
        await tick();
      },
      seen,
      dismissed,
      jumped,
      frame: () => stdout.frame(),
    });
  } finally {
    instance.unmount();
  }
}

describe("BtwPane", () => {
  test("Esc closes the pane, and is not left to the composer", async () => {
    await withPane(COMPLETE, async ({ send, seen, dismissed }) => {
      await send("\u001b");
      expect(dismissed).toEqual(["dismiss"]);
      expect(seen).toEqual([]);
    });
  });

  test("a plain letter is still someone typing", async () => {
    await withPane(COMPLETE, async ({ send, seen, dismissed, jumped }) => {
      await send("j");
      await send("q");
      // Both reached the input (nothing consumed them), and neither dismissed
      // the pane: `q` no longer closes it, and `j` switches only behind the
      // leader prefix.
      expect(seen).toEqual(["j", "q"]);
      expect(dismissed).toEqual([]);
      expect(jumped).toEqual([]);
    });
  });

  test("Ctrl+X then j switches to the fork", async () => {
    await withPane(COMPLETE, async ({ send, seen, jumped }) => {
      armLeader();
      await send("j");
      expect(jumped).toEqual(["local-conv-fork"]);
      expect(seen).toEqual([]);
    });
  });

  test("while the answer is still streaming the pane owns no keys", async () => {
    await withPane(
      { ...COMPLETE, status: "streaming" },
      async ({ send, seen, dismissed, jumped }) => {
        await send("\u001b");
        await send("j");
        // The composer's Esc and its typing are untouched.
        expect(seen).toEqual(["<esc>", "j"]);
        expect(dismissed).toEqual([]);
        expect(jumped).toEqual([]);
      },
    );
  });

  test("tells the reader how to close it without taking letters", async () => {
    await withPane(COMPLETE, async ({ frame }) => {
      const rendered = frame();
      expect(rendered).toContain("esc");
      expect(rendered).toContain("应用级快捷键暂停");
      // The footer must not advertise what the `modal` claim makes unreachable: the
      // leader prefix is app-scoped, so it cannot be armed while the pane shows.
      expect(rendered).not.toContain("ctrl+x j");
      // The old single-letter dismissal is gone on purpose: it swallowed `j` and `q`.
      expect(rendered).not.toContain("[j] Switch to fork");
    });
  });

  test("suspends app-scope chords while it shows, and only then", async () => {
    // The footer's claim, as behaviour. `modal` makes `consultedInputScopes()` return
    // `[modal, system]`, so an app-scope binding is never consulted while the pane is
    // up; with no pane there is no claim and the same key reaches it.
    const runs: string[] = [];
    registerBindingOwner("test-app", () => [
      {
        scope: "app",
        bindings: [
          {
            id: "test.shellOutput",
            chords: [{ key: "o", ctrl: true }],
            run: () => {
              runs.push("run");
              return true;
            },
          },
        ],
      },
    ]);

    await withPane(COMPLETE, async ({ send }) => {
      await send("\u000f"); // Ctrl+O
      expect(runs).toEqual([]);
    });
    await withPane({ status: "idle" }, async ({ send }) => {
      await send("\u000f");
      expect(runs).toEqual(["run"]);
    });
  });

  test("renders nothing while idle, and claims nothing either", async () => {
    await withPane({ status: "idle" }, async ({ frame, send, seen }) => {
      expect(frame()).not.toContain("btw");
      // With no pane there is no modal claim, so the composer keeps its escape.
      await send("\u001b");
      expect(seen).toEqual(["<esc>"]);
    });
  });
});
