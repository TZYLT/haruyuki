import chalk from "chalk";
import type { ReactNode } from "react";
import { colors } from "@/cli/components/colors";
import { Box, Text } from "@/cli/display/DisplayComponents";
import {
  statuslineContextLabel,
  truncateStatuslineText,
} from "@/cli/display/statusline/formatting";
import type { StatuslineUiContext } from "@/cli/display/statusline/types";
import type { ModContext } from "@/mods/types";

interface DefaultStatuslineParts {
  left: ReactNode;
  /** The left slot's plain text (`ctx 84k/128k(66%)`), or `null` when it is blank. */
  leftLabel: string | null;
  right: string;
  rightCore: string;
  rightWidth: number;
}

/**
 * Columns the right-hand column may take.
 *
 * **It is a budget, not the box's width** (2026-10-23). It used to be
 * `max(ui.rightColumnWidth, terminalWidth - 4)`, and the row drew a box of that
 * width — so on a 100-column terminal the right column reserved 96 of them and the
 * left one had four. Every left-hand state the row has (the context chip, `>> bash
 * mode`, `accept edits (shift+tab to cycle)`, `press ↑ to edit queued message`)
 * therefore either vanished or wrapped inside a four-column box; the machine hit it
 * the moment the context chip moved there. `ui.rightColumnWidth` is the width the
 * composer already sizes from the terminal (`max(28, min(72, 45%))`), which leaves
 * the left side a real share and still gives a long agent name room.
 */
export function getDefaultStatuslineRightColumnWidth(
  _context: ModContext,
  ui: StatuslineUiContext,
): number {
  return ui.rightColumnWidth;
}

export function buildDefaultStatuslineParts(
  context: ModContext,
  ui: StatuslineUiContext,
  rightColumnWidth = getDefaultStatuslineRightColumnWidth(context, ui),
): DefaultStatuslineParts {
  const separatorWidth = 3;
  const availableTextWidth = Math.max(12, rightColumnWidth - separatorWidth);
  const maxAgentChars = Math.max(8, Math.floor(availableTextWidth * 0.4));
  const displayAgentName = truncateStatuslineText(
    context.agent.name || "Unnamed",
    maxAgentChars,
  );
  const maxModelChars = Math.max(
    8,
    availableTextWidth - displayAgentName.length,
  );
  const displayModel = truncateStatuslineText(
    context.model.displayName ?? "unknown",
    maxModelChars,
  );

  // The context chip is the row's **default left content**, not a right-hand
  // suffix (2026-10-23). The machine asked for it by name: `ctx 84k/128k(66%)` at
  // the bottom, shown by default, with a permission switch temporarily taking the
  // slot and handing it back afterwards — which is exactly what the left slot
  // already does for `>> bash mode` and `accept edits (… cycle)`
  // (`DefaultStatuslineLeftContent`). It is printed whether or not the rail is
  // folded: the rail's `ctx 66% · 84k / 128k` is the detailed reading, this is the
  // one that survives the rail going away.
  const contextLabel = statuslineContextLabel({
    usedTokens: context.contextWindow.usedTokens ?? null,
    windowSize: context.contextWindow.size,
  });

  const rightWidth =
    displayAgentName.length + separatorWidth + displayModel.length;
  const rightPrefixSpaces = Math.max(0, rightColumnWidth - rightWidth);

  const rightCoreParts: string[] = [];
  rightCoreParts.push(chalk.hex(colors.footer.agentName)(displayAgentName));
  rightCoreParts.push(chalk.dim(" · "));
  rightCoreParts.push(chalk.dim(displayModel));

  const rightCore = rightCoreParts.join("");
  const right = " ".repeat(rightPrefixSpaces) + rightCore;

  return {
    left:
      contextLabel === null ? (
        <Text> </Text>
      ) : (
        <Text dimColor>{contextLabel}</Text>
      ),
    leftLabel: contextLabel,
    right,
    rightCore,
    rightWidth,
  };
}

export function renderDefaultStatusline(
  context: ModContext,
  ui: StatuslineUiContext,
) {
  const rightColumnWidth = getDefaultStatuslineRightColumnWidth(context, ui);
  const parts = buildDefaultStatuslineParts(context, ui, rightColumnWidth);

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexGrow={1} paddingRight={1}>
        {parts.left}
      </Box>
      <Box
        flexDirection="column"
        alignItems="flex-end"
        width={rightColumnWidth}
        flexShrink={0}
      >
        <Text>{parts.right}</Text>
      </Box>
    </Box>
  );
}
