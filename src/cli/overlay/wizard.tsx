import { useCallback, useState } from "react";
import { type KeyBinding, namedKeyChords } from "@/cli/helpers/input-keys";

/**
 * Multi-step overlays: the return stack, and the two keys that leave a step.
 *
 * Six overlays in this tree walk a sequence of screens by hand — `/connect`'s
 * seven (`list`, `input`, `methodSelect`, `profileSelect`, `multiInput`,
 * `options`, `oauthNameInput`), `/hooks`'s six, `/recall`'s three, `/mcp`'s
 * three, `/compaction`'s two, `/pin`'s two — and every one of them re-derives
 * the same two answers: *where does Escape go from here*, and *what does Escape
 * mean when there is nowhere left to go*. They were written as a ladder of
 * `if (screen === ...)` inside one `useInput`, which is exactly the shape that
 * made "who owns this key" unanswerable by reading one file.
 *
 * So the trail lives here as a value (`wizardForward`, `wizardBack`,
 * `wizardPopTo`) and the keys live here as a table (`wizardBindings`), with the
 * one rule that was never written down stated once: **Escape goes back one
 * step, and at the root it cancels.** Ctrl+C always cancels, from every step.
 *
 * Two things are deliberately *not* here, because they were not uniform:
 *
 * - A face whose **root** step wants Escape to do something first (the
 *   `/connect` list clears its filter before it will cancel) passes that
 *   binding in `extra`, at the head of the table, and lets it return
 *   `declined` — the router then falls through to the rule above. That is the
 *   same head-of-table seam `list-bindings.ts` documents, used for the same
 *   reason.
 * - A step that has to reset one of its own fields on the way out passes its own
 *   `onBack` to `wizardBindings`, which is where that field gets cleared. The
 *   stack never knows about a step's state.
 *
 * The trail arithmetic is the pure half, so the rule above is a unit test
 * instead of a rendered assertion.
 */

/** Where an overlay has been, root first, and where it is now. */
export interface WizardTrail<Id extends string> {
  /** Every step visited, root first. Never empty. */
  trail: readonly Id[];
  /** The step on screen: the last one pushed. */
  step: Id;
  /** Whether Escape has a step to return to. False at the root. */
  canGoBack: boolean;
}

/**
 * Walk forward. Going to the step already on screen is not a push: a face that
 * re-enters the view it is showing (a picker rebuilt from a refreshed source, a
 * confirmation reopened on the row under the cursor) must not leave a duplicate
 * behind for Escape to walk back through.
 */
export function wizardForward<Id extends string>(
  trail: readonly Id[],
  id: Id,
): readonly Id[] {
  if (trail[trail.length - 1] === id) return trail;
  return [...trail, id];
}

/**
 * Pop one step. The root is never popped: a trail of one *is* the overlay, and
 * dropping it would leave the face rendering a step that was never pushed. It
 * is the identity there, and `wizardBindings` turns that identity into "cancel"
 * — which is what every hand-written ladder in this tree already did.
 */
export function wizardBack<Id extends string>(
  trail: readonly Id[],
): readonly Id[] {
  return trail.length <= 1 ? trail : trail.slice(0, -1);
}

/**
 * Drop steps until `id` is on top again, keeping it. This is how a step that
 * *finishes* a sub-flow returns to where it started (`/hooks` adds a hook from
 * a five-deep trail and lands back on the hook list, not on the root) without
 * collapsing the steps below it — the user's Escape from there still walks back
 * the way they came.
 *
 * A trail that never visited `id` is returned unchanged: a face asking to pop
 * to a step it did not push is a bug in the face, and silently collapsing the
 * trail to that step would hide it behind a working-looking screen.
 */
export function wizardPopTo<Id extends string>(
  trail: readonly Id[],
  id: Id,
): readonly Id[] {
  const at = trail.lastIndexOf(id);
  return at < 0 ? trail : trail.slice(0, at + 1);
}

/** What the wizard's two keys need from the face. */
export interface WizardKeyHost {
  /** Whether Escape has a step to return to. */
  canGoBack: boolean;
  /** Escape with somewhere to go. The face resets its own step state here. */
  onBack: () => void;
  /** Escape at the root, and Ctrl+C from any step. */
  onCancel: () => void;
  /** Keys the face owns ahead of these; a root step's own Escape goes here. */
  extra?: readonly KeyBinding[];
}

/**
 * The keys that leave a step: Escape (back, or cancel at the root) and Ctrl+C
 * (always cancel).
 *
 * Escape is never declined, for the reason `list-bindings.ts` gives about its
 * own cancel: an overlay that cannot be left is a trap. The two are separate
 * bindings rather than one chord list because they are not the same action —
 * a face that reports "back" cannot tell the user that they closed the overlay.
 */
export function wizardBindings(host: WizardKeyHost): KeyBinding[] {
  return [
    ...(host.extra ?? []),
    {
      id: "overlay-wizard.back",
      chords: namedKeyChords("escape"),
      run: () => {
        if (host.canGoBack) {
          host.onBack();
        } else {
          host.onCancel();
        }
        return "consumed";
      },
    },
    {
      id: "overlay-wizard.cancel",
      chords: [{ key: "c", ctrl: true }],
      run: () => {
        host.onCancel();
        return "consumed";
      },
    },
  ];
}

export interface UseWizardOptions<Id extends string> {
  /** The root step. The overlay opens here. */
  initial: Id;
}

export interface WizardController<Id extends string> extends WizardTrail<Id> {
  /** Walk forward to a step. */
  goTo: (id: Id) => void;
  /** Pop one step. The caller has already checked `canGoBack`. */
  back: () => void;
  /** Drop steps until `id` is on top. See `wizardPopTo`. */
  popTo: (id: Id) => void;
}

/**
 * The trail as React state.
 *
 * `goTo`/`back`/`popTo` are stable across renders and use the functional state
 * update, so a key handler closing over them cannot pop from a stale trail —
 * which matters here more than usual, because two of these faces walk several
 * steps inside one handler (`/hooks` lands on the hook list from four steps
 * deep when an add succeeds).
 *
 * It does **not** claim an input scope: this hook binds nothing. The face
 * composes `wizardBindings` into its own table, and the frame it renders claims
 * the scope (`frame.tsx` rule).
 */
export function useWizard<Id extends string>(
  options: UseWizardOptions<Id>,
): WizardController<Id> {
  const { initial } = options;
  const [trail, setTrail] = useState<readonly Id[]>(() => [initial]);

  const goTo = useCallback((id: Id) => {
    setTrail((prev) => wizardForward(prev, id));
  }, []);
  const back = useCallback(() => {
    setTrail(wizardBack);
  }, []);
  const popTo = useCallback((id: Id) => {
    setTrail((prev) => wizardPopTo(prev, id));
  }, []);

  return {
    trail,
    step: trail[trail.length - 1] ?? initial,
    canGoBack: trail.length > 1,
    goTo,
    back,
    popTo,
  };
}
