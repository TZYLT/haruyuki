import { Box } from "ink";
import { memo, useSyncExternalStore } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { inkStringWidth, wrapText } from "@/cli/helpers/text-metrics";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import {
  SYSTEM_ALERT_CLOSE,
  SYSTEM_ALERT_OPEN,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";
import { formatRecallBlockForDisplay } from "@/reminders/recall-display";
import { isRecallReminderText } from "@/reminders/recall-reminder";
import { extractTaskNotificationsForDisplay } from "@/utils/task-notifications";
import { colors } from "./colors";
import { Text } from "./Text";
import {
  getRecallDisplay,
  getSystemRemindersExpanded,
  getSystemRemindersVisible,
  subscribeToSystemReminderDisplay,
} from "./transcript-display-state";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

type RenderedBlockLine = {
  text: string;
  highlighted: boolean;
};

export function formatSystemReminderBlock(
  text: string,
  expanded: boolean,
): string {
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
 * Split text into system-reminder blocks and user content blocks.
 * System-reminder blocks are identified by <system-reminder>...</system-reminder> tags.
 * Returns array of { text, isSystemReminder } objects in order.
 */
export function splitSystemReminderBlocks(
  text: string,
): Array<{ text: string; isSystemReminder: boolean }> {
  const blocks: Array<{ text: string; isSystemReminder: boolean }> = [];
  const tags = [
    { open: SYSTEM_REMINDER_OPEN, close: SYSTEM_REMINDER_CLOSE },
    { open: SYSTEM_ALERT_OPEN, close: SYSTEM_ALERT_CLOSE }, // legacy
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

    // Extract the full system-reminder block (including tags)
    const sysBlock = remaining.slice(
      nextTag.idx,
      closeIdx + nextTag.close.length,
    );
    blocks.push({ text: sysBlock, isSystemReminder: true });

    remaining = remaining.slice(closeIdx + nextTag.close.length);
  }

  return blocks;
}

function padToColumns(text: string, columns: number): string {
  const pad = Math.max(0, columns - inkStringWidth(text));
  return `${text}${" ".repeat(pad)}`;
}

/**
 * Render a block of text with a prompt prefix (first line) and matching-width
 * continuation spaces on subsequent lines.
 * If highlighted, applies background and foreground colors. Otherwise plain text.
 */
export function renderBlock(
  text: string,
  contentWidth: number,
  columns: number,
  highlighted: boolean,
  promptPrefix: string,
  continuationPrefix: string,
): RenderedBlockLine[] {
  const inputLines = text.split("\n");
  const outputLines: string[] = [];

  for (const inputLine of inputLines) {
    if (inputLine.trim() === "") {
      outputLines.push("");
      continue;
    }
    const wrappedLines = wrapText(inputLine, contentWidth);
    for (const wl of wrappedLines) {
      outputLines.push(wl);
    }
  }

  if (outputLines.length === 0) return [];

  const renderedLines = outputLines.map((ol, i) => {
    const prefix = i === 0 ? promptPrefix : continuationPrefix;
    const content = `${prefix}${ol}`;

    if (!highlighted) {
      return { text: content, highlighted: false };
    }

    return { text: padToColumns(content, columns), highlighted: true };
  });

  if (!highlighted) {
    return renderedLines;
  }

  const blankLine = {
    text: " ".repeat(Math.max(0, columns)),
    highlighted: true,
  };
  return [blankLine, ...renderedLines, blankLine];
}

/**
 * UserMessageRich - Rich formatting for user messages with background highlight
 *
 * Renders user messages as pre-formatted text with ANSI background codes:
 * - Custom prompt prefix on first line, matching-width spaces on subsequent lines
 * - User content blocks: full-width highlight box extending to the layout's right
 *   edge (the terminal's in the append shell, the transcript band's in the
 *   full-screen one) with one highlighted blank row above and below
 * - Word wrapping respects the prompt prefix width
 * - System-reminder parts are shown plain (no highlight), user parts highlighted
 */
export const UserMessage = memo(
  ({
    line,
    prompt,
    systemRemindersVisible = false,
    systemRemindersExpanded = false,
  }: {
    line: UserLine;
    prompt?: string;
    systemRemindersVisible?: boolean;
    systemRemindersExpanded?: boolean;
  }) => {
    // **The width is whatever `useTerminalWidth()` says, and nothing else.** Inside
    // the full-screen shell that is the transcript *band* (`TranscriptColumnsScope`),
    // which is narrower than the terminal because the context rail sits beside it and
    // two columns of right margin are kept as slack. This used to prefer
    // `process.stdout.columns` — the whole terminal — whenever it was available, so
    // the pre-wrap ran at the terminal's width while the box holding the rows was
    // the band's: every wrapped row was wider than its container and Ink truncated
    // it, which is the `…` that appeared mid-sentence in the main view on 2026-10-23.
    // The row model measures at the band width too (`ViewportTranscript` passes
    // `contentColumns`), so reading the same one number here is also what keeps the
    // predicted height equal to the painted height.
    const columns = useTerminalWidth();
    // Feature ②'s tier is display state like the reminder toggle beside it, so it
    // is read from the store rather than drilled in as a prop: Ctrl+R's gate lives
    // outside React and has to see the same value. Read before the early return
    // below — a hook may not sit behind one.
    const recallDisplay = useSyncExternalStore(
      subscribeToSystemReminderDisplay,
      getRecallDisplay,
    );
    const promptPrefix = `${prompt || CLI_GLYPHS.prompt} `;
    const prefixWidth = inkStringWidth(promptPrefix);
    const continuationPrefix = " ".repeat(prefixWidth);
    // The block's left accent bar (`《38》§11.9` ③) sits **outside** the text's own
    // budget: the wrapped width and the pad both come down by the bar's column, so
    // the block still ends exactly at the terminal's edge. Only *highlighted*
    // blocks carry the bar — a system reminder inside the same message has no edge
    // to sit on — so the two widths differ by exactly that column.
    // `row-model.ts` subtracts the same glyph from the same arithmetic; the two
    // must agree or the model's row count stops matching what the viewport draws.
    const railWidth = inkStringWidth(CLI_GLYPHS.accentRail);
    const plainWidth = Math.max(1, columns - prefixWidth);
    const contentWidth = Math.max(1, plainWidth - railWidth);
    const lineColumns = Math.max(1, columns - railWidth);
    const cleanedText = extractTaskNotificationsForDisplay(
      line.text,
    ).cleanedText;
    const displayText = cleanedText.trim();
    if (!displayText) {
      return null;
    }

    const { background, text: textColor } = colors.userMessage;

    // Split into system-reminder blocks and user content blocks
    const blocks = splitSystemReminderBlocks(displayText);

    const allLines: RenderedBlockLine[] = [];
    const pushBlock = (text: string, highlighted: boolean) => {
      if (allLines.length > 0) {
        allLines.push({ text: "", highlighted: false });
      }
      allLines.push(
        ...renderBlock(
          text,
          highlighted ? contentWidth : plainWidth,
          highlighted ? lineColumns : columns,
          highlighted,
          promptPrefix,
          continuationPrefix,
        ),
      );
    };

    for (const block of blocks) {
      if (!block.text.trim()) continue;
      if (!block.isSystemReminder) {
        pushBlock(block.text, true);
        continue;
      }
      // Feature ②'s own three tiers, deliberately independent of the
      // reminder-visibility toggle: `summary` is the default and has to show even
      // when every other reminder is hidden, and `silent` has to hide the block
      // even when they are visible (《26》§6.7).
      if (isRecallReminderText(block.text)) {
        const recall = formatRecallBlockForDisplay({
          text: block.text,
          display: recallDisplay,
          expanded: systemRemindersExpanded,
        });
        if (recall !== null) pushBlock(recall, false);
        continue;
      }
      if (!systemRemindersVisible) continue;
      pushBlock(
        formatSystemReminderBlock(block.text, systemRemindersExpanded),
        false,
      );
    }

    if (allLines.length === 0) return null;

    return (
      <Box flexDirection="column">
        {allLines.map((line, index) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: rendered rows are static
            key={index}
            backgroundColor={line.highlighted ? background : undefined}
            color={line.highlighted ? textColor : undefined}
            wrap={line.highlighted ? "truncate-end" : "wrap"}
          >
            {line.highlighted ? (
              <>
                <Text color={colors.focus.rail}>{CLI_GLYPHS.accentRail}</Text>
                {line.text}
              </>
            ) : (
              line.text
            )}
          </Text>
        ))}
      </Box>
    );
  },
);

export const LiveUserMessage = memo(
  ({ line, prompt }: { line: UserLine; prompt?: string }) => {
    const systemRemindersVisible = useSyncExternalStore(
      subscribeToSystemReminderDisplay,
      getSystemRemindersVisible,
    );
    const systemRemindersExpanded = useSyncExternalStore(
      subscribeToSystemReminderDisplay,
      getSystemRemindersExpanded,
    );
    return (
      <UserMessage
        line={line}
        prompt={prompt}
        systemRemindersVisible={systemRemindersVisible}
        systemRemindersExpanded={systemRemindersExpanded}
      />
    );
  },
);

LiveUserMessage.displayName = "LiveUserMessage";

/**
 * One recall injection as its own transcript row.
 *
 * The turn being submitted gets a row of its own rather than a part inside the user
 * bubble: the optimistic user row is appended before any reminder is built (so the
 * message appears at once) and `<Static>` never re-renders a row it has already
 * printed, so the block cannot be folded into it afterwards. This row keeps the raw
 * block and applies the tier at render time through the same call the user bubble
 * makes — which is what still answers Ctrl+R after the row has been committed.
 */
export const RecallBlockMessage = memo(function RecallBlockMessage({
  text,
}: {
  text: string;
}) {
  const display = useSyncExternalStore(
    subscribeToSystemReminderDisplay,
    getRecallDisplay,
  );
  const expanded = useSyncExternalStore(
    subscribeToSystemReminderDisplay,
    getSystemRemindersExpanded,
  );
  const shown = formatRecallBlockForDisplay({ text, display, expanded });
  if (shown === null) return null;
  return (
    <Box>
      <Text>{shown}</Text>
    </Box>
  );
});

UserMessage.displayName = "UserMessage";
