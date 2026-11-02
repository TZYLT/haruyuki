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
 * uses), which is why the screen labels them as such.
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

/** Sum of the parts, which is what the context window is compared against. */
export function contextBreakdownTotal(
  breakdown: UsageContextBreakdown,
): number {
  return breakdown.system + breakdown.messages + breakdown.tools;
}
