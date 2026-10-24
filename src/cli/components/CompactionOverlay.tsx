/**
 * The "compaction" overlay slot, which is two selectors behind one name.
 *
 * `/compact config` configures the mode; `/compact` (with topic markers to choose
 * between) asks the submit handler for a cut point and parks a
 * {@link TopicTrimRequest} in `@/cli/helpers/topic-trim-request`. AppView renders
 * this component for both, so the picker needs no new props threaded through the
 * coordinator — the trim itself stays in the submit handler, which is the only
 * place with the compaction bookkeeping.
 */
import { memo, useState } from "react";
import { takeTopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import {
  CompactionSelector,
  type CompactionSelectorProps,
} from "./CompactionSelector";
import { TopicSelector } from "./TopicSelector";

export const CompactionOverlay = memo(function CompactionOverlay(
  props: CompactionSelectorProps,
) {
  // Take the request once per mount: an overlay opened by `/compact config` finds
  // nothing here and falls through to the mode picker.
  const [request] = useState(() => takeTopicTrimRequest());
  if (request) {
    return <TopicSelector request={request} onCancel={props.onCancel} />;
  }
  return <CompactionSelector {...props} />;
});
