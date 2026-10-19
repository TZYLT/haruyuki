import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import { resetTabsForTests } from "@/cli/app/tabs";
import {
  registerBindingOwner,
  resetBindingOwners,
} from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { armLeader, disarmLeader, resetLeader } from "@/cli/helpers/leader";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { contextHint, LeaderHint } from "./LeaderHint";

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
          label: "列出可用键",
          run: () => "consumed",
        },
        ...(extra
          ? [
              {
                id: "leader.mouse",
                leader: true,
                chords: [{ key: "m" }],
                label: "切换鼠标上报",
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
  resetTabsForTests();
});

describe("LeaderHint", () => {
  test("the idle row names the context's keys, not the armed list", async () => {
    registerLeaderBindings();
    const output = await frame();
    // M6's hint row (《38》§7.3): always one row, always the current context.
    expect(output).toContain("Enter 发送");
    expect(output).toContain("/tabs 标签");
    // The leader's own entry list belongs to the armed state.
    expect(output).not.toContain("列出可用键");
  });

  test("names the prefix and every registered entry once armed", async () => {
    registerLeaderBindings();
    armLeader();
    const output = await frame();
    expect(output).toContain("ctrl+x");
    expect(output).toContain("列出可用键");
    // The entry this test registered: the hint reads bindings, not a list.
    expect(output).toContain("切换鼠标上报");
  });

  test("the help entry expands the list and says how to leave", async () => {
    registerLeaderBindings();
    armLeader({ help: true });
    const output = await frame();
    expect(output).toContain("列出可用键");
    expect(output).toContain("esc");
  });

  test("collapses back to the idle row when the prefix is left", async () => {
    registerLeaderBindings();
    armLeader();
    disarmLeader();
    const output = await frame();
    expect(output).not.toContain("列出可用键");
    expect(output).toContain("Enter 发送");
  });
});

describe("the idle hint line", () => {
  test("a conversation offers sending, the tab commands and the leader", () => {
    const line = contextHint({ pageActive: false, mouseEnabled: true });
    expect(line).toContain("Enter 发送");
    expect(line).toContain("Shift+Enter 换行");
    expect(line).toContain("/tabs 标签");
    expect(line).toContain("ctrl+x ? 键位");
  });

  test("without mouse reporting it names the command path instead", () => {
    const line = contextHint({ pageActive: false, mouseEnabled: false });
    expect(line).toContain("/tabs 标签");
    expect(line).toContain("/close 关标签");
    // Nothing tells the user to click when clicking does nothing.
    expect(line).not.toContain("点标签");
  });

  test("a page points at the way back, whichever input is available", () => {
    expect(contextHint({ pageActive: true, mouseEnabled: true })).toStartWith(
      "点标签切换",
    );
    expect(contextHint({ pageActive: true, mouseEnabled: false })).toContain(
      "/close 关标签",
    );
  });
});
