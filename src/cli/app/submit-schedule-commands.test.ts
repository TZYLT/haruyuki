import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleScheduleSubmit,
  type ScheduleSubmitContext,
} from "@/cli/app/submit-schedule-commands";
import type { ActiveOverlay } from "@/cli/app/types";
import type { CommandHandle } from "@/cli/commands/runner";
import {
  peekScheduleOverlayTarget,
  resetScheduleStore,
  setScheduleSourceForTests,
} from "@/cli/helpers/schedule-store";

/**
 * The submit layer's half of `/schedule`: which forms are claimed and which fall
 * through to the registry.
 *
 * Claiming too much is a real failure mode here — it would swallow the help text
 * (`/schedule` alone), the receipt for a pause, or the registry's refusal of an
 * unknown option — so most of these tests assert a `null` return.
 */

interface Recorded {
  input: string;
  opening: string;
  dismissed: string;
  overlay: NonNullable<ActiveOverlay>;
}

function context(overrides: Partial<ScheduleSubmitContext> = {}): {
  ctx: ScheduleSubmitContext;
  opened: Recorded[];
  finished: Array<{ output: string; success: boolean | undefined }>;
  failed: string[];
} {
  const opened: Recorded[] = [];
  const finished: Array<{ output: string; success: boolean | undefined }> = [];
  const failed: string[] = [];
  const started: string[] = [];

  const handleFor = (): CommandHandle =>
    ({
      id: `cmd-${started.length}`,
      update: () => {},
      finish: (output: string, success?: boolean) => {
        finished.push({ output, success });
      },
      fail: (message: string) => {
        failed.push(message);
      },
      agentHint: undefined,
    }) as unknown as CommandHandle;

  const ctx: ScheduleSubmitContext = {
    agentId: "agent-1",
    // Only `start` is exercised; the runner handle is the minimal shape the
    // submit path reads back (`finish`/`fail`).
    commandRunner: {
      start: (input: string) => {
        started.push(input);
        return handleFor();
      },
      getHandle: (() =>
        null) as unknown as ScheduleSubmitContext["commandRunner"]["getHandle"],
    },
    openOverlay: (
      overlay: NonNullable<ActiveOverlay>,
      input: string,
      opening: string,
      dismissed: string,
    ) => {
      opened.push({ overlay, input, opening, dismissed });
      return handleFor();
    },
    ...overrides,
  };
  return { ctx, opened, finished, failed };
}

const EMPTY_SOURCE = {
  listTasks: () => [],
  nextDueAt: () => null,
  readRuns: () => [],
};

afterEach(() => {
  resetScheduleStore();
});

describe("claimed forms", () => {
  test("list opens the schedule panel, scoped to this agent by default", async () => {
    setScheduleSourceForTests(EMPTY_SOURCE);
    const { ctx, opened } = context();
    expect(await handleScheduleSubmit("/schedule list", ctx)).toEqual({
      submitted: true,
    });
    expect(opened[0]?.overlay).toBe("schedule");
    expect(peekScheduleOverlayTarget()).toEqual({
      view: "list",
      allAgents: false,
    });
  });

  test("list --all is the same face on the wider scope", async () => {
    setScheduleSourceForTests(EMPTY_SOURCE);
    const { ctx, opened } = context();
    await handleScheduleSubmit("/schedule list --all", ctx);
    expect(opened[0]?.overlay).toBe("schedule");
    expect(peekScheduleOverlayTarget()).toEqual({
      view: "list",
      allAgents: true,
    });
  });

  test("show names its task through the one-shot bridge", async () => {
    setScheduleSourceForTests(EMPTY_SOURCE);
    const { ctx, opened } = context();
    await handleScheduleSubmit("/schedule show a1b2c3d4", ctx);
    expect(opened[0]?.overlay).toBe("schedule-detail");
    expect(opened[0]?.input).toBe("/schedule show a1b2c3d4");
    expect(peekScheduleOverlayTarget()).toEqual({
      view: "detail",
      taskId: "a1b2c3d4",
    });
  });

  test("logs opens the run history for that task", async () => {
    setScheduleSourceForTests(EMPTY_SOURCE);
    const { ctx, opened } = context();
    await handleScheduleSubmit("/schedule logs 晨报", ctx);
    expect(opened[0]?.overlay).toBe("schedule-logs");
    expect(peekScheduleOverlayTarget()).toEqual({
      view: "logs",
      taskId: "晨报",
    });
  });

  test("a partial add opens the wizard, and carries the flags it was given", async () => {
    setScheduleSourceForTests(EMPTY_SOURCE);
    const { ctx, opened } = context();
    await handleScheduleSubmit(
      '/schedule add --cron "0 9 * * *" --prompt 总结今天的提交',
      ctx,
    );
    expect(opened[0]?.overlay).toBe("schedule-add");
    const target = peekScheduleOverlayTarget();
    expect(target.view).toBe("wizard");
    if (target.view === "wizard") {
      expect(target.args).toEqual([
        "--cron",
        "0 9 * * *",
        "--prompt",
        "总结今天的提交",
      ]);
    }
  });

  test("add with no flags still opens the wizard", async () => {
    setScheduleSourceForTests(EMPTY_SOURCE);
    const { ctx, opened } = context();
    await handleScheduleSubmit("/schedule add", ctx);
    expect(opened[0]?.overlay).toBe("schedule-add");
  });

  test("a fully specified add creates in one step and prints the receipt (R-5.12.1)", async () => {
    setScheduleSourceForTests(EMPTY_SOURCE);
    const root = await mkdtemp(join(tmpdir(), "haruyuki-schedule-add-"));
    const previousHome = process.env.HARUYUKI_HOME;
    process.env.HARUYUKI_HOME = root;
    try {
      const { ctx, opened, finished } = context();
      const result = await handleScheduleSubmit(
        '/schedule add --cron "0 9 * * *" --prompt 晨报 --target new --hidden --permission standard --no-catch-up',
        ctx,
      );
      // One step: no overlay, one receipt row with the created facts.
      expect(result).toEqual({ submitted: true });
      expect(opened).toHaveLength(0);
      expect(finished).toHaveLength(1);
      expect(finished[0]?.success).toBe(true);
      expect(finished[0]?.output).toContain("Created scheduled task");
      expect(finished[0]?.output).toContain("0 9 * * *");
      // R-5.2.5: the one-step path did not ask about autostart, and says so.
      expect(finished[0]?.output).toContain("Autostart not registered");
    } finally {
      if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
      else process.env.HARUYUKI_HOME = previousHome;
      await rm(root, { recursive: true });
    }
  });

  test("run goes through the TUI host and says so when there is none", async () => {
    setScheduleSourceForTests(EMPTY_SOURCE);
    const { ctx, finished, failed } = context();
    await handleScheduleSubmit("/schedule run a1b2c3d4", ctx);
    // No host in this process: the command row says why instead of pretending.
    expect(failed.join("\n")).toContain("TUI schedule host is not running");
    expect(finished).toHaveLength(0);
  });
});

describe("forms the registry owns", () => {
  test.each([
    "/schedule",
    "/schedule help",
    "/schedule pause a1b2c3d4",
    "/schedule resume 晨报",
    "/schedule delete a1b2c3d4",
    "/schedule autostart status",
    "/schedule autostart on",
    "/schedule bogus",
    "/schedule show",
  ])("%s falls through", async (input) => {
    const { ctx, opened } = context();
    expect(await handleScheduleSubmit(input, ctx)).toBeNull();
    expect(opened).toHaveLength(0);
  });

  test("another command is not touched", async () => {
    const { ctx, opened } = context();
    expect(await handleScheduleSubmit("/schedules", ctx)).toBeNull();
    expect(await handleScheduleSubmit("/schedule-ish list", ctx)).toBeNull();
    expect(opened).toHaveLength(0);
  });
});
