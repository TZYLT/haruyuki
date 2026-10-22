/**
 * Haruyuki Color System
 *
 * The single source of colour for the TUI (《38》§11.2, layer L2). Nothing else
 * under `src/cli` writes a colour value: a component asks for a token here, and
 * this file is the only place that spells a hex (P7's `grep` judgement).
 *
 * **Two palettes, one token list.** Every token carries a dark and a light value,
 * and `colors` resolves the pair against the terminal's own theme *when it is
 * read* — the theme probe is async and lands after the first import, so a value
 * captured at import time would freeze whichever theme happened to be current
 * then (this is what kept `brandColorsLight` dead code until P7). The dark values
 * are the ones this tree shipped before P7 and are deliberately unchanged; the
 * light ones are 《38》§11.11's v1, whose rule is *same hue, darkened for text,
 * tinted for backgrounds*.
 *
 * **Tokens are named by purpose, not by component** (《38》§11.3): a component asks
 * for `text.sectionHeader`, never for "the settings page's grey". The domain
 * groups (`tool`, `approval`, `diff`, `subagent`, `contextBreakdown`, `bash`) keep
 * their finer names because their callers already speak them.
 */

import {
  getTerminalBackgroundColor,
  getTerminalTheme,
  type TerminalRgb,
  type TerminalTheme,
} from "@/cli/helpers/terminal-theme";

/**
 * Parse a hex color (#RRGGBB) to RGB components.
 */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: TerminalRgb): string {
  const toHex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function isLightRgb({ r, g, b }: TerminalRgb): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b > 128;
}

function blendRgb(
  fg: TerminalRgb,
  bg: TerminalRgb,
  alpha: number,
): TerminalRgb {
  return {
    r: Math.floor(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.floor(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.floor(fg.b * alpha + bg.b * (1 - alpha)),
  };
}

function getCodexUserMessageBackground(): string {
  const theme = getTerminalTheme();
  const terminalBg =
    getTerminalBackgroundColor() ??
    (theme === "light" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 });
  const overlay = isLightRgb(terminalBg)
    ? { color: { r: 0, g: 0, b: 0 }, alpha: 0.04 }
    : { color: { r: 255, g: 255, b: 255 }, alpha: 0.12 };

  return rgbToHex(blendRgb(overlay.color, terminalBg, overlay.alpha));
}

/**
 * The row a pointer is over (《38》§19.5).
 *
 * Lighter than `userMessage`'s tint on purpose: a pointer highlight is a
 * *transient* "you are here", and at the user message's weight a bright row would
 * read as selected. The mix follows the terminal's own background, so a light
 * theme gets a darker tint rather than a white-on-white no-op — and a terminal
 * that never answered the theme query (`getTerminalBackgroundColor` is `null`)
 * still gets a usable value from the light/dark fallback.
 *
 * **6% was invisible on the first real run.** The row is painted behind text only
 * (Ink has no cell background of its own), so at that weight it read as "nothing
 * happened". 10% is still a *background*, not a selection, and it is the value P7's
 * visual pass should start from.
 */
function getHoverBackground(): string {
  const theme = getTerminalTheme();
  const terminalBg =
    getTerminalBackgroundColor() ??
    (theme === "light" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 });
  const overlay = isLightRgb(terminalBg)
    ? { color: { r: 0, g: 0, b: 0 }, alpha: 0.1 }
    : { color: { r: 255, g: 255, b: 255 }, alpha: 0.1 };

  return rgbToHex(blendRgb(overlay.color, terminalBg, overlay.alpha));
}

/**
 * Convert a hex color (#RRGGBB) to an ANSI 24-bit background escape sequence.
 */
export function hexToBgAnsi(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Convert a hex color (#RRGGBB) to an ANSI 24-bit foreground escape sequence.
 */
export function hexToFgAnsi(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

// Brand colors (dark mode)
export const brandColors = {
  // text colors
  primaryAccent: "#7FB3E3", // spring-snow sky blue
  primaryAccentLight: "#BCD8F0", // snow highlight
  textMain: "#DEE1E4", // white
  textSecondary: "#A5A8AB", // light grey
  textDisabled: "#46484A", // dark grey
  // status colors
  statusSuccess: "#64CF64", // green
  statusWarning: "#FEE19C", // yellow
  statusError: "#F1689F", // red
} as const;

// Brand colors (light mode) — the anchors §11.11's light palette is built from.
// P7 wired them in: before that they were referenced only by the palette below,
// so no light value ever reached a component.
export const brandColorsLight = {
  // text colors
  primaryAccent: "#2F6FA8", // spring-snow sky blue
  primaryAccentLight: "#7FA8CC", // snow highlight
  textMain: "#202020", // white
  textSecondary: "#797B7D", // light grey
  textDisabled: "#A5A8AB", // dark grey
  // status colors
  statusSuccess: "#28A428", // green
  statusWarning: "#B98813", // yellow
  statusError: "#BA024C", // red
} as const;

/**
 * Shell command syntax highlighting: a light/dark pair of its own.
 *
 * It predates the palette (its values are a Catppuccin pair) and its shape is
 * wider than one token, so it stays a pair rather than being flattened into the
 * token list; `colors.shellSyntax` still resolves it per read.
 */
export type ShellSyntaxTokens = {
  prompt: string;
  text: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  literal: string;
  builtIn: string;
  variable: string;
  title: string;
  attr: string;
  operator: string;
  punctuation: string;
  meta: string;
  substitution: string;
};

const shellSyntaxDark: ShellSyntaxTokens = {
  prompt: "#cba6f7",
  text: "#cdd6f4",
  comment: "#6c7086",
  keyword: "#89b4fa",
  string: "#a6e3a1",
  number: "#fab387",
  literal: "#fab387",
  builtIn: "#f9e2af",
  variable: "#f5c2e7",
  title: "#94e2d5",
  attr: "#74c7ec",
  operator: "#bac2de",
  punctuation: "#bac2de",
  meta: "#f38ba8",
  substitution: "#f5c2e7",
} as const;

const shellSyntaxLight: ShellSyntaxTokens = {
  prompt: "#8839ef",
  text: "#4c4f69",
  comment: "#9ca0b0",
  keyword: "#1e66f5",
  string: "#40a02b",
  number: "#fe640b",
  literal: "#fe640b",
  builtIn: "#df8e1d",
  variable: "#ea76cb",
  title: "#179299",
  attr: "#209fb5",
  operator: "#5c5f77",
  punctuation: "#5c5f77",
  meta: "#d20f39",
  substitution: "#e64553",
} as const;

/**
 * The shape of one complete palette. Both palettes fill every field, so a token
 * added here fails to type-check until both themes answer it.
 */
export type CliPalette = {
  text: {
    primary: string;
    secondary: string;
    dim: string;
    disabled: string;
    inverse: string;
    sectionHeader: string;
  };
  state: {
    success: string;
    warning: string;
    error: string;
    info: string;
    pending: string;
  };
  focus: {
    selected: string;
    focusRing: string;
    cursor: string;
    /**
     * The container's left accent bar (`┃`, 《38》§11.9): the current tab's edge,
     * a page's outer edge, the user message block. Decoration only — it carries no
     * meaning a keyboard user needs.
     */
    rail: string;
  };
  surface: {
    border: string;
    rule: string;
    ruleDashed: string;
    /** Background of a diff's added / removed lines. */
    diffAddBg: string;
    diffDelBg: string;
  };
  welcome: { border: string; accent: string };
  selector: {
    border: string;
    title: string;
    itemHighlighted: string;
    itemCurrent: string;
  };
  command: {
    selected: string;
    inactive: string;
    border: string;
    running: string;
    error: string;
  };
  approval: { border: string; header: string };
  code: { inline: string };
  link: { text: string; url: string };
  heading: { primary: string; secondary: string };
  status: {
    error: string;
    success: string;
    interrupt: string;
    processing: string;
    processingShimmer: string;
    /**
     * The two anchors the "thinking" breath moves toward (`phase-visuals.ts`).
     * They are tokens rather than literals because the light theme needs a lighter
     * lobe that is still visible on white.
     */
    thinkingLighter: string;
    thinkingDeeper: string;
  };
  tool: {
    pending: string;
    completed: string;
    streaming: string;
    running: string;
    error: string;
    memoryName: string;
  };
  input: { border: string; prompt: string };
  bash: { prompt: string; border: string; dot: string };
  todo: { completed: string; inProgress: string };
  subagent: {
    header: string;
    running: string;
    completed: string;
    error: string;
    treeChar: string;
    hint: string;
  };
  bgSubagent: { label: string; spinner: string };
  info: { border: string; prompt: string };
  diff: {
    addedLineBg: string;
    removedLineBg: string;
    contextLineBg: string | undefined;
    /** Word-level highlight colours (used by `MemoryDiffRenderer`). */
    addedWordBg: string;
    removedWordBg: string;
    /**
     * Text drawn *on* a tinted diff row. It must be dark on the light palette's
     * pale tints and light on the dark palette's deep ones — which is why it is a
     * token and not `"white"` (its pre-P7 name, `textOnDark`, was the bug).
     */
    textOnTint: string;
    symbolAdd: string;
    symbolRemove: string;
    symbolContext: string | undefined;
  };
  error: { border: string; text: string };
  /** Legacy aliases of `text.primary`; no new caller should read them. */
  textLegacy: { normal: string; bold: string };
  toast: { marker: string; text: string };
  footer: { agentName: string };
  contextBreakdown: {
    system: string;
    coreMemory: string;
    tools: string;
    messages: string;
    summaryMemory: string;
    other: string;
  };
  /** The welcome logo's decorative block cells (not theme-dependent). */
  logo: { dot: string; shadow: string };
  /** Provider badges: the OpenAI Codex mark's teal (not theme-dependent). */
  provider: { openaiCodex: string };
  /** The braille context chart's cycling ramp, lightest → darkest. */
  contextChart: { ramp: readonly string[] };
};

/**
 * The dark palette: every value this tree shipped before P7.
 *
 * `《38》§11.11` freezes these — the light pass adds a second column, it does not
 * retune the first. A change here is a separate ruling.
 */
const darkPalette: CliPalette = {
  text: {
    primary: brandColors.textMain,
    secondary: brandColors.textSecondary,
    dim: "gray",
    disabled: brandColors.textDisabled,
    // On inverse video the terminal paints the *light* colour as the background,
    // so its text has to be the dark one.
    inverse: "#101014",
    // One step closer to the background than body text: on a dark terminal that is
    // a darker grey, never a near-white one (a bright header reads as selected).
    sectionHeader: "#6c7086",
  },
  state: {
    success: brandColors.statusSuccess,
    warning: brandColors.statusWarning,
    error: brandColors.statusError,
    info: brandColors.primaryAccent,
    pending: brandColors.textSecondary,
  },
  focus: {
    selected: brandColors.primaryAccent,
    focusRing: brandColors.primaryAccentLight,
    cursor: brandColors.textMain,
    rail: brandColors.primaryAccent,
  },
  surface: {
    border: brandColors.textDisabled,
    rule: brandColors.textDisabled,
    ruleDashed: brandColors.textDisabled,
    diffAddBg: "#213A2B",
    diffDelBg: "#4A221D",
  },
  welcome: {
    border: brandColors.primaryAccent,
    accent: brandColors.primaryAccent,
  },
  selector: {
    border: brandColors.primaryAccentLight,
    title: brandColors.primaryAccentLight,
    itemHighlighted: brandColors.primaryAccent,
    itemCurrent: brandColors.statusSuccess, // for "(current)" label
  },
  command: {
    selected: brandColors.primaryAccent,
    inactive: brandColors.textDisabled, // uses dimColor prop
    border: brandColors.textDisabled,
    running: brandColors.textSecondary,
    error: brandColors.statusError,
  },
  approval: {
    border: brandColors.primaryAccentLight,
    header: brandColors.primaryAccent,
  },
  code: {
    inline: "green",
  },
  link: {
    text: brandColors.primaryAccentLight,
    url: brandColors.primaryAccent,
  },
  heading: {
    primary: "cyan",
    secondary: brandColors.primaryAccent,
  },
  status: {
    error: brandColors.statusError,
    success: brandColors.statusSuccess,
    interrupt: brandColors.statusError,
    processing: brandColors.primaryAccent, // base text color
    processingShimmer: brandColors.primaryAccentLight, // shimmer highlight
    thinkingLighter: "#D8D8FF",
    thinkingDeeper: "#2828A0",
  },
  tool: {
    pending: brandColors.textSecondary, // blinking dot (ready/waiting for approval)
    completed: brandColors.statusSuccess, // solid green dot (finished successfully)
    streaming: brandColors.textSecondary, // solid gray dot (streaming/in progress)
    running: brandColors.textSecondary, // blinking gray dot (executing)
    error: brandColors.statusError, // solid red dot (failed)
    memoryName: brandColors.primaryAccent, // memory tool name highlight (matches thinking spinner)
  },
  input: {
    border: brandColors.textDisabled,
    prompt: brandColors.textMain,
  },
  bash: {
    prompt: brandColors.statusError, // Red ! prompt
    border: brandColors.statusError, // Red horizontal bars
    dot: brandColors.statusError, // Red dot in output
  },
  todo: {
    completed: brandColors.primaryAccent, // Same blue as in-progress, with strikethrough
    inProgress: brandColors.primaryAccent,
  },
  subagent: {
    header: brandColors.primaryAccent,
    running: brandColors.statusWarning,
    completed: brandColors.statusSuccess,
    error: brandColors.statusError,
    treeChar: brandColors.textSecondary,
    hint: "#808080", // Grey to match Ink's dimColor
  },
  bgSubagent: {
    label: "#87af87",
    spinner: "#5faf5f",
  },
  info: {
    border: brandColors.primaryAccent,
    prompt: brandColors.primaryAccent,
  },
  diff: {
    addedLineBg: "#213A2B",
    removedLineBg: "#4A221D",
    contextLineBg: undefined,
    // Word-level highlight colors (used by MemoryDiffRenderer)
    addedWordBg: "#2d7a2d",
    removedWordBg: "#7a2d2d",
    textOnTint: "white",
    symbolAdd: "green",
    symbolRemove: "red",
    symbolContext: undefined,
  },
  error: {
    border: "red",
    text: "red",
  },
  textLegacy: {
    normal: brandColors.textMain,
    bold: brandColors.textMain,
  },
  // The toast band above the input (M6-P6).
  //
  // A marker that is asking for attention without claiming a failure — a turn
  // finished, a connection came back — and text one step quieter than the body, so
  // a one-line report does not outrank the conversation it is reporting on.
  toast: {
    marker: brandColors.statusWarning,
    text: brandColors.textSecondary,
  },
  footer: {
    agentName: brandColors.primaryAccent,
  },
  contextBreakdown: {
    system: "#E07050", // coral-red
    coreMemory: "#E0A040", // amber
    tools: "#20B2AA", // turquoise
    messages: "#7FB3E3", // brand accent
    summaryMemory: "#D0B060", // gold
    other: "#A0A0A0", // light grey
  },
  // The logo is a brand mark, not a theme surface: the two purples are the D/S
  // shadow cells of the wordmark and stay put on both themes.
  logo: { dot: "#7272E5", shadow: "#5454B8" },
  provider: { openaiCodex: "#74AA9C" },
  // White-to-purple spectrum with brand color (#8C8CF9) in the middle.
  // Ordered lightest → brand → darkest, then bounced for smooth cycling.
  contextChart: {
    ramp: ["#B0B0B0", "#BEBEEE", "#8C8CF9", "#5B5BC8", "#3D3D8F"],
  },
};

/**
 * The light palette (《38》§11.11 v1).
 *
 * Three rules, in the doc's order: foregrounds are the *same hue, darkened* so
 * they hold contrast on white; backgrounds (diff rows, the user message tint) are
 * pale tints of the same hue; and anything drawn *on* a tint flips to dark text.
 * The category ramp is darkened as a whole so it stays distinguishable on white.
 *
 * These are a starting point, not a fixed set: M6.5 is where the user tunes them
 * by eye, one screen at a time.
 */
const lightPalette: CliPalette = {
  text: {
    primary: brandColorsLight.textMain,
    secondary: brandColorsLight.textSecondary,
    dim: "#6B6B6B", // was the literal "gray", which assumed a dark background
    disabled: brandColorsLight.textDisabled,
    inverse: "#FFFFFF",
    // On a light background "closer to the background" means *lighter*, so the
    // header is a paler grey than the body — the opposite direction from dark.
    sectionHeader: "#9ca0b0",
  },
  state: {
    success: brandColorsLight.statusSuccess,
    warning: brandColorsLight.statusWarning,
    error: brandColorsLight.statusError,
    info: brandColorsLight.primaryAccent,
    pending: brandColorsLight.textSecondary,
  },
  focus: {
    selected: brandColorsLight.primaryAccent,
    focusRing: brandColorsLight.primaryAccentLight,
    cursor: brandColorsLight.textMain,
    rail: brandColorsLight.primaryAccent,
  },
  surface: {
    border: brandColorsLight.textDisabled,
    rule: brandColorsLight.textDisabled,
    ruleDashed: brandColorsLight.textDisabled,
    diffAddBg: "#E6F4EA",
    diffDelBg: "#FCE8E6",
  },
  welcome: {
    border: brandColorsLight.primaryAccent,
    accent: brandColorsLight.primaryAccent,
  },
  selector: {
    border: brandColorsLight.primaryAccentLight,
    title: brandColorsLight.primaryAccentLight,
    itemHighlighted: brandColorsLight.primaryAccent,
    itemCurrent: brandColorsLight.statusSuccess,
  },
  command: {
    selected: brandColorsLight.primaryAccent,
    inactive: brandColorsLight.textDisabled,
    border: brandColorsLight.textDisabled,
    running: brandColorsLight.textSecondary,
    error: brandColorsLight.statusError,
  },
  approval: {
    border: brandColorsLight.primaryAccentLight,
    header: brandColorsLight.primaryAccent,
  },
  code: {
    inline: "#1F7A3D",
  },
  link: {
    text: brandColorsLight.primaryAccentLight,
    url: brandColorsLight.primaryAccent,
  },
  heading: {
    primary: "#0F6E6E",
    secondary: brandColorsLight.primaryAccent,
  },
  status: {
    error: brandColorsLight.statusError,
    success: brandColorsLight.statusSuccess,
    interrupt: brandColorsLight.statusError,
    processing: brandColorsLight.primaryAccent,
    processingShimmer: brandColorsLight.primaryAccentLight,
    thinkingLighter: "#A9A9DE",
    thinkingDeeper: "#1E2F73",
  },
  tool: {
    pending: brandColorsLight.textSecondary,
    completed: brandColorsLight.statusSuccess,
    streaming: brandColorsLight.textSecondary,
    running: brandColorsLight.textSecondary,
    error: brandColorsLight.statusError,
    memoryName: brandColorsLight.primaryAccent,
  },
  input: {
    border: brandColorsLight.textDisabled,
    prompt: brandColorsLight.textMain,
  },
  bash: {
    prompt: brandColorsLight.statusError,
    border: brandColorsLight.statusError,
    dot: brandColorsLight.statusError,
  },
  todo: {
    completed: brandColorsLight.primaryAccent,
    inProgress: brandColorsLight.primaryAccent,
  },
  subagent: {
    header: brandColorsLight.primaryAccent,
    running: brandColorsLight.statusWarning,
    completed: brandColorsLight.statusSuccess,
    error: brandColorsLight.statusError,
    treeChar: brandColorsLight.textSecondary,
    hint: "#6B6B6B",
  },
  bgSubagent: {
    label: "#2E7D32",
    spinner: "#1B5E20",
  },
  info: {
    border: brandColorsLight.primaryAccent,
    prompt: brandColorsLight.primaryAccent,
  },
  diff: {
    addedLineBg: "#E6F4EA",
    removedLineBg: "#FCE8E6",
    contextLineBg: undefined,
    addedWordBg: "#B7E1C1",
    removedWordBg: "#F5B7B1",
    // Dark on a pale tint; the light theme's version of the old `textOnDark`.
    textOnTint: "#202020",
    symbolAdd: "green",
    symbolRemove: "red",
    symbolContext: undefined,
  },
  error: {
    border: brandColorsLight.statusError,
    text: brandColorsLight.statusError,
  },
  textLegacy: {
    normal: brandColorsLight.textMain,
    bold: brandColorsLight.textMain,
  },
  toast: {
    marker: brandColorsLight.statusWarning,
    text: brandColorsLight.textSecondary,
  },
  footer: {
    agentName: brandColorsLight.primaryAccent,
  },
  contextBreakdown: {
    system: "#C0562F",
    coreMemory: "#B07A16",
    tools: "#0F8A83",
    messages: "#2F6FA8",
    summaryMemory: "#9A7B18",
    other: "#6B6B6B",
  },
  logo: { dot: "#7272E5", shadow: "#5454B8" },
  provider: { openaiCodex: "#74AA9C" },
  // Same ramp with its pale end darkened: the light theme's background is where
  // the old two lightest steps used to disappear.
  contextChart: {
    ramp: ["#8A8A8A", "#9292C4", "#5B5BC8", "#3D3D8F", "#23235E"],
  },
};

/**
 * The palette for a theme. Exported so the colour unit test can check *both*
 * palettes without moving the process's terminal state.
 */
export function paletteForTheme(theme: TerminalTheme): CliPalette {
  return theme === "light" ? lightPalette : darkPalette;
}

/**
 * Resolve the palette for the terminal the process is running in.
 *
 * Not memoised on purpose: the theme probe is async and updates the cached theme
 * after the first import, and the surface tints are mixed from the terminal's
 * background, which the probe may only learn later. Rebuilding is a handful of
 * object spreads; a frozen palette is a light terminal painted dark.
 */
function currentPalette(): CliPalette {
  return paletteForTheme(getTerminalTheme());
}

/**
 * The colour tokens, resolved at read time.
 *
 * Every group is a getter, so `colors.text.primary` answers for the terminal as it
 * is *now* — a component that memoised a string would be the one place a theme
 * change did not reach.
 */
export const colors: CliPalette & {
  /** The shell-syntax palette (a light/dark pair of its own). */
  readonly shellSyntax: ShellSyntaxTokens;
  /** The theme the terminal is in right now — the palette's own input. */
  readonly theme: TerminalTheme;
  /**
   * Surface tokens plus the two tints mixed from the terminal's background: the
   * row a pointer is over, and the user message's block.
   */
  readonly surface: CliPalette["surface"] & {
    hoverBg: string;
    userMessageBg: string;
  };
  /** The user message block's background tint. */
  readonly userMessage: { background: string; text: string | undefined };
  /**
   * A group title inside a page (《38》§12.3bis 2) — the same value as
   * `text.sectionHeader`, kept as its own name because pages say "section".
   */
  readonly sectionHeader: string;
} = {
  get text() {
    return currentPalette().text;
  },
  get state() {
    return currentPalette().state;
  },
  get focus() {
    return currentPalette().focus;
  },
  get surface() {
    // The static surface tokens plus the two that are mixed from the terminal's
    // own background at read time.
    return {
      ...currentPalette().surface,
      hoverBg: getHoverBackground(),
      userMessageBg: getCodexUserMessageBackground(),
    };
  },
  get welcome() {
    return currentPalette().welcome;
  },
  get selector() {
    return currentPalette().selector;
  },
  get command() {
    return currentPalette().command;
  },
  get approval() {
    return currentPalette().approval;
  },
  get code() {
    return currentPalette().code;
  },
  get link() {
    return currentPalette().link;
  },
  get heading() {
    return currentPalette().heading;
  },
  get status() {
    return currentPalette().status;
  },
  get tool() {
    return currentPalette().tool;
  },
  get input() {
    return currentPalette().input;
  },
  get bash() {
    return currentPalette().bash;
  },
  get shellSyntax() {
    return getTerminalTheme() === "light" ? shellSyntaxLight : shellSyntaxDark;
  },
  get theme() {
    return getTerminalTheme();
  },
  get todo() {
    return currentPalette().todo;
  },
  get subagent() {
    return currentPalette().subagent;
  },
  get bgSubagent() {
    return currentPalette().bgSubagent;
  },
  get info() {
    return currentPalette().info;
  },
  get diff() {
    return currentPalette().diff;
  },
  get error() {
    return currentPalette().error;
  },
  // `text.normal` / `text.bold` came before the token list and were `"white"` —
  // invisible on a light terminal. They are `text.primary` now, and `textLegacy`
  // is the name that says "do not add callers".
  get textLegacy() {
    return currentPalette().textLegacy;
  },
  get toast() {
    return currentPalette().toast;
  },
  get footer() {
    return currentPalette().footer;
  },
  get contextBreakdown() {
    return currentPalette().contextBreakdown;
  },
  get logo() {
    return currentPalette().logo;
  },
  get provider() {
    return currentPalette().provider;
  },
  get contextChart() {
    return currentPalette().contextChart;
  },
  get sectionHeader() {
    return currentPalette().text.sectionHeader;
  },
  // User messages (past prompts) - theme-aware background
  // Uses getter to read theme at render time (after async init)
  get userMessage() {
    return {
      background: getCodexUserMessageBackground(),
      text: undefined, // use default terminal text color
    };
  },
};
