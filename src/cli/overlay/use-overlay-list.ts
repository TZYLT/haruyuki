import { useState } from "react";
import type { InputScope, KeyBinding } from "@/cli/helpers/input-keys";
import {
  useInputScopeClaim,
  useKeyBindings,
} from "@/cli/hooks/use-input-router";
import { listBindings } from "./list-bindings";
import {
  clampCursor,
  itemAt,
  type ListWindow,
  type OverlayListItem,
  visibleWindow,
} from "./list-model";

/**
 * Wiring the list model and the key table to the input router.
 *
 * This is the seam an overlay uses instead of Ink's `useInput`: it owns the
 * cursor, publishes the key table for the render that is on screen, and hands
 * back the cursor, the item under it, and the window.
 *
 * Three properties are load-bearing.
 *
 * - **The scope is claimed here, and it is the same scope the table declares.**
 *   The router consults the owning scope plus the system layer, so a list that
 *   binds `overlay` keys without claiming the `overlay` layer would be correct and
 *   receive nothing. Claiming here rather than leaving it to the frame is what
 *   keeps a focused component test honest — the pickers are rendered on their own
 *   in tests, with no shell to claim anything — and it is ref-counted, so in the
 *   app it adds to the shell's claim rather than competing with it.
 * - **The cursor is clamped when it is read, not stored clamped.** A list that
 *   shrinks (a filter narrowing) highlights the right row in that same frame
 *   instead of leaving a frame with nothing highlighted. The raw index is kept, so
 *   clearing the filter puts the cursor back where the user left it — which is the
 *   point: the index is a position in the list the user is looking at, and only
 *   the *item identity* (`key`) is what outlives a render.
 * - **State stays in this leaf.** Nothing here touches `AppCoordinator`/`AppView`
 *   state; an overlay is one component, and a module-level store would leak across
 *   mounts and between tests.
 *
 * **Policy stays with the caller.** The list says which keys apply and hands over
 * the item's key and index; it does not decide what a `disabled` row means. The
 * two pickers decided differently and neither was wrong — a blocked row in the
 * single-select confirmed nothing, while the multi-select confirmed the whole
 * selection from wherever the cursor stood — so the decision belongs where the
 * history is. The key is consumed either way.
 */

export type OverlayInputScope = Extract<InputScope, "overlay" | "modal">;

export interface UseOverlayListOptions {
  /** Registered owner id, for diagnostics and conflict tests. */
  owner: string;
  /** Items the cursor can be on, already filtered and already ordered. */
  items: readonly OverlayListItem[];
  /** Start position (default 0). Clamped to the list. */
  initialCursorIndex?: number;
  /** Window size, which is also the PageUp/PageDown step. Unset = whole list. */
  rows?: number;
  /** Scope to claim and bind in. `overlay` unless this list is a modal's. */
  scope?: OverlayInputScope;
  /**
   * Whether the list currently has the keys. False while a text sub-view inside
   * the overlay is focused, so the arrows move the caret and `j`/`k` type.
   */
  navigationEnabled?: boolean;
  /** Whether plain `j`/`k` navigate. On by default, as the pickers had them. */
  vimKeys?: boolean;
  /**
   * Enter on the item at the cursor. Called for a `disabled` item too: whether
   * that confirms is the caller's policy, and the key is consumed either way.
   */
  onConfirm?: (key: string, index: number) => void;
  /** Escape / Ctrl+C. */
  onCancel: () => void;
  /**
   * Space on the item at the cursor. Called for a `disabled` item too, for the
   * same reason as `onConfirm`.
   */
  onToggle?: (key: string, index: number) => void;
  /** The left and right arrows on the item at the cursor. */
  onMoveItem?: (direction: "up" | "down", index: number) => void;
  /** Further bindings the caller owns; they take precedence over the list's. */
  extra?: readonly KeyBinding[];
}

export interface OverlayListController {
  /** The cursor, clamped to the current list. */
  cursor: number;
  /** The item under the cursor, or `undefined` when the list is empty. */
  current: OverlayListItem | undefined;
  /** What part of the list is on screen, for a footer or a count. */
  window: ListWindow;
  /** Move the cursor to an index, clamped. */
  setCursor: (index: number) => void;
}

export function useOverlayList(
  options: UseOverlayListOptions,
): OverlayListController {
  const {
    owner,
    items,
    rows,
    scope = "overlay",
    navigationEnabled = true,
    vimKeys,
    onConfirm,
    onCancel,
    onToggle,
    onMoveItem,
    extra,
  } = options;

  const count = items.length;
  const [rawCursor, setRawCursor] = useState(() =>
    clampCursor(options.initialCursorIndex ?? 0, count),
  );
  const cursor = clampCursor(rawCursor, count);

  useInputScopeClaim(scope, true);

  const moveTo = (index: number) => setRawCursor(clampCursor(index, count));

  useKeyBindings(owner, [
    {
      scope,
      bindings: listBindings({
        count,
        cursor,
        onMoveCursor: moveTo,
        onConfirm: onConfirm
          ? () => {
              const item = itemAt(items, cursor);
              if (!item) return;
              onConfirm(item.key, cursor);
            }
          : undefined,
        onCancel,
        rows,
        navigationEnabled,
        vimKeys,
        onToggle: onToggle
          ? () => {
              const item = itemAt(items, cursor);
              if (!item) return;
              onToggle(item.key, cursor);
            }
          : undefined,
        onMoveItem: onMoveItem
          ? (direction) => onMoveItem(direction, cursor)
          : undefined,
        extra,
      }),
    },
  ]);

  return {
    cursor,
    current: itemAt(items, cursor),
    window: visibleWindow({ count, cursor, rows }),
    setCursor: moveTo,
  };
}
