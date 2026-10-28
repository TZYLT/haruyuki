import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  createScheduleTask,
  formatScheduleCreatedLines,
  formatScheduleHelp,
  handleScheduleCommand,
  parseScheduleInvocation,
  resolveScheduleTask,
  SCHEDULE_SUBCOMMANDS,
  tokenizeScheduleInput,
} from "@/cli/commands/schedule";
import { resetScheduleStore } from "@/cli/helpers/schedule-store";
import { listScheduleTasks } from "@/cron";

/**
 * `/schedule`'s entry points that do not need a terminal: the parser every other
 * caller switches on, the help (R-5.12.1's nine subcommands), the one-step
 * `add` (US-5) and the receipts.
 */

const TEST_DIR = path.join(import.meta.dir, "__schedule_command_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  resetScheduleStore();
});

afterEach(() => {
  resetScheduleStore();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

/** The exact one-step form US-5 lists. */
const ONE_STEP = [
  "add",
  "--cron",
  "0 9 * * *",
  "--prompt",
  "总结今天的提交",
  "--target",
  "new",
  "--visible",
  "--permission",
  "acceptEdits",
  "--catch-up",
];

describe("the hub", () => {
  test("names all nine subcommands in the help", () => {
    const help = formatScheduleHelp();
    expect(SCHEDULE_SUBCOMMANDS).toHaveLength(9);
    for (const subcommand of SCHEDULE_SUBCOMMANDS) {
      expect(help).toContain(`/schedule ${subcommand}`);
    }
    // The permission tiers' limits are stated where a user picks one.
    expect(help).toContain("shell 仍被拒");
    expect(help).toContain("不承诺禁删/禁网");
  });

  test("no subcommand, help and an unknown word all answer with the help", async () => {
    expect(parseScheduleInvocation([])).toEqual({ kind: "help" });
    expect(parseScheduleInvocation(["help"])).toEqual({ kind: "help" });
    expect(await handleScheduleCommand([])).toContain("/schedule list");
    expect(await handleScheduleCommand(["nope"])).toContain("未知子命令 nope");
  });

  test("a subcommand without its task is refused by name", () => {
    const result = parseScheduleInvocation(["show"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error")
      expect(result.message).toContain("/schedule show");
  });

  test("list reads the agent's tasks, and --all reads everyone's", async () => {
    createScheduleTask({
      agentId: "agent-1",
      draft: {
        type: "prompt",
        payload: "p1",
        cron: "0 9 * * *",
        recurring: true,
        target: { kind: "new", hidden: false },
        permission: "acceptEdits",
        catchUp: false,
        name: "晨报",
      },
    });
    createScheduleTask({
      agentId: "agent-2",
      draft: {
        type: "prompt",
        payload: "p2",
        cron: "0 10 * * *",
        recurring: true,
        target: { kind: "new", hidden: false },
        permission: "acceptEdits",
        catchUp: false,
        name: "别人的",
      },
    });

    const mine = await handleScheduleCommand(["list"], { agentId: "agent-1" });
    expect(mine).toContain("晨报");
    expect(mine).not.toContain("别人的");
    const all = await handleScheduleCommand(["list", "--all"], {
      agentId: "agent-1",
    });
    expect(all).toContain("晨报");
    expect(all).toContain("别人的");
  });
});

describe("the parser", () => {
  test("the US-5 one-step form has every required flag", () => {
    const parsed = parseScheduleInvocation(ONE_STEP);
    expect(parsed.kind).toBe("add");
    if (parsed.kind !== "add") return;
    expect(parsed.missing).toEqual([]);
    expect(parsed.draft.cron).toBe("0 9 * * *");
    expect(parsed.draft.payload).toBe("总结今天的提交");
    expect(parsed.draft.permission).toBe("acceptEdits");
    expect(parsed.draft.catchUp).toBe(true);
    expect(parsed.draft.hidden).toBe(false);
  });

  test("an incomplete form names the flags it still needs", () => {
    const parsed = parseScheduleInvocation(["add", "--prompt", "hi"]);
    expect(parsed.kind).toBe("add");
    if (parsed.kind !== "add") return;
    expect(parsed.missing).toContain("--cron|--every|--at");
    expect(parsed.missing).toContain("--target");
    expect(parsed.missing).toContain("--permission");
    expect(parsed.missing).toContain("--catch-up|--no-catch-up");
    // A prompt with spaces is one value, and a missing visible/hidden choice is
    // only asked about once there is a target to attach it to.
    expect(parsed.draft.payload).toBe("hi");
    expect(parsed.missing).not.toContain("--visible|--hidden");
    expect(parsed.missing).not.toContain("--prompt|--command");
  });

  test("--target new without a visibility flag asks for one", () => {
    const parsed = parseScheduleInvocation([
      ...ONE_STEP.slice(0, ONE_STEP.indexOf("--visible")),
      ...ONE_STEP.slice(ONE_STEP.indexOf("--visible") + 1),
    ]);
    if (parsed.kind !== "add") throw new Error("expected add");
    expect(parsed.missing).toEqual(["--visible|--hidden"]);
  });

  test("--hidden sets the target, whichever order the flags arrive in", () => {
    const parsed = parseScheduleInvocation([
      "add",
      "--hidden",
      "--target",
      "new",
      "--prompt",
      "p",
      "--every",
      "1d",
      "--permission",
      "standard",
      "--no-catch-up",
    ]);
    if (parsed.kind !== "add") throw new Error("expected add");
    expect(parsed.draft.target).toEqual({ kind: "new", hidden: true });
    expect(parsed.draft.cron).toBe("0 0 * * *");
    expect(parsed.draft.catchUp).toBe(false);
    expect(parsed.missing).toEqual([]);
  });

  test("quoted text survives, and unquoted values are read greedily", () => {
    expect(tokenizeScheduleInput('/schedule add --prompt "a b c"')).toEqual([
      "/schedule",
      "add",
      "--prompt",
      "a b c",
    ]);
    const parsed = parseScheduleInvocation([
      "add",
      "--cron",
      "0",
      "9",
      "*",
      "*",
      "*",
      "--prompt",
      "p",
      "--target",
      "existing:conv-1",
      "--permission",
      "unrestricted",
      "--catch-up",
    ]);
    if (parsed.kind !== "add") throw new Error("expected add");
    expect(parsed.draft.cron).toBe("0 9 * * *");
    expect(parsed.draft.target).toEqual({
      kind: "existing",
      conversation_id: "conv-1",
    });
    expect(parsed.missing).toEqual([]);
  });

  test("bad values are refused with the value named", () => {
    const invalidCron = parseScheduleInvocation([
      "add",
      "--cron",
      "nope",
      "--prompt",
      "p",
    ]);
    expect(invalidCron.kind).toBe("add");
    expect(parseScheduleInvocation(["add", "--permission", "strict"])).toEqual({
      kind: "error",
      message: "权限只接受 standard / acceptEdits / unrestricted",
    });
    expect(parseScheduleInvocation(["add", "--every", "0m"]).kind).toBe(
      "error",
    );
    expect(parseScheduleInvocation(["autostart", "maybe"]).kind).toBe("error");
  });
});

describe("task references", () => {
  const tasks = [
    { id: "aaaaaaaa", name: "晨报" },
    { id: "bbbbbbbb", name: "周报" },
    { id: "cccccccc", name: "晨报" },
  ] as never[];

  test("an id wins, a unique name resolves, an ambiguous one is refused", () => {
    expect(resolveScheduleTask("bbbbbbbb", tasks)).toMatchObject({
      task: { id: "bbbbbbbb" },
    });
    expect(resolveScheduleTask("周报", tasks)).toMatchObject({
      task: { id: "bbbbbbbb" },
    });
    const ambiguous = resolveScheduleTask("晨报", tasks);
    expect("error" in ambiguous).toBe(true);
    if ("error" in ambiguous) expect(ambiguous.error).toContain("请用 id");
  });
});

describe("the one-step creation", () => {
  test("creates the task the flags describe, and the store can see it", () => {
    const parsed = parseScheduleInvocation(ONE_STEP);
    if (parsed.kind !== "add") throw new Error("expected add");
    const result = createScheduleTask({
      agentId: "agent-1",
      draft: parsed.draft,
    });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.name).toBe("提示: 总结今天的提交");
    expect(result.cron).toBe("0 9 * * *");
    expect(listScheduleTasks()).toHaveLength(1);
    // The receipt names what matters: the task, its schedule, its permission.
    expect(formatScheduleCreatedLines(result)[0]).toContain("已创建计划任务");
    expect(formatScheduleCreatedLines(result)[1]).toContain("可编辑");
  });

  test("a store refusal becomes one message, not a throw", () => {
    const result = createScheduleTask({
      agentId: "agent-1",
      draft: {
        type: "prompt",
        payload: "p",
        cron: "not a cron",
        recurring: true,
        target: { kind: "new", hidden: false },
        permission: "standard",
        catchUp: false,
      },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message.toLowerCase()).toContain("cron");
    }
  });

  test("the receipt says whether the OS timer exists, in all three answers", () => {
    const created = {
      kind: "created" as const,
      taskId: "a1b2c3d4",
      name: "晨报",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      permission: "acceptEdits" as const,
    };
    expect(
      formatScheduleCreatedLines(created, { autostart: "declined" }).join("\n"),
    ).toContain("你选了「否」");
    expect(
      formatScheduleCreatedLines(created, { autostart: "registered" }).join(
        "\n",
      ),
    ).toContain("自启已注册");
    const failed = formatScheduleCreatedLines(created, {
      autostart: "failed",
      detail: "schtasks 被拒绝",
    }).join("\n");
    expect(failed).toContain("任务已创建，自启未注册");
    expect(failed).toContain("schtasks 被拒绝");
  });
});

describe("the registry handler", () => {
  test("pause and resume answer with a receipt and change the store", async () => {
    const parsed = parseScheduleInvocation(ONE_STEP);
    if (parsed.kind !== "add") throw new Error("expected add");
    const created = createScheduleTask({
      agentId: "agent-1",
      draft: parsed.draft,
    });
    if (created.kind !== "created") throw new Error("expected created");

    expect(
      await handleScheduleCommand(["pause", created.taskId], {
        agentId: "agent-1",
      }),
    ).toContain("已暂停");
    expect(listScheduleTasks()[0]?.status).toBe("paused");
    expect(
      await handleScheduleCommand(["resume", created.taskId], {
        agentId: "agent-1",
      }),
    ).toContain("已恢复");
    expect(listScheduleTasks()[0]?.status).toBe("active");
    expect(
      await handleScheduleCommand(["delete", created.taskId], {
        agentId: "agent-1",
      }),
    ).toContain("已删除");
    expect(listScheduleTasks()).toHaveLength(0);
  });

  test("show prints the detail, and a missing task is named", async () => {
    const parsed = parseScheduleInvocation(ONE_STEP);
    if (parsed.kind !== "add") throw new Error("expected add");
    const created = createScheduleTask({
      agentId: "agent-1",
      draft: parsed.draft,
    });
    if (created.kind !== "created") throw new Error("expected created");
    const detail = await handleScheduleCommand(["show", created.taskId], {
      agentId: "agent-1",
    });
    expect(detail).toContain("类型      prompt");
    expect(detail).toContain("权限      可编辑");
    expect(
      await handleScheduleCommand(["show", "nope"], { agentId: "agent-1" }),
    ).toContain("找不到任务 nope");
  });

  test("add without enough flags points at the wizard instead of creating", async () => {
    const output = await handleScheduleCommand(["add", "--prompt", "hi"], {
      agentId: "agent-1",
    });
    expect(output).toContain("缺少必填参数");
    expect(output).toContain("向导");
    expect(listScheduleTasks()).toHaveLength(0);
  });

  test("run says it needs the TUI, and never runs anything itself", async () => {
    expect(
      await handleScheduleCommand(["run", "a1b2c3d4"], { agentId: "agent-1" }),
    ).toContain("TUI");
  });
});
