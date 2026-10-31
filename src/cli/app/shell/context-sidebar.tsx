// src/cli/app/shell/context-sidebar.tsx

import { Box, Text } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { emptyTurnStats, type SessionStatsSnapshot } from "@/agent/stats";
import {
  getSubagentLifecycleSnapshot,
  subscribeToSubagentLifecycle,
} from "@/agent/subagent-state";
import type { AppViewProps } from "@/cli/app/AppView";
import {
  type DreamScheduleRow,
  useDreamScheduleRow,
} from "@/cli/helpers/dream-sidebar";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { type MemfsStats, readMemfsStats } from "@/cli/helpers/memfs-stats";
import { useScheduleTasks } from "@/cli/helpers/schedule-store";
import { readUsageLedger } from "@/usage/ledger";
import { summarizeUsage, type UsageSummary } from "@/usage/summary";
import {
  buildSidebarSections,
  fitSidebarSections,
  SIDEBAR_GUTTER_COLUMNS,
  type SidebarProjection,
  type SidebarScheduleRow,
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
  const blockWidth = Math.max(1, width);
  const rows = Math.max(1, height);
  const contentWidth = sidebarContentColumns(width);
  const specs = buildSidebarSections({ ...projection, width: contentWidth });
  const fitted = fitSidebarSections(specs, rows);

  const content = fitted.flatMap((section, index) => [
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

  // **Every row is `│ ` plus its text — and nothing else.** The divider used to be
  // the box's left border, and a border is not a row: it was drawn by the border
  // machinery at a different moment from the content, which on the machine showed
  // up as a rail whose rule started one row late and whose text did not line up
  // with the `┬` above it. A painted glyph is the same row as its text, so the
  // column cannot drift — and the rows below the last section keep the rule
  // standing, because they are rows too.
  //
  // **No trailing padding.** Filling each row out to the block's width writes the
  // terminal's last columns on every band row, and a row that reaches the final
  // column leaves the terminal in the pending-wrap state — on the machine that was
  // a frame taller than the screen, with the tab strip scrolled off the top. The
  // box still reserves its width (that is what places the divider); the spaces at
  // its right edge are simply never written.
  const painted = Array.from({ length: rows }, (_, index) => {
    const row = content[index];
    const prefix = CLI_GLYPHS.rail;
    const text = row?.text ?? "";
    return {
      key: row?.key ?? `blank:${index}`,
      line: text.length > 0 ? `${prefix} ${text}` : prefix,
      title: row?.title ?? false,
    };
  });

  return (
    <Box
      width={blockWidth}
      height={rows}
      // No clip of its own: the band that holds the rail is `overflow="hidden"` and
      // is the rectangle the rail has to stay inside. Giving this box its own clip
      // would make it the innermost one (`output.js`: `clips.at(-1)`) and then the
      // rows painted from a *stale* band height — the frame the composer's popup
      // appears on — would keep going down over the composer: the machine photographed
      // the rail's divider running through the input row. The band's rectangle is the
      // one that shrinks when the chrome grows, so it is the one that has to clip.
      flexDirection="column"
      flexShrink={0}
    >
      {painted.map((row) => (
        <Text
          key={row.key}
          bold={row.title}
          dimColor={!row.title}
          wrap="truncate-end"
        >
          {row.line}
        </Text>
      ))}
    </Box>
  );
}

/** Everything the rail reads, in the app's own terms. */
export type SidebarProjectionInputs = {
  stats: SessionStatsSnapshot;
  usedContextTokens: number | null;
  contextWindowSize: number | null;
  agents: readonly { type: string; durationMs: number }[];
  /** Today's ledger summary, or `null` while the read is still in flight. */
  today: UsageSummary["today"] | null;
  memfs: MemfsStats | null;
  /** The current agent's planned runs, newest-due first (F-05, R-5.12.5). */
  schedules: readonly SidebarScheduleRow[] | null;
  /** Why the schedule store could not be read; the rail shows it (M3 #17). */
  schedulesError?: string | null;
};

/**
 * Bind the app's numbers to the rail's rows — the one place a source field is
 * named.
 *
 * Pure and exported because a wrong binding here is invisible to a frame test:
 * the row is still painted, only with another number. `today.completion` is
 * the day's output count; `cacheWrite` — what the `out` row used to print — is
 * a third *input* price, and reading it there made the row meaningless.
 */
export function sidebarProjectionFrom(
  inputs: SidebarProjectionInputs,
): Omit<SidebarProjection, "width"> {
  const { stats, today } = inputs;
  return {
    usedContextTokens: inputs.usedContextTokens,
    contextWindowSize: inputs.contextWindowSize,
    contextBreakdown: stats.contextBreakdown ?? null,
    turn: stats.turn ?? emptyTurnStats(),
    reasoningTokens: stats.usage.reasoningTokens,
    agents: inputs.agents,
    today: today
      ? {
          tokens: today.tokens,
          turns: today.turns,
          cacheReadTokens: today.cachedInput,
          uncachedTokens: today.prompt,
          outputTokens: today.completion,
          hitRate: today.cacheHitRate,
          costUsd: today.cost,
        }
      : null,
    memfs: inputs.memfs,
    schedules: inputs.schedules,
    schedulesError: inputs.schedulesError ?? null,
  };
}

/** The fields of a store row the rail's section actually reads. */
export type SidebarScheduleSourceRow = {
  id: string;
  name: string;
  agentId: string;
  type: string;
  /** The store's terse due label: a signal-triggered dream has none (`—`). */
  nextShort: string;
  statusLabel: string;
};

/**
 * The rail's scheduled rows for one agent, dream rows described live (F-06).
 *
 * A dream row carries no `nextDueAt` — its trigger is the signal source, not a
 * cron — so `nextShort` is `—`; the rail must never paint that. Its row instead
 * comes from {@link DreamScheduleRow} (`running` / `ready` / a window time), and
 * when that is `null` (dream disabled, auto-trigger off, every tier off) the row
 * is dropped **before** the three-row cap, so a hidden row never spends one of
 * the rail's three slots.
 *
 * Pure and exported because the mapping is the seam the frame tests cannot see:
 * the row is still painted, only with the store's dash.
 */
export function mapSidebarScheduleRows(
  rows: readonly SidebarScheduleSourceRow[],
  agentId: string,
  dreamRow: DreamScheduleRow | null,
): SidebarScheduleRow[] {
  const mapped = rows
    .filter((row) => row.agentId === agentId)
    .flatMap((row): SidebarScheduleRow[] => {
      if (row.type !== "dream") {
        return [
          {
            id: row.id,
            name: row.name,
            when: row.nextShort,
            status: row.statusLabel,
          },
        ];
      }
      if (!dreamRow) return [];
      return [
        {
          id: row.id,
          name: row.name,
          when: dreamRow.when,
          // The helper describes the schedule, not the task's own state: a
          // paused carrier still says so (the store's word wins when present).
          status: dreamRow.status || row.statusLabel,
        },
      ];
    });
  return mapped.slice(0, 3);
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

  // Memory stats are read on three events and never per frame: mount (the
  // session starting), a conversation switch, and a turn finishing (`streaming`
  // going false). Each read is a git call, so a per-frame read would be a
  // subprocess per repaint — the exact "1 s ticker on the whole tree" the rail
  // must not be.
  //
  // Today's usage is read on the same three events for the same reason, and it
  // is read as **the ledger**, not as a second tally of the session: the rail's
  // Usage section answers "what have I spent today", which spans conversations
  // and does not restart with this process.
  const [memfs, setMemfs] = useState<MemfsStats | null>(null);
  const [today, setToday] = useState<UsageSummary["today"] | null>(null);
  useEffect(() => {
    // Triggers, not reads: a switch and a finished turn are *when* to re-read.
    void view.conversationId;
    void view.streaming;
    let cancelled = false;
    void readMemfsStats(view.agentId).then((stats) => {
      if (!cancelled) setMemfs(stats);
    });
    void readUsageLedger().then((records) => {
      if (cancelled) return;
      // The whole `today` view is kept, not a hand-copied subset: the binding
      // between its fields and the rail's rows lives in `sidebarProjectionFrom`.
      setToday(summarizeUsage(records, new Date()).today);
    });
    return () => {
      cancelled = true;
    };
  }, [view.agentId, view.conversationId, view.streaming]);

  const stats = view.sessionStatsRef.current.getSnapshot();
  const now = Date.now();

  // F-05/F-06: the planned runs of *this* agent, from the schedule store. The
  // hook gives the rail three things for free — the read, the 30 s low-frequency
  // refresh and the event subscription — and, because the snapshot object is
  // stable when nothing changed, a tick that reads the same data does not
  // re-render this subtree (`《38》§6.6`, C-27).
  const scheduleSnapshot = useScheduleTasks();
  const agentScheduleRows = scheduleSnapshot.loaded
    ? scheduleSnapshot.rows.filter((row) => row.agentId === view.agentId)
    : [];
  // F-06: a dream row has no `nextShort` to paint (`—`). Its live description
  // costs a settings/state/liveness read, so the hook only starts when this
  // agent actually owns a dream row, and it reads on a 30 s timer — never in
  // this render body, which runs on every streaming chunk.
  const hasDreamRow = agentScheduleRows.some((row) => row.type === "dream");
  const dreamRow = useDreamScheduleRow(view.agentId, hasDreamRow);
  const schedules = scheduleSnapshot.loaded
    ? mapSidebarScheduleRows(agentScheduleRows, view.agentId, dreamRow)
    : null;

  const projection = sidebarProjectionFrom({
    stats,
    usedContextTokens: view.usedContextTokens ?? null,
    contextWindowSize: view.contextWindowSize ?? null,
    agents: running.map((agent) => ({
      type: agent.type,
      durationMs:
        agent.status === "running"
          ? Math.max(0, now - agent.startedAtMs)
          : Math.max(0, agent.elapsedMs),
    })),
    today,
    memfs,
    schedules,
    schedulesError: scheduleSnapshot.error,
  });

  return (
    // The gutter: the one spacer column `《38》§6.3`'s table leaves between the
    // band and the divider. It belongs to the placement, not the rail's own
    // drawing, so the geometry is stated once, here, instead of in both bands.
    <Box marginLeft={SIDEBAR_GUTTER_COLUMNS} flexShrink={0}>
      <ContextSidebar height={height} width={width} projection={projection} />
    </Box>
  );
}
