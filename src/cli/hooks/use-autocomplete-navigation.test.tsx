import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import { useAutocompleteNavigation } from "@/cli/hooks/use-autocomplete-navigation";

/**
 * Tab and Return are shared keys.
 *
 * The hook is the legacy half of the autocomplete (the key table owns Shift+Tab and
 * Shift+Enter), and under the kitty protocol those modified forms arrive as CSI-u
 * sequences the raw shield deliberately leaves alone — so a single keystroke used to
 * both flip the permission mode and accept the highlighted completion. This weighs the
 * hook's own half of that contract on real input.
 */

const ESCAPE = "\u001B";
const SHIFT_TAB_KITTY = `${ESCAPE}[9;2u`;
const SHIFT_ENTER_KITTY = `${ESCAPE}[13;2u`;

class NullOutput extends Writable {
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

function mountProbe(seen: string[]) {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  function Probe() {
    useAutocompleteNavigation({
      matches: ["one", "two"],
      onSelect: (item) => seen.push(`select:${item}`),
      onAutocomplete: (item) => seen.push(`accept:${item}`),
    });
    return <Text>probe</Text>;
  }

  const instance = render(<Probe />, {
    stdin,
    stdout: new NullOutput() as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    async press(sequence: string) {
      stdin.push(sequence);
      await tick();
    },
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

afterEach(() => {
  // Nothing global to reset: each probe owns its own stdin.
});

describe("autocomplete navigation vs the key table", () => {
  test("a plain Tab or Enter still accepts the highlighted match", async () => {
    const seen: string[] = [];
    const probe = mountProbe(seen);
    try {
      await probe.press("\t");
      await probe.press("\r");
      expect(seen).toEqual(["accept:one", "select:one"]);
    } finally {
      probe.stop();
    }
  });

  test("a modified Tab or Enter is left to the key table", async () => {
    const seen: string[] = [];
    const probe = mountProbe(seen);
    try {
      await probe.press(SHIFT_TAB_KITTY);
      await probe.press(SHIFT_ENTER_KITTY);
      expect(seen).toEqual([]);
    } finally {
      probe.stop();
    }
  });
});
