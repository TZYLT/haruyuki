import type { EventEmitter } from "node:events";
import { useInput, useStdin } from "ink";
import { useEffect, useRef } from "react";
import { acquireInputScope } from "@/cli/helpers/focus-ledger";
import type { InputScope, KeyBindingTable } from "@/cli/helpers/input-keys";
import {
  installInputRouter,
  registerBindingOwner,
  routeKeyEvent,
} from "@/cli/helpers/input-router";

/**
 * The imperative half of the input router (the declarative half is `keymap.ts`):
 * installs the raw shield, adds the `useInput` fallback for sequences the shield
 * does not read, and lets components register binding tables.
 */

/**
 * Ink 7 narrows `useStdin()`'s public type to `PublicProps`; the runtime context
 * still carries `internal_eventEmitter` (and `useInput` reads it from there).
 */
function useInternalEventEmitter(): EventEmitter | undefined {
  const { internalEventEmitter } = useStdin() as unknown as {
    internalEventEmitter?: EventEmitter;
  };
  return internalEventEmitter;
}

/**
 * Mounts the router. Must be mounted **once** (the app root): a second mount
 * would route every fallback event twice.
 */
export function useInputRouter(): void {
  const internalEventEmitter = useInternalEventEmitter();

  useEffect(() => {
    if (!internalEventEmitter) return undefined;
    return installInputRouter(internalEventEmitter);
  }, [internalEventEmitter]);

  // The fallback. Everything the shield did not claim arrives here with Ink's
  // own parse, so an unusual terminal encoding still reaches its binding instead
  // of being dropped. If a binding consumes it, the legacy handlers have already
  // been offered the event — which is why the table owns each of its keys
  // exclusively and no legacy handler still binds one.
  useInput((input, key) => {
    routeKeyEvent({ input, key });
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
  const tablesRef = useRef(tables);
  useEffect(() => {
    tablesRef.current = tables;
  });
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
