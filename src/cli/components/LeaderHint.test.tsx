import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { render } from "ink";
import { resetTabsForTests } from "@/cli/app/tabs";
import { commands } from "@/cli/commands/registry";
import { visibleWidth } from "@/cli/helpers/ansi-scan";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import {
  registerBindingOwner,
  resetBindingOwners,
} from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { armLeader, disarmLeader, resetLeader } from "@/cli/helpers/leader";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { useInputRouter } from "@/cli/hooks/use-input-router";
import {
  recordMessageHistory,
  resetMessageHistoryForTests,
} from "@/cli/notifications/history-store";
import {
  openMessageHistory,
  registerMessageHistoryOpener,
  resetMessageHistoryOpenerForTests,
} from "@/cli/notifications/message-history-request";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import {
  contextHint,
  LeaderHint,
  UNREAD_MARKER,
  unreadSuffix,
  unreadSuffixSpan,
} from "./LeaderHint";

/**
 * The hint is the leader's only affordance, and its two guarantees are what the
 * tests pin: it costs no rows while the prefix is off, and it names the prefix
 * and its entries while it is on.
 *
 * The entries come from the registry, so the test registers the composer's
 * leader table the way the composer does — and adds a second entry, standing in
 * for M6 filling the table, to prove the hint follows the bindings rather than a
 * list of its own.
 *
 * The harness mirrors the raw-input equivalence test: Ink only renders its
 * terminal frames when both streams look like a TTY, so `isTTY` and a real
 * `Writable` are required even though nothing is typed here.
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

/** The composer's leader entries, plus one as if a later milestone added it. */
function registerLeaderBindings(extra = true): void {
  registerBindingOwner("hint-test", () => [
    {
      scope: "app",
      bindings: [
        {
          id: "leader.help",
          leader: true,
          chords: LEADER_KEY_CHORDS.help,
          label: "List available keys",
          run: () => "consumed",
        },
        ...(extra
          ? [
              {
                id: "leader.mouse",
                leader: true,
                chords: [{ key: "m" }],
                label: "Toggle mouse reporting",
                run: () => "consumed" as const,
              },
            ]
          : []),
      ],
    },
  ]);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

async function frame(): Promise<string> {
  const stdout = new CaptureStream();
  const instance = render(<LeaderHint />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await tick();
    return stdout.frame();
  } finally {
    instance.unmount();
  }
}

afterEach(() => {
  resetLeader();
  resetBindingOwners();
  resetMouseTrackingForTests();
  resetMouseHandlers();
  resetInkTtyState();
  resetTabsForTests();
  resetMessageHistoryForTests();
  resetMessageHistoryOpenerForTests();
});

describe("LeaderHint", () => {
  test("the idle row names the context's keys, not the armed list", async () => {
    registerLeaderBindings();
    const output = await frame();
    // M6's hint row (《38》§7.3): always one row, always the current context.
    expect(output).toContain("Enter send");
    expect(output).toContain("ctrl+x ? keys");
    // The leader's own entry list belongs to the armed state.
    expect(output).not.toContain("List available keys");
  });

  test("names the prefix and every registered entry once armed", async () => {
    registerLeaderBindings();
    armLeader();
    const output = await frame();
    expect(output).toContain("ctrl+x");
    expect(output).toContain("List available keys");
    // The entry this test registered: the hint reads bindings, not a list.
    expect(output).toContain("Toggle mouse reporting");
  });

  test("the help entry expands the list and says how to leave", async () => {
    registerLeaderBindings();
    armLeader({ help: true });
    const output = await frame();
    expect(output).toContain("List available keys");
    expect(output).toContain("esc");
  });

  test("collapses back to the idle row when the prefix is left", async () => {
    registerLeaderBindings();
    armLeader();
    disarmLeader();
    const output = await frame();
    expect(output).not.toContain("List available keys");
    expect(output).toContain("Enter send");
  });
});

describe("the idle hint line", () => {
  test("a conversation offers sending, the tab list and the leader", () => {
    const line = contextHint({ pageActive: false, mouseEnabled: true });
    expect(line).toContain("Enter send");
    expect(line).toContain("Shift+Enter newline");
    // P2 registered the commands the design's copy names, so the row says them
    // now: `/tabs` is the keyboard's way to change tabs.
    expect(line).toContain("/tabs");
    expect(line).toContain("ctrl+x ? keys");
  });

  test("without mouse reporting the row leads with the way back", () => {
    const line = contextHint({ pageActive: false, mouseEnabled: false });
    expect(line).toContain("Enter send");
    expect(line).toContain("ctrl+x m mouse on");
    // Nothing tells the user to click when clicking does nothing.
    expect(line).not.toContain("click a tab");
    expect(line).not.toContain("drag");
    // The keyboard's own door to the strip survives with the mouse off.
    expect(line).toContain("/tabs");
    expect(line).toContain("/close");
  });

  test("a page offers the way back, whichever input is available", () => {
    const withMouse = contextHint({ pageActive: true, mouseEnabled: true });
    expect(withMouse).toStartWith("click a tab to switch");
    expect(withMouse).toContain("Esc back to chat");
    // With reporting off the leader's own toggle is the only way out of a page,
    // so that is what the row names.
    const withoutMouse = contextHint({ pageActive: true, mouseEnabled: false });
    expect(withoutMouse).toContain("ctrl+x m mouse on");
    expect(withoutMouse).toContain("Esc back to chat");
  });

  /**
   * The row is one line at every width, and it is truncated rather than wrapped —
   * so the leader hint has to survive the longest variant on the narrowest screen
   * the shell supports (80 columns, 《38》§6.3's fold threshold).
   */
  test("the longest variant still shows the leader hint at 80 columns", () => {
    const lines = [
      contextHint({ pageActive: false, mouseEnabled: false }),
      contextHint({ pageActive: true, mouseEnabled: false }),
    ];
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(76);
    }
  });

  /**
   * The row's one hard rule: it never names a slash command the app does not have.
   * The design's copy (`/tabs`, `/close`, `/settings`) belongs to the batch that
   * registers them; until then a name here would resolve to "unknown command".
   */
  test("it names no slash command that is not registered", () => {
    const lines = [
      contextHint({ pageActive: false, mouseEnabled: true }),
      contextHint({ pageActive: false, mouseEnabled: false }),
      contextHint({ pageActive: true, mouseEnabled: true }),
      contextHint({ pageActive: true, mouseEnabled: false }),
    ];
    const named = new Set<string>();
    for (const line of lines) {
      for (const match of line.matchAll(/\/[a-z][a-z-]*/g)) named.add(match[0]);
    }
    expect([...named].filter((name) => commands[name] === undefined)).toEqual(
      [],
    );
  });

  /**
   * `docs/38` §15.2 puts the count at the end of this row, and only when there is
   * something to read: `unread 0` would spend columns saying "nothing happened".
   *
   * The chord beside it is the ruling's other half. A count with no visible way
   * to clear it is a permanent `unread 1` (the reported defect), so the tail names
   * the key that opens the face — in both contexts, because the face is reachable
   * from a page as well.
   */
  test("the unread count rides at the end, and only when it is not zero", () => {
    const idle = contextHint({ pageActive: false, mouseEnabled: true });
    const unread = contextHint({
      pageActive: false,
      mouseEnabled: true,
      unread: 3,
    });

    expect(idle).not.toContain("unread");
    expect(unread).toBe(`${idle}${unreadSuffix(3)}`);
    expect(unread).toContain("unread 3");
    expect(unread).toContain("ctrl+x h");
    for (const pageActive of [false, true]) {
      for (const mouseEnabled of [false, true]) {
        expect(contextHint({ pageActive, mouseEnabled, unread: 1 })).toContain(
          "ctrl+x h",
        );
      }
    }
    expect(
      contextHint({ pageActive: true, mouseEnabled: true, unread: 0 }),
    ).not.toContain("unread");
  });

  /**
   * The subscription is what makes it appear at all: the row is a leaf, and the
   * store changes while it is mounted (a turn finishing is not a keystroke).
   */
  test("the frame picks the count up from the history store", async () => {
    const root = await mkdtemp(join(tmpdir(), "haruyuki-hint-"));
    const original = process.env.HARUYUKI_HOME;
    process.env.HARUYUKI_HOME = root;
    try {
      recordMessageHistory("turn", "Turn finished");
      expect(await frame()).toContain("unread 1");
    } finally {
      if (original === undefined) delete process.env.HARUYUKI_HOME;
      else process.env.HARUYUKI_HOME = original;
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The click target's arithmetic, without a renderer.
 *
 * Columns, not string indices: the span is measured in cells, so a wide
 * character before the tail would put every `.length`-based offset short of the
 * thing it means to point at. That is the bug this suite exists to keep from
 * coming back, and it is invisible in a frame assertion — the row paints fine
 * either way.
 */
describe("the unread tail's cell span", () => {
  const TAIL_LINE = "Enter send · unread 3 · ctrl+x h";

  test("measures the tail in terminal columns", () => {
    // The tail starts at its leading separator, i.e. after `Enter send` (10
    // cells), and runs to the end of the 32-cell line.
    expect(TAIL_LINE.length).toBe(32);
    expect(terminalTextWidth(TAIL_LINE)).toBe(32);
    expect(unreadSuffixSpan(TAIL_LINE, 80)).toEqual({ from: 10, to: 32 });
  });

  test("a wide character before the tail shifts columns, not indices", () => {
    // A full-width prefix is two cells but one code unit each: the text is 24
    // code units and 26 cells, so a `.length` offset would start the tail at
    // column 2 instead of column 4.
    const line = "ＡＡ · unread 3 · ctrl+x h";
    expect(line.length).toBe(24);
    expect(terminalTextWidth(line)).toBe(26);
    expect(unreadSuffixSpan(line, 80)).toEqual({ from: 4, to: 26 });
  });

  test("a row truncated inside the tail keeps the painted part clickable", () => {
    expect(unreadSuffixSpan(TAIL_LINE, 20)).toEqual({ from: 10, to: 20 });
  });

  test("a row truncated before the tail has no target at all", () => {
    // The tail's first column is 70 here, past the 60 cells the row painted.
    const line = `${"x".repeat(70)} · unread 3 · ctrl+x h`;
    expect(unreadSuffixSpan(line, 60)).toBeNull();
    // Truncated exactly at its first column: nothing of the tail is on screen.
    expect(unreadSuffixSpan(line, 70)).toBeNull();
    // One column of it is: that one cell is the target.
    expect(unreadSuffixSpan(line, 71)).toEqual({ from: 70, to: 71 });
  });

  test("a row with no tail has no target", () => {
    expect(unreadSuffixSpan("ctrl+x … m toggle mouse", 80)).toBeNull();
    expect(unreadSuffixSpan("Turn finished", 80)).toBeNull();
  });
});

/**
 * The badge as the user meets it: painted by the real component, clicked through
 * the real router with the bytes a terminal sends.
 *
 * The column is read out of the frame that was painted, never hard-coded: the
 * point is that the handler aims where the row drew the tail, and a literal here
 * would pass while the row moved.
 */
describe("clicking the unread tail", () => {
  const ESC = "\u001B";
  const settle = (ms = 120) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** A left press and release on one screen cell (1-based row and column). */
  function clickAt(tty: InkTty, row: number, column: number): Promise<void> {
    return tty.press(
      `${ESC}[<0;${column};${row}M`,
      `${ESC}[<0;${column};${row}m`,
    );
  }

  function mountHint(): InkTty {
    function Probe() {
      // The router claims mouse reports before Ink parses them; without it a
      // report is text and no handler is reachable. The shell always installs it
      // (`ShellFrame`), so this mirrors the real frame rather than adding a seam.
      useInputRouter();
      return <LeaderHint />;
    }
    // Wide enough that the whole tail is painted (the longest variant is 74
    // columns before it), so a click cannot be refused for truncation.
    return mountInkTty(<Probe />, { columns: 100, rows: 24 });
  }

  /** The 0-based screen column where the painted row starts the tail. */
  function tailColumn(rowText: string): number {
    const marker = rowText.indexOf(UNREAD_MARKER);
    expect(marker).toBeGreaterThanOrEqual(0);
    return terminalTextWidth(rowText.slice(0, marker));
  }

  test("a click on the badge opens the message history face", async () => {
    const root = await mkdtemp(join(tmpdir(), "haruyuki-hint-click-"));
    const original = process.env.HARUYUKI_HOME;
    process.env.HARUYUKI_HOME = root;
    let opened = 0;
    const dispose = registerMessageHistoryOpener(() => {
      opened += 1;
    });
    const tty = mountHint();
    try {
      recordMessageHistory("turn", "Turn finished");
      // The store publishes outside the keystroke path; give the row its frame.
      await settle(300);
      const rows = await tty.rows();
      const rowText = rows[0] ?? "";
      expect(rowText).toContain("unread 1");
      // The chord is painted, not only present in the string builder: this is
      // the discoverability half of the ruling, and a row is where it lands.
      expect(rowText).toContain("ctrl+x h");

      const column = tailColumn(rowText) + 2;
      await clickAt(tty, 1, column);
      await settle();
      expect(opened).toBe(1);

      // A second click elsewhere on the same row is not the badge: "Enter send"
      // is ordinary hint text, and the click is not this row's to swallow.
      await clickAt(tty, 1, 3);
      await settle();
      expect(opened).toBe(1);
    } finally {
      dispose();
      tty.stop();
      if (original === undefined) delete process.env.HARUYUKI_HOME;
      else process.env.HARUYUKI_HOME = original;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with no opener registered the click is a safe no-op", async () => {
    const tty = mountHint();
    try {
      recordMessageHistory("turn", "Turn finished");
      await settle(300);
      const rowText = (await tty.rows())[0] ?? "";
      const column = tailColumn(rowText) + 2;
      expect(openMessageHistory()).toBe(false);
      await clickAt(tty, 1, column);
      await settle();
      // Nothing was raised, and the row is still there: the append shell's state
      // (no face at all) is the one this mirrors.
      expect(await tty.text()).toContain("unread 1");
    } finally {
      tty.stop();
    }
  });
});
