import { useInput } from "ink";
import { useEffect, useRef } from "react";
import { acquireInputScope } from "@/cli/helpers/focus-ledger";
import type { InputScope, KeyBindingTable } from "@/cli/helpers/input-keys";
import {
  installInputRouter,
  registerBindingOwner,
  routeFallbackEvent,
} from "@/cli/helpers/input-router";
import { useInternalEventEmitter } from "@/cli/hooks/use-internal-event-emitter";

/**
 * The imperative half of the input router (the declarative half is `keymap.ts`):
 * installs the raw router, adds the `useInput` fallback for sequences the router
 * does not read itself, and lets components register binding tables.
 */

/**
 * Mounts the router. The app root calls it once; a component that registers
 * bindings also installs it, so a component rendered on its own (a focused test)
 * behaves exactly as it does in the app. Installation is idempotent per emitter.
 */
export function useInputRouter(): void {
  const internalEventEmitter = useInternalEventEmitter();

  useEffect(() => {
    if (!internalEventEmitter) return undefined;
    return installInputRouter(internalEventEmitter);
  }, [internalEventEmitter]);

  // The fallback. Everything the raw layer did not claim arrives here with Ink's
  // own parse, so an unusual terminal encoding still reaches its binding instead
  // of being dropped. If a binding consumes it, the legacy handlers have already
  // been offered the event — which is why the table owns each of its keys
  // exclusively and no legacy handler still binds one.
  useInput((input, key) => {
    routeFallbackEvent({ input, key });
  });
}

/**
 * Registers a component's key tables with the router.
 *
 * The tables are read at event time through a ref, so a handler always sees the
 * latest render's closures without the registration being torn down and rebuilt
 * on every render. Bindings are gated by the focus ledger, not by a React state
 * update: this hook adds no render-triggering state.
 */
export function useKeyBindings(
  owner: string,
  tables: readonly KeyBindingTable[],
): void {
  // A component that binds keys installs the router itself, so it works when it
  // is rendered on its own (a focused component test) exactly as it does in the
  // app. Installation is ref-counted per emitter, and the fallback dedupes per
  // dispatch, so extra installations cost nothing.
  useInputRouter();
  const tablesRef = useRef(tables);
  // Assigned during render, not in an effect: a key handler must see the closures
  // of the render that is on screen, and Ink's own `useInput` gives its callbacks
  // the same freshness (it wraps them in `useEffectEvent`). The codebase already
  // uses this latest-value ref pattern for input state.
  tablesRef.current = tables;
  useEffect(() => {
    return registerBindingOwner(owner, () => tablesRef.current);
  }, [owner]);
}

/**
 * Claims input for a scope while `active` (and releases it on unmount or when the
 * claim ends). Ref-counted per scope, so several components can share one: the
 * composer and the transcript both live in `app`, and more than one thing can be
 * an exclusive modal.
 */
export function useInputScopeClaim(scope: InputScope, active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    return acquireInputScope(scope);
  }, [scope, active]);
}
