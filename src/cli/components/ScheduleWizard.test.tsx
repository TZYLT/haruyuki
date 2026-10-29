import { afterEach, describe, expect, test } from "bun:test";
import type {
  CreateScheduleResult,
  ScheduleAddDraft,
} from "@/cli/commands/schedule";
import { ScheduleWizard } from "@/cli/components/ScheduleWizard";
import {
  WIZARD_STEPS,
  wizardStepTitle,
} from "@/cli/components/ScheduleWizardSteps";
import { resetScheduleStore } from "@/cli/helpers/schedule-store";
import type { AutostartStatus } from "@/cron";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The creation wizard's last step, judged on the frame.
 *
 * The requirement this file exists for (R-5.12.2 / Q-… "注册失败可重试且保留
 * 已填内容") is a *sequence*: the task is created, the OS refuses the timer, the
 * face says both facts, `r` retries the registration alone, and nothing the user
 * typed is lost. It is also the one place in this track where a bug would create
 * a duplicate schedule, so the test counts creations, not just frames.
 *
 * The real registration is never reached: `registerAutostartEntry` is injected.
 * A wizard test that let M4's registrar run would write an OS entry on the
 * machine running the suite.
 */

const ENTER = "\r";
const DOWN = "\u001b[B";

/** Every field pre-filled, so the face opens near the end of the flow. */
const FULL_ARGS = [
  "--type",
  "prompt",
  "--prompt",
  "总结今天的提交",
  "--cron",
  "0 9 * * *",
  "--target",
  "new",
  "--visible",
  "--permission",
  "acceptEdits",
  "--catch-up",
  "--name",
  "晨报",
];

function created(draft: ScheduleAddDraft): CreateScheduleResult {
  return {
    kind: "created",
    taskId: "a1b2c3d4",
    name: draft.name ?? "晨报",
    cron: draft.cron ?? "0 9 * * *",
    timezone: draft.timezone ?? "Asia/Shanghai",
    permission: draft.permission ?? "acceptEdits",
  };
}

/** The registration the machine refuses once, then accepts. */
function flakyRegistrar(calls: {
  count: number;
}): () => Promise<AutostartStatus> {
  return async () => {
    calls.count += 1;
    if (calls.count === 1) {
      throw new Error("schtasks 被组策略拒绝");
    }
    return { registered: true, platform: "win32", method: "schtasks" };
  };
}

/** Walk from the pre-filled step to the autostart question. */
async function walkToAutostart(tty: {
  press(...keys: string[]): Promise<void>;
}): Promise<void> {
  // `--permission`/`--catch-up` are pre-filled in FULL_ARGS, so the walk from
  // the timezone step skips both: timezone → timeout → wait → name → autostart.
  for (let step = 0; step < 4; step += 1) {
    await tty.press(ENTER);
  }
}

afterEach(() => {
  resetScheduleStore();
  resetInkTtyState();
});

describe("the creation wizard", () => {
  test("a refused autostart keeps the task, keeps the input, and retries alone", async () => {
    const registrations = { count: 0 };
    const drafts: ScheduleAddDraft[] = [];
    const tty = mountInkTty(
      <ScheduleWizard
        agentId="agent-1"
        args={FULL_ARGS}
        onClose={() => {}}
        createTask={(draft) => {
          drafts.push(draft);
          return created(draft);
        }}
        registerAutostartEntry={flakyRegistrar(registrations)}
      />,
      { columns: 110, rows: 30 },
    );
    try {
      await walkToAutostart(tty);
      // The autostart question, answered "yes".
      await tty.press(ENTER);
      await Bun.sleep(40);

      const failedFrame = await tty.text();
      expect(failedFrame).toContain("任务已创建 · 自启未注册");
      expect(failedFrame).toContain("schtasks 被组策略拒绝");
      // The receipt still names the task and its schedule: the input survived
      // the failure instead of being rebuilt from an empty draft.
      expect(failedFrame).toContain("已创建计划任务 晨报");
      expect(failedFrame).toContain("0 9 * * *");
      expect(failedFrame).toContain("r 重试注册");
      expect(drafts).toHaveLength(1);

      await tty.press("r");
      await Bun.sleep(40);
      const retriedFrame = await tty.text();
      expect(retriedFrame).toContain("已创建");
      expect(retriedFrame).toContain("自启已注册");
      expect(retriedFrame).not.toContain("自启未注册");
      // The one thing a retry must never do.
      expect(drafts).toHaveLength(1);
      expect(registrations.count).toBe(2);
    } finally {
      tty.stop();
    }
  });

  test("answering '否' creates the task and never calls the registrar", async () => {
    const registrations = { count: 0 };
    const tty = mountInkTty(
      <ScheduleWizard
        agentId="agent-1"
        args={FULL_ARGS}
        onClose={() => {}}
        createTask={(draft) => created(draft)}
        registerAutostartEntry={flakyRegistrar(registrations)}
      />,
      { columns: 110, rows: 30 },
    );
    try {
      await walkToAutostart(tty);
      // The "否" row is the second one.
      await tty.press(DOWN, ENTER);
      await Bun.sleep(40);
      const frame = await tty.text();
      expect(frame).toContain("已创建");
      expect(frame).toContain("你选了「否」");
      expect(registrations.count).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("a creation failure says so and keeps the filled fields", async () => {
    const tty = mountInkTty(
      <ScheduleWizard
        agentId="agent-1"
        args={FULL_ARGS}
        onClose={() => {}}
        createTask={() => ({
          kind: "error",
          message: "缺少必填参数：--target",
        })}
        registerAutostartEntry={async () => ({
          registered: false,
          platform: "win32",
          method: null,
        })}
      />,
      { columns: 110, rows: 30 },
    );
    try {
      await walkToAutostart(tty);
      await tty.press(ENTER);
      await Bun.sleep(40);
      const frame = await tty.text();
      expect(frame).toContain("创建失败");
      expect(frame).toContain("缺少必填参数：--target");
      expect(frame).toContain("已填内容都还在");

      // Escape goes back to the question, and the draft is still the same one:
      // the wizard rebuilds no field from scratch.
      await tty.press("\u001b");
      await Bun.sleep(40);
      expect(await tty.text()).toContain("12/12 开机自启");
    } finally {
      tty.stop();
    }
  });

  test("pre-filled --permission/--no-catch-up are not re-asked and survive Enter", async () => {
    const drafts: ScheduleAddDraft[] = [];
    const tty = mountInkTty(
      <ScheduleWizard
        agentId="agent-1"
        args={[
          "--type",
          "prompt",
          "--prompt",
          "总结今天的提交",
          "--cron",
          "0 9 * * *",
          "--target",
          "new",
          "--visible",
          "--permission",
          "unrestricted",
          "--no-catch-up",
          "--name",
          "晨报",
        ]}
        onClose={() => {}}
        createTask={(draft) => {
          drafts.push(draft);
          return created(draft);
        }}
        registerAutostartEntry={async () => ({
          registered: true,
          platform: "win32",
          method: "schtasks",
        })}
      />,
      { columns: 110, rows: 30 },
    );
    try {
      // It opens on the timezone step: permission and catch-up are answered.
      expect(await tty.text()).toContain("6/12 时区");
      await walkToAutostart(tty);
      expect(await tty.text()).toContain("12/12 开机自启");
      await tty.press(ENTER);
      await Bun.sleep(40);
      expect(drafts).toHaveLength(1);
      // The old bug: Enter on the default permission row rewrote unrestricted to
      // standard, and "--no-catch-up" came back as 补跑.
      expect(drafts[0]?.permission).toBe("unrestricted");
      expect(drafts[0]?.catchUp).toBe(false);
    } finally {
      tty.stop();
    }
  });

  test("--target new without --visible/--hidden asks the visibility (M3 #4)", async () => {
    const drafts: ScheduleAddDraft[] = [];
    const tty = mountInkTty(
      <ScheduleWizard
        agentId="agent-1"
        args={[
          "--type",
          "prompt",
          "--prompt",
          "总结今天的提交",
          "--cron",
          "0 9 * * *",
          "--target",
          "new",
          "--permission",
          "acceptEdits",
          "--catch-up",
        ]}
        onClose={() => {}}
        createTask={(draft) => {
          drafts.push(draft);
          return created(draft);
        }}
        registerAutostartEntry={async () => ({
          registered: true,
          platform: "win32",
          method: "schtasks",
        })}
      />,
      { columns: 110, rows: 30 },
    );
    try {
      // It does not skip the target step: the visibility is still unanswered.
      expect(await tty.text()).toContain("2/12 目标");
      await tty.press(DOWN, ENTER);
      await Bun.sleep(40);
      // The payload is pre-filled, so the flow continues at the time step.
      expect(await tty.text()).toContain("6/12 时区");
      await walkToAutostart(tty);
      await tty.press(ENTER);
      await Bun.sleep(40);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.target).toEqual({ kind: "new", hidden: true });
    } finally {
      tty.stop();
    }
  });

  test("double Enter on the autostart question creates one task (M3 #6)", async () => {
    const drafts: ScheduleAddDraft[] = [];
    let registrations = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tty = mountInkTty(
      <ScheduleWizard
        agentId="agent-1"
        args={FULL_ARGS}
        onClose={() => {}}
        createTask={(draft) => {
          drafts.push(draft);
          return created(draft);
        }}
        registerAutostartEntry={async () => {
          registrations += 1;
          await gate;
          return { registered: true, platform: "win32", method: "schtasks" };
        }}
      />,
      { columns: 110, rows: 30 },
    );
    try {
      await walkToAutostart(tty);
      // Two Enter presses while the registration is still in flight.
      await tty.press(ENTER, ENTER);
      expect(drafts).toHaveLength(1);
      release();
      await Bun.sleep(80);
      expect(drafts).toHaveLength(1);
      expect(registrations).toBe(1);
    } finally {
      release();
      tty.stop();
    }
  });

  test("every step title is unique and numbered from one list (M3 #15)", () => {
    const titles = WIZARD_STEPS.map((entry) => wizardStepTitle(entry.id));
    expect(new Set(titles).size).toBe(titles.length);
    expect(wizardStepTitle("timeout")).toBe(`9/${WIZARD_STEPS.length} 超时`);
    expect(wizardStepTitle("wait")).toBe(`10/${WIZARD_STEPS.length} 等待`);
    expect(wizardStepTitle("autostart")).toBe(
      `12/${WIZARD_STEPS.length} 开机自启`,
    );
    // The sub-steps share their parent's slot instead of taking a new number.
    expect(wizardStepTitle("schedule-mode")).toBe(wizardStepTitle("schedule"));
    expect(wizardStepTitle("conversation-pick")).toBe(
      wizardStepTitle("conversation"),
    );
  });
});
