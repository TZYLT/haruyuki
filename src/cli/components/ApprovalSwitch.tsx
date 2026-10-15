import { memo } from "react";
import { resolveApproval } from "@/cli/helpers/approval-info";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { InlineBashApproval } from "./InlineBashApproval";
import { InlineFileEditApproval } from "./InlineFileEditApproval";
import { InlineGenericApproval } from "./InlineGenericApproval";
import { InlineTaskApproval } from "./InlineTaskApproval";

type Props = {
  approval: ApprovalRequest;

  // Common handlers
  onApprove: (diffs?: Map<string, AdvancedDiffSuccess>) => void;
  onApproveAlways: (
    scope: "project" | "session",
    diffs?: Map<string, AdvancedDiffSuccess>,
  ) => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
  showPreview?: boolean;
  defaultScope?: "project" | "session";

  // External data for FileEdit approvals
  precomputedDiff?: AdvancedDiffSuccess;
  allDiffs?: Map<string, AdvancedDiffSuccess>;
};

/**
 * ApprovalSwitch - Unified approval component that renders the appropriate
 * specialized approval UI based on tool type.
 *
 * This consolidates the approval rendering logic that was previously duplicated
 * in the transcript rendering and fallback UI paths. The dispatch and the args
 * parsing live in `@/cli/helpers/approval-info` — `resolveApproval` is the single
 * decision, shared with the transcript row model, so the measured height matches
 * the approval that is on screen.
 */
export const ApprovalSwitch = memo(
  ({
    approval,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
    precomputedDiff,
    allDiffs,
    showPreview = true,
    defaultScope = "project",
  }: Props) => {
    const toolName = approval.toolName;
    // The dispatch and the args parsing are the row model's too: one call decides
    // which surface renders *and* hands over the fields it will render, so the
    // measured height cannot be computed from a different decision.
    const resolved = resolveApproval(approval);

    if (resolved.kind === "fileEdit") {
      return (
        <InlineFileEditApproval
          fileEdit={resolved.fileEdit}
          precomputedDiff={precomputedDiff}
          allDiffs={allDiffs}
          onApprove={(diffs) => onApprove(diffs)}
          onApproveAlways={(scope, diffs) => onApproveAlways(scope, diffs)}
          onDeny={onDeny}
          onCancel={onCancel}
          isFocused={isFocused}
          approveAlwaysText={approveAlwaysText}
          allowPersistence={allowPersistence}
          defaultScope={defaultScope}
          showPreview={showPreview}
        />
      );
    }

    if (resolved.kind === "shell") {
      return (
        <InlineBashApproval
          bashInfo={resolved.bash}
          onApprove={() => onApprove()}
          onApproveAlways={(scope) => onApproveAlways(scope)}
          onDeny={onDeny}
          onCancel={onCancel}
          isFocused={isFocused}
          approveAlwaysText={approveAlwaysText}
          allowPersistence={allowPersistence}
          defaultScope={defaultScope}
          showPreview={showPreview}
        />
      );
    }

    if (resolved.kind === "task") {
      return (
        <InlineTaskApproval
          taskInfo={resolved.task}
          onApprove={() => onApprove()}
          onApproveAlways={(scope) => onApproveAlways(scope)}
          onDeny={onDeny}
          onCancel={onCancel}
          isFocused={isFocused}
          approveAlwaysText={approveAlwaysText}
          allowPersistence={allowPersistence}
        />
      );
    }

    // Fallback → InlineGenericApproval
    return (
      <InlineGenericApproval
        toolName={toolName}
        toolArgs={approval.toolArgs}
        onApprove={() => onApprove()}
        onApproveAlways={(scope) => onApproveAlways(scope)}
        onDeny={onDeny}
        onCancel={onCancel}
        isFocused={isFocused}
        approveAlwaysText={approveAlwaysText}
        allowPersistence={allowPersistence}
        defaultScope={defaultScope}
        showPreview={showPreview}
      />
    );
  },
);

ApprovalSwitch.displayName = "ApprovalSwitch";
