import { describe, expect, test } from "bun:test";
import { scanAnsi, visibleText, visibleWidth } from "@/cli/helpers/ansi-scan";

const ESC = "\u001B";

describe("ansi scanning", () => {
  test("splits text, escapes and controls without losing a byte", () => {
    const cases = [
      "plain",
      `${ESC}[1;31mred${ESC}[0m`,
      `${ESC}[?25lhidden`,
      `${ESC}]0;title\u0007after`,
      `${ESC}]52;c;YWJj${ESC}\\after`,
      `${ESC}(Bcs`,
      "a\u0007b",
      "line\nnext",
      `${ESC}[38;5;200mcoloured${ESC}[0m and ${ESC}[7minverse${ESC}[27m`,
      // Unterminated sequences must not throw or swallow the tail silently.
      `${ESC}]0;unterminated`,
      `${ESC}[1;2`,
      ESC,
    ];

    for (const input of cases) {
      const tokens = scanAnsi(input);
      expect([input, tokens.map((token) => token.value).join("")]).toEqual([
        input,
        input,
      ]);
      expect(tokens.every((token) => token.value.length > 0)).toBe(true);
    }
  });

  test("reads the kind of each token", () => {
    expect(scanAnsi(`${ESC}[0mhi`)).toEqual([
      { kind: "escape", value: `${ESC}[0m` },
      { kind: "text", value: "hi" },
    ]);
    expect(scanAnsi("\u0007")).toEqual([{ kind: "control", value: "\u0007" }]);
    expect(scanAnsi("a\r\nb")).toEqual([
      { kind: "text", value: "a" },
      { kind: "control", value: "\r" },
      { kind: "control", value: "\n" },
      { kind: "text", value: "b" },
    ]);
  });

  test("keeps an escape sequence in one token, parameters included", () => {
    // A parameter byte misread as content would shift every later column, which
    // is what the selection's copy and highlight are computed from.
    const tokens = scanAnsi(`${ESC}[<0;10;5M`);
    expect(tokens).toEqual([{ kind: "escape", value: `${ESC}[<0;10;5M` }]);
  });

  test("measures the visible text, not the escapes", () => {
    expect(visibleText(`${ESC}[1mhello${ESC}[0m`)).toBe("hello");
    expect(visibleWidth(`${ESC}[1mhello${ESC}[0m`)).toBe(5);
    // Wide characters take two columns, which is what makes a column-based
    // selection line up with what the user dragged over.
    expect(visibleWidth(`${ESC}[32m中文${ESC}[0m`)).toBe(4);
    expect(visibleWidth("a😀b")).toBe(4);
  });
});
