import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import {
  registerBindingOwner,
  resetBindingOwners,
} from "@/cli/helpers/input-router";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { armLeader, disarmLeader, resetLeader } from "@/cli/helpers/leader";
import { LeaderHint } from "./LeaderHint";

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
          run: () => {},
        },
        ...(extra
          ? [
              {
                id: "leader.mouse",
                leader: true,
                chords: [{ key: "m" }],
                label: "切换鼠标上报",
                run: () => {},
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
});

describe("LeaderHint", () => {
  test("renders nothing while the prefix is off", async () => {
    registerLeaderBindings();
    const output = await frame();
    expect(output).not.toContain("ctrl+x");
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

  test("collapses again when the prefix is left", async () => {
    registerLeaderBindings();
    armLeader();
    disarmLeader();
    const output = await frame();
    expect(output).not.toContain("ctrl+x");
  });
});
