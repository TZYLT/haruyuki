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
  registeredBindingOwners,
  resetBindingOwners,
  routeFallbackEvent,
  routeKeyEvent,
} from "@/cli/helpers/input-router";
import { keyEventFrom, shieldKeyEvent } from "@/cli/helpers/input-sequence";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import {
  armLeader,
  isLeaderArmed,
  isLeaderHelpOpen,
  resetLeader,
} from "@/cli/helpers/leader";
import {
  registeredMouseHandlers,
  registerMouseHandler,
  resetMouseHandlers,
} from "@/cli/helpers/mouse-router";

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
  resetLeader();
});

/** The composer's leader table as the app builds it: prefix plus one entry. */
function leaderTables(runs: string[]): KeyBindingTable[] {
  return [
    {
      scope: "app",
      bindings: [
        {
          id: "leader.activate",
          chords: LEADER_KEY_CHORDS.activate,
          run: () => {
            runs.push("arm");
            armLeader();
          },
        },
        {
          id: "leader.help",
          leader: true,
          chords: LEADER_KEY_CHORDS.help,
          run: () => {
            runs.push("help");
          },
        },
        // An ordinary app chord, to prove a second key does not reach it through
        // the leader path and that the prefix does not shadow it either.
        {
          id: "transcript.shell",
          chords: [{ key: "o", ctrl: true }],
          run: () => {
            runs.push("shell");
          },
        },
      ],
    },
  ];
}

describe("the leader prefix in the router", () => {
  test("the second key reaches a leader entry and is swallowed", () => {
    const runs: string[] = [];
    const { emitter, legacy, uninstall } = harness(leaderTables(runs));
    emitter.emit("input", "\u0018"); // Ctrl+X
    expect(runs).toEqual(["arm"]);
    expect(isLeaderArmed()).toBe(true);
    emitter.emit("input", "?"); // the leader's help entry
    expect(runs).toEqual(["arm", "help"]);
    expect(legacy).toEqual([]);
    // One-shot: this entry does not re-arm, so the prefix is left behind it.
    expect(isLeaderArmed()).toBe(false);
    uninstall();
  });

  test("a leader entry that re-arms keeps the prefix", () => {
    // The help entry is the one entry whose *job* is to re-arm (with the list
    // open), and the router used to disarm after running it, erasing the re-arm
    // in the same keystroke: the entry ran and the screen showed nothing. The
    // prefix therefore has to be left before the entry runs, not after.
    const runs: string[] = [];
    const emitter = new EventEmitter();
    registerBindingOwner("test", () => [
      {
        scope: "app",
        bindings: [
          {
            id: "leader.activate",
            chords: LEADER_KEY_CHORDS.activate,
            run: () => {
              armLeader();
            },
          },
          {
            id: "leader.help",
            leader: true,
            chords: LEADER_KEY_CHORDS.help,
            run: () => {
              runs.push("help");
              armLeader({ help: true });
            },
          },
        ],
      },
    ]);
    const uninstall = installInputRouter(emitter);
    emitter.emit("input", "\u0018"); // Ctrl+X
    emitter.emit("input", "?"); // the leader's help entry
    expect(runs).toEqual(["help"]);
    expect(isLeaderArmed()).toBe(true);
    expect(isLeaderHelpOpen()).toBe(true);
    uninstall();
    resetLeader();
  });

  test("a key the prefix does not know disarms it and continues normally", () => {
    const runs: string[] = [];
    const { emitter, legacy, uninstall } = harness(leaderTables(runs));
    emitter.emit("input", "\u0018");
    emitter.emit("input", "\u000F"); // Ctrl+O: an ordinary app chord
    expect(runs).toEqual(["arm", "shell"]);
    expect(isLeaderArmed()).toBe(false);
    // The ordinary binding swallowed it, exactly as it would have without a
    // leader in front.
    expect(legacy).toEqual([]);
    uninstall();
  });

  test("an unknown plain letter is typed, not eaten by the prefix", () => {
    const runs: string[] = [];
    const { emitter, legacy, uninstall } = harness(leaderTables(runs));
    emitter.emit("input", "\u0018");
    emitter.emit("input", "z");
    expect(runs).toEqual(["arm"]);
    expect(isLeaderArmed()).toBe(false);
    // No leader entry, no app binding: it travels to the text input.
    expect(legacy).toEqual(["z"]);
    uninstall();
  });

  test("Escape leaves the prefix instead of interrupting", () => {
    const runs: string[] = [];
    const interrupted: string[] = [];
    const { emitter, legacy, uninstall } = harness([
      ...leaderTables(runs),
      {
        scope: "app",
        bindings: [
          {
            id: "app.interrupt",
            chords: [{ key: "escape" }],
            run: () => {
              interrupted.push("interrupt");
            },
          },
        ],
      },
    ]);
    emitter.emit("input", "\u0018");
    emitter.emit("input", "\u001b"); // Escape
    expect(interrupted).toEqual([]);
    expect(isLeaderArmed()).toBe(false);
    expect(runs).toEqual(["arm"]);
    expect(legacy).toEqual([]);
    uninstall();
  });

  test("a leader entry is unreachable while the prefix is not armed", () => {
    const runs: string[] = [];
    const { emitter, legacy, uninstall } = harness(leaderTables(runs));
    emitter.emit("input", "?");
    expect(runs).toEqual([]);
    // Nothing bound it, so `?` is typing.
    expect(legacy).toEqual(["?"]);
    uninstall();
  });
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

  test("releasing one owner does not unregister another that shares its id", () => {
    // The composer and every overlay's input are the same component, so two
    // `composer-input` registrations are live at once whenever a selector is open
    // (the composer is mounted for the whole session). Keying the registry by the
    // id alone let the overlay's unmount delete the composer's tables, which no
    // component ever rebuilds while it stays mounted — its editing keys went dead
    // silently for the rest of the session.
    const runs: string[] = [];
    const emitter = new EventEmitter();
    registerBindingOwner("composer-input", () =>
      shells(() => {
        runs.push("composer");
        return true;
      }),
    );
    const releaseOverlay = registerBindingOwner("composer-input", () =>
      shells(() => {
        runs.push("overlay");
        return true;
      }),
    );
    const uninstall = installInputRouter(emitter);

    expect(registeredBindingOwners()).toEqual([
      "composer-input",
      "composer-input",
    ]);
    releaseOverlay(); // the overlay closes; the composer never unmounted
    emitter.emit("input", CTRL_O);
    expect(runs).toEqual(["composer"]);
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

  test("a declined shielded key is offered to the tables once", () => {
    // The app always has a `useInput` fallback installed (every `useKeyBindings`
    // caller adds one), so a declined key used to be routed a second time during the
    // same dispatch: the shield's reading and Ink's are the same one for a sequence
    // the shield claims, and the fallback exists for sequences it does not claim.
    const emitter = new EventEmitter();
    const legacy: string[] = [];
    emitter.on("input", (raw: string) => legacy.push(String(raw)));
    let runs = 0;
    registerBindingOwner("test", () => [
      {
        scope: "app",
        bindings: [
          {
            id: "test.declineBackspace",
            chords: [{ key: "backspace" }],
            run: () => {
              runs += 1;
              return false; // decline
            },
          },
        ],
      },
    ]);
    // The fallback, as Ink delivers it: the same event Ink parses the payload into.
    emitter.on("input", (raw: string) => {
      const parsed = shieldKeyEvent(String(raw));
      if (parsed) routeFallbackEvent(parsed);
    });
    const uninstall = installInputRouter(emitter);

    emitter.emit("input", "\u007F");

    expect(runs).toBe(1);
    // ...and the payload still reaches the text path, which is why the decline was
    // not a swallow.
    expect(legacy).toEqual(["\u007F"]);
    uninstall();
  });

  test("a declined workaround never reaches Ink's reading of it", () => {
    // Ink reads `ESC[27;2;13~` as literal text (the entry's own reason says so). The
    // shield reads Shift+Enter; when its owner declines, handing the payload back is
    // what types `[27;2;13~` into a field that has no paste-aware input.
    const emitter = new EventEmitter();
    const legacy: string[] = [];
    emitter.on("input", (raw: string) => legacy.push(String(raw)));
    let runs = 0;
    registerBindingOwner("test", () => [
      {
        scope: "app",
        bindings: [
          {
            id: "test.declineShiftEnter",
            chords: [{ key: "return", shift: true }],
            run: () => {
              runs += 1;
              return false; // decline
            },
          },
        ],
      },
    ]);
    const uninstall = installInputRouter(emitter);

    emitter.emit("input", "\u001B[27;2;13~");

    expect(runs).toBe(1);
    expect(legacy).toEqual([]);
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

describe("mouse reports in the router", () => {
  const ESC = "\u001b";
  const WHEEL_UP = `${ESC}[<64;10;5M`;
  const WHEEL_DOWN = `${ESC}[<65;10;5M`;
  const LEFT_PRESS = `${ESC}[<0;4;2M`;
  /** The X10 encoding, for a terminal that ignores the request for SGR. */
  const X10_WHEEL_UP = `${ESC}[M${String.fromCharCode(64 + 32, 10 + 32, 5 + 32)}`;

  afterEach(() => {
    resetMouseHandlers();
  });

  test("a wheel notch reaches the handler and never the text path", () => {
    const reports: string[] = [];
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    registerMouseHandler((report) => {
      reports.push(`${report.wheel ?? "none"}@${report.column},${report.row}`);
      return true;
    });

    emitter.emit("input", WHEEL_UP);
    emitter.emit("input", WHEEL_DOWN);

    expect(reports).toEqual(["up@10,5", "down@10,5"]);
    // The point of the whole module: an unread report is *typed*, because Ink has
    // no mouse API and parses the sequence as input.
    expect(legacy).toEqual([]);
    uninstall();
  });

  test("a report is spent even when nothing is listening", () => {
    // Reporting can be off while a report is already in flight (the toggle, the
    // exit path). It must not surface in the draft in that window.
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    expect(registeredMouseHandlers()).toBe(0);

    emitter.emit("input", LEFT_PRESS);

    expect(legacy).toEqual([]);
    uninstall();
  });

  test("reads the X10 encoding too", () => {
    const seen: string[] = [];
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    registerMouseHandler((report) => {
      seen.push(`${report.wheel ?? "none"}@${report.column},${report.row}`);
      return true;
    });

    emitter.emit("input", X10_WHEEL_UP);

    expect(seen).toEqual(["up@10,5"]);
    expect(legacy).toEqual([]);
    uninstall();
  });

  test("a declining handler does not stop the report from being spent", () => {
    // The handler convention (a `false` return means "I did not want this") must
    // not leak the report back onto the text path.
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    const seen: number[] = [];
    registerMouseHandler((report) => {
      seen.push(report.column);
      return false;
    });

    emitter.emit("input", WHEEL_UP);

    expect(seen).toEqual([10]);
    expect(legacy).toEqual([]);
    uninstall();
  });

  test("keys that only look like mouse reports still take their own path", () => {
    // The claim is an exact match on the two encodings, not a CSI prefix: an
    // over-broad claim would swallow real sequences (here, Shift+Left, which the
    // raw layer deliberately leaves to Ink's parse).
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    registerMouseHandler(() => true);

    emitter.emit("input", SHIFT_LEFT_ARROW);

    expect(legacy).toEqual([SHIFT_LEFT_ARROW]);
    uninstall();
  });

  test("a report with a zero coordinate is still a report, never text", () => {
    // The shape is matched, so it has already been kept away from the text editor:
    // returning "not a report" for a coordinate outside the 1-based grammar put the
    // bytes into the draft instead. Both coordinates are clamped by the parser and
    // the report is spent like any other.
    const { emitter, legacy, uninstall } = harness(shells(() => true));
    const seen: string[] = [];
    registerMouseHandler((report) => {
      seen.push(`${report.column},${report.row}`);
      return true;
    });

    emitter.emit("input", `${ESC}[<0;0;5M`);
    emitter.emit("input", `${ESC}[<0;10;0M`);

    expect(seen).toEqual(["1,5", "10,1"]);
    expect(legacy).toEqual([]);
    uninstall();
  });
});
