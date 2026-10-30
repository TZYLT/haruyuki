/**
 * Dream pressure reader (F-06 M2, route §2.3.5 S3).
 *
 * `src/dream-budget-math.ts` owns the formula; this module owns the inputs —
 * the agent's usage interval plus the memFS delta — and must stay synchronous
 * because `DreamSignalDeps.readPressure` is called inside a scheduler tick.
 *
 * L0 stub: returns `0` (below every threshold) so the signal never fires until
 * M2 lands. The signature is frozen and only the Lead may change it.
 */

/** Current dream pressure for an agent; `0` when there is no usage to read. */
export function readDreamPressure(_agentId: string, _now?: Date): number {
  // Filled in by M2.
  return 0;
}
