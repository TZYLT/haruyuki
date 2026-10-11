/**
 * How much of an injected recall block the transcript shows (《26》§6.7).
 *
 * The three tiers exist because the same block has two audiences. The model needs
 * the passages; the user needs to know *that* something was recalled, and to be
 * able to read it when they doubt it. `summary` is the default: one line, with the
 * full text one keystroke away through the channel the transcript already uses for
 * every other reminder block.
 *
 * The marker is the only thing this module trusts, and it is parsed by the same
 * module that wrote it (`recall-reminder.ts`), so a user who types the tag into
 * their own message gets their text back rather than a forged summary.
 */
import { parseRecallMarker } from "./recall-reminder";

export type RecallDisplay = "silent" | "summary" | "full";

export const RECALL_DISPLAY_DEFAULT: RecallDisplay = "summary";

const DISPLAYS: readonly RecallDisplay[] = ["silent", "summary", "full"];

export function isRecallDisplay(value: unknown): value is RecallDisplay {
  return DISPLAYS.includes(value as RecallDisplay);
}

/**
 * The one line the summary tier shows.
 *
 * Built from the marker rather than from the block's first line: the transcript
 * echo strips reminder bodies before the display layer sees them, so the marker is
 * the only part guaranteed to survive (`recall-reminder.ts` says why the two
 * halves live together).
 */
export function formatRecallSummaryLine(marker: {
  items: number;
  transcript: number;
  memory: number;
}): string {
  const parts: string[] = [];
  if (marker.transcript > 0) {
    parts.push(
      `${marker.transcript} earlier conversation${marker.transcript === 1 ? "" : "s"}`,
    );
  }
  if (marker.memory > 0) {
    parts.push(
      `${marker.memory} memory passage${marker.memory === 1 ? "" : "s"}`,
    );
  }
  const detail = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return `↩ recalled ${marker.items} passage${marker.items === 1 ? "" : "s"}${detail}`;
}

/**
 * Render one recall block for the transcript, or `null` when the tier hides it.
 *
 * - `silent` never shows it, even expanded: the tier is the user's setting, and a
 *   hidden block must not become visible through an unrelated Ctrl+R.
 * - `summary` shows the line, and the full text once expanded.
 * - `full` shows the text directly; expansion has nothing left to reveal, so the
 *   line is not offered.
 *
 * A block whose marker cannot be parsed renders as null under `summary` — a
 * block that claims to be recall but cannot say what it recalled is not something
 * to guess at. `full` still shows it, because that tier shows the text itself.
 */
export function formatRecallBlockForDisplay(input: {
  text: string;
  display: RecallDisplay;
  expanded: boolean;
}): string | null {
  if (input.display === "silent") return null;
  if (input.display === "full") return input.text;
  const marker = parseRecallMarker(input.text);
  if (!marker) return null;
  const line = formatRecallSummaryLine(marker);
  return input.expanded
    ? `${line} (ctrl+r to collapse)\n${input.text}`
    : `▸ ${line} (ctrl+r to expand)`;
}
