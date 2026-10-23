import { describe, expect, test } from "bun:test";
import {
  type ConsoleFont,
  type ConsoleFontGuardEvent,
  type ConsoleFontPort,
  type ConsoleFontTarget,
  chooseConsoleFace,
  consoleFontTargetFor,
  DEFAULT_CONSOLE_FONT,
  isRasterConsoleFont,
  parseConsoleFontMode,
  startConsoleFontGuard,
} from "@/cli/helpers/console-font";

/** The preset, at the height this machine's window uses. */
const CONSOLAS_18: ConsoleFont = {
  face: "Consolas",
  cellWidth: 9,
  cellHeight: 18,
  family: 0x36,
  weight: 400,
};

/** The flip: the smallest raster face, and it has no block glyphs. */
const RASTER_12: ConsoleFont = {
  face: "Terminal",
  cellWidth: 8,
  cellHeight: 12,
  family: 0x30,
  weight: 400,
};

/** What conhost puts back around startup when the console's default is 宋体. */
const SIMSUN_16: ConsoleFont = {
  face: "宋体",
  cellWidth: 10,
  cellHeight: 18,
  family: 0x07,
  weight: 400,
};

/** A CJK monospace console face, to pin that "not the preset" is not "raster". */
const XIAWU_16: ConsoleFont = {
  face: "霞鹜文楷等宽",
  cellWidth: 8,
  cellHeight: 18,
  family: 0x36,
  weight: 400,
};

interface FakeConsole {
  port: ConsoleFontPort;
  applied: ConsoleFontTarget[];
  reads: () => number;
  show(font: ConsoleFont | null): void;
  /** Accept the call but keep drawing `font` — what a CJK console does. */
  substitute(font: ConsoleFont): void;
  refuse(value: boolean): void;
  closes: () => number;
}

/**
 * A console the test drives: `apply` records the request, then either takes effect
 * (the console now reports the requested face at the requested height) or refuses.
 */
function createFakeConsole(initial: ConsoleFont | null): FakeConsole {
  let font = initial;
  let refused = false;
  let substituted: ConsoleFont | null = null;
  let reads = 0;
  let closes = 0;
  const applied: ConsoleFontTarget[] = [];
  return {
    applied,
    reads: () => reads,
    closes: () => closes,
    port: {
      async read() {
        reads += 1;
        return font;
      },
      async apply(target) {
        applied.push(target);
        if (refused) return false;
        font = substituted ?? {
          ...(font ?? CONSOLAS_18),
          face: target.face,
          cellHeight: target.cellHeight,
          weight: target.weight,
        };
        return true;
      },
      close() {
        closes += 1;
      },
    },
    show: (next) => {
      font = next;
    },
    substitute: (next) => {
      substituted = next;
    },
    refuse: (value) => {
      refused = value;
    },
  };
}

/**
 * A `setInterval` the test drives by hand, so no test waits on the clock.
 *
 * `tick` awaits the timer callback and then a macrotask: the guard's check is
 * asynchronous now, and a synchronous tick would assert before the fake port's
 * promise had resolved.
 */
function createFakeTimer(): {
  setIntervalImpl: typeof setInterval;
  clearIntervalImpl: typeof clearInterval;
  tick: () => Promise<void>;
  clears: () => number;
} {
  let callback: (() => void) | null = null;
  let clears = 0;
  const setIntervalImpl = ((handler: () => void) => {
    callback = handler;
    return 1;
  }) as unknown as typeof setInterval;
  const clearIntervalImpl = (() => {
    clears += 1;
    callback = null;
  }) as unknown as typeof clearInterval;
  return {
    setIntervalImpl,
    clearIntervalImpl,
    async tick() {
      callback?.();
      // Let the awaited port round trip (and the check it belongs to) finish.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    clears: () => clears,
  };
}

describe("isRasterConsoleFont", () => {
  test("the raster fallback is recognised by name and by family bits", () => {
    expect(isRasterConsoleFont(RASTER_12)).toBe(true);
    expect(isRasterConsoleFont({ face: "Consolas", family: 0x30 })).toBe(true);
  });

  test("a scalable face is not, whatever it is called", () => {
    expect(isRasterConsoleFont(CONSOLAS_18)).toBe(false);
    expect(isRasterConsoleFont(SIMSUN_16)).toBe(false);
    expect(isRasterConsoleFont(XIAWU_16)).toBe(false);
  });
});

describe("parseConsoleFontMode", () => {
  test("absent and blank mean auto", () => {
    expect(parseConsoleFontMode(undefined)).toBe("auto");
    expect(parseConsoleFontMode("")).toBe("auto");
    expect(parseConsoleFontMode("   ")).toBe("auto");
    expect(parseConsoleFontMode(42)).toBe("auto");
  });

  test("auto and off are case-insensitive", () => {
    expect(parseConsoleFontMode("auto")).toBe("auto");
    expect(parseConsoleFontMode("AUTO")).toBe("auto");
    expect(parseConsoleFontMode(" off ")).toBe("off");
  });

  test("anything else is a face to draw with, trimmed", () => {
    expect(parseConsoleFontMode(" Consolas ")).toEqual({
      pinnedFace: "Consolas",
    });
    expect(parseConsoleFontMode("霞鹜文楷等宽")).toEqual({
      pinnedFace: "霞鹜文楷等宽",
    });
  });
});

describe("chooseConsoleFace", () => {
  test("keeps the preferred face when the console reports it", () => {
    expect(chooseConsoleFace("Consolas", ["Consolas", "NSimSun"])).toBe(
      "Consolas",
    );
  });

  test("is case- and whitespace-insensitive", () => {
    expect(chooseConsoleFace("consolas", [" Consolas "])).toBe("consolas");
  });

  test("falls back in priority order when the preferred face is missing", () => {
    expect(chooseConsoleFace("Consolas", ["Lucida Console", "NSimSun"])).toBe(
      "Lucida Console",
    );
    expect(chooseConsoleFace("Consolas", ["NSimSun"])).toBe("NSimSun");
  });

  test("a CJK monospace face is only a fallback, never preferred", () => {
    // The inventory below is this machine's: Consolas and a CJK monospace are both
    // installed, so the preset must win.
    expect(
      chooseConsoleFace("Consolas", [
        "Consolas",
        "霞鹜文楷等宽 Regular",
        "NSimSun",
      ]),
    ).toBe("Consolas");
  });

  test("trusts the preference when there is no inventory to check", () => {
    expect(chooseConsoleFace("Consolas", null)).toBe("Consolas");
  });

  test("still tries the preference when no fallback is installed either", () => {
    expect(chooseConsoleFace("Consolas", ["Some Font"])).toBe("Consolas");
  });
});

describe("consoleFontTargetFor", () => {
  test("auto keeps the session's own face at its own height", () => {
    expect(consoleFontTargetFor("auto", CONSOLAS_18)).toEqual({
      face: "Consolas",
      cellHeight: 18,
      weight: 400,
    });
  });

  test("the preset wins over the session's face but keeps its height", () => {
    expect(consoleFontTargetFor({ pinnedFace: "Consolas" }, SIMSUN_16)).toEqual(
      {
        face: "Consolas",
        cellHeight: 18,
        weight: 400,
      },
    );
  });

  test("a session with no scalable reading falls back to the preset", () => {
    expect(consoleFontTargetFor("auto", null)).toEqual({
      face: DEFAULT_CONSOLE_FONT.face,
      cellHeight: DEFAULT_CONSOLE_FONT.cellHeight,
      weight: DEFAULT_CONSOLE_FONT.weight,
    });
  });

  test("a resolved default face is what that fallback uses", () => {
    expect(consoleFontTargetFor("auto", null, "霞鹜文楷等宽")).toEqual({
      face: "霞鹜文楷等宽",
      cellHeight: DEFAULT_CONSOLE_FONT.cellHeight,
      weight: DEFAULT_CONSOLE_FONT.weight,
    });
  });

  test("off has no target at all", () => {
    expect(consoleFontTargetFor("off", CONSOLAS_18)).toBeNull();
  });
});

describe("startConsoleFontGuard", () => {
  test("records the baseline and leaves the preset face alone", async () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const events: ConsoleFontGuardEvent[] = [];
    await startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      onEvent: (event) => events.push(event),
    });

    expect(events).toEqual([{ kind: "baseline", font: CONSOLAS_18 }]);
    expect(fake.applied).toEqual([]);
  });

  test("a face that is not the preset is repaired, not just a raster one", async () => {
    // The 2026-10-23 report: conhost re-applies the console's saved default (宋体)
    // around startup. 宋体 is TrueType, so a raster-only judgement let it stand.
    const fake = createFakeConsole(SIMSUN_16);
    const events: ConsoleFontGuardEvent[] = [];
    await startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      onEvent: (event) => events.push(event),
    });

    expect(fake.applied).toEqual([
      { face: "Consolas", cellHeight: 18, weight: 400 },
    ]);
    expect(events.at(-1)).toEqual({
      kind: "repaired",
      before: SIMSUN_16,
      target: { face: "Consolas", cellHeight: 18, weight: 400 },
    });
  });

  test("puts the session's face back after a flip", async () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const events: ConsoleFontGuardEvent[] = [];
    const guard = await startConsoleFontGuard({
      port: fake.port,
      mode: "auto",
      onEvent: (event) => events.push(event),
    });

    fake.show(RASTER_12);
    await guard.check();

    expect(fake.applied).toEqual([
      { face: "Consolas", cellHeight: 18, weight: 400 },
    ]);
    expect(events.at(-1)).toEqual({
      kind: "repaired",
      before: RASTER_12,
      target: { face: "Consolas", cellHeight: 18, weight: 400 },
    });
  });

  test("a steady window is not rewritten on every tick", async () => {
    const fake = createFakeConsole(SIMSUN_16);
    const timer = createFakeTimer();
    await startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      intervalMs: 250,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    });

    // The first check repaired 宋体 → Consolas; the fake now reports Consolas, so the
    // next three ticks must write nothing.
    expect(fake.applied).toHaveLength(1);
    await timer.tick();
    await timer.tick();
    await timer.tick();
    expect(fake.applied).toHaveLength(1);
  });

  test("a pinned face is what the repair writes", async () => {
    const fake = createFakeConsole(CONSOLAS_18);
    await startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "霞鹜文楷等宽" },
    });

    expect(fake.applied[0]?.face).toBe("霞鹜文楷等宽");
  });

  test("a session that starts raster falls back to the resolved default face", async () => {
    const fake = createFakeConsole(RASTER_12);
    const events: ConsoleFontGuardEvent[] = [];
    await startConsoleFontGuard({
      port: fake.port,
      mode: "auto",
      defaultFace: "霞鹜文楷等宽",
      onEvent: (event) => events.push(event),
    });

    expect(fake.applied).toEqual([
      {
        face: "霞鹜文楷等宽",
        cellHeight: DEFAULT_CONSOLE_FONT.cellHeight,
        weight: DEFAULT_CONSOLE_FONT.weight,
      },
    ]);
    // The raster reading must not become the baseline: that would "restore" the
    // raster font on every later check.
    expect(events.some((event) => event.kind === "baseline")).toBe(false);
  });

  test("a console that does not answer stops the guard after one reading", async () => {
    const fake = createFakeConsole(null);
    const events: ConsoleFontGuardEvent[] = [];
    const guard = await startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      onEvent: (event) => events.push(event),
    });

    await guard.check();

    expect(events).toEqual([{ kind: "unavailable" }]);
    expect(fake.reads()).toBe(1);
  });

  test("stopping releases the port exactly once", async () => {
    const fake = createFakeConsole(null);
    const guard = await startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
    });

    expect(fake.closes()).toBe(1);
    guard.stop();
    guard.stop();
    expect(fake.closes()).toBe(1);
  });

  test("off does not even read the console", async () => {
    const fake = createFakeConsole(CONSOLAS_18);
    await startConsoleFontGuard({ port: fake.port, mode: "off" });

    expect(fake.reads()).toBe(0);
    expect(fake.applied).toEqual([]);
  });

  test("a substituted face ends the guard instead of flickering forever", async () => {
    // A CJK-only console accepts `Consolas` and keeps drawing 宋体. Without the
    // read-back this would rewrite the same rejected face every tick.
    const fake = createFakeConsole(SIMSUN_16);
    fake.substitute(SIMSUN_16);
    const timer = createFakeTimer();
    const events: ConsoleFontGuardEvent[] = [];
    await startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      intervalMs: 250,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      onEvent: (event) => events.push(event),
    });

    expect(events.at(-1)?.kind).toBe("not-taken");
    await timer.tick();
    await timer.tick();
    await timer.tick();

    expect(fake.applied).toHaveLength(2);
    expect(events.filter((event) => event.kind === "not-taken")).toHaveLength(
      2,
    );
    expect(timer.clears()).toBe(1);
  });

  test("two refused repairs end the polling", async () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const timer = createFakeTimer();
    const events: ConsoleFontGuardEvent[] = [];
    fake.refuse(true);
    await startConsoleFontGuard({
      port: fake.port,
      mode: "auto",
      intervalMs: 250,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      onEvent: (event) => events.push(event),
    });

    // The baseline is Consolas and the window is Consolas, so the guard is quiet
    // until something changes.
    expect(fake.applied).toHaveLength(0);
    fake.show(RASTER_12);
    await timer.tick();
    await timer.tick();
    await timer.tick();

    expect(fake.applied).toHaveLength(2);
    expect(
      events.filter((event) => event.kind === "repair-failed"),
    ).toHaveLength(2);
    expect(timer.clears()).toBe(1);
  });
});
