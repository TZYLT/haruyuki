import { useEffect, useRef, useState } from "react";
import type { KeyBinding } from "@/cli/helpers/input-keys";
import { useKeyBindings } from "@/cli/hooks/use-input-router";

interface UseAutocompleteNavigationOptions<T> {
  /** Array of items to navigate through */
  matches: T[];
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
}

interface UseAutocompleteNavigationResult {
  /** Currently selected index */
  selectedIndex: number;
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
 * Two of those neighbours already stand down for the popup and keep doing so:
 * `InputRich`'s history handler reads the live `isAutocompleteActive`, and the
 * composer's Tab binding returns `false` while the popup is up. What changes is
 * that the popup now *owns* ↑/↓/Tab/Enter at the dispatch point instead of
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
}: UseAutocompleteNavigationOptions<T>): UseAutocompleteNavigationResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prevMatchCountRef = useRef(0);
  const prevIsActiveRef = useRef(false);

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
        if (!matches.length || disabled || !onSelect) return "declined";
        const selected = matches[selectedIndex];
        if (!selected) return "declined";
        onSelect(selected);
        return "consumed";
      },
    },
  ];

  useKeyBindings("autocomplete-navigation", [{ scope: "app", bindings }]);

  return { selectedIndex };
}
