import { describe, expect, test } from "bun:test";
import {
  type ConsoleFont,
  type ConsoleFontGuardEvent,
  type ConsoleFontPort,
  type ConsoleFontTarget,
  consoleFontTargetFor,
  DEFAULT_CONSOLE_FONT,
  isRasterConsoleFont,
  parseConsoleFontMode,
  startConsoleFontGuard,
} from "@/cli/helpers/console-font";

/** The preset, at the height this machine's window uses. */
const CONSOLAS_18: ConsoleFont = {
  face: "Consolas",
  cellWidth: 8,
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
  cellWidth: 8,
  cellHeight: 16,
  family: 0x36,
  weight: 400,
};

/** A CJK monospace console face, to pin that "not the preset" is not "raster". */
const XIAWU_16: ConsoleFont = {
  face: "霞鹜文楷等宽",
  cellWidth: 7,
  cellHeight: 16,
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
  const applied: ConsoleFontTarget[] = [];
  return {
    applied,
    reads: () => reads,
    port: {
      read: () => {
        reads += 1;
        return font;
      },
      apply: (target) => {
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

/** A `setInterval` the test drives by hand, so no test waits on the clock. */
function createFakeTimer(): {
  setIntervalImpl: typeof setInterval;
  clearIntervalImpl: typeof clearInterval;
  tick: () => void;
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
    tick: () => callback?.(),
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
        cellHeight: 16,
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

  test("off has no target at all", () => {
    expect(consoleFontTargetFor("off", CONSOLAS_18)).toBeNull();
  });
});

describe("startConsoleFontGuard", () => {
  test("records the baseline and leaves the preset face alone", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const events: ConsoleFontGuardEvent[] = [];
    startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      onEvent: (event) => events.push(event),
    });

    expect(events).toEqual([{ kind: "baseline", font: CONSOLAS_18 }]);
    expect(fake.applied).toEqual([]);
  });

  test("a face that is not the preset is repaired, not just a raster one", () => {
    // The 2026-10-23 report: conhost re-applies the console's saved default (宋体)
    // around startup. 宋体 is TrueType, so a raster-only judgement let it stand.
    const fake = createFakeConsole(SIMSUN_16);
    const events: ConsoleFontGuardEvent[] = [];
    startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      onEvent: (event) => events.push(event),
    });

    expect(fake.applied).toEqual([
      { face: "Consolas", cellHeight: 16, weight: 400 },
    ]);
    expect(events.at(-1)).toEqual({
      kind: "repaired",
      before: SIMSUN_16,
      target: { face: "Consolas", cellHeight: 16, weight: 400 },
    });
  });

  test("puts the session's face back after a flip", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const events: ConsoleFontGuardEvent[] = [];
    const guard = startConsoleFontGuard({
      port: fake.port,
      mode: "auto",
      onEvent: (event) => events.push(event),
    });

    fake.show(RASTER_12);
    guard.check();

    expect(fake.applied).toEqual([
      { face: "Consolas", cellHeight: 18, weight: 400 },
    ]);
    expect(events.at(-1)).toEqual({
      kind: "repaired",
      before: RASTER_12,
      target: { face: "Consolas", cellHeight: 18, weight: 400 },
    });
  });

  test("a steady window is not rewritten on every tick", () => {
    const fake = createFakeConsole(SIMSUN_16);
    const timer = createFakeTimer();
    startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      intervalMs: 250,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    });

    // The first check repaired 宋体 → Consolas; the fake now reports Consolas, so the
    // next three ticks must write nothing.
    expect(fake.applied).toHaveLength(1);
    timer.tick();
    timer.tick();
    timer.tick();
    expect(fake.applied).toHaveLength(1);
  });

  test("a pinned face is what the repair writes", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "霞鹜文楷等宽" },
    });

    expect(fake.applied[0]?.face).toBe("霞鹜文楷等宽");
  });

  test("a session that starts raster falls back to the preset face", () => {
    const fake = createFakeConsole(RASTER_12);
    const events: ConsoleFontGuardEvent[] = [];
    startConsoleFontGuard({
      port: fake.port,
      mode: "auto",
      onEvent: (event) => events.push(event),
    });

    expect(fake.applied).toEqual([
      {
        face: DEFAULT_CONSOLE_FONT.face,
        cellHeight: DEFAULT_CONSOLE_FONT.cellHeight,
        weight: DEFAULT_CONSOLE_FONT.weight,
      },
    ]);
    // The raster reading must not become the baseline: that would "restore" the
    // raster font on every later check.
    expect(events.some((event) => event.kind === "baseline")).toBe(false);
  });

  test("a console that does not answer stops the guard after one reading", () => {
    const fake = createFakeConsole(null);
    const events: ConsoleFontGuardEvent[] = [];
    const guard = startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      onEvent: (event) => events.push(event),
    });

    guard.check();

    expect(events).toEqual([{ kind: "unavailable" }]);
    expect(fake.reads()).toBe(1);
  });

  test("off does not even read the console", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    startConsoleFontGuard({ port: fake.port, mode: "off" });

    expect(fake.reads()).toBe(0);
    expect(fake.applied).toEqual([]);
  });

  test("a substituted face ends the guard instead of flickering forever", () => {
    // A CJK-only console accepts `Consolas` and keeps drawing 宋体. Without the
    // read-back this would rewrite the same rejected face every tick.
    const fake = createFakeConsole(SIMSUN_16);
    fake.substitute(SIMSUN_16);
    const timer = createFakeTimer();
    const events: ConsoleFontGuardEvent[] = [];
    startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "Consolas" },
      intervalMs: 250,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      onEvent: (event) => events.push(event),
    });

    expect(events.at(-1)?.kind).toBe("not-taken");
    timer.tick();
    timer.tick();
    timer.tick();

    expect(fake.applied).toHaveLength(2);
    expect(events.filter((event) => event.kind === "not-taken")).toHaveLength(
      2,
    );
    expect(timer.clears()).toBe(1);
  });

  test("two refused repairs end the polling", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const timer = createFakeTimer();
    const events: ConsoleFontGuardEvent[] = [];
    fake.refuse(true);
    startConsoleFontGuard({
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
    timer.tick();
    timer.tick();
    timer.tick();

    expect(fake.applied).toHaveLength(2);
    expect(
      events.filter((event) => event.kind === "repair-failed"),
    ).toHaveLength(2);
    expect(timer.clears()).toBe(1);
  });
});
