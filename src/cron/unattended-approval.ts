/**
 * The unattended-approval policy (F-05 Q-51), pure and dependency-free.
 *
 * A scheduled run has nobody at the keyboard, so every `ask` becomes a denial
 * instead of a pending approval request. The rule is a pure function so the
 * permission checker can call it where the decision is produced
 * (`permissions/checker.ts`) and the policy tests can exercise it without a
 * turn — one rule, no inline copy to drift from (F-05 M2 F14).
 *
 * This module deliberately imports nothing: `permissions/` may import it
 * without dragging the scheduler's backend/CLI dependencies into the
 * permission layer. `cron/task-run.ts` re-exports it for compatibility.
 */

/** The checker's decision vocabulary, narrowed to what this rule consumes. */
export type PermissionDecisionLike = "allow" | "deny" | "ask" | "alwaysAsk";

export interface UnattendedApprovalDecision {
  decision: "allow" | "deny";
  reason?: string;
}

/** Deny every human prompt; pass an explicit allow/deny through unchanged. */
export function resolveUnattendedApproval(
  decision: PermissionDecisionLike,
  reason = "unattended",
): UnattendedApprovalDecision {
  if (decision === "ask" || decision === "alwaysAsk") {
    return { decision: "deny", reason };
  }
  return decision === "allow" ? { decision: "allow" } : { decision: "deny" };
}
