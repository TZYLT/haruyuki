/**
 * The one reminder the parent conversation sees while a reflection run owns its
 * memory repository (F-03 §5.7.1: one "start" and one "end", never repeated).
 *
 * This shape is a **frozen seam** between two owners: the reminder engine that
 * renders it and the post-turn trigger that decides whether a notice is due.
 * It lives in `types/` so neither side has to import the other's module, and so
 * the field set cannot drift between the two while both are being built.
 *
 * Not to be confused with the run record (`agent/reflection-run.ts`): that is
 * the authority on "is a run active", this is only what the parent is told.
 */
export type ReflectionRunNoticePhase = "start" | "end";

export interface PendingReflectionRunNotice {
  /** `start` while the run owns the repository, `end` once it released it. */
  phase: ReflectionRunNoticePhase;
  /** Run id, so the notice and the log line can be tied together. */
  runId?: string;
  /** Set on the `end` notice when the run ended by deadline rather than finishing. */
  timedOut?: boolean;
}
