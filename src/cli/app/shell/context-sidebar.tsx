// src/cli/app/shell/context-sidebar.tsx

import { Box, Text } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getSubagentLifecycleSnapshot,
  subscribeToSubagentLifecycle,
} from "@/agent/subagent-state";
import type { AppViewProps } from "@/cli/app/AppView";
import { colors } from "@/cli/components/colors";
import {
  buildSidebarSections,
  fitSidebarSections,
  SIDEBAR_GUTTER_COLUMNS,
  type SidebarProjection,
  sidebarContentColumns,
} from "./sidebar-sections";

/**
 * The static rail on the right of the band (`《38》§6`).
 *
 * It paints what `sidebar-sections.ts` decided and nothing else: the rows, the
 * fit, and the width arithmetic all happen in that module, so the rail cannot
 * disagree with the test that pins the width table.
 *
 * **The divider is the box's own left border.** Painting a `│` into every line
 * would leave the rule broken below the last section — the rail is exactly the
 * band's height, and the empty part of it still has to hold the rule up. A border
 * is drawn for the box's whole height by Ink, for one line of code.
 *
 * **No mouse, no scrolling** (`《38》§19.1`: P1 is read-only, `§6.2`: the rail
 * never scrolls). Its content is bounded by construction — `fitSidebarSections`
 * degrades whole sections instead of clipping a line.
 */
export type ContextSidebarProps = {
  /** Band rows the rail may occupy. */
  height: number;
  /** The whole block, divider and its space included. */
  width: number;
  projection: Omit<SidebarProjection, "width">;
};

export function ContextSidebar({
  height,
  width,
  projection,
}: ContextSidebarProps) {
  const contentWidth = sidebarContentColumns(width);
  const specs = buildSidebarSections({ ...projection, width: contentWidth });
  const fitted = fitSidebarSections(specs, height);

  const rows = fitted.flatMap((section, index) => [
    ...(index > 0
      ? [{ key: `${section.spec.id}:gap`, text: "", title: false }]
      : []),
    { key: `${section.spec.id}:title`, text: section.spec.title, title: true },
    ...section.lines.map((line, offset) => ({
      key: `${section.spec.id}:${offset}`,
      text: line,
      title: false,
    })),
  ]);

  return (
    <Box
      width={Math.max(1, width)}
      height={Math.max(1, height)}
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      paddingLeft={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      // The same colour the strip's rule uses: the divider is chrome, not content.
      borderColor={colors.input.border}
    >
      {rows.map((row) => (
        <Text
          key={row.key}
          bold={row.title}
          dimColor={!row.title}
          wrap="truncate-end"
        >
          {row.text}
        </Text>
      ))}
    </Box>
  );
}

/**
 * The rail wired to the app's own projections.
 *
 * One assembly point, because the two places that draw a band (the transcript and
 * a page) must not each decide what the rail reads: that is how a sidebar starts
 * disagreeing with the status line about how many tokens a conversation has used.
 * Every field below is read, never recomputed — `《38》§6.5`.
 *
 * The ticker is **local to this component and only runs while an agent is
 * active**. `《38》§6.6` forbids a one-second ticker on the whole tree; a rail
 * that re-renders itself is the narrow version of that, and it is what makes the
 * `12s` in the Agents section advance.
 */
export function ContextSidebarSlot({
  view,
  height,
  width,
}: {
  view: AppViewProps;
  height: number;
  width: number;
}) {
  const snapshot = useSyncExternalStore(
    subscribeToSubagentLifecycle,
    getSubagentLifecycleSnapshot,
  );
  const running = snapshot.filter(
    (agent) => agent.status === "pending" || agent.status === "running",
  );
  const [, setTick] = useState(0);
  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running.length]);

  const stats = view.sessionStatsRef.current.getSnapshot();
  const now = Date.now();
  const projection: Omit<SidebarProjection, "width"> = {
    usedContextTokens: view.usedContextTokens ?? null,
    contextWindowSize: view.contextWindowSize ?? null,
    stepCount: stats.usage.stepCount,
    inputTokens: stats.usage.promptTokens,
    outputTokens: stats.usage.completionTokens,
    reasoningTokens: stats.usage.reasoningTokens,
    sessionWallMs: stats.totalWallMs,
    agents: running.map((agent) => ({
      type: agent.type,
      durationMs:
        agent.status === "running"
          ? Math.max(0, now - agent.startedAtMs)
          : Math.max(0, agent.elapsedMs),
    })),
    // Both land with their own readers: today's usage needs P4's ledger, and the
    // memory figures need a git/disk reader that no part of M6 owns yet. The
    // sections say so instead of printing a zero that would read as a measurement.
    today: null,
    memfs: null,
  };

  return (
    // The gutter: the one spacer column `《38》§6.3`'s table leaves between the
    // band and the divider. It belongs to the placement, not the rail's own
    // drawing, so the geometry is stated once, here, instead of in both bands.
    <Box marginLeft={SIDEBAR_GUTTER_COLUMNS} flexShrink={0}>
      <ContextSidebar height={height} width={width} projection={projection} />
    </Box>
  );
}
