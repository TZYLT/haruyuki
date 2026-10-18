import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "@/cli/components/colors";
import { PasteAwareTextInput } from "@/cli/components/PasteAwareTextInput";
import { Text } from "@/cli/components/Text";

/**
 * The overlay toolkit's text sub-view: the labelled editor row.
 *
 * Ten overlays in this tree ask for one line of text — `/connect`'s filter, its
 * API key, its OAuth provider name and each of its `multiInput` fields,
 * `/hooks`'s matcher and command, `/recall`'s and `/compaction`'s value
 * editors, `/pin`'s agent name, `/sleeptime`'s two inline fields, `/feedback`'s
 * message — and nine of them asked for it by hand: a `useInput` that appended
 * `input` to a string and `slice(0, -1)` on Backspace, with the text painted as
 * a plain `<Text>`. That is why none of them had a caret, and why a paste into
 * any of them was **silently dropped** (the router hands a paste to a
 * `PasteAwareTextInput` or to nobody; a hand-rolled appender is nobody).
 *
 * So the row is here once, built on the editor the composer already uses: the
 * caret, the paste channel, the IME accumulation and the parent-drivable cursor
 * offset all come from `PasteAwareTextInput`, and this module only decides what
 * surrounds it — the marker before it and, for `/connect`, the status text
 * after it.
 *
 * **Optional on purpose.** `marker: null` is a field with no `> ` in front of
 * it (`/hooks` draws the editor inside its own rounded box, and `/connect`'s
 * in-place fields are labelled by the row they sit in); `focus` is what an
 * in-place field passes when it is not the row the cursor is on — with it off,
 * the editor declines every key, so a form can move over a text field without
 * the field eating the arrows.
 *
 * The keys that *leave* a text step are not here: they are the wizard's
 * (`wizard.tsx`), because "Escape goes back a step" is the same sentence in
 * every one of these overlays, text step or list step.
 */

export interface OverlayTextFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter. Omitted leaves the key to whatever else is bound in this scope. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  /**
   * What sits before the editor. A plain string is painted in `markerColor`;
   * anything else is drawn as it is, the way `OverlayFrame`'s `footer` works, so
   * a face can hand over its own label (`/connect`'s dim `Filter: `, its
   * per-field `> Label:` runs). `null` draws nothing at all — which is not the
   * same as `""`, a marker that still takes its place in the row.
   */
  marker?: ReactNode;
  /**
   * The marker's colour. Defaults to the approval-header accent the value
   * editors use; `/connect` and `/feedback` prompt in the selector accent
   * instead, and that difference is visible, so it stays a parameter.
   */
  markerColor?: string;
  /**
   * Passed straight to the editor: a single character repeated over the value,
   * which is how the API-key field stays unreadable while keeping a caret. The
   * editor's own value is the real one — only the paint is masked.
   */
  mask?: string;
  /**
   * Whether typing reaches this field. On by default. Off is for a field the
   * cursor is not on, so a form can navigate across it: a focused editor claims
   * Backspace and the arrow-adjacent keys through the router.
   */
  focus?: boolean;
  /** Painted after the editor, inside the same row — `/connect`'s status text. */
  trailing?: React.ReactNode;
}

export function OverlayTextField({
  value,
  onChange,
  onSubmit,
  placeholder,
  marker = "> ",
  markerColor,
  mask,
  focus,
  trailing,
}: OverlayTextFieldProps) {
  return (
    <Box flexDirection="row">
      {typeof marker === "string" ? (
        <Text color={markerColor ?? colors.approval.header}>{marker}</Text>
      ) : (
        marker
      )}
      <PasteAwareTextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
        mask={mask}
        focus={focus}
      />
      {trailing}
    </Box>
  );
}
