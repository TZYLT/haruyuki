import { Box } from "ink";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  ReflectionMergeMode,
  ReflectionSettings,
  ReflectionTrigger,
} from "@/cli/helpers/memory-reminder";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { wizardBindings } from "@/cli/overlay/wizard";
import { colors } from "./colors";
import { Text } from "./Text";

const DEFAULT_STEP_COUNT = "25";

type FocusRow =
  | "trigger-off"
  | "trigger-step-count"
  | "trigger-compaction"
  | "merge-auto"
  | "merge-explicit"
  | "merge-instructions";

interface SleeptimeSelectorProps {
  initialSettings: ReflectionSettings;
  memfsEnabled: boolean;
  onSave: (settings: ReflectionSettings) => void;
  onCancel: () => void;
}

const TRIGGER_OPTIONS: readonly ReflectionTrigger[] = [
  "off",
  "step-count",
  "compaction-event",
];
const MERGE_OPTIONS: readonly ReflectionMergeMode[] = ["auto", "explicit"];

function triggerFocusRow(trigger: ReflectionTrigger): FocusRow {
  switch (trigger) {
    case "off":
      return "trigger-off";
    case "step-count":
      return "trigger-step-count";
    case "compaction-event":
      return "trigger-compaction";
  }
}

function mergeFocusRow(merge: ReflectionMergeMode): FocusRow {
  return merge === "explicit" ? "merge-explicit" : "merge-auto";
}

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

function cycleOption<T extends string>(
  options: readonly T[],
  current: T,
  direction: -1 | 1,
): T {
  if (options.length === 0) {
    return current;
  }
  const currentIndex = options.indexOf(current);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + options.length) % options.length;
  return options[nextIndex] ?? current;
}

function parseInitialState(initialSettings: ReflectionSettings): {
  trigger: ReflectionTrigger;
  stepCount: string;
  merge: ReflectionMergeMode;
  mergeInstructions: string;
} {
  return {
    trigger:
      initialSettings.trigger === "off" ||
      initialSettings.trigger === "step-count" ||
      initialSettings.trigger === "compaction-event"
        ? initialSettings.trigger
        : "step-count",
    stepCount: String(
      Number.isInteger(initialSettings.stepCount) &&
        initialSettings.stepCount > 0
        ? initialSettings.stepCount
        : Number(DEFAULT_STEP_COUNT),
    ),
    merge: initialSettings.merge === "explicit" ? "explicit" : "auto",
    mergeInstructions: initialSettings.mergeInstructions ?? "",
  };
}

function parseStepCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * `/sleeptime`'s form.
 *
 * It is the tree's one self-drawn form: a radio group over two sections with two
 * fields edited **in place** rather than in a sub-view, which is what it was
 * signed off to keep. What changed is the two fields: they are the toolkit's
 * editors now, so they carry a caret and accept a paste where the hand-rolled
 * row only appended characters and painted a `█`. While a field has the cursor,
 * the arrows and Home/End belong to the caret; ←/→ still cycle the option on the
 * rows that are not fields, and ↑↓/Tab still walk the form, which is the split
 * the face was signed off for.
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

  const [trigger, setTrigger] = useState<ReflectionTrigger>(
    initialState.trigger,
  );
  const [stepCountInput, setStepCountInput] = useState(initialState.stepCount);
  const [merge, setMerge] = useState<ReflectionMergeMode>(initialState.merge);
  const [mergeInstructions, setMergeInstructions] = useState(
    initialState.mergeInstructions,
  );
  const [focusRow, setFocusRow] = useState<FocusRow>(() =>
    triggerFocusRow(initialState.trigger),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const visibleRows = useMemo(() => {
    const rows: FocusRow[] = [
      "trigger-off",
      "trigger-step-count",
      "trigger-compaction",
      "merge-auto",
      "merge-explicit",
    ];
    if (merge === "explicit") {
      rows.push("merge-instructions");
    }
    return rows;
  }, [merge]);
  const isEditingStepCount = focusRow === "trigger-step-count";
  const isEditingMergeInstructions =
    focusRow === "merge-instructions" && merge === "explicit";
  const isFieldFocused = isEditingStepCount || isEditingMergeInstructions;

  useEffect(() => {
    if (!visibleRows.includes(focusRow)) {
      setFocusRow(visibleRows[visibleRows.length - 1] ?? "trigger-off");
    }
  }, [focusRow, visibleRows]);

  const saveSelection = useCallback(() => {
    if (trigger === "step-count") {
      const stepCount = parseStepCount(stepCountInput);
      if (stepCount === null) {
        setValidationError("must be a positive integer");
        return;
      }
      onSave({ trigger, stepCount, merge, mergeInstructions });
      return;
    }

    const fallbackStepCount =
      parseStepCount(stepCountInput) ?? Number(DEFAULT_STEP_COUNT);
    onSave({
      trigger,
      stepCount: fallbackStepCount,
      merge,
      mergeInstructions,
    });
  }, [merge, mergeInstructions, onSave, stepCountInput, trigger]);

  const selectFocusedOption = () => {
    switch (focusRow) {
      case "trigger-off":
        setTrigger("off");
        break;
      case "trigger-step-count":
        setTrigger("step-count");
        break;
      case "trigger-compaction":
        setTrigger("compaction-event");
        break;
      case "merge-auto":
        setMerge("auto");
        break;
      case "merge-explicit":
        setMerge("explicit");
        break;
      case "merge-instructions":
        break;
    }
    setValidationError(null);
  };

  const moveFocus = (direction: -1 | 1) => {
    if (visibleRows.length === 0) return;
    setValidationError(null);
    const currentIndex = visibleRows.indexOf(focusRow);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex =
      (safeIndex + direction + visibleRows.length) % visibleRows.length;
    setFocusRow(visibleRows[nextIndex] ?? "trigger-off");
  };

  const cycleFocusedGroup = (direction: -1 | 1) => {
    setValidationError(null);
    if (focusRow.startsWith("trigger-")) {
      const nextTrigger = cycleOption(TRIGGER_OPTIONS, trigger, direction);
      setTrigger(nextTrigger);
      setFocusRow(triggerFocusRow(nextTrigger));
    } else if (focusRow.startsWith("merge-")) {
      const nextMerge = cycleOption(MERGE_OPTIONS, merge, direction);
      setMerge(nextMerge);
      setFocusRow(mergeFocusRow(nextMerge));
    }
  };

  useKeyBindings("sleeptime-selector", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "sleeptime-selector.next",
          chords: [{ key: "tab" }, { key: "downArrow" }],
          run: () => {
            moveFocus(1);
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.previous",
          chords: [{ key: "tab", shift: true }, { key: "upArrow" }],
          run: () => {
            moveFocus(-1);
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.cycle-next",
          chords: [{ key: "rightArrow" }],
          run: () => {
            // A field's caret owns the arrows while it has the cursor.
            if (isFieldFocused) return "declined";
            cycleFocusedGroup(1);
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.cycle-previous",
          chords: [{ key: "leftArrow" }],
          run: () => {
            if (isFieldFocused) return "declined";
            cycleFocusedGroup(-1);
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.select",
          chords: [{ key: "space" }],
          run: () => {
            // The instructions field is text, so a space there is a space; the
            // step count is a number, and space has always meant "select".
            if (isEditingMergeInstructions) return "declined";
            selectFocusedOption();
            return "consumed";
          },
        },
        {
          id: "sleeptime-selector.save",
          chords: [{ key: "return" }],
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
            focused={focusRow === "trigger-off"}
            selected={trigger === "off"}
          >
            {" Off "}
          </ChoiceRow>
          <Box flexDirection="row">
            <Text>{isEditingStepCount ? "> " : "  "}</Text>
            <Text
              backgroundColor={
                trigger === "step-count"
                  ? colors.selector.itemHighlighted
                  : undefined
              }
              color={trigger === "step-count" ? "black" : undefined}
              bold={trigger === "step-count"}
            >
              {" Every ["}
            </Text>
            <OverlayTextField
              marker={null}
              value={stepCountInput}
              onChange={(value) => {
                setTrigger("step-count");
                setStepCountInput(value);
                setValidationError(null);
              }}
              // Enter in the field is the form's save: the `return` binding
              // declines while a field has the cursor, so this is the only path.
              onSubmit={saveSelection}
              focus={isEditingStepCount}
            />
            <Text
              backgroundColor={
                trigger === "step-count"
                  ? colors.selector.itemHighlighted
                  : undefined
              }
              color={trigger === "step-count" ? "black" : undefined}
              bold={trigger === "step-count"}
            >
              {"] steps "}
            </Text>
          </Box>
          {validationError && (
            <Text color={colors.error.text}>
              {`    Error: ${validationError}`}
            </Text>
          )}
          <ChoiceRow
            focused={focusRow === "trigger-compaction"}
            selected={trigger === "compaction-event"}
          >
            {" On compaction "}
          </ChoiceRow>

          <Box height={1} />
          <Text bold color={colors.selector.title}>
            Memory updates
          </Text>
          <Box height={1} />
          <ChoiceRow
            focused={focusRow === "merge-auto"}
            selected={merge === "auto"}
          >
            {" Apply automatically "}
          </ChoiceRow>
          <ChoiceRow
            focused={focusRow === "merge-explicit"}
            selected={merge === "explicit"}
          >
            {" Agent reviews before applying "}
          </ChoiceRow>

          {merge === "explicit" && (
            <>
              <Box height={1} />
              <Text bold>{"  Review instructions"}</Text>
              <Box flexDirection="row">
                <Text>{isEditingMergeInstructions ? "> " : "  "}</Text>
                <Text>{"["}</Text>
                <OverlayTextField
                  marker={null}
                  value={mergeInstructions}
                  onChange={(value) => {
                    setMergeInstructions(value);
                    setValidationError(null);
                  }}
                  onSubmit={saveSelection}
                  focus={isEditingMergeInstructions}
                />
                <Text>{"]"}</Text>
              </Box>
            </>
          )}

          <Box height={1} />
          <Text dimColor>
            {
              "  Enter save · ↑↓/Tab move · Space select · ←→ options · Esc cancel"
            }
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
