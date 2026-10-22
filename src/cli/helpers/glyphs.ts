/**
 * Central registry of CLI display glyphs.
 * Change these once to update every component that renders them.
 */
export const CLI_GLYPHS = {
  /** User input prompt character */
  prompt: "›",
  /** Bullet for assistant/tool/status messages */
  bullet: "•",
  /** Result continuation corner — aligns with continuation bar */
  result: "└",
  /** Multi-line command continuation bar */
  continuation: "│",
  /** The static rail's divider: one column, every band row, meeting the rule */
  rail: "│",
  /** Where the rail's divider meets the strip's rule */
  railJunction: "┬",
  /** Close affordance on a tab of the shell's top bar */
  close: "×",
  /**
   * The toast band's marker.
   *
   * Drawn in the warning colour, so the glyph itself only has to say "this is a
   * report about something that already happened, not a question": `!` is the
   * frame sketch's mark (`docs/38` §2.2) and the one the pending-approval stub
   * already uses for the same reason.
   */
  toast: "!",
} as const;
