import type { EventEmitter } from "node:events";
import { useStdin } from "ink";

/**
 * Ink's private input emitter.
 *
 * Ink 7 narrows `useStdin()`'s public type to `PublicProps`, but the runtime
 * context still carries the emitter every `useInput` handler subscribes to
 * (Ink names it `internal_eventEmitter`, with an underscore). The input router
 * needs that exact object — it is the only seam where a key can be kept from the
 * legacy `useInput` handlers.
 *
 * It lives in one module on purpose: reading the private name through a cast
 * means a typo produces `undefined` and silently disables the router instead of
 * failing to compile, so there must be exactly one place that spells it.
 *
 * Ink's `StdinContext` default value already supplies an emitter, so the runtime
 * object always has one; the type is derived from the cast rather than from Ink's
 * narrowed public props.
 */
export function useInternalEventEmitter(): EventEmitter {
  const context = useStdin() as unknown as {
    internal_eventEmitter: EventEmitter;
  };
  return context.internal_eventEmitter;
}
