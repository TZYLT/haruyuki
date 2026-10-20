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
} as const;
