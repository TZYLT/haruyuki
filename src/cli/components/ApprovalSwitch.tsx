import { memo } from "react";
import {
  getBashApprovalInfo,
  getFileEditApprovalInfo,
  getTaskApprovalInfo,
  isCommandMonitorApproval,
} from "@/cli/helpers/approval-info";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping.js";
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
 * parsing live in `@/cli/helpers/approval-info`, shared with the transcript row
 * model so the measured height matches the approval that is on screen.
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

    // File edit/write/patch tools → InlineFileEditApproval
    if (
      isFileEditTool(toolName) ||
      isFileWriteTool(toolName) ||
      isPatchTool(toolName)
    ) {
      const fileEditInfo = getFileEditApprovalInfo(approval);
      if (fileEditInfo) {
        return (
          <InlineFileEditApproval
            fileEdit={fileEditInfo}
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
    }

    // Shell/Bash tools → InlineBashApproval
    if (isShellTool(toolName) || isCommandMonitorApproval(approval)) {
      const bashInfo = getBashApprovalInfo(approval);
      if (bashInfo) {
        return (
          <InlineBashApproval
            bashInfo={bashInfo}
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
    }

    // Task tool → InlineTaskApproval
    if (isTaskTool(toolName)) {
      const taskInfo = getTaskApprovalInfo(approval);
      if (taskInfo) {
        return (
          <InlineTaskApproval
            taskInfo={taskInfo}
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
