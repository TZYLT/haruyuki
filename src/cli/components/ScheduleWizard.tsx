/**
 * `/schedule add` — the creation wizard (R-5.12.1/R-5.12.2).
 *
 * The order is the requirement's: type → target → content → time → permission →
 * catch-up → timeout → wait → name → autostart. Every step keeps its value in
 * component state, which is what makes the last step's failure path work: when
 * the OS refuses the autostart entry the task is **already created**, the wizard
 * shows the receipt with "自启未注册", and `r` retries the registration alone —
 * no second task, no lost field.
 *
 * Two things are injectable on purpose:
 *
 * - `createTask` — the default is the real `addTask` (through
 *   `commands/schedule.ts`, so the one-step form and this wizard cannot drift on
 *   validation or on which flags are required).
 * - `registerAutostartEntry` — the default is M4's `registerAutostart`. A test
 *   that let the real one run would write an OS entry on the machine running it.
 *
 * The three step frames, the pure parsers and the pre-filled opening step live
 * in `ScheduleWizardSteps.tsx`: this file is the state machine, and the 1,000
 * line ceiling is the point where a reader stops holding a face in one pass.
 *
 * One key owner at a time (`overlay/README.md`, rules 1 and 8): a picker step
 * brings the toolkit's cancel and binds nothing else here; the text steps mount
 * `wizardBindings`; the receipt steps bind their own keys.
 */

import { Box } from "ink";
import { useCallback, useMemo, useState } from "react";
import {
  type CreateScheduleResult,
  createScheduleTask,
  formatScheduleCreatedLines,
  type ScheduleAddDraft,
} from "@/cli/commands/schedule";
import { colors } from "@/cli/components/colors";
import {
  commandAllowed,
  isTimeZone,
  looksLikeConversationId,
  PERMISSION_ROWS,
  PickerStep,
  parseMinutes,
  parseScheduleInput,
  prefillFromArgs,
  type ScheduleChoice,
  type ScheduleMode,
  StepHint,
  TextStep,
  type WizardStep,
} from "@/cli/components/ScheduleWizardSteps";
import { Text } from "@/cli/components/Text";
import { shortId } from "@/cli/helpers/schedule-store";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import type { SingleSelectItem } from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import {
  type AutostartStatus,
  type PermissionTier,
  registerAutostart,
  TASK_COMMAND_WHITELIST,
} from "@/cron";

/** One conversation the target step can point at (R-5.12.3). */
export interface ScheduleConversationChoice {
  id: string;
  label: string;
}

export type ScheduleConversationSearch = (
  query: string,
) => Promise<ScheduleConversationChoice[]>;

export interface ScheduleWizardProps {
  agentId: string;
  /** The conversation the wizard was opened from, offered as a row. */
  currentConversationId?: string;
  onClose: () => void;
  /** `/schedule add …` partial flags, pre-filled (missing ones are still asked). */
  args?: readonly string[];
  /** Injected by tests; defaults to the real creation path. */
  createTask?: (
    draft: ScheduleAddDraft,
    agentId: string,
  ) => CreateScheduleResult;
  /** Injected by tests; defaults to M4's registration. */
  registerAutostartEntry?: () => Promise<AutostartStatus>;
  /** Injected by tests; defaults to the backend's keyword search. */
  searchConversations?: ScheduleConversationSearch;
}

/** The default conversation search: the backend's own summary search. */
async function backendConversationSearch(
  agentId: string,
  query: string,
): Promise<ScheduleConversationChoice[]> {
  const { getBackend } = await import("@/backend");
  const listed = (await getBackend().listConversations({
    agent_id: agentId,
    limit: 10,
    ...(query ? { summary_search: query } : {}),
  })) as unknown as Array<{ id: string; summary?: string | null }>;
  return listed.map((conversation) => ({
    id: conversation.id,
    label: conversation.summary?.trim() || conversation.id,
  }));
}

export function ScheduleWizard({
  agentId,
  currentConversationId,
  onClose,
  args,
  createTask,
  registerAutostartEntry,
  searchConversations,
}: ScheduleWizardProps) {
  const width = Math.max(1, useTerminalWidth() - 2);
  const prefill = useMemo(() => prefillFromArgs(args), [args]);

  const [type, setType] = useState<"prompt" | "command">(
    prefill.draft.type ?? "prompt",
  );
  const [targetMode, setTargetMode] = useState<"new" | "existing">(
    prefill.draft.target?.kind === "existing" ? "existing" : "new",
  );
  const [hidden, setHidden] = useState<boolean>(prefill.draft.hidden ?? false);
  const [conversationId, setConversationId] = useState(
    prefill.draft.target?.kind === "existing"
      ? prefill.draft.target.conversation_id === "default"
        ? ""
        : prefill.draft.target.conversation_id
      : "",
  );
  const [payload, setPayload] = useState(prefill.draft.payload ?? "");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    prefill.mode ?? "cron",
  );
  const [scheduleInput, setScheduleInput] = useState(prefill.raw ?? "");
  const [schedule, setSchedule] = useState<ScheduleChoice>({
    cron: prefill.draft.cron,
    recurring: prefill.draft.recurring ?? true,
    scheduledFor: prefill.draft.scheduledFor,
  });
  const [timezone, setTimezone] = useState(
    prefill.draft.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [permission, setPermission] = useState<PermissionTier | null>(
    prefill.draft.permission ?? null,
  );
  const [catchUp, setCatchUp] = useState<boolean | null>(
    prefill.draft.catchUp ?? null,
  );
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    String(prefill.draft.timeoutMinutes ?? 30),
  );
  const [waitMinutes, setWaitMinutes] = useState(
    String(prefill.draft.waitMinutes ?? 10),
  );
  const [name, setName] = useState(prefill.draft.name ?? "");

  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<ScheduleConversationChoice[]>([]);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateScheduleResult | null>(null);
  const [receipt, setReceipt] = useState<string[]>([]);

  const wizard = useWizard<WizardStep>({ initial: prefill.initialStep });
  const { step, canGoBack, goTo, back } = wizard;

  const leave = useCallback(() => {
    setError(null);
    if (canGoBack) {
      back();
      return;
    }
    onClose();
  }, [back, canGoBack, onClose]);

  const draft: ScheduleAddDraft = useMemo(() => {
    const target: ScheduleAddDraft["target"] =
      targetMode === "existing"
        ? { kind: "existing", conversation_id: conversationId || "default" }
        : { kind: "new", hidden };
    return {
      type,
      payload: payload.trim() || undefined,
      cron: schedule.cron,
      recurring: schedule.recurring,
      scheduledFor: schedule.scheduledFor,
      timezone: timezone.trim() || undefined,
      target,
      hidden,
      permission: permission ?? undefined,
      catchUp: catchUp ?? undefined,
      timeoutMinutes: parseMinutes(timeoutMinutes),
      waitMinutes: parseMinutes(waitMinutes),
      name: name.trim() || undefined,
    };
  }, [
    catchUp,
    conversationId,
    hidden,
    name,
    payload,
    permission,
    schedule,
    targetMode,
    timeoutMinutes,
    timezone,
    type,
    waitMinutes,
  ]);

  /**
   * Register the OS entry for a task that already exists.
   *
   * Runs on the failure path too: a retry must not create a second task, and the
   * receipt keeps saying "任务已创建，自启未注册" until a retry succeeds.
   */
  const registerFor = useCallback(
    async (result: CreateScheduleResult) => {
      setRegisterError(null);
      try {
        const status = await (registerAutostartEntry ?? registerAutostart)();
        if (!status.registered) {
          setRegisterError(status.error ?? "注册未生效");
          setReceipt(
            formatScheduleCreatedLines(result, {
              autostart: "failed",
              detail: status.error,
            }),
          );
          return;
        }
        setReceipt(
          formatScheduleCreatedLines(result, { autostart: "registered" }),
        );
      } catch (registerFailure) {
        const message =
          registerFailure instanceof Error
            ? registerFailure.message
            : String(registerFailure);
        setRegisterError(message);
        setReceipt(
          formatScheduleCreatedLines(result, {
            autostart: "failed",
            detail: message,
          }),
        );
      }
    },
    [registerAutostartEntry],
  );

  /** Create the task once, then ask about autostart. A refusal keeps the task. */
  const create = useCallback(
    (wantAutostart: boolean) => {
      setError(null);
      const result = createTask
        ? createTask(draft, agentId)
        : createScheduleTask({ agentId, draft });
      setCreated(result);
      if (result.kind === "error") {
        setError(result.message);
        goTo("create-failed");
        return;
      }
      if (!wantAutostart) {
        setReceipt(
          formatScheduleCreatedLines(result, { autostart: "declined" }),
        );
        goTo("done");
        return;
      }
      void registerFor(result).then(() => goTo("done"));
    },
    [agentId, createTask, draft, goTo, registerFor],
  );

  const retryRegistration = useCallback(() => {
    if (!created || created.kind !== "created") return;
    void registerFor(created);
  }, [created, registerFor]);

  // ── Keys: exactly one owner per step ──────────────────────────────
  const isTextStep =
    step === "payload" ||
    step === "conversation" ||
    step === "schedule" ||
    step === "timezone" ||
    step === "timeout" ||
    step === "wait" ||
    step === "name";
  useKeyBindings("schedule-wizard", [
    {
      scope: "overlay",
      bindings: isTextStep
        ? wizardBindings({ canGoBack, onBack: leave, onCancel: onClose })
        : step === "done"
          ? [
              {
                id: "schedule-wizard.done.close",
                chords: [{ key: "escape" }, { key: "return" }],
                run: () => {
                  onClose();
                  return "consumed" as const;
                },
              },
              {
                id: "schedule-wizard.done.interrupt",
                chords: [{ key: "c", ctrl: true }],
                run: () => {
                  onClose();
                  return "consumed" as const;
                },
              },
              {
                id: "schedule-wizard.done.retry",
                chords: [{ key: "r" }],
                run: () => {
                  if (registerError === null) return "declined" as const;
                  retryRegistration();
                  return "consumed" as const;
                },
              },
            ]
          : step === "create-failed"
            ? wizardBindings({
                canGoBack: true,
                onBack: leave,
                onCancel: onClose,
              })
            : [],
    },
  ]);

  switch (step) {
    case "type":
      return (
        <PickerStep
          command="/schedule add"
          title="新建计划任务 · 1/10 类型"
          hint="prompt 往会话里发一段话；command 跑一个能无人值守跑完的命令。"
          items={[
            {
              key: "prompt",
              label: "prompt",
              description: "注入一段用户消息并跑一轮",
            },
            {
              key: "command",
              label: "command",
              description: `只允许 ${[...TASK_COMMAND_WHITELIST].join(" / ")}`,
            },
          ]}
          onSelect={(key) => {
            setType(key === "command" ? "command" : "prompt");
            goTo("target");
          }}
          onCancel={leave}
          footer="Enter 选择 · ↑↓ 移动 · Esc 取消"
          width={width}
        />
      );

    case "target":
      return (
        <PickerStep
          command="/schedule add"
          title="2/10 目标"
          hint="prompt 任务落在哪个会话：每次新建，还是写进一个已有会话。"
          items={[
            {
              key: "new-visible",
              label: "每次新建可见会话",
              description: "任务名作为会话摘要",
            },
            {
              key: "new-hidden",
              label: "每次新建隐藏会话",
              description: "不进会话列表，可在 /hidden-sessions 里看",
            },
            {
              key: "existing",
              label: "写进已有会话",
              description: "该会话必须存在且非隐藏",
            },
          ]}
          onSelect={(key) => {
            setError(null);
            if (key === "new-visible") {
              setTargetMode("new");
              setHidden(false);
              goTo("payload");
              return;
            }
            if (key === "new-hidden") {
              setTargetMode("new");
              setHidden(true);
              goTo("payload");
              return;
            }
            setTargetMode("existing");
            goTo("conversation");
          }}
          onCancel={leave}
          footer="Enter 选择 · ↑↓ 移动 · Esc 取消"
          width={width}
        />
      );

    case "conversation":
      return (
        <TextStep
          command="/schedule add"
          title="3/10 会话"
          hint={
            currentConversationId
              ? `粘贴会话 id，或输入关键词搜索最近 10 个。当前会话 ${shortId(currentConversationId)}。`
              : "粘贴会话 id，或输入关键词搜索最近 10 个会话。"
          }
          value={conversationId}
          onChange={(value) => {
            setConversationId(value);
            setError(null);
          }}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              setError("需要一个会话 id（或 default）。");
              return;
            }
            if (trimmed === "default" || looksLikeConversationId(trimmed)) {
              setConversationId(trimmed);
              goTo("payload");
              return;
            }
            setError(null);
            setChoices([]);
            goTo("conversation-pick");
            void (
              searchConversations
                ? searchConversations(trimmed)
                : backendConversationSearch(agentId, trimmed)
            )
              .then((found) => setChoices(found))
              .catch((searchError) => {
                setChoices([]);
                setError(
                  searchError instanceof Error
                    ? searchError.message
                    : String(searchError),
                );
              });
          }}
          placeholder="会话 id / default / 关键词"
          error={error}
          footer="Enter 确认 · Esc 返回"
          width={width}
        />
      );

    case "conversation-pick": {
      const items: SingleSelectItem[] =
        choices.length > 0
          ? choices.map((choice) => ({
              key: choice.id,
              label: choice.label,
              description: shortId(choice.id),
            }))
          : [
              currentConversationId
                ? {
                    key: currentConversationId,
                    label: "当前会话",
                    description: shortId(currentConversationId),
                  }
                : {
                    key: "default",
                    label: "default",
                    description: "agent 的默认会话",
                  },
            ];
      return (
        <PickerStep
          command="/schedule add"
          title="3/10 选择会话"
          hint={
            choices.length > 0
              ? `最近 ${choices.length} 个匹配的会话。`
              : "没有搜到可选的会话：Esc 回去直接粘 id，或选默认会话。"
          }
          items={items}
          onSelect={(key) => {
            setConversationId(key);
            goTo("payload");
          }}
          onCancel={leave}
          footer="Enter 选择 · Esc 返回输入"
          width={width}
        />
      );
    }

    case "payload":
      return (
        <TextStep
          command="/schedule add"
          title={type === "command" ? "4/10 命令（参数原样透传）" : "4/10 内容"}
          hint={
            type === "command"
              ? `只允许 ${[...TASK_COMMAND_WHITELIST].join(" / ")}；如 /compact 3。`
              : "这一轮会作为一条用户消息发给会话。"
          }
          value={payload}
          onChange={(value) => {
            setPayload(value);
            setError(null);
          }}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              setError("内容不能为空。");
              return;
            }
            if (type === "command") {
              const command = trimmed.replace(/^\//, "").split(/\s+/)[0] ?? "";
              if (!commandAllowed(command)) {
                setError(
                  `命令 ${command || "(空)"} 不在白名单（${[...TASK_COMMAND_WHITELIST].join(" / ")}）。`,
                );
                return;
              }
            }
            setPayload(trimmed);
            setError(null);
            goTo(schedule.cron ? "timezone" : "schedule-mode");
          }}
          placeholder={type === "command" ? "/compact 3" : "要发给会话的内容"}
          error={error}
          footer="Enter 下一步 · Esc 返回"
          width={width}
        />
      );

    case "schedule-mode":
      return (
        <PickerStep
          command="/schedule add"
          title="5/10 时间"
          hint="什么时候跑。cron 表达式最精确，间隔与一次性是它的常用写法。"
          items={[
            {
              key: "cron",
              label: "cron 表达式",
              description: "5 字段，如 0 9 * * *",
            },
            { key: "every", label: "间隔", description: "5m / 2h / 1d" },
            {
              key: "at",
              label: "一次性时间",
              description: '"in 45m" / "3:00pm"',
            },
          ]}
          onSelect={(key) => {
            setScheduleMode(
              key === "every" ? "every" : key === "at" ? "at" : "cron",
            );
            setScheduleInput("");
            setError(null);
            goTo("schedule");
          }}
          onCancel={leave}
          footer="Enter 选择 · Esc 返回"
          width={width}
        />
      );

    case "schedule":
      return (
        <TextStep
          command="/schedule add"
          title="5/10 时间"
          hint={
            scheduleMode === "cron"
              ? "5 字段 cron：分 时 日 月 周。"
              : scheduleMode === "every"
                ? "间隔：5m、2h、1d（最小 1 分钟）。"
                : '一次性时间："in 45m"、"3:00pm" 或带时区的 RFC 3339。'
          }
          value={scheduleInput}
          onChange={(value) => {
            setScheduleInput(value);
            setError(null);
          }}
          onSubmit={(value) => {
            const parsed = parseScheduleInput(scheduleMode, value.trim());
            if (!parsed) {
              setError(
                scheduleMode === "cron"
                  ? "不是合法的 5 字段 cron 表达式。"
                  : scheduleMode === "every"
                    ? "无法识别间隔（试试 5m、2h、1d）。"
                    : '无法识别时间（试试 "in 45m"、"3:00pm"）。',
              );
              return;
            }
            setScheduleInput(value.trim());
            setSchedule(parsed);
            setError(null);
            goTo("timezone");
          }}
          placeholder={
            scheduleMode === "cron"
              ? "0 9 * * *"
              : scheduleMode === "every"
                ? "1d"
                : "in 45m"
          }
          error={error}
          footer="Enter 下一步 · Esc 返回"
          width={width}
        />
      );

    case "timezone":
      return (
        <TextStep
          command="/schedule add"
          title="6/10 时区"
          hint="IANA 时区；cron 的时间按这个时区解释。"
          value={timezone}
          onChange={(value) => {
            setTimezone(value);
            setError(null);
          }}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed && !isTimeZone(trimmed)) {
              setError("不是合法的 IANA 时区。");
              return;
            }
            setTimezone(trimmed);
            setError(null);
            goTo("permission");
          }}
          placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
          error={error}
          footer="Enter 下一步 · Esc 返回"
          width={width}
        />
      );

    case "permission":
      return (
        <PickerStep
          command="/schedule add"
          title="7/10 权限"
          hint="无人值守时任何审批请求都会被拒绝，所以档位就是能做什么的全部。"
          items={PERMISSION_ROWS}
          onSelect={(key) => {
            if (
              key === "standard" ||
              key === "acceptEdits" ||
              key === "unrestricted"
            ) {
              setPermission(key);
            }
            goTo("catch-up");
          }}
          onCancel={leave}
          footer="Enter 选择 · Esc 返回"
          width={width}
        />
      );

    case "catch-up":
      return (
        <PickerStep
          command="/schedule add"
          title="8/10 补跑"
          hint="机器关机/休眠错过触发点时，要不要补最近一次。"
          items={[
            {
              key: "yes",
              label: "补跑",
              description: "只补最近一次；标原定与实际时间",
            },
            { key: "no", label: "不补跑", description: "记错过，不执行" },
          ]}
          onSelect={(key) => {
            setCatchUp(key === "yes");
            goTo("timeout");
          }}
          onCancel={leave}
          footer="Enter 选择 · Esc 返回"
          width={width}
        />
      );

    case "timeout":
      return (
        <TextStep
          command="/schedule add"
          title="9/10 超时"
          hint="单次运行上限（分钟）。0 表示不限时。"
          value={timeoutMinutes}
          onChange={(value) => {
            setTimeoutMinutes(value);
            setError(null);
          }}
          onSubmit={(value) => {
            if (parseMinutes(value) === undefined) {
              setError("需要 0 或正整数分钟。");
              return;
            }
            setError(null);
            goTo("wait");
          }}
          placeholder="30"
          error={error}
          footer="Enter 下一步 · Esc 返回"
          width={width}
        />
      );

    case "wait":
      return (
        <TextStep
          command="/schedule add"
          title="9/10 等待"
          hint="目标会话被占用时最多等多久（分钟）；超时记跳过，不计失败。"
          value={waitMinutes}
          onChange={(value) => {
            setWaitMinutes(value);
            setError(null);
          }}
          onSubmit={(value) => {
            if (parseMinutes(value) === undefined) {
              setError("需要 0 或正整数分钟。");
              return;
            }
            setError(null);
            goTo("name");
          }}
          placeholder="10"
          error={error}
          footer="Enter 下一步 · Esc 返回"
          width={width}
        />
      );

    case "name":
      return (
        <TextStep
          command="/schedule add"
          title="10/10 名称"
          hint="展示用；留空则用内容前 32 个字符。"
          value={name}
          onChange={(value) => {
            setName(value);
            setError(null);
          }}
          onSubmit={(value) => {
            setName(value.trim());
            setError(null);
            goTo("autostart");
          }}
          placeholder="晨报"
          error={error}
          footer="Enter 下一步 · Esc 返回"
          width={width}
        />
      );

    case "autostart":
      return (
        <PickerStep
          command="/schedule add"
          title="最后一步 · 开机自启"
          hint="注册后由 OS 每分钟唤起短命宿主；不注册则只在 Haruyuki 运行时执行。"
          items={[
            {
              key: "yes",
              label: "是（默认）",
              description: "注册用户级自启项",
            },
            { key: "no", label: "否", description: "面板会标未注册" },
          ]}
          onSelect={(key) => create(key === "yes")}
          onCancel={leave}
          footer="Enter 选择 · Esc 取消"
          width={width}
        />
      );

    case "create-failed":
      return (
        <OverlayFrame
          command="/schedule add"
          title="创建失败"
          footer={<StepHint text="Esc 返回修改 · Ctrl+C 关闭" width={width} />}
        >
          <Box flexDirection="column">
            <Text color={colors.status.error}>
              {truncateText(error ?? "未知原因", width)}
            </Text>
            <Box height={1} />
            <Text dimColor>
              {truncateText("已填内容都还在，Esc 回去改。", width)}
            </Text>
          </Box>
        </OverlayFrame>
      );

    case "done": {
      const failed = registerError !== null;
      return (
        <OverlayFrame
          command="/schedule add"
          title={failed ? "任务已创建 · 自启未注册" : "已创建"}
          footer={
            <StepHint
              text={
                failed ? "r 重试注册 · Enter/Esc 关闭" : "Enter 或 Esc 关闭"
              }
              width={width}
            />
          }
        >
          <Box flexDirection="column">
            {receipt.map((line, index) => (
              <Text
                key={line}
                color={
                  failed && line.includes("自启")
                    ? colors.status.error
                    : undefined
                }
                dimColor={index > 0}
              >
                {truncateText(line, width)}
              </Text>
            ))}
            {failed && (
              <Box marginTop={1}>
                <Text dimColor>
                  {truncateText(
                    "任务本身没问题，只是 OS 条目没建起来。",
                    width,
                  )}
                </Text>
              </Box>
            )}
          </Box>
        </OverlayFrame>
      );
    }
  }
}
