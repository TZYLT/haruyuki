import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@/cli/helpers/input-keys";
import { matchingBindings } from "@/cli/helpers/input-keys";
import { keyEventFrom } from "@/cli/helpers/input-sequence";
import { type ListBindingHost, listBindings } from "./list-bindings";

/**
 * Dispatch exactly the way the router does: walk the matching bindings in order
 * and take the first that consumes. A `declined` binding must let the next one —
 * and finally the legacy handlers — have the key, which is the property these
 * tests exist to hold. The id that comes back is the binding that took it.
 */
function dispatch(host: ListBindingHost, event: KeyEvent): string | undefined {
  const table = listBindings(host);
  for (const binding of matchingBindings(table, event)) {
    if (binding.run(event) === "consumed") return binding.id;
  }
  return undefined;
}

interface Harness {
  host: ListBindingHost;
  moved: number[];
  reorders: ("up" | "down")[];
  confirms: number;
  cancels: number;
}

function harness(overrides: Partial<ListBindingHost> = {}): Harness {
  const moved: number[] = [];
  const state = {
    moved,
    reorders: [] as ("up" | "down")[],
    confirms: 0,
    cancels: 0,
    host: null as unknown as ListBindingHost,
  };
  state.host = {
    count: 5,
    cursor: 2,
    onMoveCursor: (index) => moved.push(index),
    onConfirm: () => {
      state.confirms += 1;
    },
    onCancel: () => {
      state.cancels += 1;
    },
    ...overrides,
  };
  return state;
}

describe("listBindings", () => {
  test("arrows move the cursor by one and clamp at the ends", () => {
    const up = harness({ cursor: 2 });
    expect(dispatch(up.host, keyEventFrom("", { upArrow: true }))).toBe(
      "overlay-list.up",
    );
    expect(up.moved).toEqual([1]);

    const down = harness({ cursor: 2 });
    dispatch(down.host, keyEventFrom("", { downArrow: true }));
    expect(down.moved).toEqual([3]);

    const top = harness({ cursor: 0 });
    dispatch(top.host, keyEventFrom("", { upArrow: true }));
    expect(top.moved).toEqual([0]);

    const bottom = harness({ cursor: 4 });
    dispatch(bottom.host, keyEventFrom("", { downArrow: true }));
    expect(bottom.moved).toEqual([4]);
  });

  test("j and k navigate by default, because the pickers did", () => {
    const host = harness();
    expect(dispatch(host.host, keyEventFrom("k"))).toBe("overlay-list.up");
    expect(dispatch(host.host, keyEventFrom("j"))).toBe("overlay-list.down");
    expect(host.moved).toEqual([1, 3]);
  });

  test("a chord names a key, so the shifted letter is the same key", () => {
    // `matchChord` compares case-insensitively by design. The pre-toolkit pickers
    // compared `input === "k"` and so ignored Shift+K; the table does not make that
    // distinction when the terminal does not report the modifier.
    const unmodified = harness();
    expect(dispatch(unmodified.host, keyEventFrom("K"))).toBe(
      "overlay-list.up",
    );

    // With the modifier reported (the kitty protocol), shift is a different key
    // and nothing in the table claims it.
    const shifted = harness();
    expect(
      dispatch(shifted.host, keyEventFrom("K", { shift: true })),
    ).toBeUndefined();
  });

  test("vimKeys off leaves the letters to whoever is typing", () => {
    const host = harness({ vimKeys: false });
    expect(dispatch(host.host, keyEventFrom("k"))).toBeUndefined();
    expect(dispatch(host.host, keyEventFrom("j"))).toBeUndefined();
    expect(dispatch(host.host, keyEventFrom("", { upArrow: true }))).toBe(
      "overlay-list.up",
    );
  });

  test("PageUp and PageDown step by the window", () => {
    const up = harness({ count: 10, cursor: 6, rows: 3 });
    dispatch(up.host, keyEventFrom("", { pageUp: true }));
    expect(up.moved).toEqual([3]);

    const down = harness({ count: 10, cursor: 3, rows: 3 });
    dispatch(down.host, keyEventFrom("", { pageDown: true }));
    expect(down.moved).toEqual([6]);
  });

  test("Home and End jump to the ends", () => {
    const host = harness({ count: 9, cursor: 4 });
    dispatch(host.host, keyEventFrom("", { home: true }));
    dispatch(host.host, keyEventFrom("", { end: true }));
    expect(host.moved).toEqual([0, 8]);
  });

  test("an empty list declines the navigation keys instead of eating them", () => {
    const host = harness({ count: 0 });
    for (const event of [
      keyEventFrom("", { upArrow: true }),
      keyEventFrom("", { downArrow: true }),
      keyEventFrom("", { pageUp: true }),
      keyEventFrom("", { home: true }),
      keyEventFrom("k"),
    ]) {
      expect(dispatch(host.host, event)).toBeUndefined();
    }
    expect(host.moved).toEqual([]);
  });

  test("Enter confirms when there is something to confirm", () => {
    const host = harness();
    expect(dispatch(host.host, keyEventFrom("\r", { return: true }))).toBe(
      "overlay-list.confirm",
    );
    expect(host.confirms).toBe(1);
  });

  test("Enter is declined by a list that cannot confirm", () => {
    const host = harness({ onConfirm: undefined });
    expect(
      dispatch(host.host, keyEventFrom("\r", { return: true })),
    ).toBeUndefined();
  });

  test("Enter is declined on an empty list, so the key is not lost", () => {
    const host = harness({ count: 0 });
    expect(
      dispatch(host.host, keyEventFrom("\r", { return: true })),
    ).toBeUndefined();
    expect(host.confirms).toBe(0);
  });

  test("Space toggles only where toggling is a thing", () => {
    let toggles = 0;
    const host = harness({
      onToggle: () => {
        toggles += 1;
      },
    });
    expect(dispatch(host.host, keyEventFrom(" "))).toBe("overlay-list.toggle");
    expect(toggles).toBe(1);

    const plain = harness();
    expect(dispatch(plain.host, keyEventFrom(" "))).toBeUndefined();
  });

  test("left and right reorder only where reordering is a thing", () => {
    const host = harness();
    const reorders: ("up" | "down")[] = [];
    const reordering = harness({
      onMoveItem: (direction) => {
        reorders.push(direction);
      },
    });
    dispatch(reordering.host, keyEventFrom("", { leftArrow: true }));
    dispatch(reordering.host, keyEventFrom("", { rightArrow: true }));
    expect(reorders).toEqual(["up", "down"]);

    expect(
      dispatch(host.host, keyEventFrom("", { leftArrow: true })),
    ).toBeUndefined();
  });

  test("Escape and Ctrl+C cancel, and are never declined", () => {
    const host = harness({ count: 0 });
    expect(dispatch(host.host, keyEventFrom("\u001b", { escape: true }))).toBe(
      "overlay-list.cancel",
    );
    // A doubled Escape arrives as escape + meta; the cancel binding must still
    // match it, or a double press would be needed to get out.
    expect(
      dispatch(host.host, keyEventFrom("\u001b", { escape: true, meta: true })),
    ).toBe("overlay-list.cancel");
    expect(dispatch(host.host, keyEventFrom("c", { ctrl: true }))).toBe(
      "overlay-list.cancel",
    );
    expect(host.cancels).toBe(3);
  });

  test("navigationEnabled false hands every key to the focused sub-view", () => {
    const host = harness({ navigationEnabled: false });
    for (const event of [
      keyEventFrom("", { upArrow: true }),
      keyEventFrom("k"),
      keyEventFrom("", { pageDown: true }),
      keyEventFrom("", { home: true }),
      keyEventFrom(" "),
      keyEventFrom("", { leftArrow: true }),
      keyEventFrom("\r", { return: true }),
    ]) {
      expect(dispatch(host.host, event)).toBeUndefined();
    }
    expect(host.moved).toEqual([]);
    // ...except getting out: the overlay must stay dismissible.
    expect(dispatch(host.host, keyEventFrom("\u001b", { escape: true }))).toBe(
      "overlay-list.cancel",
    );
  });

  test("a caller's own binding is tried before the list's", () => {
    let tabbed = 0;
    const host = harness({
      extra: [
        {
          id: "overlay-list.test-tab",
          chords: [{ key: "rightArrow" }],
          run: () => {
            tabbed += 1;
            return "consumed";
          },
        },
      ],
      onMoveItem: () => {
        throw new Error("the caller's binding should have won");
      },
    });
    expect(dispatch(host.host, keyEventFrom("", { rightArrow: true }))).toBe(
      "overlay-list.test-tab",
    );
    expect(tabbed).toBe(1);
  });

  test("a list with no cancel declares no cancel, so a wizard keeps the key", () => {
    // The `/connect` shape: inside a multi-step overlay Escape goes back a step
    // and Ctrl+C closes it, so the list must not claim either — otherwise one
    // list's cancel would answer for every step, and Ctrl+C would walk back
    // instead of closing.
    const host = harness({ onCancel: undefined });
    const table = listBindings(host.host);
    expect(table.map((binding) => binding.id)).not.toContain(
      "overlay-list.cancel",
    );
    expect(dispatch(host.host, keyEventFrom("\u001b", { escape: true }))).toBe(
      undefined,
    );
    expect(dispatch(host.host, keyEventFrom("c", { ctrl: true }))).toBe(
      undefined,
    );
    expect(host.cancels).toBe(0);
    // The rest of the table is untouched.
    expect(dispatch(host.host, keyEventFrom("k"))).toBe("overlay-list.up");
  });

  test("edgeKeys off leaves Home/End to the editor beside the list", () => {
    // `/connect`'s shape: the filter is a live editor whose Home/End are the
    // caret's. That editor remounts whenever the overlay walks into a provider's
    // step and back, which re-registers it *behind* the list's table — so a list
    // that also claimed Home/End would move the cursor after such a trip and the
    // caret before it. Undeclared here, the editor's claim is unconditional.
    const host = harness({ count: 9, cursor: 4, edgeKeys: false });
    const table = listBindings(host.host);
    const ids = table.map((binding) => binding.id);
    expect(ids).not.toContain("overlay-list.first");
    expect(ids).not.toContain("overlay-list.last");

    expect(
      dispatch(host.host, keyEventFrom("", { home: true })),
    ).toBeUndefined();
    expect(
      dispatch(host.host, keyEventFrom("", { end: true })),
    ).toBeUndefined();
    expect(host.moved).toEqual([]);

    // The rest of the table is untouched: PageDown still steps by the window.
    expect(dispatch(host.host, keyEventFrom("", { pageDown: true }))).toBe(
      "overlay-list.page-down",
    );
  });

  test("every binding has a unique id and declares at least one chord", () => {
    const table = listBindings(harness().host);
    const ids = table.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const binding of table) {
      expect(binding.chords?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
