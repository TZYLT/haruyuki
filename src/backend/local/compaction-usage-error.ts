/**
 * The tokens a failed or cancelled compaction run already spent (§5.14).
 *
 * A run's usage is normally read from the preview it produced. A run that threw
 * produced no preview, yet the spend is real — a summarizer that burned 40k
 * prompt tokens before the user pressed Esc is exactly the case a usage view
 * exists for. The numbers are computed inside the summarizer's call ladder, so
 * they have to travel *on the error*; no caller can recompute them.
 *
 * A `WeakMap` rather than a property on the error: the error object may be the
 * provider layer's own (it inspects `name`/`message`/`usage`), and this must not
 * change what it is. The entry disappears with the error, so a long-lived
 * process accumulates nothing.
 */
import type { CompactUsage } from "./compaction-preview";

const spentUsageByError = new WeakMap<object, CompactUsage>();

/** Attach the spend to the error that carries it up, without changing its type. */
export function withCompactUsage<T>(error: T, usage: CompactUsage): T {
  if (typeof error === "object" && error !== null) {
    spentUsageByError.set(error, usage);
  }
  return error;
}

/** The spend carried by a thrown run, or `undefined` when it is unknown. */
export function compactUsageOf(error: unknown): CompactUsage | undefined {
  return typeof error === "object" && error !== null
    ? spentUsageByError.get(error)
    : undefined;
}
