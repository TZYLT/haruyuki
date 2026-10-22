import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { calculateLuminance } from "@/cli/helpers/terminal-theme";
import { type CliPalette, colors, paletteForTheme } from "./colors";

/**
 * The colour layer's own guarantees (P7, 《38》§11).
 *
 * Three things are worth a test and nothing else is:
 *
 * 1. **Both palettes are complete.** The type already forces the light palette to
 *    answer every key, but it cannot force a *non-empty* answer — and an empty
 *    string is an invisible token that type-checks.
 * 2. **The light palette is actually the light one.** "Same hue, darkened" is a
 *    rule with a measurable consequence: text must be darker than the dark
 *    theme's text, and a background tint must be lighter than the dark theme's.
 * 3. **No colour literal lives outside this module.** That is the whole point of
 *    the token layer; a hex in a component is a value that will not follow the
 *    theme, and it is invisible in review.
 */

const TERMINAL_THEME_STATE_KEY = Symbol.for("letta.terminalThemeState");

type ThemeState = { cachedTheme: "light" | "dark" | null };

function themeState(): ThemeState {
  const globalObject = globalThis as typeof globalThis & {
    [TERMINAL_THEME_STATE_KEY]?: ThemeState;
  };
  globalObject[TERMINAL_THEME_STATE_KEY] ??= { cachedTheme: null };
  return globalObject[TERMINAL_THEME_STATE_KEY] as ThemeState;
}

function luminanceOf(value: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const int = parseInt(match[1], 16);
  return calculateLuminance((int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff);
}

function expectDarker(light: string, dark: string, token: string): void {
  const lightLum = luminanceOf(light);
  const darkLum = luminanceOf(dark);
  // A named colour (`"green"`) is the terminal's own palette and cannot be
  // compared numerically; the tokens listed below are hex on both sides by design.
  if (lightLum === null || darkLum === null) {
    throw new Error(`${token} is not a hex pair: ${light} / ${dark}`);
  }
  expect({ token, darker: lightLum < darkLum }).toEqual({
    token,
    darker: true,
  });
}

function expectLighter(light: string, dark: string, token: string): void {
  const lightLum = luminanceOf(light);
  const darkLum = luminanceOf(dark);
  if (lightLum === null || darkLum === null) {
    throw new Error(`${token} is not a hex pair: ${light} / ${dark}`);
  }
  expect({ token, lighter: lightLum > darkLum }).toEqual({
    token,
    lighter: true,
  });
}

/** Every string leaf of a palette, as `a.b.c → value`, so completeness is walkable. */
function flatten(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): void {
  if (typeof value === "string" || value === undefined) {
    out.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    out.set(prefix, value);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      flatten(nested, prefix === "" ? key : `${prefix}.${key}`, out);
    }
  }
}

describe("the palettes", () => {
  const dark = paletteForTheme("dark");
  const light = paletteForTheme("light");

  test("answer the same tokens, and no light token is empty", () => {
    const darkTokens = new Map<string, unknown>();
    const lightTokens = new Map<string, unknown>();
    flatten(dark, "", darkTokens);
    flatten(light, "", lightTokens);

    expect([...lightTokens.keys()].sort()).toEqual(
      [...darkTokens.keys()].sort(),
    );
    for (const [token, value] of lightTokens) {
      if (typeof value === "string") {
        expect({ token, empty: value.trim() === "" }).toEqual({
          token,
          empty: false,
        });
      }
    }
  });

  test("light text is darker than dark text", () => {
    // `text.disabled` and `text.sectionHeader` are deliberately *not* here: those
    // two move toward the background, which means lighter on a light terminal.
    const tokens: [string, string, string][] = [
      ["text.primary", light.text.primary, dark.text.primary],
      ["text.secondary", light.text.secondary, dark.text.secondary],
      ["state.success", light.state.success, dark.state.success],
      ["state.warning", light.state.warning, dark.state.warning],
      ["state.error", light.state.error, dark.state.error],
      ["focus.selected", light.focus.selected, dark.focus.selected],
      ["focus.focusRing", light.focus.focusRing, dark.focus.focusRing],
      ["subagent.hint", light.subagent.hint, dark.subagent.hint],
      ["bgSubagent.label", light.bgSubagent.label, dark.bgSubagent.label],
      [
        "contextBreakdown.system",
        light.contextBreakdown.system,
        dark.contextBreakdown.system,
      ],
      [
        "contextBreakdown.tools",
        light.contextBreakdown.tools,
        dark.contextBreakdown.tools,
      ],
    ];
    for (const [token, lightValue, darkValue] of tokens) {
      expectDarker(lightValue, darkValue, token);
    }
  });

  test("light backgrounds are tints, not the dark theme's deep fills", () => {
    expectLighter(
      light.surface.diffAddBg,
      dark.surface.diffAddBg,
      "surface.diffAddBg",
    );
    expectLighter(
      light.surface.diffDelBg,
      dark.surface.diffDelBg,
      "surface.diffDelBg",
    );
    expectLighter(
      light.diff.addedWordBg,
      dark.diff.addedWordBg,
      "diff.addedWordBg",
    );
    expectLighter(
      light.diff.removedWordBg,
      dark.diff.removedWordBg,
      "diff.removedWordBg",
    );
  });

  test("text drawn on a tint flips to dark on the light theme", () => {
    // Dark: the tint is deep, so the text is `white` (the terminal's own). Light:
    // the tint is pale, so the token must be a dark hex — "white" here would be
    // the pre-P7 bug this rename fixes.
    expect(dark.diff.textOnTint).toBe("white");
    const lightLum = luminanceOf(light.diff.textOnTint);
    expect(lightLum).not.toBeNull();
    expect(lightLum as number).toBeLessThan(0.2);
  });

  test("the section header stays one step toward the background", () => {
    // Dark theme: the header is darker than body text. Light theme: lighter.
    const darkHeader = luminanceOf(dark.text.sectionHeader);
    const darkBody = luminanceOf(dark.text.primary);
    const lightHeader = luminanceOf(light.text.sectionHeader);
    const lightBody = luminanceOf(light.text.primary);
    expect(darkHeader).not.toBeNull();
    expect(darkBody).not.toBeNull();
    expect(lightHeader).not.toBeNull();
    expect(lightBody).not.toBeNull();
    expect(darkHeader as number).toBeLessThan(darkBody as number);
    expect(lightHeader as number).toBeGreaterThan(lightBody as number);
  });

  test("the chart ramp keeps its five steps on both themes", () => {
    expect(dark.contextChart.ramp).toHaveLength(5);
    expect(light.contextChart.ramp).toHaveLength(5);
  });
});

describe("the live token object", () => {
  let originalTheme: "light" | "dark" | null;

  beforeAll(() => {
    originalTheme = themeState().cachedTheme;
  });

  afterAll(() => {
    themeState().cachedTheme = originalTheme;
  });

  test("resolves against the theme at read time, not at import time", () => {
    themeState().cachedTheme = "light";
    expect(colors.theme).toBe("light");
    expect(colors.text.primary).toBe("#202020");

    themeState().cachedTheme = "dark";
    expect(colors.theme).toBe("dark");
    expect(colors.text.primary).toBe("#DEE1E4");
  });

  test("the page groups read through to the palette", () => {
    themeState().cachedTheme = "dark";
    expect(colors.sectionHeader).toBe(
      paletteForTheme("dark").text.sectionHeader,
    );
    expect(colors.surface.hoverBg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(colors.userMessage.background).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

/**
 * `src/cli` must contain no colour literal outside the palette.
 *
 * The scan is deliberately blunt — any `#RRGGBB` in a shipped file — because the
 * failure it guards against is "someone added a colour that looks right in the
 * dark theme". Test files are skipped: they assert expected colours, which is the
 * opposite of a literal leaking into the product.
 */
describe("the colour layer is the only place with a hex", () => {
  const here = import.meta.dir;
  const cliRoot = path.resolve(here, "..");
  const colorModule = path.join(here, "colors.ts");

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...sourceFiles(full));
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      found.push(full);
    }
    return found;
  }

  test("no hex outside colors.ts", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(cliRoot)) {
      if (path.resolve(file) === colorModule) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
        offenders.push(`${path.relative(cliRoot, file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every palette value is a colour this terminal can paint", () => {
    // Named ANSI colours and hex are both fine; an empty or free-form string is
    // the failure (a token that typos into invisibility).
    const named = new Set([
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "gray",
      "grey",
      "blackBright",
      "redBright",
      "greenBright",
      "yellowBright",
      "blueBright",
      "magentaBright",
      "cyanBright",
      "whiteBright",
    ]);
    const values = new Map<string, unknown>();
    flatten(paletteForTheme("light"), "", values);
    flatten(paletteForTheme("dark"), "", values);
    for (const [token, value] of values) {
      if (typeof value !== "string") continue;
      const ok = /^#[0-9a-f]{6}$/i.test(value) || named.has(value);
      expect({ token, ok }).toEqual({ token, ok: true });
    }
  });
});

// Keep the palettes' shape honest at the type level as well: a rename in the
// palette type that forgets a palette fails this assignment, next to the runtime
// walk above.
const _darkShape: CliPalette = paletteForTheme("dark");
const _lightShape: CliPalette = paletteForTheme("light");
void _darkShape;
void _lightShape;
