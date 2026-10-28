/**
 * The topic faces, mounted by `AppView` under one condition.
 *
 * A registry handler returns a string; a face is mounted here. These lived inline
 * in `AppView` until the three topic views were folded into one panel
 * (2026-10-28) — the file is on the size ratchet, and its own review note said
 * the next change to these faces should move them out.
 *
 * The mapping is explicit rather than derived from the overlay name: the panel's
 * views are the user-facing names (`blocks`/`context`/`all`), the overlays are
 * the routing ids, and keeping the two lists in one place is what stops an
 * overlay from mounting the wrong view.
 */

import type { ActiveOverlay } from "@/cli/app/types";
import type { TopicPanelView } from "@/cli/helpers/topic-panel";
import { TopicListOverlay } from "./TopicListOverlay";
import { TopicSearchOverlay } from "./TopicSearchOverlay";

/** Which panel view each topic overlay opens. */
const TOPIC_PANEL_OVERLAYS = {
  "topic-blocks": "blocks",
  "topic-context": "context",
  "topic-all": "all",
} as const satisfies Partial<
  Record<NonNullable<ActiveOverlay>, TopicPanelView>
>;

type TopicPanelOverlay = keyof typeof TOPIC_PANEL_OVERLAYS;

/** True for every overlay this module mounts, so `AppView` keeps one branch. */
export function isTopicOverlay(
  overlay: NonNullable<ActiveOverlay>,
): overlay is TopicPanelOverlay | "topic-search" {
  return overlay === "topic-search" || overlay in TOPIC_PANEL_OVERLAYS;
}

export function TopicOverlays({
  overlay,
  agentId,
  conversationId,
  searchQuery,
  onClose,
}: {
  overlay: NonNullable<ActiveOverlay>;
  agentId: string;
  conversationId: string;
  /** The one-shot keyword `/topic search <kw>` was invoked with, if any. */
  searchQuery: string;
  onClose: () => void;
}) {
  if (overlay === "topic-search") {
    return (
      <TopicSearchOverlay
        agentId={agentId}
        onClose={onClose}
        initialQuery={searchQuery || undefined}
      />
    );
  }
  const view = TOPIC_PANEL_OVERLAYS[overlay as TopicPanelOverlay];
  if (view === undefined) return null;
  return (
    <TopicListOverlay
      agentId={agentId}
      conversationId={conversationId}
      view={view}
      onClose={onClose}
    />
  );
}
