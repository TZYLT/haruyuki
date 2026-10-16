import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { AppViewProps } from "./AppView";

/**
 * The projection slice the focused approval surface reads.
 *
 * Indexed off `AppViewProps` rather than re-declared, so this stays a truthful
 * narrowing: the shells pass their projection straight through, and a test can
 * build one honestly instead of casting a partial object.
 */
export interface FocusedApprovalView {
  currentApproval: AppViewProps["currentApproval"];
  currentApprovalContext: AppViewProps["currentApprovalContext"];
  precomputedDiffsRef: AppViewProps["precomputedDiffsRef"];
  handleApproveCurrent: AppViewProps["handleApproveCurrent"];
  handleApproveAlways: AppViewProps["handleApproveAlways"];
  handleDenyCurrent: AppViewProps["handleDenyCurrent"];
  handleCancelApprovals: AppViewProps["handleCancelApprovals"];
  showApprovalPreview: AppViewProps["showApprovalPreview"];
}

/**
 * The one focused approval surface.
 *
 * `ApprovalSwitch` is the only tool-approval renderer (`src/cli/AGENTS.md`), and
 * the props it derives are derived here, once, instead of at each call site: the
 * append shell draws the surface inline for the tool call in its live list and
 * again as a fallback when that list holds nothing, and the full-screen shell
 * pins it below the viewport when nothing in the band draws it.
 */
export function FocusedApproval({
  view,
  precomputedDiff,
}: {
  view: FocusedApprovalView;
  precomputedDiff?: AdvancedDiffSuccess;
}) {
  const {
    currentApproval,
    currentApprovalContext,
    precomputedDiffsRef,
    handleApproveCurrent,
    handleApproveAlways,
    handleDenyCurrent,
    handleCancelApprovals,
    showApprovalPreview,
  } = view;

  if (!currentApproval) {
    return null;
  }

  return (
    <ApprovalSwitch
      approval={currentApproval}
      onApprove={handleApproveCurrent}
      onApproveAlways={handleApproveAlways}
      onDeny={handleDenyCurrent}
      onCancel={handleCancelApprovals}
      precomputedDiff={precomputedDiff}
      allDiffs={precomputedDiffsRef.current}
      isFocused={true}
      approveAlwaysText={currentApprovalContext?.approveAlwaysText}
      allowPersistence={currentApprovalContext?.allowPersistence ?? true}
      defaultScope={
        currentApprovalContext?.defaultScope === "user"
          ? "session"
          : (currentApprovalContext?.defaultScope ?? "project")
      }
      showPreview={showApprovalPreview}
    />
  );
}
