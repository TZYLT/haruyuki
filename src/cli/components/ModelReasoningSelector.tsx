import { Box } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { ModelReasoningSelection } from "@/agent/model";
import { formatXhighEffortLabel } from "@/agent/reasoning-effort-label";
import { namedKeyChords } from "@/cli/helpers/input-keys";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { moveCursor } from "@/cli/overlay/list-model";
import { colors } from "./colors";
import type { ModelSelectorSelection } from "./ModelSelector";
import { Text } from "./Text";

const EFFORT_BLOCK = "▌";

interface ReasoningOption {
  effort: ModelReasoningSelection;
  modelId: string;
  selection?: ModelSelectorSelection;
}

interface ModelReasoningSelectorProps {
  modelLabel: string;
  options: ReasoningOption[];
  initialModelId: string;
  initialEffort?: ModelReasoningSelection;
  onSelect: (option: ReasoningOption) => void;
  onCancel: () => void;
}

function formatEffortLabel(
  effort: ModelReasoningSelection,
  hasDistinctMaxTier: boolean,
): string {
  if (effort === null) return "Default";
  if (effort === "none") return "Off";
  if (effort === "xhigh") return formatXhighEffortLabel(hasDistinctMaxTier);
  if (effort === "max") return "Max";
  if (effort === "minimal") return "Minimal";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function ModelReasoningSelector({
  modelLabel,
  options,
  initialModelId,
  initialEffort,
  onSelect,
  onCancel,
}: ModelReasoningSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex(
      (option) =>
        option.modelId === initialModelId &&
        (initialEffort === undefined || option.effort === initialEffort),
    );
    return idx >= 0 ? idx : 0;
  });

  useEffect(() => {
    const idx = options.findIndex(
      (option) =>
        option.modelId === initialModelId &&
        (initialEffort === undefined || option.effort === initialEffort),
    );
    if (idx >= 0) {
      setSelectedIndex(idx);
    }
  }, [options, initialModelId, initialEffort]);

  const selectedOption = options[selectedIndex] ?? options[0];
  const effortOptions = useMemo(
    () =>
      options.filter(
        (option) => option.effort !== null && option.effort !== "none",
      ),
    [options],
  );
  const hasDistinctMaxTier = useMemo(
    () => options.some((option) => option.effort === "max"),
    [options],
  );
  const totalBars = Math.max(effortOptions.length, 1);
  const selectedBars = useMemo(() => {
    if (!selectedOption) return 0;
    if (selectedOption.effort === null || selectedOption.effort === "none")
      return 0;
    const effortIndex = effortOptions.findIndex(
      (option) => option.effort === selectedOption.effort,
    );
    return effortIndex >= 0 ? effortIndex + 1 : 0;
  }, [effortOptions, selectedOption]);

  useKeyBindings("model-reasoning-selector", [
    {
      scope: "overlay",
      bindings: [
        // Escape is never declined in this tree — an overlay that cannot be left
        // is a trap — and Ctrl+C is the same action here, as it always was.
        {
          id: "model-reasoning.cancel",
          chords: [...namedKeyChords("escape"), { key: "c", ctrl: true }],
          run: () => {
            onCancel();
            return "consumed";
          },
        },
        {
          id: "model-reasoning.select",
          chords: namedKeyChords("return"),
          run: () => {
            if (!selectedOption) return "declined";
            onSelect(selectedOption);
            return "consumed";
          },
        },
        {
          id: "model-reasoning.previous",
          chords: namedKeyChords("leftArrow"),
          run: () => {
            if (options.length === 0) return "declined";
            setSelectedIndex((prev) =>
              moveCursor({
                cursor: prev,
                count: options.length,
                delta: -1,
                wrap: true,
              }),
            );
            return "consumed";
          },
        },
        {
          // Shift+Tab too: Ink reports the modifier, and the hand-written
          // handler this replaced read `key.tab` without looking at it.
          id: "model-reasoning.next",
          chords: [
            { key: "rightArrow" },
            { key: "tab" },
            { key: "tab", shift: true },
          ],
          run: () => {
            if (options.length === 0) return "declined";
            setSelectedIndex((prev) =>
              moveCursor({
                cursor: prev,
                count: options.length,
                delta: 1,
                wrap: true,
              }),
            );
            return "consumed";
          },
        },
      ],
    },
  ]);

  const effortLabel = selectedOption
    ? formatEffortLabel(selectedOption.effort, hasDistinctMaxTier)
    : "Medium";
  const selectedText =
    selectedBars > 0 ? EFFORT_BLOCK.repeat(selectedBars) : "";
  const remainingBars =
    totalBars > selectedBars
      ? EFFORT_BLOCK.repeat(totalBars - selectedBars)
      : "";

  return (
    <OverlayFrame
      command="/model"
      title="Set your model's reasoning settings"
      footer={
        <Box paddingLeft={1}>
          <Text dimColor>Enter select · ←→/Tab switch · Esc back</Text>
        </Box>
      }
    >
      <Box paddingLeft={1}>
        <Text>{modelLabel}</Text>
      </Box>

      <Box height={1} />

      <Box paddingLeft={1} flexDirection="row">
        <Text color={colors.selector.itemHighlighted}>{selectedText}</Text>
        <Text dimColor>{remainingBars}</Text>
        <Text> </Text>
        <Text bold>{effortLabel}</Text>
        <Text dimColor> reasoning effort</Text>
      </Box>
    </OverlayFrame>
  );
}
