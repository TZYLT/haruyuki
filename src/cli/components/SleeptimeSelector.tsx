import { Box } from "ink";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { namedKeyChords } from "@/cli/helpers/input-keys";
import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { wizardBindings } from "@/cli/overlay/wizard";
import {
  DEFAULT_REFLECTION_TIMEOUT_MINUTES,
  MAX_REFLECTION_TIMEOUT_MINUTES,
  MIN_REFLECTION_TIMEOUT_MINUTES,
  SUGGESTED_REFLECTION_EVERY_USER_MESSAGES,
} from "@/reflection-settings";
import { colors } from "./colors";
import { Text } from "./Text";

type FocusRow = "on-compaction" | "every" | "timeout" | "delete";

interface SleeptimeSelectorProps {
  initialSettings: ReflectionSettings;
  memfsEnabled: boolean;
  onSave: (settings: ReflectionSettings) => void;
  onCancel: () => void;
}

const FOCUS_ROWS: readonly FocusRow[] = [
  "on-compaction",
  "every",
  "timeout",
  "delete",
];

function ChoiceRow(props: {
  focused: boolean;
  selected: boolean;
  children: ReactNode;
}) {
  const { focused, selected, children } = props;
  return (
    <Box flexDirection="row">
      <Text>{focused ? "> " : "  "}</Text>
      <Text
        backgroundColor={selected ? colors.selector.itemHighlighted : undefined}
        color={selected ? "black" : undefined}
        bold={selected}
      >
        {children}
      </Text>
    </Box>
  );
}

function parseNonNegativeInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseTimeout(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed >= MIN_REFLECTION_TIMEOUT_MINUTES &&
    parsed <= MAX_REFLECTION_TIMEOUT_MINUTES
    ? parsed
    : null;
}

function parseInitialState(initialSettings: ReflectionSettings): {
  onCompaction: boolean;
  everyUserMessages: string;
  timeoutMinutes: string;
  deleteSessionOnSuccess: boolean;
} {
  const every = Number.isInteger(initialSettings.everyUserMessages)
    ? initialSettings.everyUserMessages
    : 0;
  const timeout = Number.isInteger(initialSettings.timeoutMinutes)
    ? initialSettings.timeoutMinutes
    : DEFAULT_REFLECTION_TIMEOUT_MINUTES;
  return {
    onCompaction: initialSettings.onCompaction === true,
    everyUserMessages: String(Math.max(0, every)),
    timeoutMinutes: String(timeout),
    deleteSessionOnSuccess: initialSettings.deleteSessionOnSuccess === true,
  };
}

/**
 * `/sleeptime` (and `/memory config`)'s form.
 *
 * F-03 replaced the old one-of-three trigger + merge block with two independent
 * switches and the run policy. The two numeric knobs are edited **in place**
 * with the toolkit's editors, which is the split this face was signed off for:
 * while a field has the cursor the arrows and Home/End belong to the caret,
 * ←/→ toggles the switch rows, and ↑↓/Tab walk the form.
 */
export function SleeptimeSelector({
  initialSettings,
  memfsEnabled,
  onSave,
  onCancel,
}: SleeptimeSelectorProps) {
  const initialState = useMemo(
    () => parseInitialState(initialSettings),
    [initialSettings],
  );

  const [onCompaction, setOnCompaction] = useState(initialState.onCompaction);
  const [everyInput, setEveryInput] = useState(initialState.everyUserMessages);
  const [timeoutInput, setTimeoutInput] = useState(initialState.timeoutMinutes);
  const [deleteOnSuccess, setDeleteOnSuccess] = useState(
    initialState.deleteSessionOnSuccess,
  );
  const [focusRow, setFocusRow] = useState<FocusRow>("on-compaction");
  const [validationError, setValidationError] = useState<string | null>(null);

  const isEditingEvery = focusRow === "every";
  const isEditingTimeout = focusRow === "timeout";
  const isFieldFocused = isEditingEvery || isEditingTimeout;

  useEffect(() => {
    if (!FOCUS_ROWS.includes(focusRow)) {
      setFocusRow("on-compaction");
    }
  }, [focusRow]);

  const saveSelection = useCallback(() => {
    const everyUserMessages = parseNonNegativeInteger(everyInput);
    if (everyUserMessages === null) {
      setValidationError("must be a non-negative integer (0 = off)");
      return;
    }
    const timeoutMinutes = parseTimeout(timeoutInput);
    if (timeoutMinutes === null) {
      setValidationError(
        `must be between ${MIN_REFLECTION_TIMEOUT_MINUTES} and ${MAX_REFLECTION_TIMEOUT_MINUTES}`,
      );
      return;
    }
    onSave({
      onCompaction,
      everyUserMessages,
      timeoutMinutes,
      deleteSessionOnSuccess: deleteOnSuccess,
    });
  }, [deleteOnSuccess, everyInput, onCompaction, onSave, timeoutInput]);

  const toggleFocusedSwitch = () => {
    setValidationError(null);
    switch (focusRow) {
      case "on-compaction":
        setOnCompaction((value) => !value);
        break;
      case "delete":
        setDeleteOnSuccess((value) => !value);
        break;
      case "every":
      case "timeout":
        // A field's own editor owns the key, including Space.
        break;
    }
  };

  const moveFocus = (direction: -1 | 1) => {
    setValidationError(null);
    const currentIndex = FOCUS_ROWS.indexOf(focusRow);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex =
      (safeIndex + direction + FOCUS_ROWS.length) % FOCUS_ROWS.length;
    setFocusRow(FOCUS_ROWS[nextIndex] ?? "on-compaction");
  };

  const cycleFocusedSwitch = (direction: -1 | 1) => {
    // Only the switch rows cycle; while a field has the cursor the arrows are
    // the caret's.
    if (isFieldFocused) return;
    void direction;
    toggleFocusedSwitch();
  };

  useKeyBindings("sleeptime-selector", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "sleeptime-selector.next",
          chords: [{ key: "tab" }, ...namedKeyChords("downArrow")],
          run: () => {
            moveFocus(1);
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.previous",
          chords: [{ key: "tab", shift: true }, ...namedKeyChords("upArrow")],
          run: () => {
            moveFocus(-1);
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.cycle-next",
          chords: namedKeyChords("rightArrow"),
          run: () => {
            if (isFieldFocused) return "declined";
            cycleFocusedSwitch(1);
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.cycle-previous",
          chords: namedKeyChords("leftArrow"),
          run: () => {
            if (isFieldFocused) return "declined";
            cycleFocusedSwitch(-1);
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.select",
          chords: namedKeyChords("space"),
          run: () => {
            if (isFieldFocused) return "declined";
            toggleFocusedSwitch();
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.save",
          chords: namedKeyChords("return"),
          run: () => {
            if (!memfsEnabled) {
              onCancel();
              return "consumed";
            }
            // A focused field submits through its own editor, so this would be
            // the same save twice.
            if (isFieldFocused) return "declined";
            saveSelection();
            return "consumed";
          },
        },
        ...wizardBindings({
          canGoBack: false,
          onBack: onCancel,
          onCancel,
        }),
      ],
    },
  ]);

  return (
    <OverlayFrame
      command="/sleeptime"
      title={memfsEnabled ? "Dream Settings" : undefined}
    >
      {memfsEnabled ? (
        <>
          <ChoiceRow
            focused={focusRow === "on-compaction"}
            selected={onCompaction}
          >
            {" On compaction "}
          </ChoiceRow>
          <Box flexDirection="row">
            <Text>{isEditingEvery ? "> " : "  "}</Text>
            <Text
              backgroundColor={
                everyInput !== "0" ? colors.selector.itemHighlighted : undefined
              }
              color={everyInput !== "0" ? "black" : undefined}
              bold={everyInput !== "0"}
            >
              {" Every ["}
            </Text>
            <OverlayTextField
              marker={null}
              value={everyInput}
              onChange={(value) => {
                setEveryInput(value);
                setValidationError(null);
              }}
              // Enter in the field is the form's save: the `return` binding
              // declines while a field has the cursor, so this is the only path.
              onSubmit={saveSelection}
              focus={isEditingEvery}
            />
            <Text
              backgroundColor={
                everyInput !== "0" ? colors.selector.itemHighlighted : undefined
              }
              color={everyInput !== "0" ? "black" : undefined}
              bold={everyInput !== "0"}
            >
              {`] user messages (0 = off, suggest ${SUGGESTED_REFLECTION_EVERY_USER_MESSAGES})`}
            </Text>
          </Box>

          <Box height={1} />
          <Text bold color={colors.selector.title}>
            Run policy
          </Text>
          <Box height={1} />
          <Box flexDirection="row">
            <Text>{isEditingTimeout ? "> " : "  "}</Text>
            <Text>{" Timeout ["}</Text>
            <OverlayTextField
              marker={null}
              value={timeoutInput}
              onChange={(value) => {
                setTimeoutInput(value);
                setValidationError(null);
              }}
              onSubmit={saveSelection}
              focus={isEditingTimeout}
            />
            <Text>{"] minutes"}</Text>
          </Box>
          <ChoiceRow focused={focusRow === "delete"} selected={deleteOnSuccess}>
            {" Delete session on success "}
          </ChoiceRow>

          {validationError && (
            <Text color={colors.error.text}>
              {`    Error: ${validationError}`}
            </Text>
          )}

          <Box height={1} />
          <Text dimColor>
            {"  Enter save · ↑↓/Tab move · Space/←→ toggle · Esc cancel"}
          </Text>
        </>
      ) : (
        <>
          <Text>
            Dream settings require the memory filesystem (MemFS) to be enabled
            for this agent.
          </Text>

          <Box height={1} />
          <Text dimColor>{"  Enter or Esc to close"}</Text>
        </>
      )}
    </OverlayFrame>
  );
}
