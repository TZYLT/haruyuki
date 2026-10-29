/**
 * `/schedule add` — the creation wizard (R-5.12.1/R-5.12.2).
 *
 * The order is the requirement's: type → target → content → time → permission →
 * catch-up → timeout → wait → name → autostart. Every step keeps its value in
 * component state, which is what makes the last step's failure path work: when
 * the OS refuses the autostart entry the task is **already created**, the wizard
 * shows the receipt with "autostart not registered", and `r` retries the
 * registration alone — no second task, no lost field.
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
import { useCallback, useMemo, useRef, useState } from "react";
import {
  type CreateScheduleResult,
  createScheduleTask,
  formatScheduleCreatedLines,
  type ScheduleAddDraft,
} from "@/cli/commands/schedule";
import { colors } from "@/cli/components/colors";
import {
  commandAllowed,
  cursorIndexFor,
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
  wizardStepTitle,
} from "@/cli/components/ScheduleWizardSteps";
import { Text } from "@/cli/components/Text";
import { conversationRef } from "@/cli/helpers/schedule-store";
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
  /**
   * Called instead of `onClose` when the user leaves the receipt of a task that
   * was created. The overlay uses it to close without printing its dismiss
   * text: the task exists, so "cancelled" would be a lie.
   */
  onCompleted?: () => void;
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

/** The type step's rows; the same list feeds the cursor prefill. */
const TYPE_ITEMS: readonly SingleSelectItem[] = [
  {
    key: "prompt",
    label: "prompt",
    description: "Injects a user message and runs one turn",
  },
  {
    key: "command",
    label: "command",
    description: `Only ${[...TASK_COMMAND_WHITELIST].join(" / ")} allowed`,
  },
];

/** The target step's rows (R-5.12.3): new-visible, new-hidden, existing. */
const TARGET_ITEMS: readonly SingleSelectItem[] = [
  {
    key: "new-visible",
    label: "New visible conversation each run",
    description: "The task name becomes the conversation summary",
  },
  {
    key: "new-hidden",
    label: "New hidden conversation each run",
    description: "Kept out of the conversation list; see /hidden-sessions",
  },
  {
    key: "existing",
    label: "Write into an existing conversation",
    description: "The conversation must exist and not be hidden",
  },
];

/** The catch-up question's two rows; row 0 is "catch up". */
const CATCH_UP_ITEMS: readonly SingleSelectItem[] = [
  {
    key: "yes",
    label: "Catch up",
    description:
      "Only the most recent missed slot; the original and actual times are kept",
  },
  {
    key: "no",
    label: "No catch-up",
    description: "Record the miss; do not run",
  },
];

export function ScheduleWizard({
  agentId,
  currentConversationId,
  onClose,
  onCompleted,
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

  // M3 #6: two Enter presses on the autostart question used to run `create`
  // twice and leave two tasks behind. The ref flips **before** the first await,
  // so the second key sees a creation in flight; it is only cleared when the
  // attempt failed and the user is back on the question to retry.
  const creatingRef = useRef(false);

  /**
   * The next step that still needs an answer.
   *
   * Forward navigation skips a step whose flag already answered it (M3 #3):
   * `--permission`/`--catch-up` are required, so a wizard that asked them again
   * and took Enter's row 0 silently replaced the user's choice. The optional
   * timeout/wait/name steps keep their default values and are always shown.
   */
  const nextAfterTime = useCallback((): WizardStep => {
    if (permission === null) return "permission";
    if (catchUp === null) return "catch-up";
    return "timeout";
  }, [catchUp, permission]);

  /** Where the flow goes once the content and the time are known. */
  const afterContent = useCallback((): WizardStep => {
    return schedule.cron ? "timezone" : "schedule-mode";
  }, [schedule.cron]);

  const leave = useCallback(() => {
    setError(null);
    if (canGoBack) {
      back();
      return;
    }
    onClose();
  }, [back, canGoBack, onClose]);

  /**
   * Leaving the receipt: a created task is a success, not a dismissal.
   *
   * `onCompleted` lets the overlay close without its "cancelled" line; a mount
   * site that passes none keeps the old close behaviour.
   */
  const leaveDone = useCallback(() => {
    if (created?.kind === "created" && onCompleted) {
      onCompleted();
      return;
    }
    onClose();
  }, [created, onClose, onCompleted]);

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
   * receipt keeps saying "task created, autostart not registered" until a retry
   * succeeds.
   */
  const registerFor = useCallback(
    async (result: CreateScheduleResult) => {
      setRegisterError(null);
      try {
        const status = await (registerAutostartEntry ?? registerAutostart)();
        if (!status.registered) {
          setRegisterError(status.error ?? "registration did not take effect");
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
      if (creatingRef.current) return;
      creatingRef.current = true;
      setError(null);
      const result = createTask
        ? createTask(draft, agentId)
        : createScheduleTask({ agentId, draft });
      setCreated(result);
      if (result.kind === "error") {
        // The task was not made, so the question is still unanswered: clear the
        // guard and let the user go back and try again.
        creatingRef.current = false;
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
                  leaveDone();
                  return "consumed" as const;
                },
              },
              {
                id: "schedule-wizard.done.interrupt",
                chords: [{ key: "c", ctrl: true }],
                run: () => {
                  leaveDone();
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
          key="type"
          command="/schedule add"
          title={wizardStepTitle("type")}
          hint="prompt sends a message into the conversation; command runs a command that can finish unattended."
          items={TYPE_ITEMS}
          initialCursorIndex={cursorIndexFor(TYPE_ITEMS, type)}
          onSelect={(key) => {
            setType(key === "command" ? "command" : "prompt");
            goTo("target");
          }}
          onCancel={leave}
          footer="Enter select · ↑↓ move · Esc cancel"
          width={width}
        />
      );

    case "target": {
      // The prefilled target picks the opening row (M3 #3), and a bare
      // `--target new` opens on the visible-new row so Enter answers the
      // visibility question rather than skipping it (M3 #4).
      const targetKey =
        targetMode === "existing"
          ? "existing"
          : hidden
            ? "new-hidden"
            : "new-visible";
      return (
        <PickerStep
          key="target"
          command="/schedule add"
          title={wizardStepTitle("target")}
          hint="Where a prompt task lands: a new conversation each run, or an existing one."
          items={TARGET_ITEMS}
          initialCursorIndex={cursorIndexFor(TARGET_ITEMS, targetKey)}
          onSelect={(key) => {
            setError(null);
            if (key === "new-visible" || key === "new-hidden") {
              setTargetMode("new");
              setHidden(key === "new-hidden");
              goTo(payload.trim() ? afterContent() : "payload");
              return;
            }
            setTargetMode("existing");
            goTo("conversation");
          }}
          onCancel={leave}
          footer="Enter select · ↑↓ move · Esc cancel"
          width={width}
        />
      );
    }

    case "conversation":
      return (
        <TextStep
          key="conversation"
          command="/schedule add"
          title={wizardStepTitle("conversation")}
          hint={
            currentConversationId
              ? `Paste a conversation id, or type keywords to search the 10 most recent. Current conversation ${conversationRef(currentConversationId)}.`
              : "Paste a conversation id, or type keywords to search the 10 most recent conversations."
          }
          value={conversationId}
          onChange={(value) => {
            setConversationId(value);
            setError(null);
          }}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              setError("A conversation id is required (or `default`).");
              return;
            }
            if (trimmed === "default" || looksLikeConversationId(trimmed)) {
              setConversationId(trimmed);
              goTo(payload.trim() ? afterContent() : "payload");
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
          placeholder="conversation id / default / keywords"
          error={error}
          footer="Enter confirm · Esc back"
          width={width}
        />
      );

    case "conversation-pick": {
      const items: SingleSelectItem[] =
        choices.length > 0
          ? choices.map((choice) => ({
              key: choice.id,
              label: choice.label,
              description: conversationRef(choice.id),
            }))
          : [
              currentConversationId
                ? {
                    key: currentConversationId,
                    label: "Current conversation",
                    description: conversationRef(currentConversationId),
                  }
                : {
                    key: "default",
                    label: "default",
                    description: "the agent's default conversation",
                  },
            ];
      return (
        <PickerStep
          key="conversation-pick"
          command="/schedule add"
          title={wizardStepTitle("conversation-pick", "Select conversation")}
          hint={
            choices.length > 0
              ? `${choices.length} matching conversations.`
              : "No conversations found: press Esc to paste an id, or choose the default conversation."
          }
          items={items}
          initialCursorIndex={cursorIndexFor(items, conversationId)}
          onSelect={(key) => {
            setConversationId(key);
            goTo(payload.trim() ? afterContent() : "payload");
          }}
          onCancel={leave}
          footer="Enter select · Esc back to input"
          width={width}
        />
      );
    }

    case "payload":
      return (
        <TextStep
          key="payload"
          command="/schedule add"
          title={wizardStepTitle(
            "payload",
            type === "command"
              ? "Command (arguments passed through)"
              : "Payload",
          )}
          hint={
            type === "command"
              ? `Only ${[...TASK_COMMAND_WHITELIST].join(" / ")}; e.g. /compact 3.`
              : "This is sent to the conversation as one user message."
          }
          value={payload}
          onChange={(value) => {
            setPayload(value);
            setError(null);
          }}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              setError("Payload cannot be empty.");
              return;
            }
            if (type === "command") {
              const command = trimmed.replace(/^\//, "").split(/\s+/)[0] ?? "";
              if (!commandAllowed(command)) {
                setError(
                  `Command ${command || "(empty)"} is not in the allowlist (${[...TASK_COMMAND_WHITELIST].join(" / ")}).`,
                );
                return;
              }
            }
            setPayload(trimmed);
            setError(null);
            goTo(afterContent());
          }}
          placeholder={
            type === "command"
              ? "/compact 3"
              : "Message to send to the conversation"
          }
          error={error}
          footer="Enter next · Esc back"
          width={width}
        />
      );

    case "schedule-mode":
      return (
        <PickerStep
          key="schedule-mode"
          command="/schedule add"
          title={wizardStepTitle("schedule-mode")}
          hint="When it runs. A cron expression is the most precise; interval and one-off are its common shorthand."
          items={[
            {
              key: "cron",
              label: "cron expression",
              description: "5 fields, e.g. 0 9 * * *",
            },
            { key: "every", label: "Interval", description: "5m / 2h / 1d" },
            {
              key: "at",
              label: "One-off time",
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
          footer="Enter select · Esc back"
          width={width}
        />
      );

    case "schedule":
      return (
        <TextStep
          key="schedule"
          command="/schedule add"
          title={wizardStepTitle("schedule")}
          hint={
            scheduleMode === "cron"
              ? "5-field cron: minute hour day month weekday."
              : scheduleMode === "every"
                ? "Interval: 5m, 2h, 1d (minimum 1 minute)."
                : 'One-off time: "in 45m", "3:00pm", or an RFC 3339 timestamp with a zone.'
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
                  ? "Not a valid 5-field cron expression."
                  : scheduleMode === "every"
                    ? "Unrecognized interval (try 5m, 2h, 1d)."
                    : 'Unrecognized time (try "in 45m", "3:00pm").',
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
          footer="Enter next · Esc back"
          width={width}
        />
      );

    case "timezone":
      return (
        <TextStep
          key="timezone"
          command="/schedule add"
          title={wizardStepTitle("timezone")}
          hint="IANA timezone; cron times are interpreted in it."
          value={timezone}
          onChange={(value) => {
            setTimezone(value);
            setError(null);
          }}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed && !isTimeZone(trimmed)) {
              setError("Not a valid IANA timezone.");
              return;
            }
            setTimezone(trimmed);
            setError(null);
            goTo(nextAfterTime());
          }}
          placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
          error={error}
          footer="Enter next · Esc back"
          width={width}
        />
      );

    case "permission":
      return (
        <PickerStep
          key="permission"
          command="/schedule add"
          title={wizardStepTitle("permission")}
          hint="Unattended runs deny every approval request, so the tier is all the task can do."
          items={PERMISSION_ROWS}
          // A prefilled `--permission` opens on its own row (M3 #3).
          initialCursorIndex={cursorIndexFor(PERMISSION_ROWS, permission)}
          onSelect={(key) => {
            if (
              key === "standard" ||
              key === "acceptEdits" ||
              key === "unrestricted"
            ) {
              setPermission(key);
            }
            goTo(catchUp === null ? "catch-up" : "timeout");
          }}
          onCancel={leave}
          footer="Enter select · Esc back"
          width={width}
        />
      );

    case "catch-up":
      return (
        <PickerStep
          key="catch-up"
          command="/schedule add"
          title={wizardStepTitle("catch-up")}
          hint="When the machine was off or asleep and a trigger was missed, run the most recent one."
          items={CATCH_UP_ITEMS}
          // `--no-catch-up` must not be flipped back to "catch up" by Enter (M3 #3).
          initialCursorIndex={cursorIndexFor(
            CATCH_UP_ITEMS,
            catchUp === false ? "no" : "yes",
          )}
          onSelect={(key) => {
            setCatchUp(key === "yes");
            goTo("timeout");
          }}
          onCancel={leave}
          footer="Enter select · Esc back"
          width={width}
        />
      );

    case "timeout":
      return (
        <TextStep
          key="timeout"
          command="/schedule add"
          title={wizardStepTitle("timeout")}
          hint="Run limit in minutes. 0 means no limit."
          value={timeoutMinutes}
          onChange={(value) => {
            setTimeoutMinutes(value);
            setError(null);
          }}
          onSubmit={(value) => {
            if (parseMinutes(value) === undefined) {
              setError("Needs 0 or a positive number of minutes.");
              return;
            }
            setError(null);
            goTo("wait");
          }}
          placeholder="30"
          error={error}
          footer="Enter next · Esc back"
          width={width}
        />
      );

    case "wait":
      return (
        <TextStep
          key="wait"
          command="/schedule add"
          title={wizardStepTitle("wait")}
          hint="How long to wait when the target conversation is busy (minutes); a timeout records a skip, not a failure."
          value={waitMinutes}
          onChange={(value) => {
            setWaitMinutes(value);
            setError(null);
          }}
          onSubmit={(value) => {
            if (parseMinutes(value) === undefined) {
              setError("Needs 0 or a positive number of minutes.");
              return;
            }
            setError(null);
            goTo("name");
          }}
          placeholder="10"
          error={error}
          footer="Enter next · Esc back"
          width={width}
        />
      );

    case "name":
      return (
        <TextStep
          key="name"
          command="/schedule add"
          title={wizardStepTitle("name")}
          hint="Display name; leave empty to use the first 32 characters of the payload."
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
          placeholder="Morning report"
          error={error}
          footer="Enter next · Esc back"
          width={width}
        />
      );

    case "autostart":
      return (
        <PickerStep
          key="autostart"
          command="/schedule add"
          title={wizardStepTitle("autostart")}
          hint="Registers an OS entry that wakes a short-lived host every minute; without it the task runs only while Haruyuki is running."
          items={[
            {
              key: "yes",
              label: "Yes (default)",
              description: "Register a user-level autostart entry",
            },
            {
              key: "no",
              label: "No",
              description: "The panel marks it as not registered",
            },
          ]}
          onSelect={(key) => create(key === "yes")}
          onCancel={leave}
          footer="Enter select · Esc cancel"
          width={width}
        />
      );

    case "create-failed":
      return (
        <OverlayFrame
          command="/schedule add"
          title="Creation failed"
          footer={
            <StepHint text="Esc back to edit · Ctrl+C close" width={width} />
          }
        >
          <Box flexDirection="column">
            <Text color={colors.status.error}>
              {truncateText(error ?? "Unknown reason", width)}
            </Text>
            <Box height={1} />
            <Text dimColor>
              {truncateText(
                "Everything you filled in is still here; press Esc to go back.",
                width,
              )}
            </Text>
          </Box>
        </OverlayFrame>
      );

    case "done": {
      const failed = registerError !== null;
      return (
        <OverlayFrame
          command="/schedule add"
          title={failed ? "Task created · autostart not registered" : "Created"}
          footer={
            <StepHint
              text={
                failed
                  ? "r retry registration · Enter/Esc close"
                  : "Enter or Esc close"
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
                  failed && line.toLowerCase().includes("autostart")
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
                    "The task itself is fine; only the OS entry could not be created.",
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
