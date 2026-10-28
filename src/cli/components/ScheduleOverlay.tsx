/**
 * The `/schedule` faces: the task list, one task's detail, and its run history.
 *
 * Three views over one model (R-5.12.4), each its own component because each
 * owns a different key table — the overlay toolkit allows exactly one list key
 * owner per scope (`overlay/README.md`, rule 1), and a detail view that kept the
 * list's hook mounted would register a second owner for the same `overlay`
 * layer. `ScheduleOverlay` is therefore a route, not a list: it picks the view
 * and the task, and the mounted face owns its keys.
 *
 * The command that opened the overlay picks the opening view (`list`, `detail`
 * for `show`, `logs` for `logs`), and Escape from a sub-view returns to the list
 * before it closes the face — the walk `useWizard` already describes.
 *
 * The data comes from `schedule-store.ts`, which owns the read, the 30 s
 * low-frequency refresh and the event subscription. This file never polls: it
 * re-renders when the snapshot object changes, and that object is stable when
 * nothing a row displays changed (C-27).
 */

import { Box } from "ink";
import { useEffect, useMemo, useState } from "react";
import { formatScheduleDetailLines } from "@/cli/commands/schedule";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import {
  type AutostartView,
  formatRunGroupLine,
  groupRunsByRunId,
  liveScheduleSource,
  peekScheduleOverlayTarget,
  readAutostartView,
  type ScheduleRunGroup,
  type ScheduleTaskRow,
  scheduleNow,
  shortId,
  useScheduleTasks,
} from "@/cli/helpers/schedule-store";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { wizardBindings } from "@/cli/overlay/wizard";
import type { ScheduleTaskV2 } from "@/cron";

export type ScheduleOverlayView = "list" | "detail" | "logs";

/** The overlay ids this file draws; `app/types.ts` names them. */
export const SCHEDULE_OVERLAY_IDS = [
  "schedule",
  "schedule-detail",
  "schedule-logs",
] as const;

export type ScheduleOverlayId = (typeof SCHEDULE_OVERLAY_IDS)[number];

/**
 * The type guard `AppView` narrows `activeOverlay` with. A plain `boolean`
 * would leave the mount site failing to prove the id is one of the three.
 */
export function isScheduleOverlay(id: string): id is ScheduleOverlayId {
  return (SCHEDULE_OVERLAY_IDS as readonly string[]).includes(id);
}

/** Chrome a windowed list does not get: frame header/title, indicators, footer. */
const CHROME_ROWS = 9;

/** How many run-log entries one view reads. The panel pages, it never dumps. */
export const RUN_LOG_LIMIT = 100;

export interface ScheduleOverlayProps {
  /** Where the face opens. `detail`/`logs` are reached from a command too. */
  view?: ScheduleOverlayView;
  /** The task `show`/`logs` named; `list` ignores it. */
  taskId?: string;
  agentId: string;
  /** `list --all` shows every agent's tasks (the rail never does). */
  allAgents?: boolean;
  onClose: () => void;
  /** Injectable run-log reader; the app passes nothing and reads the journal. */
  readRuns?: (taskId: string) => ScheduleRunGroup[];
  /** Injectable autostart read; the app shells out to the M4 registrar. */
  readAutostart?: () => Promise<AutostartView>;
}

/** The rows the face shows: the agent's tasks, or everything for `--all`. */
function visibleRows(
  allRows: readonly ScheduleTaskRow[],
  agentId: string,
  allAgents: boolean,
): readonly ScheduleTaskRow[] {
  return allAgents ? allRows : allRows.filter((row) => row.agentId === agentId);
}

/**
 * `> 任务名 · …` — one line per task: name, type, next run, last result, status,
 * permission, and the failure streak when there is one (R-5.12.4).
 */
function ScheduleRow({
  row,
  width,
  isCursor,
}: {
  row: ScheduleTaskRow;
  width: number;
  isCursor: boolean;
}) {
  const color = isCursor ? colors.selector.itemHighlighted : undefined;
  const pausedByFailures = row.task.pausedReason === "auto_failures";
  return (
    <Box flexDirection="row">
      <Text color={color}>{isCursor ? "> " : "  "}</Text>
      <Text
        bold={isCursor}
        color={pausedByFailures ? colors.status.error : color}
      >
        {truncateText(row.listLine, Math.max(1, width - 2))}
      </Text>
    </Box>
  );
}

/** The list face. Owns the list's keys; the two sub-faces own theirs. */
function ScheduleListView({
  rows,
  width,
  height,
  autostart,
  error,
  loaded,
  emptyMessage,
  onOpenDetail,
  onOpenLogs,
  onClose,
}: {
  rows: readonly ScheduleTaskRow[];
  width: number;
  height: number;
  autostart: AutostartView | null;
  error: string | null;
  loaded: boolean;
  emptyMessage: string;
  onOpenDetail: (row: ScheduleTaskRow) => void;
  onOpenLogs: (row: ScheduleTaskRow) => void;
  onClose: () => void;
}) {
  const listRows = Math.max(1, height - CHROME_ROWS);
  const items = rows.map((row) => ({ key: row.id, label: row.listLine }));
  const list = useOverlayList({
    owner: "schedule-list",
    items,
    rows: listRows,
    onCancel: onClose,
    onConfirm: (_key, index) => {
      const row = rows[index];
      if (row) onOpenDetail(row);
    },
    extra: [
      {
        id: "schedule.list.logs",
        chords: [{ key: "l" }],
        run: () => {
          const row = rows[list.cursor];
          if (!row) return "declined";
          onOpenLogs(row);
          return "consumed";
        },
      },
      {
        id: "schedule.list.quit",
        chords: [{ key: "q" }],
        run: () => {
          onClose();
          return "consumed";
        },
      },
    ],
  });

  const count = rows.length;
  const hint =
    count === 0
      ? "Esc 关闭 · /schedule add 新建"
      : `共 ${count} 个 · ↑↓ 选择 · Enter 详情 · l 运行记录 · Esc 关闭`;

  return (
    <OverlayFrame
      command="/schedule list"
      title="计划任务"
      footer={
        <Box flexDirection="column">
          <Text dimColor>{truncateText(hint, width)}</Text>
          {autostart && (
            <Text dimColor>{truncateText(autostart.label, width)}</Text>
          )}
          {error && (
            <Text color={colors.status.error}>
              {truncateText(`读取失败：${error}`, width)}
            </Text>
          )}
        </Box>
      }
    >
      {count === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>
            {truncateText(loaded ? emptyMessage : "正在读取计划任务…", width)}
          </Text>
          <Text dimColor>
            {truncateText(
              "计划任务随宿主运行：TUI 开着时每 60s 检查一次。",
              width,
            )}
          </Text>
        </Box>
      ) : (
        <OverlayListView
          items={items}
          cursor={list.cursor}
          rows={listRows}
          renderRow={(_item, index, isCursor) => {
            const row = rows[index];
            if (!row) return null;
            return <ScheduleRow row={row} width={width} isCursor={isCursor} />;
          }}
        />
      )}
    </OverlayFrame>
  );
}

/** One task, every field the requirement names plus the ones that explain it. */
function ScheduleDetailView({
  row,
  width,
  autostart,
  onBack,
  onLogs,
  onClose,
}: {
  row: ScheduleTaskRow;
  width: number;
  autostart: AutostartView | null;
  onBack: () => void;
  onLogs: () => void;
  onClose: () => void;
}) {
  const now = scheduleNow();
  const lines = formatScheduleDetailLines(row.task, now, row.nextDueAt);
  useKeyBindings("schedule-detail", [
    {
      scope: "overlay",
      bindings: [
        ...wizardBindings({
          canGoBack: true,
          onBack,
          onCancel: onClose,
        }),
        {
          id: "schedule.detail.logs",
          chords: [{ key: "l" }],
          run: () => {
            onLogs();
            return "consumed";
          },
        },
        {
          id: "schedule.detail.quit",
          chords: [{ key: "q" }],
          run: () => {
            onClose();
            return "consumed";
          },
        },
      ],
    },
  ]);

  return (
    <OverlayFrame
      command={`/schedule show ${shortId(row.id)}`}
      title={row.name}
      footer={
        <Box flexDirection="column">
          <Text dimColor>
            {truncateText("l 运行记录 · Esc 返回列表 · q 关闭", width)}
          </Text>
          {autostart && (
            <Text dimColor>{truncateText(autostart.label, width)}</Text>
          )}
        </Box>
      }
    >
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text
            key={`${row.id}:${index}`}
            dimColor={index > 0}
            color={
              row.task.pausedReason === "auto_failures" && index === 4
                ? colors.status.error
                : undefined
            }
          >
            {truncateText(line, width)}
          </Text>
        ))}
      </Box>
    </OverlayFrame>
  );
}

/**
 * The run history, grouped by `runId` (one row per run, R-5.14.1).
 *
 * The group is the unit: an old entry written before F-05 has no run id and
 * stands alone rather than merging into a neighbour (`groupRunsByRunId`).
 */
function ScheduleRunLogView({
  task,
  groups,
  width,
  height,
  onBack,
  onClose,
  onRefresh,
}: {
  task: ScheduleTaskV2;
  groups: readonly ScheduleRunGroup[];
  width: number;
  height: number;
  onBack: () => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const listRows = Math.max(1, height - CHROME_ROWS);
  const now = scheduleNow();
  const items = groups.map((group) => ({
    key: group.key,
    label: formatRunGroupLine(group, now),
  }));
  const list = useOverlayList({
    owner: "schedule-run-log",
    items,
    rows: listRows,
    onCancel: onBack,
    extra: [
      {
        id: "schedule.logs.refresh",
        chords: [{ key: "r" }],
        run: () => {
          onRefresh();
          return "consumed";
        },
      },
      {
        id: "schedule.logs.quit",
        chords: [{ key: "q" }],
        run: () => {
          onClose();
          return "consumed";
        },
      },
    ],
  });

  const empty = groups.length === 0;
  return (
    <OverlayFrame
      command={`/schedule logs ${shortId(task.id)}`}
      title={`${task.name} · 运行记录`}
      footer={
        <Text dimColor>
          {truncateText(
            empty
              ? "还没有运行记录 · Esc 返回"
              : `共 ${groups.length} 次 · ↑↓ 查看 · r 刷新 · Esc 返回 · q 关闭`,
            width,
          )}
        </Text>
      }
    >
      {empty ? (
        <Box flexDirection="column">
          <Text dimColor>{truncateText("这个任务还没有跑过。", width)}</Text>
          <Text dimColor>
            {truncateText(
              "每次运行一行，按 runId 分组；错过也会记一行。",
              width,
            )}
          </Text>
        </Box>
      ) : (
        <OverlayListView
          items={items}
          cursor={list.cursor}
          rows={listRows}
          renderRow={(_item, index, isCursor) => {
            const group = groups[index];
            if (!group) return null;
            const color = isCursor
              ? colors.selector.itemHighlighted
              : undefined;
            const failed =
              group.outcome === "failed" || group.outcome === "timeout";
            return (
              <Box flexDirection="row">
                <Text color={color}>{isCursor ? "> " : "  "}</Text>
                <Text
                  bold={isCursor}
                  color={failed ? colors.status.error : color}
                >
                  {truncateText(
                    formatRunGroupLine(group, now),
                    Math.max(1, width - 2),
                  )}
                </Text>
              </Box>
            );
          }}
        />
      )}
    </OverlayFrame>
  );
}

/**
 * The face: a route over the three views, one task's id, and the run-log read.
 *
 * The run log is read on the view that shows it and again when the store's
 * revision moves (a run landed while the face was open) — never per frame. The
 * autostart line is read once on mount: it is the one OS fact the panel shows,
 * and it is a subprocess read.
 */
export function ScheduleOverlay({
  view: initialView = "list",
  taskId,
  agentId,
  allAgents = false,
  onClose,
  readRuns,
  readAutostart,
}: ScheduleOverlayProps) {
  const snapshot = useScheduleTasks();
  const rows = useMemo(
    () => visibleRows(snapshot.rows, agentId, allAgents),
    [agentId, allAgents, snapshot.rows],
  );
  const terminalRows = useTerminalRows();
  const terminalWidth = useTerminalWidth();
  const width = Math.max(1, terminalWidth - 2);

  const [step, setStep] = useState<ScheduleOverlayView>(initialView);
  const [activeId, setActiveId] = useState<string | null>(taskId ?? null);
  const [autostart, setAutostart] = useState<AutostartView | null>(null);

  // A task named by `show`/`logs` may belong to another agent (`--all` was not
  // passed) — the face still opens on it, because the command named it.
  const activeRow = useMemo(
    () => snapshot.rows.find((row) => row.id === activeId) ?? null,
    [activeId, snapshot.rows],
  );

  useEffect(() => {
    let cancelled = false;
    const read = readAutostart ?? readAutostartView;
    void read().then((next) => {
      if (!cancelled) setAutostart(next);
    });
    return () => {
      cancelled = true;
    };
  }, [readAutostart]);

  const [groups, setGroups] = useState<readonly ScheduleRunGroup[]>([]);
  const readGroups = useMemo(() => {
    if (!activeRow) return () => {};
    return () => {
      setGroups(
        readRuns
          ? readRuns(activeRow.id)
          : groupRunsByRunId(
              liveScheduleSource().readRuns(activeRow.id, RUN_LOG_LIMIT),
            ),
      );
    };
  }, [activeRow, readRuns]);

  useEffect(() => {
    // `revision` is the reload *trigger* (a run landed while the face was open),
    // read here so the dependency is visible to the lint as an input.
    void snapshot.revision;
    if (step !== "logs") return;
    readGroups();
  }, [step, readGroups, snapshot.revision]);

  if (step === "logs" && activeRow) {
    return (
      <ScheduleRunLogView
        task={activeRow.task}
        groups={groups}
        width={width}
        height={terminalRows}
        onBack={() => setStep("detail")}
        onClose={onClose}
        onRefresh={readGroups}
      />
    );
  }

  if (step === "detail" && activeRow) {
    return (
      <ScheduleDetailView
        row={activeRow}
        width={width}
        autostart={autostart}
        onBack={() => setStep("list")}
        onLogs={() => setStep("logs")}
        onClose={onClose}
      />
    );
  }

  return (
    <ScheduleListView
      rows={rows}
      width={width}
      height={terminalRows}
      autostart={autostart}
      error={snapshot.error}
      loaded={snapshot.loaded}
      emptyMessage={
        allAgents ? "还没有任何计划任务。" : "当前 agent 还没有计划任务。"
      }
      onOpenDetail={(row) => {
        setActiveId(row.id);
        setStep("detail");
      }}
      onOpenLogs={(row) => {
        setActiveId(row.id);
        setStep("logs");
      }}
      onClose={onClose}
    />
  );
}

/**
 * What `AppView` mounts: the overlay id picks the opening view, and the id a
 * `show`/`logs` command named rides the store's one-shot target bridge (the
 * submit handler can open a face but cannot pass it props).
 */
export function ScheduleOverlayRoute({
  overlay,
  agentId,
  onClose,
}: {
  overlay: "schedule" | "schedule-detail" | "schedule-logs";
  agentId: string;
  onClose: () => void;
}) {
  const target = useMemo(() => peekScheduleOverlayTarget(), []);
  const named = target.view === "detail" || target.view === "logs";
  const taskId = named ? target.taskId : undefined;
  let view: ScheduleOverlayView = "list";
  if (overlay === "schedule-detail") view = "detail";
  else if (overlay === "schedule-logs") view = "logs";
  else if (named) view = target.view;
  const allAgents =
    target.view === "list" ? (target.allAgents ?? false) : false;
  return (
    <ScheduleOverlay
      view={view}
      taskId={taskId}
      agentId={agentId}
      allAgents={allAgents}
      onClose={onClose}
    />
  );
}
