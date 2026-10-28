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
  onSelect,
  onCancel,
  footer,
  width,
}: {
  command: string;
  title: string;
  hint: string;
  items: readonly SingleSelectItem[];
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

/**
 * The partial flags a `/schedule add …` command already carried, and the step
 * the wizard should open on: a pre-filled field is not asked again.
 */
export function prefillFromArgs(args: readonly string[] | undefined): {
  draft: ScheduleAddDraft;
  mode: ScheduleMode;
  raw: string;
  initialStep: WizardStep;
} {
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

  let initialStep: WizardStep = "type";
  if (draft.type) initialStep = "target";
  if (draft.target) initialStep = "payload";
  if (draft.payload) initialStep = draft.cron ? "timezone" : "schedule-mode";
  return { draft, mode, raw, initialStep };
}
