/**
 * The "compaction" overlay slot, which is three faces behind one name.
 *
 * - `/compact config` configures the mode (`CompactionSelector`);
 * - a running summarizer shows the elapsed time and Esc (`CompactionProgress`);
 * - a finished preview asks for the cut point (`TopicSelector`).
 *
 * The three share a slot because one compaction runs at a time, and they share
 * one *mount* because the mount is what a face must not lose: switching between
 * them through the request store (`topic-trim-request.ts`) re-renders this
 * component in place, while a remount would drop a frame and, on a `<Static>`
 * host, risk a double print (`src/cli/AGENTS.md`).
 *
 * Nothing here touches `AppCoordinator`: the elapsed line is local to the
 * progress face, and its Esc is an overlay-scope binding, so the cancel path
 * needs no coordinator state.
 */
import { Box } from "ink";
import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { colors } from "@/cli/components/colors";
import { namedKeyChords } from "@/cli/helpers/input-keys";
import {
  type CompactionPreparingRequest,
  compactionOverlayRequest,
  subscribeCompactionOverlayRequest,
} from "@/cli/helpers/topic-trim-request";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import {
  CompactionSelector,
  type CompactionSelectorProps,
} from "./CompactionSelector";
import { Text } from "./Text";
import { TopicSelector } from "./TopicSelector";

/** How long the summarizer has been running, in whole seconds. */
function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

/**
 * `preparing`: the one thing the user needs while a call with no timeout runs.
 *
 * The elapsed number is recomputed from the clock on each paint rather than
 * accumulated, so a delayed tick shows the true time; the tick itself only
 * schedules the paint. One second is the coarsest interval that still reads as
 * "it is alive", and it is local to this leaf — `AppCoordinator` never sees it.
 */
function CompactionProgress({
  request,
  onDismiss,
}: {
  request: CompactionPreparingRequest;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useKeyBindings("compaction-progress", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "compaction-progress.cancel",
          chords: [...namedKeyChords("escape"), { key: "c", ctrl: true }],
          run: () => {
            request.onCancel();
            onDismiss();
            return "consumed";
          },
        },
      ],
    },
  ]);

  const seconds = elapsedSeconds(request.startedAt, now);
  return (
    <OverlayFrame command="/compact" title="Preparing the compaction">
      <Box flexDirection="column">
        <Text color={colors.text.secondary}>
          {`Summarizing this conversation's older topics... ${seconds}s`}
        </Text>
        <Box height={1} />
        <Text dimColor>
          Nothing has been written yet. Esc cancels the call and leaves the
          context as it is.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Esc cancel · the summary is one model call</Text>
        </Box>
      </Box>
    </OverlayFrame>
  );
}

export const CompactionOverlay = memo(function CompactionOverlay(
  props: CompactionSelectorProps,
) {
  // The slot is read live: `preparing` becomes `trim` in place when the
  // summarizer answers, and clearing it returns the slot to `/compact config`.
  const current = useSyncExternalStore(
    subscribeCompactionOverlayRequest,
    compactionOverlayRequest,
    compactionOverlayRequest,
  );

  if (current?.kind === "preparing") {
    return (
      <CompactionProgress
        request={current.request}
        onDismiss={props.onCancel}
      />
    );
  }
  if (current?.kind === "trim") {
    return (
      <TopicSelector request={current.request} onCancel={props.onCancel} />
    );
  }
  return <CompactionSelector {...props} />;
});
