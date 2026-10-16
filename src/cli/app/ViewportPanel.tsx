import { Box, type DOMElement } from "ink";
import type { RefObject } from "react";
import { SubagentGroupDisplay } from "@/cli/components/SubagentGroupDisplay";
import { FocusedApproval, type FocusedApprovalView } from "./FocusedApproval";

export interface ViewportPanelProps {
  /** The box the region measures to take these rows out of its band. */
  panelRef: RefObject<DOMElement | null>;
  /** Whether the focused approval already has a row inside the band. */
  approvalIsDrawn: boolean;
  /** The projection the pinned approval reads. */
  approval: FocusedApprovalView;
}

/**
 * The full-screen region's panel, under the transcript band and above the input.
 *
 * It is always mounted so the group keeps its live subscription and its ctrl+g
 * binding; the group renders nothing while no subagent is active, which is why the
 * panel costs no rows when idle.
 *
 * The pinned approval covers the other way an approval can end up with no row of
 * its own: its tool call is missing from the item list (the backfill cap dropped
 * it) or sits outside the band. Without it the input stays disabled with nothing on
 * screen to answer.
 */
export function ViewportPanel({
  panelRef,
  approvalIsDrawn,
  approval,
}: ViewportPanelProps) {
  return (
    <Box ref={panelRef} flexDirection="column" flexShrink={0}>
      {approvalIsDrawn ? null : <FocusedApproval view={approval} />}
      <SubagentGroupDisplay />
    </Box>
  );
}
