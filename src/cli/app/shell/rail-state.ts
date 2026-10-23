// src/cli/app/shell/rail-state.ts

/**
 * Whether the band is drawing a rail **this frame**.
 *
 * The status line needs one bit from the shell — "is the rail on screen" — and a
 * behaviour hangs off it: `《32》§6.3` / `《38》§6` (「折叠后：只把 `ctx 62%` 降级进底部
 * 状态行」) says that when the rail folds, its context number moves to the bottom
 * row instead of simply vanishing (which is what it did while this bit was
 * missing — the number was the one thing in the rail that can page the user out).
 *
 * **A module store, not a context.** The reader is `buildDefaultStatuslineParts`,
 * a pure function called from inside the composer's memoised render body; making
 * it a component just to reach a hook would put a shell concept in the middle of
 * the composer, and `InputRich.tsx` is pinned at its line ceiling. The writer is
 * `V2Shell`, which already owns the geometry — it sets the bit during its own
 * render, so the status line below it reads the value of the **same** frame. The
 * append shell never writes it, so the default (`true` = "no fold") keeps legacy
 * exactly as frozen.
 *
 * The default is `true` for the same reason: a tree that never declares a fold is
 * not folding, and a chip that appeared in legacy would be a new behaviour in the
 * shell that must not gain any.
 */
let railIsDrawn = true;

/** Called by the full-screen shell with `geometry.railWidth > 0`. */
export function setRailDrawn(value: boolean): void {
  railIsDrawn = value;
}

/** True when the rail is on screen, or when no shell has said otherwise. */
export function isRailDrawn(): boolean {
  return railIsDrawn;
}

/** Reset for the tests that switch shells in one process. */
export function resetRailStateForTests(): void {
  railIsDrawn = true;
}
