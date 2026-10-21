import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import {
  getViewportScrollRequest,
  resetViewportScroll,
} from "@/cli/app/viewport-scroll";
import { LeaderHint } from "@/cli/components/LeaderHint";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import {
  leaderEntries,
  registeredBindingOwners,
  resetBindingOwners,
} from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { armLeader, resetLeader } from "@/cli/helpers/leader";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import {
  isMouseTrackingEnabled,
  MOUSE_TRACKING_DISABLE,
  MOUSE_TRACKING_ENABLE,
  type MouseTrackingStream,
  resetMouseTrackingForTests,
} from "@/cli/helpers/mouse-tracking";
import { getNotice, resetNoticeForTests } from "@/cli/helpers/notice";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useMouseInput } from "./use-mouse-input";

/**
 * Mouse input, driven through the **real** router and judged where it matters.
 *
 * Two levels are checked here that a unit test cannot reach: a real terminal
 * sequence pushed into a real Ink stdin reaches the scroll store (the router's
 * claim plus the handler, end to end), and the leader's mouse switch is *seen* —
 * the notice is rendered, not merely stored, because a mode that changes nothing
 * on screen is indistinguishable from a key that did nothing.
 */

class NullOutput extends Writable {
  columns = 100;
  rows = 30;
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

function fakeMouseStream(): MouseTrackingStream & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    isTTY: true,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

const ESCAPE = "\u001b";
const ANSI = new RegExp(
  `${ESCAPE}\\[[0-9;?]*[a-zA-Z]|${ESCAPE}\\][^\\u0007]*\\u0007|${ESCAPE}[=>]|${ESCAPE}\\(B`,
  "g",
);

const CTRL_X = "\u0018";
const WHEEL_UP = `${ESCAPE}[<64;10;5M`;
const WHEEL_DOWN = `${ESCAPE}[<65;10;5M`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function mountMouse(stream: MouseTrackingStream) {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new NullOutput();

  function Probe() {
    useMouseInput(stream);
    // The composer's own prefix binding, which the real app registers in
    // `composer-key-tables.ts`: without it nothing would arm the leader, and the
    // mouse entry would be unreachable (and `m` would just be a letter).
    useKeyBindings("test-leader-prefix", [
      {
        scope: "app",
        bindings: [
          {
            id: "leader.activate",
            chords: LEADER_KEY_CHORDS.activate,
            run: () => {
              armLeader();
              return "consumed";
            },
          },
        ],
      },
    ]);
    return <LeaderHint />;
  }

  const instance = render(<Probe />, {
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
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
      return stdout.chunks.slice(mark).join("").replace(ANSI, "");
    },
    /** Pushes input without waiting for a frame — for input that changes nothing. */
    async send(...keys: string[]): Promise<void> {
      await tick();
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    /** Everything the shell has written, for "this never appeared" assertions. */
    output(): string {
      return stdout.chunks.join("");
    },
    chunkCount(): number {
      return stdout.chunks.length;
    },
    unmount() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

afterEach(() => {
  resetMouseTrackingForTests();
  resetMouseHandlers();
  resetNoticeForTests();
  resetViewportScroll();
  resetLeader();
  resetBindingOwners();
  resetInputScopes();
});

describe("mouse input", () => {
  test("asks for mouse reporting while mounted and gives it back on unmount", async () => {
    const stream = fakeMouseStream();
    const shell = mountMouse(stream);
    try {
      expect(isMouseTrackingEnabled()).toBe(true);
      expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE]);
    } finally {
      shell.unmount();
    }
    // The release is deferred by one tick so a remount can cancel it: the app is
    // keyed by the conversation, so a switch mounts the next shell before the old
    // one is gone, and a release that wrote immediately would be the last word.
    expect(isMouseTrackingEnabled()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(isMouseTrackingEnabled()).toBe(false);
    expect(stream.writes).toEqual([
      MOUSE_TRACKING_ENABLE,
      MOUSE_TRACKING_DISABLE,
    ]);
  });

  test("a shell that replaces another in the same tick leaves the mode on and writes nothing", async () => {
    const stream = fakeMouseStream();
    const first = mountMouse(stream);
    first.unmount();
    // The next shell mounts in the same tick, as a conversation switch does.
    const second = mountMouse(stream);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(isMouseTrackingEnabled()).toBe(true);
      // One enable in total: the release was cancelled, so the terminal never
      // saw the modes blink off and back on.
      expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE]);
    } finally {
      second.unmount();
    }
  });

  test("a real wheel report scrolls the transcript three rows", async () => {
    const stream = fakeMouseStream();
    const shell = mountMouse(stream);
    try {
      await shell.press(WHEEL_UP);
      expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 3 });

      // Three more rows back down, and the wheel clamps at the top of the
      // history instead of running past it.
      await shell.send(WHEEL_DOWN);
      expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 0 });
      await shell.send(WHEEL_DOWN);
      expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 0 });
    } finally {
      shell.unmount();
    }
  });

  test("the leader lists the mouse switch", () => {
    const stream = fakeMouseStream();
    const shell = mountMouse(stream);
    try {
      expect(registeredBindingOwners()).toContain("mouse");
      const entry = leaderEntries().find(
        (candidate) => candidate.id === "leader.toggleMouse",
      );
      expect(entry?.label).toBe("鼠标上报 开/关");
    } finally {
      shell.unmount();
    }
  });

  test("Ctrl+X m takes the mouse back, with a notice on the frame", async () => {
    const stream = fakeMouseStream();
    const shell = mountMouse(stream);
    try {
      expect(isMouseTrackingEnabled()).toBe(true);
      await shell.press(CTRL_X);
      const frame = await shell.press("m");

      expect(isMouseTrackingEnabled()).toBe(false);
      // Reported where the user can see it: the hint slot above the input.
      expect(getNotice()).toContain("鼠标上报已关闭");
      expect(frame).toContain("鼠标上报已关闭");
      expect(stream.writes.at(-1)).toBe(MOUSE_TRACKING_DISABLE);
    } finally {
      shell.unmount();
    }
  });

  test("a click changes nothing on screen while the selection layer is absent", async () => {
    const stream = fakeMouseStream();
    const shell = mountMouse(stream);
    try {
      // Mount settles into two frames on purpose: the hint row names the mouse
      // paths only once reporting is actually on (`useMouseInput` enables it in
      // an effect), so the line is repainted once for that. The claim here is
      // about the click, which must not repaint at all.
      await tick();
      await tick();
      const before = shell.chunkCount();
      // A left press on the transcript: nothing acts on it yet, so it must not
      // repaint (a frame would mean the bytes went somewhere) and must never be
      // written out as text.
      await shell.send(`${ESCAPE}[<0;4;2M`);

      expect(shell.chunkCount()).toBe(before);
      expect(shell.output()).not.toContain("0;4;2");
    } finally {
      shell.unmount();
    }
  });
});
