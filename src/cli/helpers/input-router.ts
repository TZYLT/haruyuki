import type { EventEmitter } from "node:events";
import { consultedInputScopes } from "./focus-ledger";
import type { KeyBinding, KeyBindingTable, KeyEvent } from "./input-keys";
import { matchingBindings } from "./input-keys";
import { shieldKeyEvent } from "./input-sequence";

/**
 * The app's single input router.
 *
 * **Why it intercepts `emit`.** Ink fans one stdin event out to every `useInput`
 * listener through an event emitter and offers no stopPropagation: ordering a
 * listener first (`prependListener`) changes *when* it runs, not whether the rest
 * still run, because the emitter hands the event to all of them. The only seam
 * that can actually keep a key away from the legacy handlers is the dispatch
 * itself, so the router wraps `internal_eventEmitter.emit` for the `input`
 * channel (the same private object the codebase already depends on for raw
 * sequences), routes the event, and either returns without dispatching —
 * swallowing it — or dispatches normally. The original `emit` is restored on
 * release, and every visible effect is local to that emitter instance.
 *
 * The route itself is declarative: tables from `keymap.ts`, priority chain from
 * `focus-ledger.ts`. Two kinds of event reach the router:
 *
 * 1. Sequences `input-sequence.ts` reads on its own (single characters, plus an
 *    exact table of the multi-character sequences the app binds). When a binding
 *    consumes one, it is swallowed.
 * 2. Anything else is dispatched unchanged and re-routed by the router's own
 *    `useInput` fallback (see `use-cli-input-router`), which sees Ink's parse.
 *    The key still works; it is simply not shielded from legacy handlers, which
 *    is exactly why every chord in the table had to be taken away from the
 *    legacy handler that used to own it. An unfamiliar terminal encoding thus
 *    degrades to "works, unshielded" instead of "silently dropped".
 */

/** Binding tables by owner id. Owners are components; order is mount order. */
const bindingSources = new Map<string, () => readonly KeyBindingTable[]>();

/** Live routers, one wrapper per emitter no matter how many callers install. */
const installations = new WeakMap<
  EventEmitter,
  {
    count: number;
    originalEmit: EventEmitter["emit"];
    wrapper: EventEmitter["emit"];
  }
>();

let forwarding = false;

/** Registers a component's binding tables. Call the result on unmount. */
export function registerBindingOwner(
  owner: string,
  source: () => readonly KeyBindingTable[],
): () => void {
  bindingSources.set(owner, source);
  return () => {
    if (bindingSources.get(owner) === source) bindingSources.delete(owner);
  };
}

/** Test seam: drop every registered owner. */
export function resetBindingOwners(): void {
  bindingSources.clear();
}

function bindingsForScope(scope: KeyBindingTable["scope"]): KeyBinding[] {
  const bindings: KeyBinding[] = [];
  for (const source of bindingSources.values()) {
    for (const table of source()) {
      if (table.scope === scope) bindings.push(...table.bindings);
    }
  }
  return bindings;
}

/**
 * Route an already-parsed key event. Returns true when a binding consumed it.
 *
 * Called from both ends: the raw layer (for sequences it read itself) and the
 * `useInput` fallback (for everything Ink parsed).
 */
export function routeKeyEvent(event: KeyEvent): boolean {
  for (const scope of consultedInputScopes()) {
    const bindings = bindingsForScope(scope);
    if (bindings.length === 0) continue;
    for (const binding of matchingBindings(bindings, event)) {
      if (binding.run(event) === false) continue;
      return true;
    }
  }
  return false;
}

function inputPayloadToString(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as { sequence?: unknown }).sequence === "string"
  ) {
    return (payload as { sequence: string }).sequence;
  }
  return null;
}

/**
 * Re-inject an event into the normal Ink path. Used by the composer's paste
 * forwarder, where a paste must reach whichever input holds focus; a direct
 * `emit` would be routed twice (once by the router, once by the caller).
 */
export function forwardInputEvent(
  emitter: EventEmitter | undefined,
  raw: string,
): void {
  if (!emitter || forwarding) return;
  forwarding = true;
  try {
    emitter.emit("input", raw);
  } finally {
    forwarding = false;
  }
}

/**
 * Installs the router on an emitter. Idempotent; the last release restores the
 * original `emit`.
 */
export function installInputRouter(emitter: EventEmitter): () => void {
  const existing = installations.get(emitter);
  if (existing) {
    existing.count += 1;
    return () => releaseInputRouter(emitter);
  }

  const originalEmit = emitter.emit;
  const wrapper: EventEmitter["emit"] = function (
    this: EventEmitter,
    type: string | symbol,
    ...args: unknown[]
  ) {
    if (type !== "input" || forwarding) {
      return originalEmit.apply(this, [type, ...args] as never);
    }
    const raw = inputPayloadToString(args[0]);
    if (raw !== null) {
      const claimed = shieldKeyEvent(raw);
      if (claimed && routeKeyEvent(claimed)) return true;
    }
    forwarding = true;
    try {
      return originalEmit.apply(this, [type, ...args] as never);
    } finally {
      forwarding = false;
    }
  };

  installations.set(emitter, { count: 1, originalEmit, wrapper });
  emitter.emit = wrapper;
  return () => releaseInputRouter(emitter);
}

function releaseInputRouter(emitter: EventEmitter): void {
  const installation = installations.get(emitter);
  if (!installation) return;
  installation.count -= 1;
  if (installation.count > 0) return;
  installations.delete(emitter);
  if (emitter.emit === installation.wrapper) {
    emitter.emit = installation.originalEmit;
  }
}
