/**
 * The text a markdown line **paints**, as opposed to the source that carries it.
 *
 * The renderers drop inline markers before Ink wraps the line: `InlineMarkdown`
 * turns `**bold**` into the styled word `bold`, `` `code` `` into the styled word
 * `code`, and `[text](url)` into `text (url)`. The row model must measure the
 * words that reach the screen, not the source: counting the markers adds columns
 * that are never painted, and a line that only *just* overflows with them is
 * measured one row taller than it draws. In the viewport that is not a cosmetic
 * row — the window is fitted from these numbers, and a window the model thinks is
 * full paints short, leaving a blank band at the top (2026-10-23: a 94-row
 * assistant message measured 8 rows larger than it drew, at 62 columns).
 *
 * `MarkdownTable` has used exactly this transform for its cells since it had to
 * size a column; it is shared here rather than copied so a cell and a paragraph
 * cannot disagree about how wide a styled word is.
 *
 * Deliberate scope: **inline** markers only. Block syntax (fences, lists,
 * headings) is classified by the block walker, and code-fence bodies are painted
 * verbatim — the walker must not strip anything inside them.
 */
export function inlineMarkdownDisplayText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\\([\\|`*~[\]])/g, "$1");
}

/**
 * The line structure `AssistantMessage`/`ReasoningMessage` hand to
 * `MarkdownDisplay`.
 *
 * Less aggressive than it looks: trailing newlines are kept so a message that
 * ends on a blank line keeps that row, while a run of three or more newlines is
 * collapsed to one blank line (the renderer never paints more than one). The row
 * model has to run the same pass, or a body with several double-spaced sections
 * measures taller than it paints for the same reason the inline markers did.
 */
export function normalizeMarkdownBody(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/g, "");
}
