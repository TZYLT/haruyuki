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

/** What the machine's window reports before the flip (2026-10-23 measurement). */
const CONSOLAS_18: ConsoleFont = {
  face: "Consolas",
  cellWidth: 8,
  cellHeight: 18,
  family: 0x36,
  weight: 400,
};

/** The flip itself: the smallest raster face, and it has no block glyphs. */
const RASTER_12: ConsoleFont = {
  face: "Terminal",
  cellWidth: 8,
  cellHeight: 12,
  family: 0x30,
  weight: 400,
};

/** A CJK monospace console face, to pin that "not Consolas" is not "raster". */
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
  refuse(value: boolean): void;
}

function createFakeConsole(initial: ConsoleFont | null): FakeConsole {
  let font = initial;
  let refused = false;
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
        return !refused;
      },
    },
    show: (next) => {
      font = next;
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

  test("anything else is a face to restore, trimmed", () => {
    expect(parseConsoleFontMode(" Consolas ")).toEqual({
      pinnedFace: "Consolas",
    });
    expect(parseConsoleFontMode("霞鹜文楷等宽")).toEqual({
      pinnedFace: "霞鹜文楷等宽",
    });
  });
});

describe("consoleFontTargetFor", () => {
  test("auto restores the session's own face at its own height", () => {
    expect(consoleFontTargetFor("auto", CONSOLAS_18)).toEqual({
      face: "Consolas",
      cellHeight: 18,
      weight: 400,
    });
  });

  test("a pinned face wins, the height still comes from the session", () => {
    expect(
      consoleFontTargetFor({ pinnedFace: "霞鹜文楷等宽" }, CONSOLAS_18),
    ).toEqual({
      face: "霞鹜文楷等宽",
      cellHeight: 18,
      weight: 400,
    });
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
  test("records the baseline and leaves a healthy console alone", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const events: ConsoleFontGuardEvent[] = [];
    startConsoleFontGuard({
      port: fake.port,
      mode: "auto",
      onEvent: (event) => events.push(event),
    });

    expect(events).toEqual([{ kind: "baseline", font: CONSOLAS_18 }]);
    expect(fake.applied).toEqual([]);
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

  test("a pinned face is what the repair writes", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const guard = startConsoleFontGuard({
      port: fake.port,
      mode: { pinnedFace: "霞鹜文楷等宽" },
    });

    fake.show(RASTER_12);
    guard.check();

    expect(fake.applied[0]?.face).toBe("霞鹜文楷等宽");
  });

  test("a session that starts flipped falls back to the preset face", () => {
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
      mode: "auto",
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

  test("three refused repairs end the polling", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const timer = createFakeTimer();
    const events: ConsoleFontGuardEvent[] = [];
    startConsoleFontGuard({
      port: fake.port,
      mode: "auto",
      intervalMs: 1000,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      onEvent: (event) => events.push(event),
    });

    fake.show(RASTER_12);
    fake.refuse(true);
    timer.tick();
    timer.tick();
    timer.tick();
    timer.tick();

    expect(fake.applied).toHaveLength(3);
    expect(
      events.filter((event) => event.kind === "repair-failed"),
    ).toHaveLength(3);
    expect(timer.clears()).toBe(1);
  });

  test("the timer keeps checking until it is stopped", () => {
    const fake = createFakeConsole(CONSOLAS_18);
    const timer = createFakeTimer();
    const guard = startConsoleFontGuard({
      port: fake.port,
      mode: "auto",
      intervalMs: 1000,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    });

    expect(fake.reads()).toBe(1);
    timer.tick();
    expect(fake.reads()).toBe(2);

    fake.show(RASTER_12);
    timer.tick();
    expect(fake.applied).toHaveLength(1);

    guard.stop();
    timer.tick();
    expect(fake.reads()).toBe(3);
  });
});
