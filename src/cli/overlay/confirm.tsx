import { Box } from "ink";
import type { ReactElement } from "react";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";

/**
 * The confirmation controls: one row per option, and the line a destructive
 * action makes you type a name into.
 *
 * A confirmation is the last screen before something is deleted, so what it owes
 * the user is that the row under the marker is unmistakably the row Enter acts on.
 * That is what lives here — the marker, its width on the unselected rows, and the
 * emphasised row. The question, the warning and the footer do not: those are the
 * words of one particular deletion and stay with the face doing the confirming.
 *
 * The emphasis is a **parameter**, because the two confirmations in this tree
 * disagree and both were already shipping. `/mcp` bolds and colours the whole
 * selected row behind a `> ` marker; `/hooks` colours a `❯ ` and its label and
 * leaves the row upright. M5 keeps both looking exactly as they looked — a shared
 * renderer that picked one of them would be a visible change wearing the costume
 * of a deduplication. The unselected rows are derived from the marker's width, so
 * `> ` and `❯ ` each keep their own alignment.
 *
 * This module grows when its next consumer arrives (the approval faces, B5, whose
 * options are numbered and whose custom reason is a text field); it does not
 * pre-build those shapes today.
 */

export interface ConfirmOption {
  /** Stable identity for the row. */
  key: string;
  label: string;
}

export interface ConfirmOptionsProps {
  options: readonly ConfirmOption[];
  selectedIndex: number;
  /**
   * Drawn in front of the selected option, separator space included; the others
   * get blanks of that width. `❯ ` is the tree's common shape.
   */
  marker?: string;
  /** Colour of the selected option — marker and label together. */
  selectedColor?: string;
  /** Bold the whole selected row rather than only its marker and label. */
  boldSelected?: boolean;
}

/**
 * The option rows of a confirmation.
 *
 * A fragment, not a box: the callers differ in how they place the rows (one wants
 * a `marginTop`, the other interleaves blank lines around them), and a container
 * imposed here would have to be undone there.
 */
export function ConfirmOptions({
  options,
  selectedIndex,
  marker = "❯ ",
  selectedColor = colors.input.prompt,
  boldSelected = false,
}: ConfirmOptionsProps): ReactElement {
  return (
    <>
      {options.map((option, index) => {
        const isSelected = index === selectedIndex;
        return (
          <Text key={option.key} bold={boldSelected && isSelected}>
            <Text color={isSelected ? selectedColor : undefined}>
              {isSelected ? marker : " ".repeat(marker.length)}
              {option.label}
            </Text>
          </Text>
        );
      })}
    </>
  );
}

export interface TypedConfirmPromptProps {
  /** What the user has typed so far. */
  value: string;
  /** Shown dim instead of the value while it is empty. */
  placeholder: string;
}

/**
 * The `> ` line a typed confirmation is entered on.
 *
 * It renders the value, and the placeholder only while there is no value — the
 * caller keeps the draft and decides when it matches (a name comparison belongs to
 * the action being confirmed, not to its prompt).
 */
export function TypedConfirmPrompt({
  value,
  placeholder,
}: TypedConfirmPromptProps): ReactElement {
  return (
    <Box flexDirection="row">
      <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
      <Text dimColor={!value}>{value || placeholder}</Text>
    </Box>
  );
}
