/**
 * The Windows console font, and the guard that puts this session's own back.
 *
 * ## The artifact this exists for
 *
 * Legacy `conhost.exe` can swap a *live* console window from the TrueType face it
 * was given to the smallest raster font — `FaceName = "Terminal"`, a 12-pixel-tall
 * cell, `FontFamily = 0x30` — while the program drawing into it keeps running. The
 * user calls it "换成最小号点阵字体", and it is the worst possible state for this
 * UI: block art, `·`, `┃` and every ambiguous width the layout arithmetic is built
 * on are drawn by a font that has none of those glyphs.
 *
 * Measured on this machine on 2026-10-23, in the interactive TUI: 08:04:35 a turn
 * started (the title spinner began), 08:04:38.691 the same window reported
 * `Terminal` / 8×12 / family 0x30 where it had reported `Consolas` / 8×18 / 0x36,
 * and **the cell grid, the screen buffer, the code page and the title were all
 * unchanged** — 99×39, 99×39, 65001, `⠇ KisetsuMeguriCoder` on both sides of the
 * flip. The registry was never involved: `HKCU\Console` still said `Consolas`,
 * family 0x36, height 0x10. So this is a runtime flip inside the console host, not
 * saved-setting drift — and nothing the app writes to the console undoes it.
 *
 * It is not our byte stream either: a synthetic load of exactly what the shell
 * writes (full-height frames with `ESC[2J`, alternate-screen hops at 8 Hz, an OSC 0
 * title spinner at 10 Hz, OSC 9;4 progress, rows past the band, CJK and block
 * glyphs) ran for a minute on a console of the same kind without a flip. Codex CLI
 * reports the same runtime flip under classic conhost (openai/codex#19141,
 * 2026-04-23) and confirms an external `SetCurrentConsoleFontEx` repairs the
 * affected window in place.
 *
 * ## What the guard does, and what it cannot do
 *
 * No escape sequence selects a console font — the Win32 call is the only lever — so
 * the guard reads the console's font on a timer and writes the target face back when
 * the window is drawing anything else. A reading is one Win32 call and a repair is
 * one more, so a quarter-second poll is free.
 *
 * The [user] expectation it serves is *“字体始终保持一致”*, not “换坏了再修”：the
 * guard exists because the console host changes the font on its own, twice observed —
 * `Consolas` → `宋体` around startup (the console's saved default being re-applied) and
 * `Consolas` → `Terminal` 8×12 mid-turn. A repair that only looked for the raster
 * fallback adopted `宋体` as “this session's face” and then restored *that* (report,
 * 2026-10-23), which is why the target is the configured face and the loop holds it.
 *
 * It **cannot** notice the flip any other way, and the measurement says why: the
 * cell grid did not change (99×39 stayed 99×39), so the terminal never sent
 * `resize`, and the app's own font-change signal — the ambiguous-width probe,
 * re-armed on resize (`./ambiguous-width-probe.ts`) — stayed silent. Nothing in the
 * frame differs; only a console query can see it. That is also why the guard polls
 * instead of hooking an event: there is no event.
 *
 * The port (`ConsoleFontPort`) is the whole Win32 surface, so everything above it
 * is testable without a console; `./console-font-bun.ts` supplies the real one.
 */

/** What conhost calls the raster fallback, in `FaceName`. */
export const RASTER_CONSOLE_FACE = "Terminal";

/**
 * `TMPF_VECTOR | TMPF_TRUETYPE` from `CONSOLE_FONT_INFOEX.FontFamily`.
 *
 * Every TrueType console face sets both bits — measured 0x36 for `Consolas` and
 * `霞鹜文楷等宽`, against 0x30 for `Terminal` — so their absence is a font the
 * renderer is rasterising, whatever it is called.
 */
const TRUE_TYPE_FAMILY_FLAGS = 0x06;

/**
 * The preset face: what to draw with when nothing else says otherwise.
 *
 * `Consolas` is the machine's own console default (`HKCU\Console` FaceName on the
 * machine this was written for) and the face the TUI is designed against: a Western
 * monospace at ~0.55 em, which is what makes ambiguous characters one column
 * (`/font-width`). It is also the fallback target for a session that never reported a
 * scalable face of its own.
 */
export const DEFAULT_CONSOLE_FONT = {
  face: "Consolas",
  cellHeight: 16,
  weight: 400,
} as const;

/** One reading of the console's font (`GetCurrentConsoleFontEx`). */
export interface ConsoleFont {
  face: string;
  /** Cell width in pixels; 0 when the face chooses its own. */
  cellWidth: number;
  /** Cell height in pixels. */
  cellHeight: number;
  /** Win32 `FontFamily`: style bits plus the `TMPF_*` capability flags. */
  family: number;
  weight: number;
}

/** What `SetCurrentConsoleFontEx` is given: a face and the cell height to draw it at. */
export interface ConsoleFontTarget {
  face: string;
  cellHeight: number;
  weight: number;
}

/**
 * The guard's configuration.
 *
 * The runtime's default is the **preset** (`{ pinnedFace: "Consolas" }`, see
 * `DEFAULT_CONSOLE_FONT`): the window draws that face and the guard holds it there.
 * `auto` is the opt-in alternative — restore the face this session started with, for
 * a machine whose console is configured for some other monospace. `off` disables the
 * guard. A pinned face always wins over the session's own.
 */
export type ConsoleFontMode = "auto" | "off" | { pinnedFace: string };

/** Everything the guard needs from Win32. */
export interface ConsoleFontPort {
  /** The console's current font, or `null` when this console does not answer. */
  read(): ConsoleFont | null;
  /** Ask the console to draw with `target`; `false` when it refused. */
  apply(target: ConsoleFontTarget): boolean;
}

export type ConsoleFontGuardEvent =
  | { kind: "baseline"; font: ConsoleFont }
  | { kind: "repaired"; before: ConsoleFont; target: ConsoleFontTarget }
  | { kind: "repair-failed"; target: ConsoleFontTarget }
  /** The console accepted the call and drew a different face (substitution). */
  | { kind: "not-taken"; target: ConsoleFontTarget; observed: ConsoleFont }
  | { kind: "unavailable" };

export interface ConsoleFontGuard {
  /** Run one check; the timer calls this, and `/console-font` may force it. */
  check(): void;
  /** Stop the timer. Idempotent. */
  stop(): void;
}

export interface ConsoleFontGuardOptions {
  port: ConsoleFontPort;
  mode: ConsoleFontMode;
  /** Called for everything worth a log line; never writes to the screen itself. */
  onEvent?: (event: ConsoleFontGuardEvent) => void;
  /** Poll interval in milliseconds; `0` checks once and stops. */
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

/** How many refusals in a row end the polling. */
const MAX_REPAIR_FAILURES = 2;

/** Whether this reading is the raster fallback rather than a scalable face. */
export function isRasterConsoleFont(
  font: Pick<ConsoleFont, "face" | "family">,
): boolean {
  if (font.face === RASTER_CONSOLE_FACE) return true;
  return (font.family & TRUE_TYPE_FAMILY_FLAGS) !== TRUE_TYPE_FAMILY_FLAGS;
}

/**
 * Read a stored or environment value as a mode.
 *
 * Anything unrecognised is `auto`: a typo in `settings.json` must leave the guard
 * working, not leave the window in the raster font.
 */
export function parseConsoleFontMode(value: unknown): ConsoleFontMode {
  if (typeof value !== "string") return "auto";
  const trimmed = value.trim();
  if (trimmed === "") return "auto";
  const lowered = trimmed.toLowerCase();
  if (lowered === "auto") return "auto";
  if (lowered === "off") return "off";
  return { pinnedFace: trimmed };
}

/** The face to write back, or `null` when the guard is off. */
export function consoleFontTargetFor(
  mode: ConsoleFontMode,
  baseline: ConsoleFont | null,
): ConsoleFontTarget | null {
  if (mode === "off") return null;
  const face =
    typeof mode === "object" ? mode.pinnedFace : (baseline?.face ?? "");
  return {
    face: face === "" ? DEFAULT_CONSOLE_FONT.face : face,
    cellHeight:
      baseline !== null && baseline.cellHeight > 0
        ? baseline.cellHeight
        : DEFAULT_CONSOLE_FONT.cellHeight,
    weight:
      baseline !== null && baseline.weight > 0
        ? baseline.weight
        : DEFAULT_CONSOLE_FONT.weight,
  };
}

/**
 * Hold the console at the target face.
 *
 * **A face that is not the target is repaired, not just a raster one.** On the
 * machine this was written for, conhost also swaps `Consolas` for `宋体` (the
 * console's saved default) when it re-applies console properties around startup,
 * and a guard that only looked for the raster fallback ended up "restoring" `宋体`:
 * the app adopted `宋体` as the session's face and faithfully put the user back into
 * the font they were trying to leave (user report, 2026-10-23: `Consolas → 启动 →
 * 宋体 → 手动 Consolas → 运行命令 → 点阵 → 自动切换宋体`). The rule is therefore "the
 * window draws the target face", and the only thing compared is the **face**: a
 * different cell height is the user zooming with `Ctrl+wheel`, which the guard leaves
 * alone.
 *
 * The **baseline** is the first scalable reading, and only `auto` consults it (auto
 * restores whatever the session started with). A raster reading is never adopted, so
 * one flipped moment cannot become the target.
 *
 * Every write is **verified with a second reading**. conhost may accept the call and
 * draw something else — a CJK-only console substitutes `宋体` for a Western face —
 * and without the check the guard would rewrite the same rejected font every tick:
 * a flicker forever, and a repair that exists only to fight itself. Two rejections
 * end the polling with a logged reason, which is the honest outcome.
 *
 * A console that does not answer (a ConPTY host, a redirected stdout) ends the guard
 * on the first reading instead of spawning a timer that can never do anything.
 */
export function startConsoleFontGuard(
  options: ConsoleFontGuardOptions,
): ConsoleFontGuard {
  const {
    port,
    mode,
    onEvent,
    intervalMs = 0,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = options;

  let baseline: ConsoleFont | null = null;
  let refusals = 0;
  let stopped = mode === "off";
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  const check = (): void => {
    if (stopped) return;

    const current = port.read();
    if (current === null) {
      onEvent?.({ kind: "unavailable" });
      stop();
      return;
    }

    if (baseline === null && !isRasterConsoleFont(current)) {
      baseline = current;
      onEvent?.({ kind: "baseline", font: current });
    }

    const target = consoleFontTargetFor(mode, baseline);
    if (target === null) {
      stop();
      return;
    }

    const holding =
      current.face === target.face && !isRasterConsoleFont(current);
    if (holding) return;

    if (!port.apply(target)) {
      refusals += 1;
      onEvent?.({ kind: "repair-failed", target });
      if (refusals >= MAX_REPAIR_FAILURES) stop();
      return;
    }

    const observed = port.read();
    if (observed === null) {
      onEvent?.({ kind: "unavailable" });
      stop();
      return;
    }
    if (observed.face !== target.face) {
      refusals += 1;
      onEvent?.({ kind: "not-taken", target, observed });
      if (refusals >= MAX_REPAIR_FAILURES) stop();
      return;
    }

    refusals = 0;
    onEvent?.({ kind: "repaired", before: current, target });
  };

  check();
  if (!stopped && intervalMs > 0) {
    timer = setIntervalImpl(check, intervalMs);
    // A guard is not a reason to keep the process alive.
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  }

  return { check, stop };
}
