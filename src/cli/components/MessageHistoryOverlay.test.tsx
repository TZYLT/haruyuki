import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import {
  getMessageHistorySnapshot,
  recordMessageHistory,
  resetMessageHistoryForTests,
} from "@/cli/notifications/history-store";
import { MessageHistoryOverlay } from "./MessageHistoryOverlay";

/**
 * The face's frame: rows newest first, the clock and the kind in a column, the
 * empty label, and the two keys that do something (`C` and Escape).
 *
 * A real TTY mount for the reason `src/cli/AGENTS.md` gives — a face can be wired
 * perfectly and paint nothing, and this is the file that decides what it paints.
 */

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const UP = "\u001B[A";
const ENTER = "\r";
const ESCAPE = "\u001B";
const BASE = Date.now() - 2 * 60 * 60 * 1_000;

let tempRoot: string | null = null;
const originalHome = process.env.HARUYUKI_HOME;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "haruyuki-history-face-"));
  process.env.HARUYUKI_HOME = tempRoot;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHome;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  resetMessageHistoryForTests();
  resetInputScopes();
  resetBindingOwners();
});

async function mount() {
  const stdout = new CaptureStream();
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  let closed = 0;
  const instance = render(
    <MessageHistoryOverlay
      onClose={() => {
        closed += 1;
      }}
    />,
    {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await tick();

  return {
    frame: () => stdout.frame(),
    closed: () => closed,
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    async frameAfter(keys: string[]) {
      stdout.chunks = [];
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
      return stdout.frame();
    },
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

describe("the message history face", () => {
  test("says what it is and what it will do when it is empty", async () => {
    const face = await mount();
    try {
      expect(face.frame()).toContain("Message history");
      expect(face.frame()).toContain("Nothing yet");
      expect(face.frame()).toContain("C clear");
      expect(face.frame()).toContain("Esc close");
    } finally {
      face.stop();
    }
  });

  test("lists the newest entry first, with its clock, its kind and its text", async () => {
    recordMessageHistory("turn", "Turn finished", { at: BASE });
    recordMessageHistory("error", "Stream error", { at: BASE + 60_000 });
    const face = await mount();
    try {
      const frame = face.frame();
      expect(frame).toContain("turn");
      expect(frame).toContain("Turn finished");
      expect(frame).toContain("Stream error");
      expect(frame.indexOf("Stream error")).toBeLessThan(
        frame.indexOf("Turn finished"),
      );
    } finally {
      face.stop();
    }
  });

  test("opening it clears the unread count", async () => {
    recordMessageHistory("turn", "Turn finished", { at: BASE });
    expect(getMessageHistorySnapshot().unread).toBe(1);

    const face = await mount();
    try {
      expect(getMessageHistorySnapshot().unread).toBe(0);
    } finally {
      face.stop();
    }
  });

  test("C asks before it clears, and the default answer keeps the log", async () => {
    recordMessageHistory("turn", "Turn finished", { at: BASE });
    const face = await mount();
    try {
      const confirm = await face.frameAfter(["c"]);
      expect(confirm).toContain("Clear the message history?");
      expect(confirm).toContain("Yes, clear");
      expect(confirm).toContain("No, keep");

      const back = await face.frameAfter([ENTER]);
      expect(back).not.toContain("Clear the message history?");
      expect(getMessageHistorySnapshot().entries).toHaveLength(1);
    } finally {
      face.stop();
    }
  });

  test("choosing to clear empties the log", async () => {
    recordMessageHistory("turn", "Turn finished", { at: BASE });
    const face = await mount();
    try {
      await face.press("c");
      await face.frameAfter([UP, ENTER]);

      expect(getMessageHistorySnapshot().entries).toEqual([]);
      expect(face.frame()).toContain("Nothing yet");
    } finally {
      face.stop();
    }
  });

  test("Escape closes the face instead of clearing anything", async () => {
    recordMessageHistory("turn", "Turn finished", { at: BASE });
    const face = await mount();
    try {
      await face.press(ESCAPE);

      expect(face.closed()).toBe(1);
      expect(getMessageHistorySnapshot().entries).toHaveLength(1);
    } finally {
      face.stop();
    }
  });
});
