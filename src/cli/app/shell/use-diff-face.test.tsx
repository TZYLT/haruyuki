import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { DiffPatchFile } from "@/cli/helpers/diff-patch";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { armLeader, resetLeader } from "@/cli/helpers/leader";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useDiffFace } from "./use-diff-face";

/**
 * The diff chord, driven through the **real** router.
 *
 * A table-level test cannot see whether `Ctrl+X d` reaches the opener after a real
 * `Ctrl+X`, and the plain `d` case is the other half: after the prefix `d` is a
 * command, and the rest of the time it is a letter. The empty-map case is the third:
 * a session with no diff must leave the key alone rather than open an empty face.
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
}

const CTRL_X = "\u0018";
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const DIFF: AdvancedDiffSuccess = {
  mode: "advanced",
  fileName: "a.ts",
  oldStr: "",
  newStr: "",
  hunks: [
    {
      oldStart: 1,
      newStart: 1,
      lines: [{ raw: "-old" }, { raw: "+new" }],
    },
  ],
};

function mountDiffChord(diffs: Map<string, AdvancedDiffSuccess>) {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new CaptureStream();
  const opened: DiffPatchFile[][] = [];

  function Probe() {
    useDiffFace({
      precomputedDiffsRef: { current: diffs },
      open: (files) => {
        opened.push(files);
      },
    });
    // The composer's own prefix binding (`composer-key-tables.ts`); without it
    // nothing would arm the leader and `d` would just be a letter.
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
    return null;
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
    async press(...keys: string[]): Promise<void> {
      await tick();
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    unmount() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

afterEach(() => {
  resetLeader();
  resetBindingOwners();
  resetInputScopes();
  resetMouseTrackingForTests();
});

describe("the diff chord", () => {
  test("Ctrl+X d hands the newest diff to the opener", async () => {
    const shell = mountDiffChord(new Map([["tc-1:src/a.ts", DIFF]]));
    try {
      await shell.press(CTRL_X, "d");
      expect(shell.opened).toHaveLength(1);
      expect(shell.opened[0]?.map((file) => file.path)).toEqual(["src/a.ts"]);
      expect(shell.opened[0]?.[0]?.additions).toBe(1);
      expect(shell.opened[0]?.[0]?.deletions).toBe(1);
    } finally {
      shell.unmount();
    }
  });

  test("d on its own is a letter, not a command", async () => {
    const shell = mountDiffChord(new Map([["tc-1:src/a.ts", DIFF]]));
    try {
      await shell.press("d");
      expect(shell.opened).toEqual([]);
    } finally {
      shell.unmount();
    }
  });

  test("a session with no diff leaves the chord alone", async () => {
    const shell = mountDiffChord(new Map());
    try {
      await shell.press(CTRL_X, "d");
      expect(shell.opened).toEqual([]);
    } finally {
      shell.unmount();
    }
  });
});
