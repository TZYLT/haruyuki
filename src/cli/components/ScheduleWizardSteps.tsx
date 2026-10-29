/**
 * The presentational half of `/schedule add`: the three step frames, the pure
 * parse helpers and the pre-filled opening step.
 *
 * Split from `ScheduleWizard.tsx` because that file owns a state machine and the
 * 1,000-line ceiling is the point at which a reader stops being able to hold the
 * whole face in one pass. Nothing here holds state: a step frame draws what it
 * is given, and every helper is a pure function of its arguments (the prefill
 * reads the same one-shot bridge the faces use, once, on mount).
 */

import { Box } from "ink";
import {
  parseScheduleInvocation,
  type ScheduleAddDraft,
} from "@/cli/commands/schedule";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { peekScheduleOverlayTarget } from "@/cli/helpers/schedule-store";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayTextField } from "@/cli/overlay/text-view";
import {
  isValidCron,
  parseAt,
  parseEvery,
  TASK_COMMAND_WHITELIST,
} from "@/cron";

/** Which wizard step a face is on. */
export type WizardStep =
  | "type"
  | "target"
  | "conversation"
  | "conversation-pick"
  | "payload"
  | "schedule-mode"
  | "schedule"
  | "timezone"
  | "permission"
  | "catch-up"
  | "timeout"
  | "wait"
  | "name"
  | "autostart"
  | "create-failed"
  | "done";

/**
 * The steps the wizard asks, in the order it asks them (M3 #15).
 *
 * One list, because the numbering used to be literals in `ScheduleWizard.tsx`
 * and drifted: "9/10 超时" and "9/10 等待" shared a number, the timezone step
 * claimed 6/10, and autostart was outside the count. A title now comes from the
 * row's index here, so adding or reordering a step renumbers every frame without
 * another edit. The two sub-steps (`conversation-pick`, `schedule-mode`) share
 * their parent's slot; `create-failed`/`done` are not numbered at all.
 */
export const WIZARD_STEPS = [
  { id: "type", label: "类型" },
  { id: "target", label: "目标" },
  { id: "conversation", label: "会话" },
  { id: "payload", label: "内容" },
  { id: "schedule", label: "时间" },
  { id: "timezone", label: "时区" },
  { id: "permission", label: "权限" },
  { id: "catch-up", label: "补跑" },
  { id: "timeout", label: "超时" },
  { id: "wait", label: "等待" },
  { id: "name", label: "名称" },
  { id: "autostart", label: "开机自启" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

/** The numbered slot a screen step belongs to, or `null` for unnumbered ones. */
function wizardStepSlot(step: WizardStep): WizardStepId | null {
  if (step === "schedule-mode" || step === "schedule") return "schedule";
  if (step === "conversation-pick") return "conversation";
  if (step === "create-failed" || step === "done") return null;
  return step;
}

/**
 * `7/12 权限` — the step's title, with its number derived from `WIZARD_STEPS`.
 *
 * `label` overrides just the words (the payload step names the command form);
 * the count always comes from the table.
 */
export function wizardStepTitle(step: WizardStep, label?: string): string {
  const slot = wizardStepSlot(step);
  if (slot === null) return label ?? "";
  const index = WIZARD_STEPS.findIndex((entry) => entry.id === slot);
  const words = label ?? WIZARD_STEPS[index]?.label ?? "";
  return `${index + 1}/${WIZARD_STEPS.length} ${words}`;
}

/** Where a picker's cursor starts when the flags already chose a row. */
export function cursorIndexFor(
  items: readonly SingleSelectItem[],
  key: string | null | undefined,
): number {
  if (!key) return 0;
  const index = items.findIndex((item) => item.key === key);
  return index >= 0 ? index : 0;
}

/** How the time step was answered. */
export type ScheduleMode = "cron" | "every" | "at";

/** What the time step produced, kept together so one edit cannot desync them. */
export interface ScheduleChoice {
  cron?: string;
  recurring: boolean;
  scheduledFor?: Date;
}

/** The three permission tiers, in the order the survey displays them. */
export const PERMISSION_ROWS: readonly SingleSelectItem[] = [
  {
    key: "standard",
    label: "只读（standard）",
    description: "读文件、搜索；写文件、shell、子代理都不行",
  },
  {
    key: "acceptEdits",
    label: "可编辑（acceptEdits）",
    description: "能读写文件；shell 仍被拒",
  },
  {
    key: "unrestricted",
    label: "全权（unrestricted）",
    description: "全部工具，无审批；本版不承诺禁删/禁网",
  },
];

export function StepHint({ text, width }: { text: string; width: number }) {
  return <Text dimColor>{truncateText(text, width)}</Text>;
}

/** A text step: the labelled editor, its hint, and Enter. */
export function TextStep({
  command,
  title,
  hint,
  value,
  onChange,
  onSubmit,
  placeholder,
  error,
  footer,
  width,
}: {
  command: string;
  title: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  error: string | null;
  footer: string;
  width: number;
}) {
  return (
    <OverlayFrame
      command={command}
      title={title}
      footer={<StepHint text={footer} width={width} />}
    >
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <StepHint text={hint} width={width} />
        </Box>
        <OverlayTextField
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
        />
        {error ? (
          <Box marginTop={1}>
            <Text color={colors.status.error}>
              {truncateText(error, width)}
            </Text>
          </Box>
        ) : null}
      </Box>
    </OverlayFrame>
  );
}

/** A picker step: the toolkit list, whose own cancel walks the wizard back. */
export function PickerStep({
  command,
  title,
  hint,
  items,
  initialCursorIndex,
  onSelect,
  onCancel,
  footer,
  width,
}: {
  command: string;
  title: string;
  hint: string;
  items: readonly SingleSelectItem[];
  /**
   * The row the cursor starts on. Pre-filled flags pass their decision through
   * here (M3 #3): a permission picker opened with `--permission unrestricted`
   * must not have Enter rewrite the task to `standard`.
   */
  initialCursorIndex?: number;
  onSelect: (key: string) => void;
  onCancel: () => void;
  footer: string;
  width: number;
}) {
  return (
    <OverlayFrame command={command} title={title}>
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <StepHint text={hint} width={width} />
        </Box>
        <SingleSelectPicker
          items={[...items]}
          initialCursorIndex={initialCursorIndex}
          onSelect={onSelect}
          onCancel={onCancel}
          footer={<Text dimColor>{footer}</Text>}
        />
      </Box>
    </OverlayFrame>
  );
}

export function parseMinutes(raw: string): number | undefined {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The wizard's own gate, limited to the constant the core exports.
 *
 * `isAllowedScheduledCommand` is the runtime's answer and belongs to the runner
 * (it is still an M2 stub); asking it here would make the wizard throw for a
 * command it should merely refuse.
 */
export function commandAllowed(command: string): boolean {
  return TASK_COMMAND_WHITELIST.has(command);
}

export function looksLikeConversationId(value: string): boolean {
  return /^[0-9a-f]{8,}$/i.test(value) || value.includes("-");
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * What a `--cron`/`--every`/`--at` value resolves to, or `null` when it does not
 * parse. Shares the core's parsers, so the wizard and the one-step form accept
 * exactly the same strings.
 */
export function parseScheduleInput(
  mode: ScheduleMode,
  raw: string,
): ScheduleChoice | null {
  if (!raw) return null;
  if (mode === "cron") {
    return isValidCron(raw) ? { cron: raw, recurring: true } : null;
  }
  if (mode === "every") {
    const parsed = parseEvery(raw);
    return parsed ? { cron: parsed.cron, recurring: true } : null;
  }
  const at = parseAt(raw);
  return at
    ? { cron: at.cron, recurring: false, scheduledFor: at.scheduledFor }
    : null;
}

export interface SchedulePrefill {
  draft: ScheduleAddDraft;
  mode: ScheduleMode;
  raw: string;
  initialStep: WizardStep;
  /** Steps the flags already answered; the wizard must not ask them again. */
  answered: readonly WizardStep[];
}

/**
 * The partial flags a `/schedule add …` command already carried, and the step
 * the wizard should open on: a pre-filled field is not asked again.
 *
 * Two details are the fix M3 #3/#4 names:
 *
 * - A required step whose flag is present is *answered*, and the wizard's
 *   forward walk skips it — so `--permission unrestricted` can no longer become
 *   `standard` by pressing Enter on a picker whose cursor defaulted to row 0.
 * - `--target new` is **not** answered until its visibility is: the parser
 *   reports `--visible|--hidden` as missing, and the target picker is where that
 *   is asked (row 0 is the visible new conversation).
 */
export function prefillFromArgs(
  args: readonly string[] | undefined,
): SchedulePrefill {
  const target = peekScheduleOverlayTarget();
  const rawArgs = args ?? (target.view === "wizard" ? (target.args ?? []) : []);
  const invocation = parseScheduleInvocation(["add", ...rawArgs]);
  const draft: ScheduleAddDraft =
    invocation.kind === "add" ? invocation.draft : { recurring: true };

  // Which time flag was used, and the value next to it, so the step can open on
  // the value the user already typed (the registry path splits unquoted values).
  let mode: ScheduleMode = "cron";
  let raw = "";
  for (let index = 0; index < rawArgs.length; index += 1) {
    const flag = rawArgs[index];
    if (flag === "--cron" || flag === "--every" || flag === "--at") {
      mode = flag === "--cron" ? "cron" : flag === "--every" ? "every" : "at";
      const next = rawArgs[index + 1] ?? "";
      raw = next.startsWith("--") ? "" : next;
      break;
    }
  }

  const answered: WizardStep[] = [];
  if (draft.type) answered.push("type");
  // `--target new` without `--visible/--hidden` is not answered (M3 #4): the
  // command would create a *visible* task nobody chose, so visibility is asked.
  const targetAnswered =
    draft.target !== undefined &&
    !(draft.target.kind === "new" && draft.hidden === undefined);
  if (targetAnswered) {
    answered.push("target");
    answered.push("conversation");
  }
  if (draft.payload) answered.push("payload");
  if (draft.cron) answered.push("schedule");
  // The timezone step has a system default; only an explicit `--tz` answers it.
  if (draft.timezone) answered.push("timezone");
  if (draft.permission) answered.push("permission");
  if (draft.catchUp !== undefined) answered.push("catch-up");

  // The required steps in the order they are asked. The optional three
  // (timeout/wait/name) are always offered: they have visible defaults, so
  // Entering through them is cheap and skipping them would hide the fields.
  const requiredOrder: WizardStep[] = [
    "type",
    "target",
    "conversation",
    "payload",
    "schedule",
    "timezone",
    "permission",
    "catch-up",
  ];
  let initialStep: WizardStep = "timeout";
  for (const candidate of requiredOrder) {
    if (!answered.includes(candidate)) {
      initialStep = candidate;
      break;
    }
  }
  return { draft, mode, raw, initialStep, answered };
}
