import { Static, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { subscribeToTranscriptDisplayRepaint } from "@/cli/components/transcript-display-state";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { releaseCommittedDiffPayloads } from "./approval-diffs";
import { TranscriptItemView } from "./TranscriptItem";
import type { StaticItem } from "./types";

type InkAppWithStaticOutputReset = ReturnType<typeof useApp> & {
  resetStaticOutput?: () => void;
};

export function StaticTranscript({
  renderEpoch,
  items,
  columns,
  statusLinePrompt,
  showCompactionsEnabled,
  precomputedDiffs,
  hiddenToolCallId,
  lastShellToolCallId,
}: {
  renderEpoch: number;
  items: StaticItem[];
  columns: number;
  statusLinePrompt: string;
  showCompactionsEnabled: boolean;
  precomputedDiffs: Map<string, AdvancedDiffSuccess>;
  hiddenToolCallId?: string;
  /** Used to show ctrl+o hint on the last committed tool call.
   *  Intentionally NOT included in the Static key — passing it here without
   *  keying on it means the hint shows correctly when an item first commits,
   *  and may be stale on older items (minor cosmetic issue, much better than
   *  remounting on every tool call and re-printing history). */
  lastShellToolCallId?: string;
}) {
  const [displayRenderEpoch, setDisplayRenderEpoch] = useState(0);
  const { resetStaticOutput } = useApp() as InkAppWithStaticOutputReset;
  useEffect(
    () =>
      subscribeToTranscriptDisplayRepaint(() => {
        resetStaticOutput?.();
        setDisplayRenderEpoch((epoch) => epoch + 1);
      }),
    [resetStaticOutput],
  );

  // Release the full before/after file contents cached for approval diffs
  // once their owning item has been committed here and rendered. Running as
  // an effect guarantees the commit render already consumed the diff; the
  // release itself is render-neutral because renderers only read hunks, which
  // stay cached for Static remounts (resize repaints, ctrl+o, display
  // toggles). See LET-13144.
  const releasedItemIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    releaseCommittedDiffPayloads(
      precomputedDiffs,
      items,
      releasedItemIdsRef.current,
    );
  }, [items, precomputedDiffs]);

  return (
    <Static
      key={`${renderEpoch}-${displayRenderEpoch}-${hiddenToolCallId ?? ""}`}
      items={items}
      style={{ flexDirection: "column" }}
    >
      {(item: StaticItem, index: number) => (
        <TranscriptItemView
          key={item.id}
          item={item}
          index={index}
          columns={columns}
          statusLinePrompt={statusLinePrompt}
          showCompactionsEnabled={showCompactionsEnabled}
          precomputedDiffs={precomputedDiffs}
          hiddenToolCallId={hiddenToolCallId}
          lastShellToolCallId={lastShellToolCallId}
        />
      )}
    </Static>
  );
}
