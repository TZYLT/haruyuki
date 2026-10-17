import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { KeyBindingTable } from "@/cli/helpers/input-keys";
import {
  installInputRouter,
  registerBindingOwner,
  resetBindingOwners,
  routeKeyEvent,
} from "@/cli/helpers/input-router";
import {
  filterRawInput,
  keyEventFrom,
  noteModifiedEnter,
  resetRawInputPlatformState,
} from "@/cli/helpers/input-sequence";

/**
 * Enter on Linux.
 *
 * Ink 7 flags only CR (`\r`) as `return`; Linux terminals may send LF (`\n`), which
 * Ink names `enter` with no flag this app's chords can match. Before these rules,
 * an LF was not claimed by anything, fell through to the text editor and was
 * inserted into the draft as a literal newline instead of submitting — the
 * retired vendored patch had normalized it (`shouldTreatAsReturn`) and its
 * removal took the behaviour with it.
 *
 * These are the *only* platform-dependent rules in the input layer, so they are
 * also the only ones that can be wrong on a machine this suite does not run on.
 * Every branch is pinned here, including the ones that must not fire.
 */

afterEach(() => {
  resetBindingOwners();
  resetRawInputPlatformState();
});

describe("raw payload rules", () => {
  test("platforms other than linux get their payload back untouched", () => {
    for (const platform of ["win32", "darwin", "freebsd"]) {
      expect(filterRawInput("\n", platform, 1_000)).toBe("\n");
      expect(filterRawInput("\r", platform, 1_000)).toBe("\r");
      expect(filterRawInput("a", platform, 1_000)).toBe("a");
    }
  });

  test("linux reads LF as Enter and leaves CR alone", () => {
    expect(filterRawInput("\n", "linux", 1_000)).toBe("\r");
    expect(filterRawInput("\r", "linux", 1_000)).toBe("\r");
  });

  test("linux passes keys that are not newlines through", () => {
    expect(filterRawInput("\u000f", "linux", 1_000)).toBe("\u000f");
    expect(filterRawInput("\u001b[5~", "linux", 1_000)).toBe("\u001b[5~");
  });

  test("the LF half of a CRLF pair is not a second key", () => {
    // Some terminals put the console in newline mode, where Enter is CR LF: two
    // payloads for one keystroke. Submitting twice is the failure this prevents.
    expect(filterRawInput("\r", "linux", 1_000)).toBe("\r");
    expect(filterRawInput("\n", "linux", 1_005)).toBeNull();
  });

  test("an LF that only looks adjacent is still Enter", () => {
    // The second payload of a *real* second Enter press must not be eaten, so the
    // CRLF window is short and each CR re-arms it.
    expect(filterRawInput("\r", "linux", 1_000)).toBe("\r");
    expect(filterRawInput("\n", "linux", 1_100)).toBe("\r");
    expect(filterRawInput("\r", "linux", 1_100)).toBe("\r");
    expect(filterRawInput("\n", "linux", 1_105)).toBeNull();
  });

  test("a modified Enter swallows the echo that can follow it", () => {
    // Shift+Enter inserts a newline; on the terminals that echo a bare LF after
    // it, the echo must not be a second Enter that submits the draft.
    noteModifiedEnter(keyEventFrom("\r", { return: true, shift: true }), 1_000);
    expect(filterRawInput("\n", "linux", 1_010)).toBeNull();
    // ... and only that one: the next newline is a key press again.
    expect(filterRawInput("\n", "linux", 1_020)).toBe("\r");
  });

  test("the echo window is honoured, not left armed forever", () => {
    // The retired patch computed a deadline and never read it, so a later Enter
    // press vanished. 75ms is the window; past it the newline is Enter again.
    noteModifiedEnter(keyEventFrom("\r", { return: true, meta: true }), 1_000);
    expect(filterRawInput("\n", "linux", 1_200)).toBe("\r");
  });

  test("a plain Enter arms nothing", () => {
    noteModifiedEnter(keyEventFrom("\r", { return: true }), 1_000);
    expect(filterRawInput("\n", "linux", 1_010)).toBe("\r");
  });
});

const RETURN_TABLE: KeyBindingTable[] = [
  {
    scope: "app",
    bindings: [
      {
        id: "test.return",
        chords: [{ key: "return" }],
        run: () => "consumed",
      },
    ],
  },
];

/** A table that owns nothing, so every key is dispatched to the legacy chain. */
const EMPTY_TABLE: KeyBindingTable[] = [];

describe("the router's Linux Enter rules", () => {
  test("an LF reaches a `return` binding, and is kept from the handlers", () => {
    const seen: string[] = [];
    const emitter = new EventEmitter();
    emitter.on("input", (raw: string) => seen.push(raw));
    registerBindingOwner("test", () => RETURN_TABLE);
    const uninstall = installInputRouter(emitter, "linux");

    emitter.emit("input", "\n");
    // Shielded and consumed: the legacy `useInput` handlers never see it, which is
    // what makes one keystroke one action.
    expect(seen).toEqual([]);
    uninstall();
  });

  test("an LF nothing claims is still dispatched as CR", () => {
    // The rewrite is what reaches the components that parse their own input (the
    // text editor submits on `key.return`), so it has to survive the unrouted path.
    const seen: string[] = [];
    const emitter = new EventEmitter();
    emitter.on("input", (raw: string) => seen.push(raw));
    registerBindingOwner("test", () => EMPTY_TABLE);
    const uninstall = installInputRouter(emitter, "linux");

    emitter.emit("input", "\n");
    expect(seen).toEqual(["\r"]);
    uninstall();
  });

  test("another platform keeps the LF exactly as it arrived", () => {
    const seen: string[] = [];
    const emitter = new EventEmitter();
    emitter.on("input", (raw: string) => seen.push(raw));
    registerBindingOwner("test", () => EMPTY_TABLE);
    const uninstall = installInputRouter(emitter, "win32");

    emitter.emit("input", "\n");
    expect(seen).toEqual(["\n"]);
    uninstall();
  });

  test("the echo of a modified Enter never reaches the handlers", () => {
    const seen: string[] = [];
    const emitter = new EventEmitter();
    emitter.on("input", (raw: string) => seen.push(raw));
    registerBindingOwner("test", () => EMPTY_TABLE);
    const uninstall = installInputRouter(emitter, "linux");

    // Option+Enter, shielded and routed, which is what arms the echo suppression.
    emitter.emit("input", "\u001b\r");
    expect(seen).toEqual(["\u001b\r"]);
    // The bare LF the terminal can send right after it: one keystroke, not two.
    emitter.emit("input", "\n");
    expect(seen).toEqual(["\u001b\r"]);
    // The next newline is a key press again.
    emitter.emit("input", "\n");
    expect(seen).toEqual(["\u001b\r", "\r"]);
    uninstall();
  });

  test("a routing path that never sees a modified Enter still submits", () => {
    // Guards the arming: an LF with no modified Enter before it is Enter.
    expect(routeKeyEvent(keyEventFrom("\n"))).toBe(false);
    expect(filterRawInput("\n", "linux", 1_000)).toBe("\r");
  });
});
