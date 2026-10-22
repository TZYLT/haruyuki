import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { LeaderHint } from "@/cli/components/LeaderHint";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { armLeader, resetLeader } from "@/cli/helpers/leader";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useMessageHistory } from "./use-message-history";

/**
 * The history chord, driven through the **real** router.
 *
 * Two things a unit test of the table cannot see are checked here: the chord
 * actually reaches the opener after a real `Ctrl+X`, and the hint row names it —
 * an entry nobody can read the keystroke for is an entry nobody uses. The plain
 * `h` case is the other half: after the prefix, `h` is a command, and the rest of
 * the time it is a letter.
 */

class CaptureStream extends Writable {
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

  frame(): string {
    return this.chunks.join("");
  }
}

const CTRL_X = "\u0018";
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function mountHistory() {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new CaptureStream();
  const opened: string[] = [];

  function Probe() {
    useMessageHistory(() => {
      opened.push("opened");
    });
    // The composer's own prefix binding (`composer-key-tables.ts`); without it
    // nothing would arm the leader and `h` would just be a letter.
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
    opened,
    async press(...keys: string[]): Promise<string> {
      await tick();
      const mark = stdout.chunks.length;
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
      return stdout.chunks.slice(mark).join("");
    },
    unmount() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

// The prefix is module state: another file in the same process can leave it armed,
// and then this file's `Ctrl+X` would change nothing on screen (arming an already
// armed prefix notifies nobody) and its frame delta would be empty.
beforeEach(resetLeader);

afterEach(() => {
  resetLeader();
  resetBindingOwners();
  resetInputScopes();
  resetMouseTrackingForTests();
});

describe("the message history chord", () => {
  test("Ctrl+X h opens the face and the hint row names it", async () => {
    const shell = mountHistory();
    try {
      const armed = await shell.press(CTRL_X);
      expect(armed).toContain("h 消息历史");

      await shell.press("h");
      expect(shell.opened).toEqual(["opened"]);
    } finally {
      shell.unmount();
    }
  });

  test("h on its own is a letter, not a command", async () => {
    const shell = mountHistory();
    try {
      await shell.press("h");
      expect(shell.opened).toEqual([]);
    } finally {
      shell.unmount();
    }
  });
});
