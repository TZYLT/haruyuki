/**
 * Transcript row model.
 *
 * Given a terminal width, how many rows does a transcript item occupy once it is
 * laid out? The full-screen shell answers this *without rendering* so it can
 * virtualize: it decides which items intersect the viewport and how tall the
 * scroll extent is.
 *
 * This module owns the item-level dispatch (gap, welcome, subagent group) and the
 * plain transcript lines. Two kinds are delegated because their height is a
 * layout of their own:
 *
 * - `tool_call` → `@/cli/app/tool-call-rows` (one branch per tool family)
 * - approvals → `@/cli/app/approval-rows` (the viewport substitutes an approval
 *   UI or a pending stub for a tool call item)
 *
 * Every branch reuses the same pure primitives the renderers use
 * (`@/cli/helpers/text-metrics`, `markdown-rows`, `diff-rows`), so the model and
 * the render pass cannot disagree about a row count. Where a renderer's height
 * depends on runtime display state (ctrl+r / ctrl+t / ctrl+o) or on data the model
 * must not fetch (a diff, a syntax highlight), the caller passes the state in and
 * the approximation is documented on the branch that carries it.
 */

import {
  type ApprovalMeasureOptions,
  type ApprovalSubstitutions,
  approvalPreviewItemRows,
  substitutedApprovalRows,
} from "@/cli/app/approval-rows";
import { streamingOutputRows, toolCallRows } from "@/cli/app/tool-call-rows";
import type { StaticItem } from "@/cli/app/types";
import type { Line } from "@/cli/helpers/accumulator";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { markdownRowCount } from "@/cli/helpers/markdown-rows";
import { normalizeMarkdownBody } from "@/cli/helpers/markdown-text";
import { selectCollapsedOutput } from "@/cli/helpers/shell-output";
import {
  countTextRows,
  inkStringWidth,
  wrapText,
} from "@/cli/helpers/text-metrics";
import {
  COMPACTION_SUMMARY_HEADER,
  INTERRUPTED_BY_USER,
  SYSTEM_ALERT_CLOSE,
  SYSTEM_ALERT_OPEN,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";
import {
  formatRecallBlockForDisplay,
  RECALL_DISPLAY_DEFAULT,
  type RecallDisplay,
} from "@/reminders/recall-display";
import { isRecallReminderText } from "@/reminders/recall-reminder";
import { extractTaskNotificationsForDisplay } from "@/utils/task-notifications";

/** Two-column gutter used by assistant/reasoning/error rows. */
export const TRANSCRIPT_GUTTER_WIDTH = 2;

/** Blank row `StaticTranscript` inserts between two committed items. */
export const STATIC_ITEM_GAP_ROWS = 1;

/** Gutter `CommandMessage` draws before its output (`  └  `). */
const COMMAND_OUTPUT_GUTTER_WIDTH = 5;

/**
 * Rows the welcome banner occupies, measured against the component.
 *
 * It used to be **12** — "approximate height (it is a fixed template)", which was
 * wrong twice over: the template is a 4-row logo beside 3 text rows, so the banner
 * is 5 rows including its own `marginTop`, and the two states it can be in (no
 * agent yet, or an agent with model and path) differ again. Measured against
 * `WelcomeScreen` itself at 120 columns: **4 rows painted, 5 laid out** (the last
 * row is blank, which is why a frame read trims it). A model that claims 12 for a
 * 5-row banner believes the viewport is filled when it is not: the content box is
 * shorter than the band, the offset lifts it off the bottom, and the machine sees
 * "big blocks of text vanish while scrolling" (2026-10-20, `blankTail=14` in the
 * window that starts at the banner).
 *
 * `welcomeBannerRows` in the fidelity test is the guard: it renders the real
 * component and fails if this number drifts.
 */
const WELCOME_ROWS = 5;

/** Rows per subagent entry in a committed subagent group. */
const SUBAGENT_ROWS = 4;

/**
 * Preview row budget used when the caller does not report the terminal height.
 * Approval previews shrink to fit the terminal; measuring them unbounded is the
 * larger answer, which is the safe direction for a window calculation.
 */
const UNBOUNDED_PREVIEW_ROWS = Number.MAX_SAFE_INTEGER;

/** No precomputed diffs, for callers that measure without a render frame. */
const EMPTY_DIFFS: ReadonlyMap<string, AdvancedDiffSuccess> = new Map();

export interface RowMeasureOptions {
  /** Total terminal columns. */
  columns: number;
  /** Full prompt prefix for user rows; defaults to `<glyph> `. */
  userPromptPrefix?: string;
  /** Whether collapsed reasoning rows render their body (ctrl+t). */
  reasoningExpanded?: boolean;
  /**
   * Whether system-reminder blocks render at all (ctrl+r). Reminder blocks are
   * part of a *user* row, so this changes that row's height; the value is the
   * transcript display state (`getSystemRemindersVisible`).
   */
  systemRemindersVisible?: boolean;
  /**
   * Whether reminder and recall blocks render their full body instead of a
   * one-line header (ctrl+r).
   */
  systemRemindersExpanded?: boolean;
  /**
   * Tier the transcript renders recall blocks with (`getRecallDisplay`): it
   * decides whether a recall block is a summary line, its full text, or nothing.
   */
  recallDisplay?: RecallDisplay;
  /** Total terminal rows; sizes the approval preview budgets. */
  terminalRows?: number;
  /** Diffs precomputed for this frame, keyed by tool call id (and `id:path`). */
  diffs?: ReadonlyMap<string, AdvancedDiffSuccess>;
  /** Tool call whose shell output the user expanded (ctrl+o). */
  expandedToolCallId?: string | null;
  /** Shell tool call that owns the ctrl+o expand hint. */
  lastShellToolCallId?: string | null;
  /**
   * Set by the full-screen viewport, which substitutes the current approval and
   * the pending/queued stubs for a tool call item. Omit it when the item really
   * renders as a tool call (the append shell's measurement).
   */
  substitutions?: ApprovalSubstitutions;
  /**
   * Whether a finished compaction event paints its summary body
   * (`getCompactionSummaryVisible`).
   *
   * The renderer hides it outside `HARUYUKI_DEBUG=1`, and this used to be counted
   * unconditionally: a compacted conversation then reserved a hundred-odd rows for
   * a body nobody painted, the viewport believed the band was full, and the
   * transcript came up mostly blank (`《34》3.11` predicted this exact shape). The
   * model and the renderer now ask the **same** store.
   */
  compactionSummaryVisible?: boolean;
  /**
   * Whether compaction events are drawn at all (`showCompactionsEnabled`).
   *
   * `TranscriptItemView` renders **nothing** for a compaction event while the
   * setting is off — no row, not even the one-line header — so the model must not
   * count one either. That phantom row was the second half of the same blank-band
   * report.
   */
  showCompactionsEnabled?: boolean;
}

/**
 * Everything that changes an item's measured **height**, as one value.
 *
 * The viewport records a page's height once and then *skips* that page on every later
 * walk, so a layout change has to invalidate the recorded number (`older-history.ts`,
 * `setOlderHistoryRowsKey`). That only works if the key and the measurement are built
 * from the same values — which is what this type is for: the viewport builds one of
 * these, measures with it, and derives the key from it, so the two cannot drift.
 *
 * `Record<keyof RowLayoutOptions, true>` below makes this list **exhaustive at
 * compile time**: adding a field here without adding it to `LAYOUT_FIELDS` (and so to
 * the key) is a type error, and the test walks every field to prove the key moves.
 * Add any new height-affecting display input to both.
 */
export interface RowLayoutOptions {
  /** Total terminal columns. */
  columns: number;
  /** Total terminal rows; sizes the approval preview budgets. */
  terminalRows?: number;
  /** Full prompt prefix for user rows; defaults to `<glyph> `. */
  userPromptPrefix?: string;
  /** Whether collapsed reasoning rows render their body (`Ctrl+T`). */
  reasoningExpanded?: boolean;
  /** Whether system-reminder blocks render at all (`Ctrl+R`). */
  systemRemindersVisible?: boolean;
  /** Whether reminder and recall blocks render their full body (`Ctrl+R`). */
  systemRemindersExpanded?: boolean;
  /** Tier the transcript renders recall blocks with. */
  recallDisplay?: RecallDisplay;
  /** Tool call whose shell output the user expanded (`Ctrl+O`). */
  expandedToolCallId?: string | null;
  /** Shell tool call that owns the `Ctrl+O` expand hint. */
  lastShellToolCallId?: string | null;
  /**
   * How many diffs are in the frame's precomputed map.
   *
   * The map is mutated in place, so its identity says nothing; a number that grows
   * when a diff arrives is the cheap signal that a tool row now draws rows it did not
   * draw when the page was measured.
   */
  diffCount: number;
  /**
   * Signature of the frame's approval substitutions.
   *
   * Which tool call is being approved, whether its preview is shown, and how many
   * pending/queued stubs there are all change a tool row's height (a stub is shorter
   * than the tool call it stands in for).
   */
  substitutionsSignature: string;
  /**
   * Whether a finished compaction event paints its summary body.
   *
   * It is in the key because the height difference is *large* — the body of a
   * compaction summary is dozens of rows — so a ledger entry recorded under the
   * wrong value is not one row off, it is the whole band.
   */
  compactionSummaryVisible: boolean;
  /** Whether compaction events are drawn at all (`showCompactionsEnabled`). */
  showCompactionsEnabled: boolean;
}

/** The fields `rowLayoutKey` reads. Exhaustive by construction (see the type). */
export const LAYOUT_FIELDS: Record<keyof RowLayoutOptions, true> = {
  columns: true,
  terminalRows: true,
  userPromptPrefix: true,
  reasoningExpanded: true,
  systemRemindersVisible: true,
  systemRemindersExpanded: true,
  recallDisplay: true,
  expandedToolCallId: true,
  lastShellToolCallId: true,
  diffCount: true,
  substitutionsSignature: true,
  compactionSummaryVisible: true,
  showCompactionsEnabled: true,
};

/**
 * The key a measured height was recorded under.
 *
 * Deliberately a string: it is stored on the ledger entry and compared for equality,
 * never parsed. `undefined` and `""` collapse together, which is what we want — a
 * field being absent is not a different layout from it being empty.
 */
export function rowLayoutKey(options: RowLayoutOptions): string {
  return (Object.keys(LAYOUT_FIELDS) as (keyof RowLayoutOptions)[])
    .map((field) => `${field}=${options[field] ?? ""}`)
    .join("|");
}

/** The subset of the measure options the approval layout needs. */
function approvalMeasureOptions(
  options: RowMeasureOptions,
): ApprovalMeasureOptions {
  return {
    columns: options.columns,
    terminalRows: options.terminalRows ?? UNBOUNDED_PREVIEW_ROWS,
    diffs: options.diffs ?? EMPTY_DIFFS,
  };
}

/**
 * Rows a single transcript `Line` occupies at the given width.
 *
 * Approximations are noted per kind. They are deliberately conservative on the
 * bounded/streaming paths so the viewport never silently drops content.
 */
export function measureLineRows(
  line: Line,
  options: RowMeasureOptions,
): number {
  const columns = options.columns;
  const gutterWidth = TRANSCRIPT_GUTTER_WIDTH;
  const contentWidth = Math.max(0, columns - gutterWidth);

  switch (line.kind) {
    case "separator":
      return 1;

    case "trajectory_summary":
      return 1;

    case "status": {
      // `StatusMessage` gives every line its own row box: a two-column gutter
      // and a `columns - 2` content box that wraps.
      const statusWidth = Math.max(1, columns - gutterWidth);
      return line.lines.reduce(
        (total, text) => total + countTextRows(text, statusWidth),
        0,
      );
    }

    case "assistant":
      // `AssistantMessageRich` hands its `contentWidth` to `MarkdownDisplay`,
      // so tables lay out against that width too. The body is normalized the way
      // that component normalizes it before the markdown walk: a run of blank
      // lines collapses to one, and a leading blank run disappears — rows the
      // renderer never paints.
      return markdownRowCount(normalizeMarkdownBody(line.text), contentWidth, {
        contentWidth,
      });

    case "reasoning": {
      const expanded = options.reasoningExpanded ?? false;
      if (!expanded) return line.isContinuation ? 0 : 1;
      // Expanded: header row, the one-row spacer, then the markdown body. A
      // continuation line has no header and no spacer. Measuring the raw text
      // over-counts when `normalize` collapses a blank run, and the streaming
      // live window is capped below the body's height: both err large.
      const body = markdownRowCount(
        normalizeMarkdownBody(line.text),
        contentWidth,
      );
      return line.isContinuation ? body : 2 + body;
    }

    case "recall": {
      // `RecallBlockMessage` renders the tier-formatted block as one `<Text>` at
      // the full terminal width, and renders nothing at all when the tier hides
      // it (`silent`, or a `summary` block whose marker will not parse).
      const shown = formatRecallBlockForDisplay({
        text: line.text,
        display: options.recallDisplay ?? RECALL_DISPLAY_DEFAULT,
        expanded: options.systemRemindersExpanded ?? false,
      });
      if (shown === null) return 0;
      return countTextRows(shown, Math.max(1, columns));
    }

    case "error":
      // `ErrorMessageRich` wraps inside its two-column box, not the full width.
      return Math.max(
        1,
        countTextRows(line.text, Math.max(1, columns - gutterWidth)),
      );

    case "user":
      return userLineRows(line, options);

    case "command": {
      // `CommandMessage`: a header row with the input in a `columns - 2` box (or
      // nothing while the command is waiting), then a `  └  ` row whose body is
      // markdown inside a `columns - 5` box.
      if (line.phase === "waiting") return 0;
      let rows = countTextRows(line.input, Math.max(1, columns - gutterWidth));
      if (line.output) {
        const outputWidth = Math.max(1, columns - COMMAND_OUTPUT_GUTTER_WIDTH);
        rows += line.preformatted
          ? countTextRows(line.output, outputWidth)
          : markdownRowCount(line.output, outputWidth);
      }
      return rows;
    }

    case "bash_command": {
      // `BashCommandMessage`: same two-column input row as `CommandMessage`, then
      // one of three bodies — the streaming window while running, the full
      // (never-collapsed) output once finished, or the legacy markdown block when
      // no phase was recorded.
      const rows = countTextRows(
        line.input,
        Math.max(1, columns - gutterWidth),
      );

      if (line.phase === "running" && line.streaming) {
        // Bash mode shows the "(esc to interrupt)" hint.
        return rows + streamingOutputRows(line.streaming, columns, true);
      }

      if (line.phase === "finished" && line.output) {
        if (line.output === INTERRUPTED_BY_USER) {
          return rows + Math.max(1, countTextRows(line.output, columns));
        }
        const outputWidth = Math.max(1, columns - COMMAND_OUTPUT_GUTTER_WIDTH);
        // `CollapsedOutputDisplay` with `maxLines={Infinity}`: every line of the
        // output is rendered as its own markdown block.
        const { visibleLines } = selectCollapsedOutput(line.output, {
          maxLines: Number.POSITIVE_INFINITY,
        });
        return (
          rows +
          visibleLines.reduce(
            (total, outputLine) =>
              total + markdownRowCount(outputLine, outputWidth),
            0,
          )
        );
      }

      if (!line.phase && line.output) {
        return (
          rows +
          markdownRowCount(
            line.output,
            Math.max(1, columns - COMMAND_OUTPUT_GUTTER_WIDTH),
          )
        );
      }
      return rows;
    }

    case "tool_call":
      // Measured branch by branch against the renderer (`tool-call-rows`).
      return toolCallRows(line, options);

    case "event": {
      // `TranscriptItemView` draws **nothing** for a compaction event unless the
      // setting that shows them is on, and `EventMessage` prints the summary body
      // only under `HARUYUKI_DEBUG=1`. Counting either unconditionally reserved
      // rows nobody paints: one event could claim the whole band and the
      // transcript came up mostly blank (2026-10-23, `《34》3.11`'s family).
      if (
        line.eventType === "compaction" &&
        options.showCompactionsEnabled !== true
      ) {
        return 0;
      }
      // A task notification has **no body to gate**: `EventMessage` returns after
      // one bold summary row in a `columns - 2` box. It used to fall through to
      // the compaction branch, so under `HARUYUKI_DEBUG=1` every notification was
      // measured as header + blank + body (7 rows for a 3-row paint); the viewport
      // painted the band short and the gap landed at the top (2026-10-24, the
      // restart with one notification in view).
      if (line.eventType === "task_notification") {
        const summary = line.summary || "Agent task completed";
        return countTextRows(summary, Math.max(1, columns - 2));
      }
      if (options.compactionSummaryVisible !== true || !line.summary) return 1;
      // The painted body, mirrored from `EventMessage`: a `  └  ` gutter row with
      // the summary header in a `columns - 5` box, one blank row, then the body in
      // the same box.
      const rightWidth = Math.max(1, columns - 2);
      const bodyWidth = Math.max(1, rightWidth - 3);
      return (
        1 +
        countTextRows(COMPACTION_SUMMARY_HEADER, bodyWidth) +
        1 +
        markdownRowCount(line.summary, bodyWidth)
      );
    }

    default:
      return 1;
  }
}

/**
 * Rows a `user` line occupies, mirroring `UserMessageRich`.
 *
 * `UserMessage` splits a message into system-reminder blocks and user content
 * blocks, wraps each one at the prompt-adjusted width, and draws a full-width
 * highlight row above *and* below every highlighted (user content) block. The row
 * model must not import that component — it is the render pass, not a pure
 * helper — so the block walk is mirrored here; `row-model.fidelity.test.tsx`
 * measures the real component and is what keeps the two honest.
 *
 * Which blocks exist is display state, which the caller passes in: a
 * non-recall reminder only renders while reminders are visible, and a recall
 * block follows its own tier.
 */
function userLineRows(
  line: Extract<Line, { kind: "user" }>,
  options: RowMeasureOptions,
): number {
  const columns = Math.max(1, options.columns);
  const prefix = options.userPromptPrefix ?? `${CLI_GLYPHS.prompt} `;
  // `UserMessageRich` puts the block's accent rail (`《38》§11.9` ③) in front of the
  // prompt prefix of a *highlighted* block, and wraps at what is left; a system
  // reminder inside the same message has no rail. Both sides subtract the same
  // glyph from the same block kind; a copy that forgot it would predict one row
  // fewer for every wrapped line, which is the class of defect
  // `row-model.fidelity.test.tsx` exists for.
  const plainWidth = Math.max(1, columns - inkStringWidth(prefix));
  const contentWidth = Math.max(
    1,
    plainWidth - inkStringWidth(CLI_GLYPHS.accentRail),
  );
  const displayText = extractTaskNotificationsForDisplay(
    line.text,
  ).cleanedText.trim();
  if (!displayText) return 0;

  const recallDisplay = options.recallDisplay ?? RECALL_DISPLAY_DEFAULT;
  const remindersExpanded = options.systemRemindersExpanded ?? false;
  const remindersVisible = options.systemRemindersVisible ?? false;

  // `pushBlock` separates two blocks with an empty `<Text>`, which Ink measures
  // as zero rows — the separator is not a row. The two blank rows around a
  // highlighted block are real: they are `columns` spaces wide.
  const pushBlock = (text: string, highlighted: boolean): number => {
    const bodyRows = renderedBlockRows(
      text,
      highlighted ? contentWidth : plainWidth,
    );
    return bodyRows + (highlighted ? 2 : 0);
  };

  let rows = 0;
  for (const block of splitReminderBlocks(displayText)) {
    if (!block.text.trim()) continue;
    if (!block.isSystemReminder) {
      rows += pushBlock(block.text, true);
      continue;
    }
    if (isRecallReminderText(block.text)) {
      const recall = formatRecallBlockForDisplay({
        text: block.text,
        display: recallDisplay,
        expanded: remindersExpanded,
      });
      if (recall !== null) rows += pushBlock(recall, false);
      continue;
    }
    if (!remindersVisible) continue;
    rows += pushBlock(
      systemReminderBlockText(block.text, remindersExpanded),
      false,
    );
  }
  return rows;
}

/**
 * Rows `UserMessageRich.renderBlock` produces for one block: every `\n` segment
 * wraps independently, and a blank segment still takes a row. A blank segment
 * also means the block is empty, and an empty block renders no rows at all.
 *
 * The renderer **pre-wraps** each segment with `wrapText` and paints the result,
 * so nothing Ink's own wrapper would do (a leading space on a continuation row,
 * filling a long word's tail) applies here. Counting with `wrappedRowCount` made
 * this branch the odd one out either way: it was identical to `wrapText` before,
 * and after `wrappedRowCount` moved to Ink's wrapper it would over-count exactly
 * those pre-wrapped lines.
 */
function renderedBlockRows(text: string, contentWidth: number): number {
  let rows = 0;
  for (const inputLine of text.split("\n")) {
    if (inputLine.trim() === "") {
      rows += 1;
      continue;
    }
    rows += wrapText(inputLine, contentWidth).length;
  }
  return rows;
}

/**
 * Split a message into `<system-reminder>` (and legacy `<system-alert>`) blocks
 * and user content blocks, in order.
 *
 * Mirrors `splitSystemReminderBlocks` in `UserMessageRich`, including its two
 * fallbacks: an unterminated tag makes the remainder literal user text, and
 * blocks are trimmed (so a trailing newline never becomes a blank row).
 */
function splitReminderBlocks(
  text: string,
): Array<{ text: string; isSystemReminder: boolean }> {
  const blocks: Array<{ text: string; isSystemReminder: boolean }> = [];
  const tags = [
    { open: SYSTEM_REMINDER_OPEN, close: SYSTEM_REMINDER_CLOSE },
    { open: SYSTEM_ALERT_OPEN, close: SYSTEM_ALERT_CLOSE },
  ];

  let remaining = text;
  while (remaining.length > 0) {
    const nextTag = tags
      .map((tag) => ({ ...tag, idx: remaining.indexOf(tag.open) }))
      .filter((tag) => tag.idx >= 0)
      .sort((a, b) => a.idx - b.idx)[0];

    if (!nextTag) {
      // No more system-reminder tags, rest is user content
      if (remaining.trim()) {
        blocks.push({ text: remaining.trim(), isSystemReminder: false });
      }
      break;
    }

    // Find the closing tag
    const closeIdx = remaining.indexOf(nextTag.close, nextTag.idx);
    if (closeIdx === -1) {
      // Malformed/incomplete tag - treat the whole remainder as literal user text.
      const literal = remaining.trim();
      if (literal) {
        blocks.push({ text: literal, isSystemReminder: false });
      }
      break;
    }

    // Content before the tag is user content
    if (nextTag.idx > 0) {
      const before = remaining.slice(0, nextTag.idx).trim();
      if (before) {
        blocks.push({ text: before, isSystemReminder: false });
      }
    }

    blocks.push({
      text: remaining.slice(nextTag.idx, closeIdx + nextTag.close.length),
      isSystemReminder: true,
    });

    remaining = remaining.slice(closeIdx + nextTag.close.length);
  }

  return blocks;
}

/**
 * The one-line (or expanded) form of a non-recall reminder block.
 *
 * Mirrors `formatSystemReminderBlock` in `UserMessageRich`; that module is a
 * component file the row model must not import.
 */
function systemReminderBlockText(text: string, expanded: boolean): string {
  const content = text
    .replace(SYSTEM_REMINDER_OPEN, "")
    .replace(SYSTEM_REMINDER_CLOSE, "")
    .replace(SYSTEM_ALERT_OPEN, "")
    .replace(SYSTEM_ALERT_CLOSE, "")
    .trim();
  const lineCount = content ? content.split("\n").length : 0;

  if (expanded) {
    return `▾ System reminder (ctrl+r to collapse)\n${text}`;
  }

  const lineLabel = lineCount === 1 ? "1 line" : `${lineCount} lines`;
  return `▸ System reminder · ${lineLabel} (ctrl+r to expand)`;
}

/**
 * Rows a whole transcript item occupies, including the leading blank line that
 * `TranscriptItemView` inserts for every item after the first.
 *
 * `index` is the item's position in the rendered list (0 = first), so the caller
 * must pass the global index when rendering a window.
 */
export function measureTranscriptItemRows(
  item: StaticItem,
  options: RowMeasureOptions & { index: number },
): number {
  const gap = options.index > 0 ? STATIC_ITEM_GAP_ROWS : 0;

  // The full-screen viewport substitutes an approval UI or a stub for a tool call
  // item, so the substituted node — not the tool call — is what occupies rows.
  if (item.kind === "tool_call" && options.substitutions) {
    const substituted = substitutedApprovalRows(
      item,
      options.substitutions,
      approvalMeasureOptions(options),
    );
    if (substituted !== null) return gap + substituted;
  }

  switch (item.kind) {
    case "welcome":
      return gap + WELCOME_ROWS;
    case "subagent_group":
      return gap + Math.max(1, item.agents.length) * SUBAGENT_ROWS;
    case "approval_preview":
      // Measured against `ApprovalPreview` itself; it renders only the preview,
      // with the options and hint left to the live area.
      return (
        gap + approvalPreviewItemRows(item, approvalMeasureOptions(options))
      );
    case "separator":
      // `TranscriptItemView` gives a separator its own one-row `marginTop` box on
      // top of the inter-item gap, and draws a single full-width rule.
      return gap + 2;
    default:
      return gap + measureLineRows(item, options);
  }
}
