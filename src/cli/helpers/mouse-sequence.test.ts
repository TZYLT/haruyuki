import { describe, expect, test } from "bun:test";
import {
  type MouseReport,
  parseMouseReport,
} from "@/cli/helpers/mouse-sequence";

const ESC = "\u001B";

function sgr(code: number, column: number, row: number, final = "M"): string {
  return `${ESC}[<${code};${column};${row}${final}`;
}

/** The X10 form: `ESC [ M` plus the three payload bytes, each shifted by 32. */
function x10(code: number, column: number, row: number): string {
  return (
    `${ESC}[M` +
    String.fromCharCode(code + 32) +
    String.fromCharCode(column + 32) +
    String.fromCharCode(row + 32)
  );
}

function summary(report: MouseReport | undefined) {
  if (!report) return undefined;
  return {
    kind: report.kind,
    button: report.button,
    wheel: report.wheel,
    position: [report.column, report.row],
    modifiers: report.modifiers,
  };
}

describe("mouse report parsing", () => {
  test("reads an SGR wheel notch", () => {
    expect(summary(parseMouseReport(sgr(64, 10, 5)))).toEqual({
      kind: "press",
      button: "none",
      wheel: "up",
      position: [10, 5],
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    expect(summary(parseMouseReport(sgr(65, 10, 5)))).toEqual({
      kind: "press",
      button: "none",
      wheel: "down",
      position: [10, 5],
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    // Horizontal wheels: recognized so they are never typed as text, even though
    // the viewport has no horizontal axis to move.
    expect(parseMouseReport(sgr(66, 1, 1))?.wheel).toBe("left");
    expect(parseMouseReport(sgr(67, 1, 1))?.wheel).toBe("right");
  });

  test("reads SGR press, release and motion", () => {
    expect(summary(parseMouseReport(sgr(0, 3, 4)))).toEqual({
      kind: "press",
      button: "left",
      wheel: undefined,
      position: [3, 4],
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    // `m` is the release final byte.
    expect(parseMouseReport(sgr(0, 3, 4, "m"))?.kind).toBe("release");
    // A released button without a final `m` (some terminals) is still a release.
    expect(summary(parseMouseReport(sgr(3, 3, 4)))).toEqual({
      kind: "release",
      button: "none",
      wheel: undefined,
      position: [3, 4],
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    // Bit 5 is motion, so the same button code reports a drag.
    expect(summary(parseMouseReport(sgr(32, 3, 4)))).toEqual({
      kind: "move",
      button: "left",
      wheel: undefined,
      position: [3, 4],
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    expect(parseMouseReport(sgr(1, 1, 1))?.button).toBe("middle");
    expect(parseMouseReport(sgr(2, 1, 1))?.button).toBe("right");
  });

  test("reads the modifier bits", () => {
    // shift 4 + alt 8 + ctrl 16, plus the left button.
    expect(parseMouseReport(sgr(28, 1, 1))?.modifiers).toEqual({
      shift: true,
      alt: true,
      ctrl: true,
    });
  });

  test("reads the X10 form when a caller sees the whole payload", () => {
    // A parse-level guard only: Ink's parser splits `ESC [ M` from its three payload
    // bytes, so the app never receives this shape and X10-only terminals are covered
    // by `Ctrl+X m` instead. The branch stays because the caller's contract is that no
    // report-shaped payload reaches the text path.
    expect(summary(parseMouseReport(x10(0, 1, 2)))).toEqual({
      kind: "press",
      button: "left",
      wheel: undefined,
      position: [1, 2],
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    expect(parseMouseReport(x10(3, 1, 2))?.kind).toBe("release");
    expect(parseMouseReport(x10(64, 1, 2))?.wheel).toBe("up");
    expect(parseMouseReport(x10(65, 1, 2))?.wheel).toBe("down");
    expect(parseMouseReport(x10(32, 4, 5))?.kind).toBe("move");
  });

  test("keeps decoding the reports it has no action for", () => {
    // Buttons 8-11 and horizontal wheels are still reports: returning undefined
    // for them would let the bytes through to the text editor.
    expect(parseMouseReport(sgr(128, 1, 1))).toBeDefined();
    expect(parseMouseReport(sgr(131, 1, 1))).toBeDefined();
  });

  test("claims a report whose coordinates are outside the grammar", () => {
    // `undefined` means "not a report" and nothing else. A report that matched the
    // grammar has already been kept away from the text editor at this point, so a
    // coordinate of 0 (X10 payloads below 0x20, an off-screen position some reporters
    // round down) must be clamped rather than rejected: rejecting it here is what put
    // the bytes back into the draft.
    expect(summary(parseMouseReport(sgr(0, 0, 5)))?.position).toEqual([1, 5]);
    expect(summary(parseMouseReport(sgr(0, 10, 0)))?.position).toEqual([10, 1]);
    // An X10 payload byte below 0x20 decodes to a negative coordinate.
    expect(summary(parseMouseReport(x10(0, -32, 1)))?.position).toEqual([1, 1]);
  });

  test("rejects everything that is not a mouse report", () => {
    const notMouse = [
      "hello",
      "",
      "\r",
      `${ESC}[A`,
      `${ESC}[<0;10;5X`, // unknown final byte
      `${ESC}[<;10;5M`,
      `${ESC}[<0;10;5`, // truncated
      `${ESC}[M`, // X10 header without its payload
      `${ESC}[Mab`, // five bytes: too short for the three-byte payload
      `${ESC}[25;2;13~`,
    ];
    for (const raw of notMouse) {
      expect([raw, parseMouseReport(raw)]).toEqual([raw, undefined]);
    }
  });
});
