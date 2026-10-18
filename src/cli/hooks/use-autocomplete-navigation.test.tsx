import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import { useCallback, useEffect } from "react";
import { useAutocompleteNavigation } from "@/cli/hooks/use-autocomplete-navigation";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * Tab and Return are shared keys.
 *
 * The hook is the legacy half of the autocomplete (the key table owns Shift+Tab and
 * Shift+Enter), and under the kitty protocol those modified forms arrive as CSI-u
 * sequences the raw shield deliberately leaves alone — so a single keystroke used to
 * both flip the permission mode and accept the highlighted completion. This weighs the
 * hook's own half of that contract on real input.
 *
 * The second half of the file weighs what the migration onto the router bought:
 * ↑/↓ are **consumed** while the popup has matches (so a legacy listener — the
 * composer's history handler — never sees them) and **declined** when there is
 * nothing to navigate (so that listener still does). Consuming is invisible to a
 * state assertion, which is why the probe below watches a legacy `useInput`
 * instead.
 */

const ESCAPE = "\u001B";
const SHIFT_TAB_KITTY = `${ESCAPE}[9;2u`;
const SHIFT_ENTER_KITTY = `${ESCAPE}[13;2u`;
const DOWN = `${ESCAPE}[B`;
const UP = `${ESCAPE}[A`;

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

function createStdin(): NodeJS.ReadStream {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function renderProbe(element: React.ReactElement) {
  const stdin = createStdin();
  const instance = render(element, {
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

function mountProbe(seen: string[]) {
  function Probe() {
    useAutocompleteNavigation({
      matches: ["one", "two"],
      onSelect: (item) => seen.push(`select:${item}`),
      onAutocomplete: (item) => seen.push(`accept:${item}`),
    });
    return <Text>probe</Text>;
  }

  return renderProbe(<Probe />);
}

/**
 * The probe the ownership cases need: the hook's cursor, plus a **second table in
 * the same scope, registered after it**. The router tries a scope's tables in
 * registration order and stops at the first that consumes, so this one runs only
 * when the popup declined — which is the observable half of "the popup owns
 * ↑/↓".
 *
 * A legacy `useInput` would *not* be a usable probe here: the raw shield reads
 * single characters and its own table of multi-character sequences, and an arrow
 * is neither, so an unclaimed payload is dispatched to every Ink listener
 * regardless (`input-router.ts` reading 2). That is why `InputRich`'s history
 * handler keeps its own `isAutocompleteActive` guard instead of relying on being
 * shielded.
 */
function mountOwnershipProbe(matches: string[], seen: string[]) {
  function Probe() {
    const { selectedIndex } = useAutocompleteNavigation({
      matches,
      onSelect: (item) => seen.push(`select:${item}`),
    });
    const recordIndex = useCallback(
      (index: number) => {
        seen.push(`index:${index}`);
      },
      [seen],
    );
    useEffect(() => {
      recordIndex(selectedIndex);
    }, [recordIndex, selectedIndex]);
    useKeyBindings("probe-after-autocomplete", [
      {
        scope: "app",
        bindings: [
          {
            id: "probe.arrow",
            chords: [{ key: "upArrow" }, { key: "downArrow" }],
            run: () => {
              seen.push("later:arrow");
              return "consumed";
            },
          },
        ],
      },
    ]);
    return <Text>probe</Text>;
  }

  return renderProbe(<Probe />);
}

afterEach(() => {
  // The router keeps module-level stores (binding owners, scope claims) across
  // mounts now that the hook registers a table.
  resetInkTtyState();
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

describe("autocomplete navigation on the input router", () => {
  test("↑ and ↓ move the cursor and are consumed ahead of the next table", async () => {
    const seen: string[] = [];
    const probe = mountOwnershipProbe(["one", "two"], seen);
    try {
      await probe.press(DOWN);
      await probe.press(DOWN);
      await probe.press(UP);
      expect(seen.filter((entry) => entry.startsWith("index:"))).toEqual([
        "index:0",
        "index:1",
        "index:0",
        "index:1",
      ]);
      expect(seen).not.toContain("later:arrow");
    } finally {
      probe.stop();
    }
  });

  test("with nothing to navigate the arrow is declined and the next table gets it", async () => {
    const seen: string[] = [];
    const probe = mountOwnershipProbe([], seen);
    try {
      await probe.press(DOWN);
      await probe.press(UP);
      expect(seen.filter((entry) => entry === "later:arrow")).toHaveLength(2);
      expect(seen.filter((entry) => entry.startsWith("index:"))).toEqual([
        "index:0",
      ]);
    } finally {
      probe.stop();
    }
  });
});
