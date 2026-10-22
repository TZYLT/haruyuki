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
   * The selected-row marker.
   *
   * A-level by 《38》§11.5: the one glyph that must survive a font that is missing
   * everything else, because without it there is no "which row does Enter act on".
   * P7 unified every selected row on it — list rows already used it, the two
   * confirmation controls and the approval options did not (they drew U+276F,
   * which several fonts render as a box).
   */
  selection: ">",
  /**
   * The toast band's marker.
   *
   * Drawn in the warning colour, so the glyph itself only has to say "this is a
   * report about something that already happened, not a question": `!` is the
   * frame sketch's mark (`docs/38` §2.2) and the one the pending-approval stub
   * already uses for the same reason.
   */
  toast: "!",
  /**
   * The pending-approval stub's marker, and the "waiting" mark in the approval
   * rows.
   *
   * It was U+29D7 until P7. That glyph is in no font this tree can rely on
   * — the user measured it, it failed — and a stub whose only signal is a box
   * says nothing at all. `!` is A-level (`《38》§11.5`): it is also the bash-mode
   * prompt, but in a different column of a different row, and the two are not
   * confusable in place.
   */
  pendingApproval: "!",
} as const;
