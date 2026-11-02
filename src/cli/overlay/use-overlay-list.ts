import { useCallback, useId, useMemo, useRef, useState } from "react";
import { owningInputScope } from "@/cli/helpers/focus-ledger";
import type { InputScope, KeyBinding } from "@/cli/helpers/input-keys";
import {
  useInputScopeClaim,
  useKeyBindings,
} from "@/cli/hooks/use-input-router";
import { listBindings } from "./list-bindings";
import {
  clampCursor,
  itemAt,
  type ListAnchor,
  type ListWindow,
  type OverlayListItem,
  visibleWindow,
} from "./list-model";
import type { OverlayListMouse } from "./list-view";

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
 *
 * **The pointer rides the same policy as the keys.** `mouse` is the part of the
 * controller the list view aims at: a click is *that row's Enter* (it moves the
 * cursor and calls the same `onConfirm` the keyboard calls, with the row's index
 * so it never acts on the previous frame), a wheel notch is one `↑`/`↓` step, and
 * both are refused while a text sub-view has the keys
 * (`navigationEnabled: false`) — the seam adds no second execution path
 * (《38》§19.2). A list rendered without asking for a window still answers the
 * wheel: the cursor moves and the whole list is on screen, which is what every
 * unwindowed face had before the pointer existed.
 */

type OverlayInputScope = Extract<InputScope, "overlay" | "modal">;

export interface UseOverlayListOptions {
  /** Registered owner id, for diagnostics and conflict tests. */
  owner: string;
  /** Items the cursor can be on, already filtered and already ordered. */
  items: readonly OverlayListItem[];
  /** Start position (default 0). Clamped to the list. */
  initialCursorIndex?: number;
  /** Window size, which is also the PageUp/PageDown step. Unset = whole list. */
  rows?: number;
  /**
   * Where the window sits relative to the cursor. See `list-model.ts`: `edge` is
   * the model lists' shape, `center` is `/resume`'s and `/search`'s, and `page`
   * is `/help`'s page-aligned one. A face must pass the same anchor to
   * `OverlayListView`, which is what windows.
   */
  anchor?: ListAnchor;
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
   * Whether Home/End jump to the ends of the list. On by default.
   *
   * Off is for a list whose neighbour is a live editor — `/config connect`'s filter is
   * the one. `list-bindings.ts` states the rule; this is the same switch, for a
   * face that goes through this hook rather than building the table itself.
   */
  edgeKeys?: boolean;
  /**
   * Enter on the item at the cursor. Called for a `disabled` item too: whether
   * that confirms is the caller's policy, and the key is consumed either way.
   */
  onConfirm?: (key: string, index: number) => void;
  /**
   * Escape / Ctrl+C. Omit it inside a multi-step overlay, where both keys are
   * the wizard's (`wizard.tsx`) and a list that claimed Escape would answer for
   * every step; see `list-bindings.ts`.
   */
  onCancel?: () => void;
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
  /**
   * Move the cursor to an index, clamped.
   *
   * **Stable across renders.** Three faces (`/resume`, `/search`, `/model`) hold
   * the cursor themselves and reset it from a callback they define *before* this
   * hook is called, so each of them used to keep a ref to the fresh closure it got
   * every render. The clamping reads the current count through a ref instead, so
   * the identity never has to change.
   */
  setCursor: (index: number) => void;
  /**
   * The pointer's half of the same seam (hover area, click, wheel). Pass it to
   * `OverlayListView` as `mouse`: that is the whole wiring — the list view owns
   * the geometry (it is the thing that drew the rows) and this hook owns the
   * cursor and the confirm callback, so neither has to know the other's state.
   */
  mouse: OverlayListMouse;
}

export function useOverlayList(
  options: UseOverlayListOptions,
): OverlayListController {
  const {
    owner,
    items,
    rows,
    anchor,
    scope = "overlay",
    navigationEnabled = true,
    vimKeys,
    edgeKeys,
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

  // The count this render sees, kept where `moveTo` can read it without being
  // rebuilt: assigned during render, the pattern `useKeyBindings` uses for its
  // tables (a key handler must see the render that is on screen).
  const countRef = useRef(count);
  countRef.current = count;

  const moveTo = useCallback((index: number) => {
    setRawCursor(clampCursor(index, countRef.current));
  }, []);

  const moveBy = useCallback((delta: number) => {
    setRawCursor((prev) => clampCursor(prev + delta, countRef.current));
  }, []);

  const mouse = useListMouseController({
    items,
    navigationEnabled,
    scope,
    moveTo,
    moveBy,
    onConfirm,
  });

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
        edgeKeys,
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
    window: visibleWindow({ count, cursor, rows, anchor }),
    setCursor: moveTo,
    mouse,
  };
}

/**
 * The pointer half of the controller.
 *
 * It is built here rather than in `list-view.tsx` because the two callbacks it
 * needs — the cursor and the confirm — are this hook's state; the list view only
 * knows geometry. The callbacks read the render through refs, the same reason the
 * key table does: the mouse handler is registered once and must act on the frame
 * the user is looking at, not the one that was on screen when it registered.
 *
 * `blocked` is the overlay/modal stacking guard: a modal outranks an overlay in
 * the focus ledger, so a selector still mounted behind one must not answer the
 * pointer (《38》§19.4, "overlay/modal open ⇒ refuse the whole frame"). A list that
 * *is* modal-scoped is not blocked by its own claim — it is the modal.
 */
function useListMouseController(options: {
  items: readonly OverlayListItem[];
  navigationEnabled: boolean;
  scope: OverlayInputScope;
  moveTo: (index: number) => void;
  moveBy: (delta: number) => void;
  onConfirm?: (key: string, index: number) => void;
}): OverlayListMouse {
  const { items, navigationEnabled, scope, moveTo, moveBy, onConfirm } =
    options;
  // A stable name for the hover store. `useId` is per component instance, so two
  // lists mounted at once (a wizard stack) cannot light each other's rows.
  const area = `overlay-list:${useId()}`;

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const navigationRef = useRef(navigationEnabled);
  navigationRef.current = navigationEnabled;
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const activate = useCallback(
    (index: number) => {
      // The keys are not the list's right now (a text sub-view owns them), so a
      // click is not the row's Enter either: no second path around the rule.
      if (!navigationRef.current) return;
      // `Enter` declines when there is no confirm handler; a click that moved the
      // cursor anyway would be an action Enter never had.
      const confirm = onConfirmRef.current;
      if (!confirm) return;
      const list = itemsRef.current;
      const at = clampCursor(index, list.length);
      const item = list[at];
      if (!item) return;
      // §19.2: move the cursor, then call the handler the keyboard calls. Both
      // with the clicked index — never with React state that has not landed yet.
      moveTo(at);
      confirm(item.key, at);
    },
    [moveTo],
  );

  const wheel = useCallback(
    (direction: "up" | "down") => {
      if (!navigationRef.current) return;
      moveBy(direction === "up" ? -1 : 1);
    },
    [moveBy],
  );

  const blocked = useCallback(
    () => owningInputScope() === "modal" && scopeRef.current !== "modal",
    [],
  );

  // `area` is already stable; the callbacks are stable; one object identity for
  // the life of the list keeps the list view's effect from re-registering.
  return useMemo(
    () => ({ area, activate, wheel, blocked }),
    [area, activate, wheel, blocked],
  );
}
