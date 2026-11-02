import { Box, type DOMElement, measureElement } from "ink";
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ModelReasoningSelection } from "@/agent/model";
import { formatXhighEffortLabel } from "@/agent/reasoning-effort-label";
import { owningInputScope } from "@/cli/helpers/focus-ledger";
import {
  clearHoverIn,
  setHoverTarget,
  useRowHovered,
} from "@/cli/helpers/hover-store";
import { namedKeyChords } from "@/cli/helpers/input-keys";
import { createClickTracker } from "@/cli/helpers/mouse-click";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import type { MouseReport } from "@/cli/helpers/mouse-sequence";
import { acquireMouseHover } from "@/cli/helpers/mouse-tracking";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { moveCursor } from "@/cli/overlay/list-model";
import { colors } from "./colors";
import type { ModelSelectorSelection } from "./ModelSelector";
import { Text } from "./Text";

const EFFORT_BLOCK = "▌";

/**
 * The strip's indent (`paddingLeft` on the row): bar `i` is the cell at
 * `1 + i` inside the strip's own box.
 */
const BAR_INDENT = 1;

/**
 * Which bar a 1-based screen cell lands on, and whether it is in the strip at
 * all.
 *
 * The same shape as `OverlayListView`'s row hit test — measure the box the
 * pointer is resolved against, convert the report's 1-based cell into the
 * layout tree's 0-based one, and answer `null` for chrome inside the box (the
 * effort label, the gaps) so a press there is declined rather than guessed.
 */
function barAtPoint(
  box: { x: number; y: number; width: number; height: number },
  point: { row: number; column: number },
  totalBars: number,
): { inside: boolean; index: number | null } {
  const line = point.row - 1 - box.y;
  const rowInside = line >= 0 && line < box.height;
  const columnInside =
    point.column >= box.x + 1 && point.column <= box.x + box.width;
  if (!rowInside || !columnInside) return { inside: false, index: null };
  const index = point.column - 1 - box.x - BAR_INDENT;
  return {
    inside: true,
    index: index >= 0 && index < totalBars ? index : null,
  };
}

/**
 * The pointer half of the effort bar.
 *
 * This face renders its own carousel instead of an `OverlayListView` — the
 * options are bars on one line, not rows — so it takes the shared primitives
 * (`hover-store`, `mouse-router`, `mouse-click`, `mouse-tracking`) directly and
 * adds the smallest hit test that makes the bars clickable. The rules are the
 * list view's, unchanged: a click is the row's Enter (move the selection, then
 * run the same `onSelect` the keyboard runs), hover lights the bar under the
 * pointer, and a modal above the overlay makes the whole strip decline the
 * pointer (《38》§19.4). Nothing here touches the key table: ←/→/Tab/Enter/Esc
 * keep the bindings they had.
 */
function useEffortBarPointer(options: {
  area: string;
  totalBars: number;
  onPick: (barIndex: number) => void;
}): RefObject<DOMElement | null> {
  const { area, totalBars } = options;
  const ref = useRef<DOMElement | null>(null);
  const latest = useRef(options);
  latest.current = options;
  // Nothing to pick means nothing to hover: the bar is still painted (a
  // model with no reasoning tiers shows the empty scale), but it is inert.
  const enabled = totalBars > 0;

  useEffect(() => {
    if (!enabled) return undefined;
    const tracker = createClickTracker();
    // Any-motion (`1003`) is asked for only while the strip is up and given
    // back with it; `Ctrl+X m` is honoured inside `mouse-tracking.ts`.
    const giveBack = acquireMouseHover();

    const resolve = (point: {
      row: number;
      column: number;
    }): { inside: boolean; index: number | null } => {
      const node = ref.current;
      if (!node) return { inside: false, index: null };
      const box = measureElement(node);
      if (box.height <= 0 || box.width <= 0) {
        return { inside: false, index: null };
      }
      return barAtPoint(box, point, latest.current.totalBars);
    };

    const unregister = registerMouseHandler(
      (report: MouseReport) => {
        // A modal owns the keyboard and the pointer: refuse the whole frame
        // before anything is measured (《38》§19.4).
        if (owningInputScope() === "modal") {
          clearHoverIn(area);
          return false;
        }
        // A bar has no vertical scroll: a wheel notch is not this face's.
        if (report.wheel) return false;

        const hit = resolve(report);
        if (report.kind === "press") {
          if (report.button !== "left") return false;
          if (!hit.inside || hit.index === null) return false;
          tracker.press(report, Date.now());
          return true;
        }

        if (report.kind === "move") {
          if (tracker.isPending()) {
            // A claim this strip made owns the motion of its own gesture.
            tracker.move(report);
            return true;
          }
          if (!hit.inside) {
            clearHoverIn(area);
            return false;
          }
          if (hit.index === null) {
            clearHoverIn(area);
            return true;
          }
          setHoverTarget({ area, index: hit.index });
          return true;
        }

        // Release: the press cell is what a click resolves to, so a drag that
        // ended elsewhere cannot select a tier.
        const wasPending = tracker.isPending();
        const point = tracker.release(report, Date.now());
        if (!point) return wasPending;
        const pressed = resolve(point);
        if (pressed.index !== null) latest.current.onPick(pressed.index);
        return true;
      },
      { layer: "chrome", name: area },
    );

    return () => {
      unregister();
      giveBack();
      // A strip going away while hovered must not leave a bar lit underneath
      // whatever replaces it.
      clearHoverIn(area);
    };
  }, [enabled, area]);

  return ref;
}

/** One bar of the scale, lit by the pointer's hover while it is over it. */
function EffortBar({
  area,
  index,
  selected,
}: {
  area: string;
  index: number;
  selected: boolean;
}) {
  const hovered = useRowHovered(area, index);
  return (
    <Text
      color={selected ? colors.selector.itemHighlighted : undefined}
      dimColor={!selected}
      backgroundColor={hovered ? colors.surface.hoverBg : undefined}
    >
      {EFFORT_BLOCK}
    </Text>
  );
}

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

  // The pointer's half of the carousel: click a bar to select that tier,
  // hover to light it. `effortOptions.length` (not the display's at-least-one
  // bar) is what the hit test accepts, so an empty scale is inert.
  const pointerArea = `model-reasoning:${useId()}`;
  const pickBar = useCallback(
    (barIndex: number) => {
      const option = effortOptions[barIndex];
      if (!option) return;
      const index = options.indexOf(option);
      if (index < 0) return;
      // Click is that bar's Enter: move the selection, then run the handler the
      // keyboard runs, both on the clicked option (《38》§19.2).
      setSelectedIndex(index);
      onSelect(option);
    },
    [effortOptions, options, onSelect],
  );
  const barRef = useEffortBarPointer({
    area: pointerArea,
    totalBars: effortOptions.length,
    onPick: pickBar,
  });

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

      <Box ref={barRef} paddingLeft={1} flexDirection="row">
        {Array.from({ length: totalBars }, (_, index) => (
          <EffortBar
            key={`${effortOptions[index]?.effort ?? "empty"}:${index}`}
            area={pointerArea}
            index={index}
            selected={index < selectedBars}
          />
        ))}
        <Text> </Text>
        <Text bold>{effortLabel}</Text>
        <Text dimColor> reasoning effort</Text>
      </Box>
    </OverlayFrame>
  );
}
