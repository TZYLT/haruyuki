/**
 * `/schedule` in the submit layer (F-05, M3).
 *
 * A registry handler returns a string; a face is mounted by `AppView`. So the
 * forms that need a face — `list`, `show`, `add`, `logs` and `run` — are claimed
 * here, exactly as `/search` and `/topic list` are, and the registry's
 * `/schedule` entry stays as the answer for the channels that have no terminal
 * (listener, headless).
 *
 * Two boundaries are deliberate:
 *
 * - **`run` is claimed but executed through the TUI host**, not by the registry:
 *   the host owns the runner instance and the scheduler lease, and the whole
 *   point of claiming it is that a run started from the TUI goes through the
 *   same core entry as a run the tick started (`runScheduledTaskViaTuiHost`).
 *   The listener's `runCronTaskNow` is never used from here.
 * - **Everything else falls through.** `pause`/`resume`/`delete`/`autostart` are
 *   answered by `commands/schedule.ts`, which prints through the command row the
 *   same way every other registry command does; claiming them here would be a
 *   second copy of the mutation and its receipt.
 */

import type { CommandHandle } from "@/cli/commands/runner";
import {
  parseScheduleInvocation,
  tokenizeScheduleInput,
} from "@/cli/commands/schedule";
import { runScheduledTaskViaTuiHost } from "@/cli/helpers/schedule-host";
import {
  ensureScheduleTasksLoaded,
  setScheduleOverlayTarget,
} from "@/cli/helpers/schedule-store";
import type { ActiveOverlay, AppCommandRunner } from "./types";

/**
 * What these commands need, narrower than `SubmitHandlerContext` so a test can
 * build three fields instead of eighty. The real context satisfies it
 * structurally — `submit-topic-commands.ts` does the same, which is why this
 * file's call site is two lines in a pinned file.
 */
export interface ScheduleSubmitContext {
  agentId: string;
  commandRunner: AppCommandRunner;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => CommandHandle;
}

function isScheduleCommand(input: string): boolean {
  return input === "/schedule" || input.startsWith("/schedule ");
}

/**
 * Claim one `/schedule` invocation, or answer `null` so the submit handler keeps
 * dispatching (to the registry, which owns everything not listed above).
 */
export async function handleScheduleSubmit(
  msg: string,
  ctx: ScheduleSubmitContext,
): Promise<{ submitted: true } | null> {
  const input = msg.trim();
  if (!isScheduleCommand(input)) return null;

  // `/schedule` with no subcommand is the help text, and an unknown subcommand
  // is the registry's refusal: neither has a face to open.
  const args = tokenizeScheduleInput(input).slice(1);
  const invocation = parseScheduleInvocation(args);
  if (invocation.kind === "help" || invocation.kind === "error") return null;

  // Read the store before the face mounts, so its first frame is the data
  // rather than a "正在读取…" row (the rail usually got there first; this is
  // the append shell and the very first `/schedule list` of a session).
  ensureScheduleTasksLoaded();

  switch (invocation.kind) {
    case "list":
      setScheduleOverlayTarget({
        view: "list",
        allAgents: invocation.allAgents,
      });
      ctx.openOverlay(
        "schedule",
        "/schedule list",
        "打开计划任务…",
        "计划任务面板已关闭",
      );
      return { submitted: true };

    case "show":
      setScheduleOverlayTarget({ view: "detail", taskId: invocation.taskRef });
      ctx.openOverlay(
        "schedule-detail",
        `/schedule show ${invocation.taskRef}`,
        "打开计划任务详情…",
        "计划任务详情已关闭",
      );
      return { submitted: true };

    case "logs":
      setScheduleOverlayTarget({ view: "logs", taskId: invocation.taskRef });
      ctx.openOverlay(
        "schedule-logs",
        `/schedule logs ${invocation.taskRef}`,
        "打开运行记录…",
        "运行记录已关闭",
      );
      return { submitted: true };

    case "add":
      // The prefill travels through the same one-shot bridge the faces use; the
      // wizard consumes it on mount, so a partial `--cron …` is not asked twice.
      // The subcommand word itself is dropped: the wizard re-parses the flags.
      setScheduleOverlayTarget({ view: "wizard", args: args.slice(1) });
      ctx.openOverlay(
        "schedule-add",
        "/schedule add",
        "打开新建计划任务向导…",
        "新建计划任务已取消",
      );
      return { submitted: true };

    case "run": {
      const cmd = ctx.commandRunner.start(
        `/schedule run ${invocation.taskRef}`,
        `立即运行 ${invocation.taskRef}…`,
      );
      try {
        const result = await runScheduledTaskViaTuiHost(invocation.taskRef);
        if (result.kind === "unavailable") {
          cmd.fail(result.message);
          return { submitted: true };
        }
        if (result.kind === "started") {
          // A prompt task's run lasts as long as its turn, so the row reports
          // the hand-off instead of holding the command open; the run reports
          // itself through the notification and the run log.
          cmd.finish(
            `已开始运行「${result.taskName}」；结束后会发一条通知，记录在运行记录里。`,
            true,
          );
          return { submitted: true };
        }
        const succeeded = result.outcome === "success";
        cmd.finish(
          `已运行 ${invocation.taskRef}：${result.outcome}${
            result.error ? ` · ${result.error}` : ""
          }`,
          succeeded,
        );
      } catch (error) {
        cmd.fail(
          `运行 ${invocation.taskRef} 失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return { submitted: true };
    }

    default:
      return null;
  }
}
