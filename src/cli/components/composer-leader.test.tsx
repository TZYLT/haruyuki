import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import {
  isLeaderArmed,
  isLeaderHelpOpen,
  resetLeader,
} from "@/cli/helpers/leader";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { buildModInvocationContext } from "@/mods/context";
import { settingsManager } from "@/settings-manager";
import { Input } from "./InputRich";

/**
 * The leader prefix, driven through the **real composer** and judged on the
 * rendered frame.
 *
 * This is the level the router's own tests cannot reach, and the gap cost a real
 * defect: every router-level assertion about the help entry passed — the entry
 * ran, it armed the list — while the screen showed nothing, because the router
 * disarmed the prefix *after* running the entry and erased the re-arm in the same
 * keystroke. The state was right and the picture was empty. Judging the frame is
 * the only way to catch that class of bug, so these tests read the frame.
 *
 * The harness is the composer's own: a fake TTY stdin and a stream that captures
 * what Ink writes, so `Input` renders its real terminal output.
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

const ESCAPE = "\u001b";
/**
 * Terminal control sequences. Built from an escape character rather than written
 * as a regex literal, because a literal may not contain control characters.
 */
const ANSI = new RegExp(
  `${ESCAPE}\\[[0-9;?]*[a-zA-Z]|${ESCAPE}\\][^\\u0007]*\\u0007|${ESCAPE}[=>]|${ESCAPE}\\(B`,
  "g",
);

const CTRL_X = "\u0018";
/** `?` under the kitty keyboard protocol: Shift+/ as a modified `/`. */
const KITTY_QUESTION = "\u001b[63;2u";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function mountComposer() {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new NullOutput();
  const instance = render(
    <Input
      streaming={false}
      tokenCount={0}
      thinkingMessage=""
      terminalWidth={100}
      shouldAnimate={false}
      onSubmit={async () => ({ submitted: true })}
      modContext={buildModInvocationContext({
        agent: { id: "agent-composer-leader" },
      })}
      modAdapter={
        {
          hadModPanels: false,
          hasModSources: false,
          isLoading: false,
        } as unknown as LocalModAdapter
      }
    />,
    {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  return {
    /**
     * Presses keys, then returns the part of the terminal output the keys
     * produced. Ink erases its previous frame before writing the next one, so
     * the new chunk is that frame plus the erase codes, which `ANSI` strips.
     */
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
      // One more turn so a two-render update (erase, then frame) is complete.
      await tick();
      return stdout.chunks.slice(mark).join("").replace(ANSI, "");
    },
    /** Waits without typing, to prove what the screen does on its own. */
    async idle(ms: number): Promise<string> {
      const mark = stdout.chunks.length;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return stdout.chunks.slice(mark).join("").replace(ANSI, "");
    },
    unmount() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

let previousHome: string | undefined;
let tempHome: string;

beforeAll(async () => {
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-composer-leader-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterAll(async () => {
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
});

afterEach(() => {
  // The prefix is module state shared with every other test in this worker.
  resetLeader();
  resetBindingOwners();
  resetInputScopes();
});

describe("composer leader prefix", () => {
  test("Ctrl+X announces the prefix without opening the list", async () => {
    const composer = mountComposer();
    try {
      const frame = await composer.press(CTRL_X);
      expect(frame).toContain("ctrl+x");
      expect(frame).toContain("List available keys");
      expect(frame).not.toContain("esc exit");
    } finally {
      composer.unmount();
    }
  });

  test("? opens the leader list, keeps it open, and types nothing", async () => {
    const composer = mountComposer();
    try {
      await composer.press(CTRL_X);
      const frame = await composer.press("?");
      expect(frame).toContain("ctrl+x ? — List available keys");
      expect(frame).toContain("esc exit");
      // Not typed into the draft: the prompt row is still empty.
      expect(frame).toMatch(/^>\s*$/m);
      // The list is a surface to read: it must survive on its own, with the
      // prefix still armed behind it so a key from the list still works.
      await composer.idle(400);
      expect(isLeaderArmed()).toBe(true);
      expect(isLeaderHelpOpen()).toBe(true);
    } finally {
      composer.unmount();
    }
  });

  test("the kitty encoding of ? opens the same list", async () => {
    const composer = mountComposer();
    try {
      await composer.press(CTRL_X);
      const frame = await composer.press(KITTY_QUESTION);
      expect(frame).toContain("esc exit");
      expect(frame).toContain("List available keys");
    } finally {
      composer.unmount();
    }
  });

  test("the prefix is one-shot: the next plain letter is typing", async () => {
    const composer = mountComposer();
    try {
      await composer.press(CTRL_X);
      const frame = await composer.press("a");
      // The prefix was left, and the letter reached the draft. The bottom row
      // still names the prefix (M6's hint row does), so the armed *list* is what
      // has to be gone.
      expect(frame).not.toContain("List available keys");
      expect(frame).toMatch(/^>\s*a\s*$/m);
    } finally {
      composer.unmount();
    }
  });

  test("Escape leaves the prefix and the list", async () => {
    const composer = mountComposer();
    try {
      await composer.press(CTRL_X);
      await composer.press("?");
      const frame = await composer.press(ESCAPE);
      expect(frame).not.toContain("List available keys");
      expect(frame).not.toContain("esc exit");
    } finally {
      composer.unmount();
    }
  });
});
