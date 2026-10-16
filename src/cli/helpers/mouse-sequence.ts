/**
 * The raw mouse reports a terminal sends, read the way `input-sequence.ts` reads
 * a key sequence: a deliberately small, sound-by-construction set.
 *
 * Why this module exists at all: Ink 7 has no mouse API, and a report that
 * nobody reads does not stay invisible — Ink parses it as input, so a wheel
 * notch or a click lands in the draft as literal text. The router therefore has
 * to recognize the two encodings a terminal can use and keep them away from the
 * text editor.
 *
 * Two encodings, both recognized exactly (never by a general CSI grammar):
 *
 * - **SGR** (`ESC [ < Cb ; Cx ; Cy M|m`), the one the app asks for with the
 *   `1006` mode. Coordinates are 1-based decimal, and `m` marks a release
 *   instead of a press.
 * - **X10** (`ESC [ M` + three bytes), what a terminal sends when it ignores the
 *   request for `1006`. Each byte has 32 added to it, so the payload is three
 *   bytes in `0x20`–`0xff`.
 *
 * A report Ink would read as text is a report this module must claim, so the
 * unrecognized-button cases do *not* return `undefined`: the caller's contract is
 * "a mouse report is never text", whether or not the app has an action for it.
 */

const ESC = "\u001B";

export type MouseButton = "left" | "middle" | "right" | "none";

export type MouseWheelDirection = "up" | "down" | "left" | "right";

export interface MouseModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface MouseReport {
  /** A button went down or up, or the pointer moved while one was down. */
  kind: "press" | "release" | "move";
  button: MouseButton;
  /** Set for a wheel notch; a wheel report carries no press or release. */
  wheel?: MouseWheelDirection;
  /** 1-based screen column, exactly as the terminal reported it. */
  column: number;
  /** 1-based screen row, exactly as the terminal reported it. */
  row: number;
  modifiers: MouseModifiers;
}

const SGR_REPORT = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`);
const X10_PREFIX = `${ESC}[M`;
const X10_LENGTH = X10_PREFIX.length + 3;

/**
 * What a button code means.
 *
 * The low two bits select the button, bit 5 marks motion, bit 6 a wheel notch
 * and bit 7 the additional buttons 8–11. The two wheel axes reuse the same two
 * low bits (`0`/`1` vertical, `2`/`3` horizontal), which is why they are read
 * before the button is.
 */
function decodeButton(code: number): {
  button: MouseButton;
  wheel?: MouseWheelDirection;
  motion: boolean;
} {
  const motion = (code & 32) !== 0;
  const low = code & 3;

  if ((code & 64) !== 0) {
    const wheel: MouseWheelDirection =
      low === 1 ? "down" : low === 2 ? "left" : low === 3 ? "right" : "up";
    return { button: "none", wheel, motion };
  }

  // Buttons 8–11 (bit 7) have no action in this app; they are still reports, so
  // they are decoded as "no button" rather than dropped.
  if ((code & 128) !== 0) {
    return { button: "none", motion };
  }

  const button: MouseButton =
    low === 0 ? "left" : low === 1 ? "middle" : low === 2 ? "right" : "none";
  return { button, motion };
}

function decodeModifiers(code: number): MouseModifiers {
  return {
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

function buildReport(
  code: number,
  column: number,
  row: number,
  final: "M" | "m" | "x10",
): MouseReport | undefined {
  if (!Number.isSafeInteger(code) || column < 1 || row < 1) return undefined;
  const { button, wheel, motion } = decodeButton(code);
  if (wheel) {
    // A wheel report has no press/release of its own: the notch *is* the press.
    return {
      kind: "press",
      button,
      wheel,
      column,
      row,
      modifiers: decodeModifiers(code),
    };
  }
  // X10 has no release byte: a released button is code 3, which is how it says
  // "no button is down any more".
  const kind: MouseReport["kind"] =
    final === "m"
      ? "release"
      : motion
        ? "move"
        : button === "none"
          ? "release"
          : "press";
  return { kind, button, wheel, column, row, modifiers: decodeModifiers(code) };
}

/**
 * Read a raw stdin string as a mouse report, or `undefined` when it is not one.
 *
 * `undefined` means "not a mouse report" and nothing else: the caller then lets
 * the ordinary key path have the payload.
 */
export function parseMouseReport(raw: string): MouseReport | undefined {
  const sgr = SGR_REPORT.exec(raw);
  if (sgr) {
    const [, code, column, row, final] = sgr;
    return buildReport(
      Number.parseInt(code ?? "", 10),
      Number.parseInt(column ?? "", 10),
      Number.parseInt(row ?? "", 10),
      final === "m" ? "m" : "M",
    );
  }

  if (raw.length !== X10_LENGTH || !raw.startsWith(X10_PREFIX))
    return undefined;
  return buildReport(
    raw.charCodeAt(X10_PREFIX.length) - 32,
    raw.charCodeAt(X10_PREFIX.length + 1) - 32,
    raw.charCodeAt(X10_PREFIX.length + 2) - 32,
    "x10",
  );
}

/** Whether this raw payload is a mouse report (the router must not treat it as text). */
export function isMouseReport(raw: string): boolean {
  return parseMouseReport(raw) !== undefined;
}
