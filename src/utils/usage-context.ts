/**
 * What one provider request was made of, in estimated tokens.
 *
 * Layer: `utils/` (bottom) because three owners speak it — the backend that can
 * actually measure the serialized request, the drain that carries the number to
 * the TUI, and the ledger that stores it per turn.
 *
 * `system` **includes memory locally**: core memory is compiled into the system
 * prompt before the request is built, so it cannot be separated afterwards. The
 * Usage screen says so rather than inventing a memory row it cannot measure.
 *
 * These are estimates (4 bytes per token, the same heuristic the context floor
 * uses), which is why the screens label them with `~` and never mix them into a
 * measured total.
 */
export interface UsageContextBreakdown {
  system: number;
  messages: number;
  tools: number;
}

/**
 * The label the Usage screen and the rail print for the `system` component
 * (T-05/T-06, 47-2 §2.3): memory is compiled into the system prompt locally, so
 * the honest name is `sys+mem` and the separate "memory is included" note goes
 * away (R-05.5 / R-06.6). Both owners import this constant instead of spelling
 * the string twice.
 */
export const CONTEXT_SYSTEM_LABEL = "sys+mem";

/** The component keys, in the order the screens print them. */
export type UsageContextComponentKey = "system" | "tools" | "messages";

/** One labelled component of the request, as the screens draw it. */
export interface UsageContextComponent {
  key: UsageContextComponentKey;
  label: string;
  tokens: number;
}

/**
 * The request's components, labelled and ordered for display (R-05.5).
 *
 * The order is the spec's: `sys+mem`, `tools`, `messages`. It is a function
 * rather than two literals in the page and the rail so the label (`sys+mem`,
 * not `system`) and the order cannot drift between them — the rail is T-06's,
 * but it reads this module for the same reason the page does.
 */
export function contextComponents(
  breakdown: UsageContextBreakdown,
): readonly UsageContextComponent[] {
  return [
    { key: "system", label: CONTEXT_SYSTEM_LABEL, tokens: breakdown.system },
    { key: "tools", label: "tools", tokens: breakdown.tools },
    { key: "messages", label: "messages", tokens: breakdown.messages },
  ];
}

/** Sum of the parts, which is what the context window is compared against. */
export function contextBreakdownTotal(
  breakdown: UsageContextBreakdown,
): number {
  return breakdown.system + breakdown.messages + breakdown.tools;
}

/**
 * The denominator a component's percentage is divided by (R-05.6).
 *
 * Not the sum of the three components: the "total" the screen shows is the
 * provider-reported occupancy (`context_tokens`, the same number the rail's
 * `ctx%` uses — R-05.4/Q-19), and the estimate is only supposed to *approach*
 * it. Dividing by the sum would force the three shares to total 100% by
 * construction, hiding exactly the error the `~` is there to admit. When the row
 * has no provider total (an old ledger row, or a turn the provider gave no
 * occupancy for), the sum is the only denominator available.
 *
 * A non-positive or non-finite provider value is not a denominator; fall back to
 * the sum instead of dividing by zero.
 */
export function contextShareDenominator(
  breakdown: UsageContextBreakdown,
  contextTokens?: number,
): number {
  if (
    contextTokens !== undefined &&
    Number.isFinite(contextTokens) &&
    contextTokens > 0
  ) {
    return contextTokens;
  }
  return contextBreakdownTotal(breakdown);
}
