import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { Text } from "@/cli/components/Text";
import { owningInputScope, resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";
import { type OverlayContainer, OverlayFrame } from "@/cli/overlay/frame";

/**
 * The frame is judged on the rows it draws, and on the scope it occupies.
 *
 * Both halves matter and neither implies the other: the markup is what the user
 * sees, and the scope claim is what makes the router able to route the overlay's
 * keys at all. A frame that paints perfectly and claims nothing leaves every key
 * bound through `useOverlayList` unreachable — a wiring bug a snapshot of the
 * picture cannot see.
 */

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

/** A frame with no capture harness, for the scope-claim tests. */
function mountBareFrame() {
  return render(
    <OverlayFrame command="/a" title="A">
      <Text>a</Text>
    </OverlayFrame>,
    {
      stdin: fakeStdin(),
      stdout: new CaptureStream() as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
}

function mountFrame(container?: OverlayContainer) {
  const stdout = new CaptureStream() as unknown as NodeJS.WriteStream;
  const release = installTerminalFrameCapture(stdout);
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const instance = render(
    <OverlayFrame
      command="/personality"
      title="Choose a personality"
      container={container}
      footer="Enter select · Esc cancel"
    >
      <Text>body text</Text>
    </OverlayFrame>,
    {
      stdin,
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  return {
    async rows(): Promise<readonly string[]> {
      await tick();
      return getTerminalFrame()?.text ?? [];
    },
    stop() {
      instance.unmount();
      instance.cleanup();
      release();
    },
  };
}

afterEach(() => {
  resetInputScopes();
  resetBindingOwners();
  resetTerminalFrameForTests();
});

describe("OverlayFrame", () => {
  test("paints the command, a solid line, the title, the body and a string footer", async () => {
    const frame = mountFrame();
    try {
      const rows = await frame.rows();
      const painted = rows.join("\n");

      expect(painted).toContain("> /personality");
      expect(rows.some((row) => /^─{10,}$/.test(row.trim()))).toBe(true);
      expect(painted).toContain("Choose a personality");
      expect(painted).toContain("body text");
      // A plain string footer is wrapped in `<Text>`. Passed raw, Ink throws
      // during commit and nothing paints — which is the regression the two
      // existing overlay tests were written for.
      expect(painted).toContain("Enter select");
      expect(painted).not.toContain("must be rendered inside");
    } finally {
      frame.stop();
    }
  });

  test("claims the overlay scope for its whole mounted life", async () => {
    expect(owningInputScope()).toBe("app");
    const frame = mountFrame();
    try {
      await tick();
      expect(owningInputScope()).toBe("overlay");
    } finally {
      frame.stop();
    }
    // Released on unmount: a leaked claim would keep the app layer from ever
    // owning input again.
    expect(owningInputScope()).toBe("app");
  });

  test("claims the modal layer when its container outranks an overlay", async () => {
    const frame = mountFrame("modal");
    try {
      await tick();
      expect(owningInputScope()).toBe("modal");
    } finally {
      frame.stop();
    }
    expect(owningInputScope()).toBe("app");
  });

  test("the claim is ref-counted, so the shell's and the frame's coexist", async () => {
    // In the app the shell claims `overlay` from the open route and the frame
    // claims it from being on screen. Neither may release the other's claim —
    // the last frame to unmount is the only one that may hand input back.
    const first = mountBareFrame();
    const second = mountBareFrame();
    try {
      await tick();
      expect(owningInputScope()).toBe("overlay");

      first.unmount();
      first.cleanup();
      await tick();
      expect(owningInputScope()).toBe("overlay");
    } finally {
      second.unmount();
      second.cleanup();
    }
    expect(owningInputScope()).toBe("app");
  });
});
