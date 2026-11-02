import { useEffect, useRef, useState } from "react";
import type { KeyBinding } from "@/cli/helpers/input-keys";
import {
  useInputScopeClaim,
  useKeyBindings,
} from "@/cli/hooks/use-input-router";

interface UseAutocompleteNavigationOptions<T> {
  /** Array of items to navigate through */
  matches: readonly T[];
  /** Maximum number of visible items (for wrapping navigation) */
  maxVisible?: number;
  /** Callback when an item is selected via Tab (autocomplete only) or Enter (when onAutocomplete is not provided) */
  onSelect?: (item: T) => void;
  /** Callback when an item is autocompleted via Tab (fill text without executing) */
  onAutocomplete?: (item: T) => void;
  /** Callback when active state changes (has matches or not) */
  onActiveChange?: (isActive: boolean) => void;
  /** Skip automatic active state management (for components with async loading) */
  manageActiveState?: boolean;
  /** Whether navigation is currently disabled (e.g., during loading) */
  disabled?: boolean;
  /**
   * Return for a popup whose Enter has its own two-step meaning (T-02, Q-46).
   *
   * Plain Enter is the composer's submit key, so a popup that wants to *fill*
   * first must own the key and answer whether it acted. The callback returns
   * `true` when it consumed the key (filled a word, or fell through to the
   * caller's submit because the word was already typed) and `false` to decline
   * and let the ordinary path have it. Left undefined, Return keeps its legacy
   * meaning (`onSelect`), which is what `FileAutocomplete` wants: its "fill" and
   * its "accept" are the same message edit.
   */
  onEnter?: (item: T) => boolean;
  /**
   * Esc: dismiss the popup (T-02, R-02.3) before the app's interrupt runs.
   *
   * Providing this also makes the popup the keyboard owner while it has rows:
   * the hook claims the `overlay` scope, which is the only way to beat the
   * composer's app-scope `Esc` (interrupt / double-escape-to-clear) without
   * editing the pinned `InputRich`. The trade is the one `BtwPane` documents —
   * app-scope chords (Ctrl+C, Ctrl+O/R/T, Shift+Tab, the leader prefix) are not
   * consulted while the rows are up; the text editor's own keys stay live
   * because `PasteAwareTextInput` registers its table in the `overlay` scope
   * too, so typing/editing a command is unaffected. `FileAutocomplete` leaves
   * this undefined: its Esc keeps the composer's meaning.
   */
  onDismiss?: () => void;
}

interface UseAutocompleteNavigationResult {
  /** Currently selected index */
  selectedIndex: number;
  /**
   * Put the cursor on an index without running anything.
   *
   * The pointer needs this: a click moves the cursor to the row it landed on and
   * *then* runs that row's accept callback, and it must not wait for the next
   * render to do so. The accepting half stays the caller's callback — this hook
   * owns no execution path of its own, and the click calls the same callback the
   * bindings below call.
   */
  setSelectedIndex: (index: number) => void;
}

/**
 * Shared hook for autocomplete keyboard navigation.
 * Handles up/down arrow keys for selection and Tab/Enter for confirmation.
 *
 * Tab and Return are only this hook's while they are *plain*: the composer's own
 * table owns Shift+Tab (cycle the permission mode) and Shift+Enter (insert a
 * newline), and under the kitty protocol those arrive as CSI-u sequences the raw
 * shield deliberately leaves alone — so a chord that named no modifier would
 * otherwise act on one keystroke that both flips the mode and accepts the
 * highlighted completion. A chord with no modifier named means "this modifier
 * must be absent", which is the whole of that rule now.
 *
 * The keys are the router's `app` table, which is the scope the composer owns:
 * they are consulted while the composer has the keyboard, and they **decline**
 * whenever there is nothing to navigate (no matches, or a load in flight), so the
 * key continues down its ordinary path — the text editor, the wrapped-line and
 * history handler, or the composer's own Tab.
 *
 * A popup with Esc-dismissal (`onDismiss`) is different: it is the keyboard
 * owner while it has rows, so its table moves to the `overlay` scope and the
 * hook claims that scope. That is what gives Esc its priority over `interrupt`
 * (T-02) — the composer's `app` table is not consulted at all while the popup is
 * up, so `Esc` cannot both close the popup and interrupt the turn behind it.
 *
 * Two of those neighbours already stand down for the popup and keep doing so:
 * `InputRich`'s history handler reads the live `isAutocompleteActive`, and the
 * composer's Tab binding returns `false` while the popup is up. What changes is
 * that the popup now *owns* ↑/↓/Tab/Enter/Esc at the dispatch point instead of
 * relying on every legacy listener to notice it — which is the state this hook
 * cannot read for itself (see the `memo`/`useEffectEvent` note in
 * `overlay/README.md`).
 */
export function useAutocompleteNavigation<T>({
  matches,
  maxVisible,
  onSelect,
  onAutocomplete,
  onActiveChange,
  manageActiveState = true,
  disabled = false,
  onEnter,
  onDismiss,
}: UseAutocompleteNavigationOptions<T>): UseAutocompleteNavigationResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prevMatchCountRef = useRef(0);
  const prevIsActiveRef = useRef(false);
  const ownsKeyboard = onDismiss !== undefined;

  // Esc can only beat the composer's interrupt if this popup is the keyboard
  // owner, and the focus ledger is what says so. Claimed only while there are
  // rows to dismiss: with no candidates the popup is not a surface at all, and
  // Esc must keep its ordinary app meaning (`onDismiss` is not even bound, since
  // the overlay-scope table is not consulted while the claim is absent).
  useInputScopeClaim(
    "overlay",
    ownsKeyboard && !disabled && matches.length > 0,
  );

  // Reset selected index when matches change significantly
  useEffect(() => {
    if (matches.length !== prevMatchCountRef.current) {
      setSelectedIndex(0);
      prevMatchCountRef.current = matches.length;
    }
  }, [matches.length]);

  // Notify parent about active state changes (only if manageActiveState is true)
  // Only fire callback when the boolean active state actually changes (not on every match count change)
  useEffect(() => {
    if (manageActiveState) {
      const isActive = matches.length > 0;
      if (isActive !== prevIsActiveRef.current) {
        prevIsActiveRef.current = isActive;
        onActiveChange?.(isActive);
      }
    }
  }, [matches.length, onActiveChange, manageActiveState]);

  // Handle keyboard navigation
  const bindings: KeyBinding[] = [
    {
      id: "autocomplete.up",
      chords: [{ key: "upArrow" }],
      run: () => {
        if (!matches.length || disabled) return "declined";
        const maxIndex =
          maxVisible !== undefined
            ? Math.min(matches.length, maxVisible) - 1
            : matches.length - 1;
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : maxIndex));
        return "consumed";
      },
    },
    {
      id: "autocomplete.down",
      chords: [{ key: "downArrow" }],
      run: () => {
        if (!matches.length || disabled) return "declined";
        const maxIndex =
          maxVisible !== undefined
            ? Math.min(matches.length, maxVisible) - 1
            : matches.length - 1;
        setSelectedIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
        return "consumed";
      },
    },
    {
      id: "autocomplete.accept",
      chords: [{ key: "tab" }],
      run: () => {
        if (!matches.length || disabled) return "declined";
        const selected = matches[selectedIndex];
        if (!selected) return "declined";
        // Tab: use onAutocomplete if provided, otherwise fall back to onSelect
        if (onAutocomplete) {
          onAutocomplete(selected);
        } else if (onSelect) {
          onSelect(selected);
        }
        return "consumed";
      },
    },
    {
      id: "autocomplete.select",
      chords: [{ key: "return" }],
      run: () => {
        if (!matches.length || disabled) return "declined";
        const selected = matches[selectedIndex];
        if (!selected) return "declined";
        // Enter with a caller-owned two-step meaning (T-02): the caller decides
        // between fill and fall-through, and answers whether it acted.
        if (onEnter) {
          return onEnter(selected) ? "consumed" : "declined";
        }
        if (!onSelect) return "declined";
        onSelect(selected);
        return "consumed";
      },
    },
  ];

  if (onDismiss) {
    bindings.push({
      id: "autocomplete.dismiss",
      chords: [{ key: "escape" }],
      run: () => {
        if (!matches.length || disabled) return "declined";
        onDismiss();
        return "consumed";
      },
    });
  }

  useKeyBindings("autocomplete-navigation", [
    { scope: ownsKeyboard ? "overlay" : "app", bindings },
  ]);

  return { selectedIndex, setSelectedIndex };
}
