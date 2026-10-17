import { INPUT_SCOPE_PRIORITY, type InputScope } from "./input-keys";

/**
 * Who owns the keyboard right now.
 *
 * Ink fans one stdin event out to every `useInput` listener and offers no way to
 * stop propagation, so arbitration has to happen before a key reaches a handler
 * — in the single input router. This store is the router's map of the priority
 * chain: an exclusive modal (an approval, a mod dialog, a profile confirmation),
 * an overlay (a selector or dialog route is open), the app layer (composer plus
 * transcript shortcuts), and a system layer that stays reachable regardless.
 *
 * It is a plain module store rather than React state on purpose: adding state
 * that updates on keystroke, timer, or stream input to `AppCoordinator` is the
 * one thing the TUI guidance forbids, and the router only needs to read the
 * answer at event time, never to re-render from it.
 */
const owners = new Map<InputScope, number>();

/**
 * Marks a scope as owning input. Ref-counted, because several components share
 * a scope (the composer and the transcript both live in `app`, and more than one
 * thing can be an exclusive modal). Call the returned function on unmount.
 */
export function acquireInputScope(scope: InputScope): () => void {
  owners.set(scope, (owners.get(scope) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (owners.get(scope) ?? 1) - 1;
    if (remaining <= 0) {
      owners.delete(scope);
    } else {
      owners.set(scope, remaining);
    }
  };
}

/**
 * The highest-priority scope that has claimed input. `app` is the default owner
 * when nothing else has, so the working set never depends on a registration
 * having happened.
 */
export function owningInputScope(): InputScope {
  for (const scope of INPUT_SCOPE_PRIORITY) {
    if (scope === "system") continue;
    if ((owners.get(scope) ?? 0) > 0) return scope;
  }
  return "app";
}

/**
 * The scopes a key event may be routed to, in priority order: the owner, then
 * the system layer only. A key the owner does not bind falls through to the
 * legacy handlers rather than down the chain, so an overlay that still owns its
 * keys through Ink cannot be shadowed by an app-level binding.
 *
 * `owningInputScope()` never returns `system` (the system layer claims no keys), so
 * `system` is always the second entry rather than a case of its own.
 */
export function consultedInputScopes(): readonly InputScope[] {
  return [owningInputScope(), "system"];
}

/** Test seam: drop every claim. */
export function resetInputScopes(): void {
  owners.clear();
}
