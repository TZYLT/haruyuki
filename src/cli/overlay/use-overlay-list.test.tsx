import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { type Key, render, Text, useInput } from "ink";
import { owningInputScope, resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import {
  type OverlayListController,
  useOverlayList,
} from "@/cli/overlay/use-overlay-list";

/**
 * The list's wiring, on real input.
 *
 * Every assertion about a *consumed* key is made on a sequence the raw layer
 * reads exactly (`input-sequence.ts`: Home, End, PageUp/PageDown, Enter, Space,
 * Escape, and any single character). For those, a consumed key never reaches a
 * listener at all, so the probe's legacy `useInput` is a faithful witness of
 * "did this key get swallowed, or did it travel on". Arrow keys are not in that
 * table — they arrive through the router's Ink-parsed fallback, where every
 * listener runs regardless — so for arrows the assertion is the cursor itself.
 */

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

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const LEFT = "\u001B[D";
const HOME = "\u001B[H";
const END = "\u001B[F";
const PAGE_DOWN = "\u001B[6~";
const ENTER = "\r";
const SPACE = " ";
const ESCAPE = "\u001B";

function rows(count: number): OverlayListItem[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `k${index}`,
    label: `Row ${index + 1}`,
  }));
}

/** A name for a key event, so "the legacy path saw it" can be asserted. */
function describeEvent(input: string, key: Key): string {
  if (key.home) return "home";
  if (key.end) return "end";
  if (key.pageDown) return "pageDown";
  if (key.pageUp) return "pageUp";
  if (key.return) return "return";
  if (key.escape) return "escape";
  if (input === " ") return "space";
  return input;
}

interface ProbeOptions {
  items: OverlayListItem[];
  initialCursorIndex?: number;
  rows?: number;
  /** The two containers a list may claim; spelled out so the alias stays local. */
  scope?: "overlay" | "modal";
  navigationEnabled?: boolean;
  vimKeys?: boolean;
  edgeKeys?: boolean;
  onConfirm?: (key: string, index: number) => void;
  onCancel?: () => void;
  onToggle?: (key: string, index: number) => void;
  onMoveItem?: (direction: "up" | "down", index: number) => void;
}

function mountProbe(options: ProbeOptions) {
  const latest: { current: OverlayListController | undefined } = {
    current: undefined,
  };
  /** Keys that reached the listener the router would have taken them from. */
  const unrouted: string[] = [];
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  let items = options.items;

  function Probe() {
    useInput((input, key) => {
      unrouted.push(describeEvent(input, key));
    });

    const list = useOverlayList({
      owner: "probe-overlay-list",
      items,
      initialCursorIndex: options.initialCursorIndex,
      rows: options.rows,
      scope: options.scope,
      navigationEnabled: options.navigationEnabled,
      vimKeys: options.vimKeys,
      edgeKeys: options.edgeKeys,
      onConfirm: options.onConfirm,
      onToggle: options.onToggle,
      onMoveItem: options.onMoveItem,
      onCancel: options.onCancel ?? (() => {}),
    });
    latest.current = list;
    return <Text>{`cursor:${list.cursor}`}</Text>;
  }

  const instance = render(<Probe />, {
    stdin,
    stdout: new NullOutput() as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    latest,
    unrouted,
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    async setItems(next: OverlayListItem[]) {
      items = next;
      instance.rerender(<Probe />);
      await tick();
    },
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

afterEach(() => {
  resetInputScopes();
  resetBindingOwners();
});

describe("useOverlayList", () => {
  test("moves on the arrows and on j/k", async () => {
    const probe = mountProbe({ items: rows(5) });
    try {
      await probe.press(DOWN);
      expect(probe.latest.current?.cursor).toBe(1);
      await probe.press("j");
      expect(probe.latest.current?.cursor).toBe(2);
      await probe.press(UP);
      expect(probe.latest.current?.cursor).toBe(1);
      await probe.press("k");
      expect(probe.latest.current?.cursor).toBe(0);
    } finally {
      probe.stop();
    }
  });

  test("clamps at both ends instead of wrapping", async () => {
    const probe = mountProbe({ items: rows(5) });
    try {
      await probe.press(UP);
      expect(probe.latest.current?.cursor).toBe(0);

      await probe.press(DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN);
      expect(probe.latest.current?.cursor).toBe(4);
    } finally {
      probe.stop();
    }
  });

  test("Home and End jump, and the key they answer is taken off the legacy path", async () => {
    const probe = mountProbe({ items: rows(5), initialCursorIndex: 2 });
    try {
      await probe.press(HOME);
      expect(probe.latest.current?.cursor).toBe(0);

      await probe.press(END);
      expect(probe.latest.current?.cursor).toBe(4);

      // Both were consumed, so nothing downstream ever saw them.
      expect(probe.unrouted).toEqual([]);
    } finally {
      probe.stop();
    }
  });

  test("confirms the item under the cursor, and hand a disabled one through too", async () => {
    const confirmed: string[] = [];
    const enabled = mountProbe({
      items: rows(3),
      initialCursorIndex: 1,
      onConfirm: (key) => confirmed.push(key),
    });
    try {
      await enabled.press(ENTER);
      expect(confirmed).toEqual(["k1"]);
      expect(enabled.unrouted).toEqual([]);
    } finally {
      enabled.stop();
    }

    const disabled = mountProbe({
      items: [{ key: "only", label: "Only", disabled: true }],
      onConfirm: (key) => confirmed.push(key),
    });
    try {
      await disabled.press(ENTER);
      // The list does not decide what a blocked row means — the caller does
      // (`SingleSelectPicker` confirms nothing there, `MultiSelectPicker`
      // confirms the selection from there). What the list guarantees is that the
      // key is spent rather than falling through to whatever else listens.
      expect(confirmed).toEqual(["k1", "only"]);
      expect(disabled.unrouted).toEqual([]);
    } finally {
      disabled.stop();
    }
  });

  test("declines Enter when the list cannot confirm", async () => {
    const probe = mountProbe({ items: rows(3) });
    try {
      await probe.press(ENTER);
      expect(probe.unrouted).toEqual(["return"]);
    } finally {
      probe.stop();
    }
  });

  test("gives every key back while a text sub-view owns them", async () => {
    let cancelled = 0;
    const probe = mountProbe({
      items: rows(5),
      initialCursorIndex: 2,
      navigationEnabled: false,
      onCancel: () => {
        cancelled += 1;
      },
    });
    try {
      await probe.press(HOME);
      await probe.press("j");
      await probe.press(PAGE_DOWN);
      expect(probe.latest.current?.cursor).toBe(2);
      expect(probe.unrouted).toEqual(["home", "j", "pageDown"]);

      // Except the way out: an overlay that cannot be left is a trap.
      await probe.press(ESCAPE);
      expect(cancelled).toBe(1);
      expect(probe.unrouted).toEqual(["home", "j", "pageDown"]);
    } finally {
      probe.stop();
    }
  });

  test("Space toggles the item under the cursor, blocked rows included", async () => {
    const toggled: string[] = [];
    const enabled = mountProbe({
      items: rows(3),
      initialCursorIndex: 1,
      onToggle: (key) => toggled.push(key),
    });
    try {
      await enabled.press(SPACE);
      expect(toggled).toEqual(["k1"]);
      expect(enabled.unrouted).toEqual([]);
    } finally {
      enabled.stop();
    }

    const disabled = mountProbe({
      items: [{ key: "only", label: "Only", disabled: true }],
      onToggle: (key) => toggled.push(key),
    });
    try {
      await disabled.press(SPACE);
      // Handed through, like Enter: the caller owns the disabled policy.
      expect(toggled).toEqual(["k1", "only"]);
      expect(disabled.unrouted).toEqual([]);
    } finally {
      disabled.stop();
    }
  });

  test("reorders the item under the cursor on ←/→", async () => {
    const moved: string[] = [];
    const probe = mountProbe({
      items: rows(3),
      initialCursorIndex: 1,
      onMoveItem: (direction, index) => moved.push(`${direction}:${index}`),
    });
    try {
      await probe.press(LEFT);
      expect(moved).toEqual(["up:1"]);
    } finally {
      probe.stop();
    }
  });

  test("turns j/k back into letters when a text field shares the overlay", async () => {
    const probe = mountProbe({ items: rows(5), vimKeys: false });
    try {
      await probe.press("j");
      expect(probe.latest.current?.cursor).toBe(0);
      expect(probe.unrouted).toEqual(["j"]);

      // The arrow still navigates: only the bare letters were given up.
      await probe.press(DOWN);
      expect(probe.latest.current?.cursor).toBe(1);
    } finally {
      probe.stop();
    }
  });

  test("gives Home/End up when a neighbour owns the caret", async () => {
    // `/connect`'s provider list sits beside a live filter, where Home and End are
    // the caret's — and the claim there has to be unconditional, because that
    // filter remounts behind the list whenever the overlay walks into a step and
    // back (`list-bindings.ts`). Both halves are asserted, since a switch that
    // silently stopped claiming the keys altogether would look the same.
    const claiming = mountProbe({ items: rows(5), initialCursorIndex: 2 });
    try {
      await claiming.press(END);
      expect(claiming.latest.current?.cursor).toBe(4);
      await claiming.press(HOME);
      expect(claiming.latest.current?.cursor).toBe(0);
    } finally {
      claiming.stop();
    }

    const givenUp = mountProbe({
      items: rows(5),
      initialCursorIndex: 2,
      edgeKeys: false,
    });
    try {
      await givenUp.press(END, HOME);
      expect(givenUp.latest.current?.cursor).toBe(2);
      expect(givenUp.unrouted).toEqual(["end", "home"]);
    } finally {
      givenUp.stop();
    }
  });

  test("claims the scope it binds in, and releases it on unmount", async () => {
    expect(owningInputScope()).toBe("app");
    const overlay = mountProbe({ items: rows(2) });
    try {
      await tick();
      expect(owningInputScope()).toBe("overlay");
    } finally {
      overlay.stop();
    }
    expect(owningInputScope()).toBe("app");

    const modal = mountProbe({ items: rows(2), scope: "modal" });
    try {
      await tick();
      expect(owningInputScope()).toBe("modal");
    } finally {
      modal.stop();
    }
    expect(owningInputScope()).toBe("app");
  });

  test("reports the window, and remembers the cursor across a shrinking list", async () => {
    const probe = mountProbe({ items: rows(10), rows: 3 });
    try {
      expect(probe.latest.current?.window).toEqual({
        start: 0,
        end: 3,
        above: 0,
        below: 7,
        total: 10,
      });

      await probe.press(DOWN, DOWN, DOWN, DOWN, DOWN);
      expect(probe.latest.current?.cursor).toBe(5);
      expect(probe.latest.current?.window).toEqual({
        start: 3,
        end: 6,
        above: 3,
        below: 4,
        total: 10,
      });

      // A filter narrows the list: the cursor is clamped to what is on screen
      // immediately, not one frame later, and the item under it is a real one.
      await probe.setItems(rows(3));
      expect(probe.latest.current?.cursor).toBe(2);
      expect(probe.latest.current?.current?.key).toBe("k2");

      // Clearing the filter puts it back where the user left it.
      await probe.setItems(rows(10));
      expect(probe.latest.current?.cursor).toBe(5);
    } finally {
      probe.stop();
    }
  });

  test("moves the cursor from the caller's side too", async () => {
    const probe = mountProbe({ items: rows(4) });
    try {
      probe.latest.current?.setCursor(3);
      await tick();
      expect(probe.latest.current?.cursor).toBe(3);

      // Clamped, not thrown: a caller that has not re-read the list yet cannot
      // put the cursor out of range.
      probe.latest.current?.setCursor(99);
      await tick();
      expect(probe.latest.current?.cursor).toBe(3);
      expect(probe.latest.current?.current?.key).toBe("k3");
    } finally {
      probe.stop();
    }
  });
});
