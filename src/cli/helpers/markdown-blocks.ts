/**
 * Markdown block classification.
 *
 * Shared by `MarkdownDisplay` (which renders the blocks) and the transcript row
 * model (which measures their height). Keeping the predicates in one place is
 * what stops the two from disagreeing about what counts as a header, fenced code
 * block, list item, blockquote, rule or table — a disagreement that would show
 * up as the viewport scrolling to the wrong row.
 */

export const HEADER_RE = /^(#{1,6})\s+(.*)$/;
export const CODE_FENCE_OPEN_RE = /^ *(`{3,}|~{3,}) *([^\s`~]*)?.*$/;
export const CODE_FENCE_CLOSE_RE = /^ *(`{3,}|~{3,}) *$/;
export const LIST_ITEM_RE = /^(\s*)([*\-+]|\d+\.)\s+(.*)$/;
export const BLOCKQUOTE_RE = /^>\s*(.*)$/;
export const HORIZONTAL_RULE_RE = /^[-*_]{3,}$/;
export const TABLE_ROW_RE = /^\|(.+)\|$/;
export const TABLE_SEPARATOR_RE = /^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)+\|$/;

/** Whether `line` closes a fenced code block opened with `fence`. */
export function isCodeFenceClose(line: string, fence: string): boolean {
  const match = line.match(CODE_FENCE_CLOSE_RE);
  if (!match) return false;
  const close = match[1] ?? "";
  return close.startsWith(fence[0] ?? "") && close.length >= fence.length;
}

/** Whether a table starts at `lines[index]` (a row followed by a separator). */
export function isTableStart(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  const next = lines[index + 1];
  return (
    typeof line === "string" &&
    TABLE_ROW_RE.test(line) &&
    typeof next === "string" &&
    TABLE_SEPARATOR_RE.test(next)
  );
}
