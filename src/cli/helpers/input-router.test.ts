import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  acquireInputScope,
  resetInputScopes,
} from "@/cli/helpers/focus-ledger";
import type { KeyBindingTable } from "@/cli/helpers/input-keys";
import {
  forwardInputEvent,
  installInputRouter,
  registerBindingOwner,
  resetBindingOwners,
  routeFallbackEvent,
  routeKeyEvent,
} from "@/cli/helpers/input-router";
import { keyEventFrom } from "@/cli/helpers/input-sequence";

const CTRL_O = "\u000F";

/** A sequence the raw layer deliberately does not read, so it takes the fallback. */
const SHIFT_LEFT_ARROW = "\u001b[1;2D";

function shiftLeftTable(runs: string[]): KeyBindingTable[] {
  return [
    {
      scope: "app",
      bindings: [
        {
          id: "test.shiftLeft",
          chords: [{ key: "leftArrow", shift: true }],
          run: () => {
            runs.push("run");
            return true;
          },
        },
      ],
    },
  ];
}

/**
 * A router on a bare emitter, plus a "legacy" listener standing in for the
 * components that still use Ink's `useInput`.
 */
function harness(tables: KeyBindingTable[]) {
  const emitter = new EventEmitter();
  const legacy: string[] = [];
  // Registered before the shield on purpose: the shield must still run first.
  emitter.on("input", (raw: string) => legacy.push(raw));
  registerBindingOwner("test", () => tables);
  const uninstall = installInputRouter(emitter);
  return { emitter, legacy, uninstall };
}

const shells = (run: () => boolean | void): KeyBindingTable[] => [
  {
    scope: "app",
    bindings: [
      { id: "transcript.shell", chords: [{ key: "o", ctrl: true }], run },
    ],
  },
];

afterEach(() => {
  resetBindingOwners();
  resetInputScopes();
});

describe("input router", () => {
  test("swallows a key a binding consumed", () => {
    const ran: string[] = [];
    const { emitter, legacy, uninstall } = harness(
      shells(() => {
        ran.push("shell");
        return true;
      }),
    );
    emitter.emit("input", CTRL_O);
    expect(ran).toEqual(["shell"]);
    expect(legacy).toEqual([]);
    uninstall();
  });

  test("runs before a listener registered earlier on the same emitter", () => {
    // This is the property that makes swallowing possible at all: Ink's own
    // `useInput` listeners are plain `.on()` subscribers.
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    emitter.emit("input", CTRL_O);
    expect(legacy).toEqual([]);
    uninstall();
  });

  test("forwards a key nothing claims, exactly once", () => {
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    emitter.emit("input", "a");
    expect(legacy).toEqual(["a"]);
    uninstall();
  });

  test("forwards a key whose binding declined it", () => {
    const { emitter, legacy, uninstall } = harness(shells(() => false));
    emitter.emit("input", CTRL_O);
    expect(legacy).toEqual([CTRL_O]);
    uninstall();
  });

  test("keeps looking after a binding declines, and lets a later one consume", () => {
    const { emitter, legacy, uninstall } = harness([
      {
        scope: "app",
        bindings: [
          {
            id: "first.declines",
            chords: [{ key: "o", ctrl: true }],
            run: () => false,
          },
          {
            id: "second.consumes",
            chords: [{ key: "o", ctrl: true }],
            run: () => true,
          },
        ],
      },
    ]);
    emitter.emit("input", CTRL_O);
    expect(legacy).toEqual([]);
    uninstall();
  });

  test("an overlay claim makes app-level bindings inert and forwards instead", () => {
    const ran: string[] = [];
    const { emitter, legacy, uninstall } = harness(
      shells(() => {
        ran.push("shell");
        return true;
      }),
    );
    const release = acquireInputScope("overlay");
    emitter.emit("input", CTRL_O);
    expect(ran).toEqual([]);
    expect(legacy).toEqual([CTRL_O]);
    release();
    emitter.emit("input", CTRL_O);
    expect(ran).toEqual(["shell"]);
    expect(legacy).toEqual([CTRL_O]);
    uninstall();
  });

  test("a system binding still runs while a modal owns input", () => {
    const ran: string[] = [];
    const { emitter, uninstall } = harness([
      {
        scope: "system",
        bindings: [
          {
            id: "system.suspend",
            chords: [{ key: "z", ctrl: true }],
            run: () => {
              ran.push("suspend");
              return true;
            },
          },
        ],
      },
    ]);
    const release = acquireInputScope("modal");
    emitter.emit("input", "\u001a");
    expect(ran).toEqual(["suspend"]);
    release();
    uninstall();
  });

  test("two owners in one scope are both consulted, in registration order", () => {
    const order: string[] = [];
    const emitter = new EventEmitter();
    registerBindingOwner("first", () => [
      {
        scope: "app",
        bindings: [
          {
            id: "first",
            chords: [{ key: "o", ctrl: true }],
            run: () => {
              order.push("first");
              return true;
            },
          },
        ],
      },
    ]);
    registerBindingOwner("second", () => [
      {
        scope: "app",
        bindings: [
          {
            id: "second",
            chords: [{ key: "o", ctrl: true }],
            run: () => {
              order.push("second");
              return true;
            },
          },
        ],
      },
    ]);
    const uninstall = installInputRouter(emitter);
    emitter.emit("input", CTRL_O);
    expect(order).toEqual(["first"]);
    uninstall();
  });

  test("a forwarding listener cannot re-enter the router", () => {
    // The forward path re-emits on the same emitter. Without the guard the
    // router would route its own forward, which is how one key becomes two.
    let seen = 0;
    const emitter = new EventEmitter();
    registerBindingOwner("test", () => [
      {
        scope: "app",
        bindings: [
          {
            id: "transcript.shell",
            chords: [{ key: "o", ctrl: true }],
            run: () => {
              seen += 1;
              return false; // decline, so the event is forwarded
            },
          },
        ],
      },
    ]);
    const uninstall = installInputRouter(emitter);
    emitter.emit("input", CTRL_O);
    expect(seen).toBe(1);
    uninstall();
  });

  test("forwardInputEvent hands a paste to the legacy chain once", () => {
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    forwardInputEvent(emitter, "pasted text");
    expect(legacy).toEqual(["pasted text"]);
    uninstall();
  });

  test("forwardInputEvent on an emitter with no router still delivers", () => {
    const emitter = new EventEmitter();
    const legacy: string[] = [];
    emitter.on("input", (raw: string) => legacy.push(raw));
    forwardInputEvent(emitter, "pasted text");
    expect(legacy).toEqual(["pasted text"]);
  });

  test("routing an event with no owners claims nothing", () => {
    expect(routeKeyEvent(keyEventFrom("g", { ctrl: true }))).toBe(false);
  });

  test("installing twice listens once and survives one release", () => {
    const emitter = new EventEmitter();
    const legacy: string[] = [];
    emitter.on("input", (raw: string) => legacy.push(raw));
    registerBindingOwner("test", () => shells(() => true));
    const first = installInputRouter(emitter);
    const second = installInputRouter(emitter);
    emitter.emit("input", CTRL_O);
    expect(legacy).toEqual([]);
    first();
    emitter.emit("input", CTRL_O);
    expect(legacy).toEqual([]);
    second();
    emitter.emit("input", CTRL_O);
    expect(legacy).toEqual([CTRL_O]);
  });

  test("routes every fallback event in turn, never disarming itself", () => {
    // The fallback arm is scoped to one dispatch. If a consumed event left it
    // set, every later key would stop being routed — which is exactly the bug
    // this test was written from.
    const runs: string[] = [];
    const emitter = new EventEmitter();
    registerBindingOwner("test", () => shiftLeftTable(runs));
    // Stands in for Ink's `useInput`: same event, Ink's parse. The sequence is
    // one the raw layer deliberately does not read, so it takes the fallback.
    const legacy = (raw: string) => {
      if (raw === SHIFT_LEFT_ARROW) {
        routeFallbackEvent(keyEventFrom("", { leftArrow: true, shift: true }));
      }
    };
    emitter.on("input", legacy);
    const uninstall = installInputRouter(emitter);
    emitter.emit("input", SHIFT_LEFT_ARROW);
    emitter.emit("input", SHIFT_LEFT_ARROW);
    expect(runs).toEqual(["run", "run"]);
    uninstall();
  });

  test("several installed fallbacks route one dispatch once", () => {
    const runs: string[] = [];
    const emitter = new EventEmitter();
    registerBindingOwner("test", () => shiftLeftTable(runs));
    const legacy = (raw: string) => {
      if (raw === SHIFT_LEFT_ARROW) {
        routeFallbackEvent(keyEventFrom("", { leftArrow: true, shift: true }));
      }
    };
    // Two installations, as the app has: the root plus every component that
    // registers bindings.
    emitter.on("input", legacy);
    emitter.on("input", legacy);
    const first = installInputRouter(emitter);
    const second = installInputRouter(emitter);
    emitter.emit("input", SHIFT_LEFT_ARROW);
    expect(runs).toEqual(["run"]);
    first();
    second();
  });
});
