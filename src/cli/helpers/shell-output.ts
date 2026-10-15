/**
 * Shell output layout, shared by the shell output renderers and the transcript
 * row model.
 *
 * `CollapsedOutputDisplay` and `StreamingOutputDisplay` each decide which of
 * their lines are visible and how many are hidden. The full-screen shell has to
 * predict the row count of the same output without rendering it, so the
 * selection lives here and both the components and the row model read it. A
 * second copy of the selection rule would let the viewport window drift from
 * what is actually printed.
 */

import type { StreamingState } from "@/cli/helpers/accumulator";

/** Lines `CollapsedOutputDisplay` shows before collapsing. */
export const DEFAULT_COLLAPSED_LINES = 3;

export interface CollapsedOutputOptions {
  /** Max lines to show before collapsing (Infinity = show all). */
  maxLines?: number;
  /** Max characters to show before clipping (undefined = no clipping). */
  maxChars?: number;
  /** Whether the user expanded the output. */
  expanded?: boolean;
}

export interface CollapsedOutputLayout {
  /** Every line of the (possibly char-clipped) output. */
  lines: string[];
  /** The lines actually rendered. */
  visibleLines: string[];
  /** Lines hidden behind the "+N lines" row (0 when everything is shown). */
  hiddenCount: number;
  /** Whether the char limit clipped the output. */
  clippedByChars: boolean;
}

/**
 * Choose the lines a collapsed or expanded shell output shows.
 *
 * `input` is the already-formatted output (`formatUnifiedExecOutputForTui`); the
 * char clipping and the trailing-newline trim happen here so the renderer and the
 * row count agree.
 */
export function selectCollapsedOutput(
  input: string,
  options: CollapsedOutputOptions = {},
): CollapsedOutputLayout {
  const maxLines = options.maxLines ?? DEFAULT_COLLAPSED_LINES;
  const { maxChars, expanded = false } = options;

  let output = input;
  let clippedByChars = false;
  if (
    !expanded &&
    typeof maxChars === "number" &&
    maxChars > 0 &&
    output.length > maxChars
  ) {
    output = `${output.slice(0, maxChars)}…`;
    clippedByChars = true;
  }

  // Keep empty lines for accurate display (don't filter them out)
  const lines = output.split("\n");
  // Remove trailing empty line from final newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    return { lines, visibleLines: [], hiddenCount: 0, clippedByChars };
  }

  const showAll = expanded || maxLines === Infinity || maxLines >= lines.length;
  const visibleLines = showAll ? lines : lines.slice(0, maxLines);
  const hiddenCount = showAll ? 0 : Math.max(0, lines.length - maxLines);

  return { lines, visibleLines, hiddenCount, clippedByChars };
}

export interface StreamingOutputLayout {
  /** First tail line with the `  └` prefix (undefined while nothing arrived). */
  first: StreamingState["tailLines"][number] | undefined;
  /** Tail lines rendered with the blank indent. */
  rest: StreamingState["tailLines"];
  /** Lines already scrolled out of the rolling window. */
  hiddenCount: number;
}

/**
 * Which streaming lines the display shows: the first tail line with the `  └`
 * prefix, the rest indented, and whether a `+N more` row is needed. When no line
 * has arrived yet the display renders its single "Running..." row instead.
 */
export function streamingOutputLayout(
  streaming: StreamingState,
): StreamingOutputLayout {
  const { tailLines, totalLineCount } = streaming;
  const hiddenCount = Math.max(0, totalLineCount - tailLines.length);
  return {
    first: tailLines[0],
    rest: tailLines.slice(1),
    hiddenCount,
  };
}
