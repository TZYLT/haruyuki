import type { ReactElement } from "react";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";

/**
 * The confirmation controls: one row per option.
 *
 * A confirmation is the last screen before something is deleted, so what it owes
 * the user is that the row under the marker is unmistakably the row Enter acts on.
 * That is what lives here — the marker, its width on the unselected rows, and the
 * emphasised row. The question, the warning and the footer do not: those are the
 * words of one particular deletion and stay with the face doing the confirming.
 *
 * **One shape, since P7.** Until then this component carried the tree's one
 * *deliberate* inconsistency: `/mcp` drew `> ` and bolded the whole selected row,
 * `/hooks` drew `❯ ` and bolded nothing, and the difference was an M4 ruling
 * ("both were already shipping"). 《38》§11.8 ④ overrode it, for a reason that is
 * not aesthetic: `❯` (U+276F) is missing from some fonts, and the one glyph a
 * confirmation cannot lose is the one that says which row Enter fires on. So the
 * shape is §11.4's: an ASCII `> ` marker, the accent foreground, bold — the same
 * three things a list row already uses. The `marker` / `selectedColor` /
 * `boldSelected` parameters went with the second variant: a face that needs a
 * different emphasis needs a different component, not another flag here.
 *
 * The **type-to-confirm** prompt used to live here too (`TypedConfirmPrompt`: the
 * value, or the placeholder while it was empty). It is gone: the one caller was
 * `/agents`'s delete confirmation, whose draft was a hand-rolled appender, so the
 * row could not receive a paste and could not show a caret. That row is the
 * toolkit's text sub-view now (`text-view.tsx`), which is a *real* editor — there
 * is one implementation of a `> ` prompt row in this tree, and it is not this one.
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
}

/** The marker and the blank that stands in for it, so the labels line up. */
const MARKER = `${CLI_GLYPHS.selection} `;

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
}: ConfirmOptionsProps): ReactElement {
  return (
    <>
      {options.map((option, index) => {
        const isSelected = index === selectedIndex;
        return (
          <Text key={option.key} bold={isSelected}>
            <Text color={isSelected ? colors.focus.selected : undefined}>
              {isSelected ? MARKER : " ".repeat(MARKER.length)}
              {option.label}
            </Text>
          </Text>
        );
      })}
    </>
  );
}
