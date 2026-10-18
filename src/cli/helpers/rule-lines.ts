/**
 * The horizontal rules the TUI draws.
 *
 * Every overlay frame, every approval header and each preview section paints one
 * of these two characters across the width it was given, and before this module
 * existed each of them re-derived it: the same `"─"` constant appeared in seven
 * files and the same `"╌"` in three, each with its own `.repeat(Math.max(…, 10))`
 * — or, in one case, without the floor at all.
 *
 * The floor is the one thing worth stating once: a rule is a separator, so it is
 * never shorter than `MIN_RULE_WIDTH` even when the terminal is, which is what
 * keeps a squeezed frame from drawing a two-character "line" that reads as text.
 */

/**
 * Narrowest a rule is drawn, whatever the terminal says.
 *
 * Ten is what the copies used; it is also wide enough to be read as a rule rather
 * than as a stray glyph when a terminal reports an absurd width.
 */
const MIN_RULE_WIDTH = 10;

/** The solid rule: an overlay's header, an approval's header, a preview's top. */
export function solidRule(columns: number): string {
  return "─".repeat(Math.max(columns, MIN_RULE_WIDTH));
}

/** The dashed rule: the boundary between sections inside a preview body. */
export function dottedRule(columns: number): string {
  return "╌".repeat(Math.max(columns, MIN_RULE_WIDTH));
}
