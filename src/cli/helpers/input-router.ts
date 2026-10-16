import type { EventEmitter } from "node:events";
import { consultedInputScopes } from "./focus-ledger";
import type { KeyBinding, KeyBindingTable, KeyEvent } from "./input-keys";
import { describeChord, matchingBindings } from "./input-keys";
import {
  filterRawInput,
  noteModifiedEnter,
  shieldKeyEvent,
} from "./input-sequence";
import { disarmLeader, isLeaderArmed } from "./leader";
import { routeMouseReport } from "./mouse-router";
import { parseMouseReport } from "./mouse-sequence";

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

interface BindingSource {
  /** The component's own id, for diagnostics. Not a key: see `registerBindingOwner`. */
  owner: string;
  tables: () => readonly KeyBindingTable[];
}

/**
 * Binding tables by registration, in mount order.
 *
 * Keyed by a unique token rather than by the owner id, because one owner id can
 * be mounted more than once at a time: the composer and every overlay input are
 * the same component (`PasteAwareTextInput`), so opening a selector mounts a
 * second `composer-input` next to the always-mounted composer. Keying by the id
 * made the overlay's unmount delete the entry the composer had registered
 * minutes earlier — with the composer's editing keys (Option+Arrow, Ctrl+W,
 * Home/End, modified Enter) silently dead for the rest of the session, since a
 * registration is never rebuilt while its component stays mounted.
 */
const bindingSources = new Map<symbol, BindingSource>();

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

/**
 * Set while the router is dispatching an event it did not consume itself.
 *
 * Only that dispatch may be routed by the fallback (the `useInput` path), and
 * `fallbackConsumed` makes sure several installed fallbacks route it once. Both
 * are cleared when the dispatch returns, so an event can never leave routing
 * disarmed for the next one.
 */
let fallbackArmed = false;
let fallbackConsumed = false;

/** Registers a component's binding tables. Call the result on unmount. */
export function registerBindingOwner(
  owner: string,
  source: () => readonly KeyBindingTable[],
): () => void {
  const token = Symbol(owner);
  bindingSources.set(token, { owner, tables: source });
  return () => {
    bindingSources.delete(token);
  };
}

/** Test seam: drop every registered owner. */
export function resetBindingOwners(): void {
  bindingSources.clear();
  fallbackArmed = false;
  fallbackConsumed = false;
}

/** The owners currently registered, for diagnostics and conflict tests. */
export function registeredBindingOwners(): string[] {
  return [...bindingSources.values()].map((entry) => entry.owner);
}

function bindingsForScope(
  scope: KeyBindingTable["scope"],
  options?: { leaderOnly?: boolean },
): KeyBinding[] {
  const bindings: KeyBinding[] = [];
  for (const { tables } of bindingSources.values()) {
    for (const table of tables()) {
      if (table.scope !== scope) continue;
      for (const binding of table.bindings) {
        if (options?.leaderOnly && binding.leader !== true) continue;
        if (!options?.leaderOnly && binding.leader === true) continue;
        bindings.push(binding);
      }
    }
  }
  return bindings;
}

/**
 * The leader entries that are currently registered, for the which-key hint.
 *
 * Read from the bindings rather than declared next to the hint: an entry added
 * where its behaviour lives shows up here on its own, which is the property the
 * command palette (M6) needs when it fills this table from the command registry.
 */
export function leaderEntries(): {
  id: string;
  keys: string[];
  label?: string;
}[] {
  const entries: { id: string; keys: string[]; label?: string }[] = [];
  for (const scope of consultedInputScopes()) {
    for (const binding of bindingsForScope(scope, { leaderOnly: true })) {
      entries.push({
        id: binding.id,
        keys: (binding.chords ?? []).map(describeChord),
        label: binding.label,
      });
    }
  }
  return entries;
}

/**
 * Route an event Ink parsed.
 *
 * This is the fallback path: sequences the raw layer did not read itself arrive
 * here with Ink's parse, so an unusual terminal encoding still reaches its
 * binding instead of being dropped. Every component that installs the router
 * adds one `useInput` fallback; the arm/consumed pair makes them route the
 * dispatch once between them, and only while the router is dispatching it.
 */
export function routeFallbackEvent(event: KeyEvent): void {
  if (!fallbackArmed || fallbackConsumed) return;
  if (routeKeyEvent(event)) fallbackConsumed = true;
}

/**
 * Route an already-parsed key event. Returns true when a binding consumed it.
 *
 * Called from both ends: the raw layer (for sequences it read itself) and the
 * `useInput` fallback (for everything Ink parsed).
 *
 * An armed leader prefix takes the key first, and takes it *instead of* the
 * ordinary tables rather than in addition to them: the second key of the prefix
 * has no meaning on its own (`?` would otherwise be typing). A key the prefix
 * does not know disarms it and then continues down the normal path, so a stray
 * `Ctrl+X` costs the next keystroke nothing.
 *
 * The prefix is left **before** its entry runs, not after. An entry is allowed to
 * re-arm on purpose — `?` (the help list) does exactly that, so the list stays
 * open while the user reads it and picks a key from it — and disarming afterwards
 * would erase the re-arm in the same keystroke. That is not a hypothetical: it is
 * why the help entry ran, notified, and still showed nothing, leaving the hint
 * line gone and no list behind it.
 */
export function routeKeyEvent(event: KeyEvent): boolean {
  // Linux terminals report Enter as LF, which Ink does not flag as `return`; the
  // echo a modified Enter can be followed by is dropped before it gets here. This
  // is the one place every routed event passes through, so it is where the flag
  // that suppresses that echo is armed.
  noteModifiedEnter(event);
  if (isLeaderArmed()) {
    if (event.key.escape === true) {
      // Escape leaves the prefix and stops there: the user asked to get out, not
      // to interrupt the turn that is running behind it.
      disarmLeader();
      return true;
    }
    disarmLeader();
    const consumed = routeScopes(event, { leaderOnly: true });
    if (consumed) return true;
  }
  return routeScopes(event);
}

function routeScopes(
  event: KeyEvent,
  options?: { leaderOnly?: boolean },
): boolean {
  for (const scope of consultedInputScopes()) {
    const bindings = bindingsForScope(scope, options);
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
 *
 * `platform` selects the host's raw-payload rules (`input-sequence.ts`). It is a
 * parameter so the Linux Enter behaviour is testable from any machine, and it is
 * read when the wrapper is created — the first installation on an emitter wins,
 * which is fine because production always passes the default.
 */
export function installInputRouter(
  emitter: EventEmitter,
  platform: string = process.platform,
): () => void {
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
    let payload = raw;
    if (raw !== null) {
      payload = filterRawInput(raw, platform);
      // A dropped payload is the terminal echoing a keystroke already delivered.
      if (payload === null) return true;
      // Mouse reports are read here, before the key path, and are spent here
      // whether or not anything acts on them. Ink has no mouse API: an unread
      // report is not ignored, it is *typed* — a wheel notch or a click lands in
      // the draft as `[<0;10;5M`. Claiming the exact shapes keeps that from
      // happening even when reporting is off and a stray report arrives late.
      const mouse = parseMouseReport(payload);
      if (mouse) {
        routeMouseReport(mouse);
        return true;
      }
      const claimed = shieldKeyEvent(payload);
      if (claimed && routeKeyEvent(claimed)) return true;
    }
    const dispatched =
      payload !== null && payload !== raw ? [payload, ...args.slice(1)] : args;
    forwarding = true;
    fallbackArmed = true;
    fallbackConsumed = false;
    try {
      return originalEmit.apply(this, [type, ...dispatched] as never);
    } finally {
      forwarding = false;
      fallbackArmed = false;
      fallbackConsumed = false;
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
