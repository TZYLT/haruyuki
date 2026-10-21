import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

interface AutocompleteBoxProps {
  /** Optional header text shown at top of autocomplete */
  header?: ReactNode;
  children: ReactNode;
}

/**
 * Shared container for autocomplete dropdowns.
 * Provides consistent styling for both file and command autocomplete.
 */
export function AutocompleteBox({ header, children }: AutocompleteBoxProps) {
  return (
    <Box flexDirection="column">
      {header && <Text dimColor>{header}</Text>}
      {children}
    </Box>
  );
}

interface AutocompleteItemProps {
  /** Whether this item is currently selected */
  selected: boolean;
  /**
   * Whether the pointer is on this row (`surface.hoverBg`).
   *
   * The row is a `Box`, not a bare `Text`, because the second background is a
   * *surface* rule (《38》§19.3.1: the whole row, foreground unchanged) rather than
   * part of the line's text. Two rows can be involved in one pointer gesture, so
   * each row subscribes for itself rather than the list re-rendering.
   *
   * Selection wins: a hovered row that is also the cursor paints no hover
   * background, so the two signals never stack or invert (§19.3.2).
   */
  hovered?: boolean;
  /** Unique key for React */
  children: ReactNode;
}

/**
 * Shared item component for autocomplete lists.
 * Handles selection styling (color-based, no arrow indicator).
 * 2-char gutter aligns with input box prompt.
 */
export function AutocompleteItem({
  selected,
  hovered,
  children,
}: AutocompleteItemProps) {
  return (
    <Box
      backgroundColor={
        hovered && !selected ? colors.surface.hoverBg : undefined
      }
    >
      <Text
        color={selected ? colors.command.selected : undefined}
        bold={selected}
        // Keep each item one visual line tall so navigating doesn't reflow the footer.
        wrap="truncate-end"
      >
        {"  "}
        {children}
      </Text>
    </Box>
  );
}
