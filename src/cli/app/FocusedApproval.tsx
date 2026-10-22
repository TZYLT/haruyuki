import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { AppViewProps } from "./AppView";
import { diffFaceFilesFromDiffs } from "./faces/diff-face-model";
import { setDiffFaceSource } from "./faces/diff-face-store";
import { useHasDiffFace } from "./shell/diff-face-scope";

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
  /** The diff face's third door: `O` expands this approval's diff (`docs/38` §16.2). */
  openOverlay: AppViewProps["openOverlay"];
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
    openOverlay,
  } = view;
  // The append shell has no band to raise the face in, so `O` is not a key there.
  const hasDiffFace = useHasDiffFace();

  if (!currentApproval) {
    return null;
  }

  /**
   * `O`: raise the diff face over this approval, read-only.
   *
   * The approval is what answers the tool — the face is a viewer — and it stays
   * pending underneath: the overlay route drops it from the focused slot while the
   * face is up, so no key in the face can approve anything, and Escape brings it
   * back exactly as it was.
   */
  const openDiffFace = (diffs: Map<string, AdvancedDiffSuccess>): void => {
    const files = diffFaceFilesFromDiffs([...diffs.entries()]);
    if (files.length === 0) return;
    const file = files[0];
    setDiffFaceSource({
      label: files.length === 1 && file ? file.path : `${files.length} files`,
      files,
    });
    openOverlay("diff", "/approval", "Approval diff", "Diff closed");
  };

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
      onOpenDiffFace={hasDiffFace ? openDiffFace : undefined}
    />
  );
}
