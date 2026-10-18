import type { KeyBinding } from "@/cli/helpers/input-keys";
import { edgeCursor, moveCursor } from "./list-model";

/**
 * The overlay list's key table, as data.
 *
 * Every navigation key an overlay recognises is declared here once, in the
 * router's `KeyBinding` shape, so "who owns this key" is answerable by reading
 * one file instead of by grepping a dozen `useInput` handlers. The handlers stay
 * with the caller: this module says *which* keys a list answers to and *when*
 * they apply, never what a selection means.
 *
 * Two rules, both load-bearing:
 *
 * - **Decline, do not swallow.** A key that does not apply right now (empty list,
 *   a text sub-view owns typing, no confirm handler) returns `declined`, so the
 *   router keeps looking and the key reaches whatever legitimately owns it —
 *   usually the text editor. A binding that matches and consumes when it had
 *   nothing to do is how a keystroke disappears.
 * - **Escape is never declined.** An overlay that cannot be left is a trap, so
 *   cancel is consumed unconditionally (with Ctrl+C, which is what cancels an
 *   overlay today).
 */

/** Rows a PageUp/PageDown step covers when the caller does not say. */
const DEFAULT_PAGE_ROWS = 10;

export interface ListBindingHost {
  /** Items the cursor can be on, already filtered. */
  count: number;
  cursor: number;
  /** Move the cursor. The host owns the state. */
  onMoveCursor: (index: number) => void;
  /**
   * Confirm the item at the cursor. Omitted means this list cannot confirm.
   *
   * Whether a `disabled` item confirms is the host's decision, not this table's:
   * it has to stay a consumed key either way, because that is what the pickers
   * did (Enter on a disabled row did nothing, it did not fall through).
   */
  onConfirm?: () => void;
  /**
   * Escape / Ctrl+C. Always consumed where it is declared, but **optional**:
   * a list inside a multi-step overlay declares no cancel, because there the
   * two keys are the wizard's (`wizard.tsx`) — Escape goes back one step and
   * Ctrl+C closes the overlay. A list that claimed Escape would take it away
   * from every other step, and one that claimed Ctrl+C would turn "close this"
   * into "go back".
   */
  onCancel?: () => void;
  /** Window size, which is also the PageUp/PageDown step. */
  rows?: number;
  /**
   * Whether the list currently has the keys. False while a text sub-view is
   * focused inside the overlay, so the arrows move the caret and `j`/`k` type —
   * the sub-view keeps Escape for itself through `extra`.
   */
  navigationEnabled?: boolean;
  /**
   * Whether plain `j`/`k` navigate. On by default because the pickers did it, but
   * a list that sits beside a text field wants them off: they are letters.
   */
  vimKeys?: boolean;
  /**
   * Whether Home/End jump to the ends of the list. On by default.
   *
   * Off is for a list whose neighbour is a **live text editor** — `/connect`'s
   * filter is the one. The editor binds Home/End for the caret, and which of the
   * two claims the key is decided by binding **registration order**: a child that
   * is mounted once (the composer) registers before every face, but a child that
   * unmounts and remounts — the filter, whenever the overlay walks into a
   * provider's own step and back — re-registers *behind* the list's table. The
   * result is that the same key moves the caret before such a trip and jumps the
   * list after it. Leaving Home/End undeclared here makes the editor's claim
   * unconditional, whatever order the two ended up in.
   */
  edgeKeys?: boolean;
  /** Space toggles the item at the cursor (multi-select). */
  onToggle?: () => void;
  /** ←/→ move the item at the cursor (reorder). */
  onMoveItem?: (direction: "up" | "down") => void;
  /**
   * Keys the caller still owns — tabs, search, refresh, a sub-view's own Escape.
   * Kept at the head of the table, so a caller can claim a key the list would
   * otherwise take.
   */
  extra?: readonly KeyBinding[];
}

export function listBindings(host: ListBindingHost): KeyBinding[] {
  const count = Math.max(0, Math.trunc(host.count));
  const cursor = host.cursor;
  const rows = Math.max(1, Math.trunc(host.rows ?? DEFAULT_PAGE_ROWS));
  const navigation = host.navigationEnabled ?? true;
  const vim = host.vimKeys ?? true;
  const edges = host.edgeKeys ?? true;

  const bindings: KeyBinding[] = [...(host.extra ?? [])];

  const step = (delta: number): "consumed" | "declined" => {
    if (!navigation || count === 0) return "declined";
    host.onMoveCursor(moveCursor({ cursor, count, delta }));
    return "consumed";
  };

  const edge = (where: "start" | "end"): "consumed" | "declined" => {
    if (!navigation || count === 0) return "declined";
    host.onMoveCursor(edgeCursor(count, where));
    return "consumed";
  };

  bindings.push(
    {
      id: "overlay-list.up",
      chords: vim ? [{ key: "upArrow" }, { key: "k" }] : [{ key: "upArrow" }],
      run: () => step(-1),
    },
    {
      id: "overlay-list.down",
      chords: vim
        ? [{ key: "downArrow" }, { key: "j" }]
        : [{ key: "downArrow" }],
      run: () => step(1),
    },
    {
      id: "overlay-list.page-up",
      chords: [{ key: "pageUp" }],
      run: () => step(-rows),
    },
    {
      id: "overlay-list.page-down",
      chords: [{ key: "pageDown" }],
      run: () => step(rows),
    },
  );

  if (edges) {
    bindings.push(
      {
        id: "overlay-list.first",
        chords: [{ key: "home" }],
        run: () => edge("start"),
      },
      {
        id: "overlay-list.last",
        chords: [{ key: "end" }],
        run: () => edge("end"),
      },
    );
  }

  bindings.push(
    {
      id: "overlay-list.confirm",
      chords: [{ key: "return" }],
      run: () => {
        if (!host.onConfirm || !navigation || count === 0) return "declined";
        host.onConfirm();
        return "consumed";
      },
    },
    {
      id: "overlay-list.toggle",
      chords: [{ key: "space" }],
      run: () => {
        if (!host.onToggle || !navigation || count === 0) return "declined";
        host.onToggle();
        return "consumed";
      },
    },
    {
      id: "overlay-list.move-item-up",
      chords: [{ key: "leftArrow" }],
      run: () => {
        if (!host.onMoveItem || !navigation || count === 0) return "declined";
        host.onMoveItem("up");
        return "consumed";
      },
    },
    {
      id: "overlay-list.move-item-down",
      chords: [{ key: "rightArrow" }],
      run: () => {
        if (!host.onMoveItem || !navigation || count === 0) return "declined";
        host.onMoveItem("down");
        return "consumed";
      },
    },
  );

  if (host.onCancel) {
    const onCancel = host.onCancel;
    bindings.push({
      id: "overlay-list.cancel",
      chords: [{ key: "escape" }, { key: "c", ctrl: true }],
      run: () => {
        onCancel();
        return "consumed";
      },
    });
  }

  return bindings;
}
