// Toolset selector.
//
// The toolkit's list, not a list of its own: the same frame, the same key table
// and the same row shape the other overlay lists use. What this face contributes
// is data — its `Auto` row's marker names the preset the preference resolves to
// (`currentLabel`), because "which toolset am I actually on" is the question this
// overlay exists to answer, and `Auto (current)` would not answer it.

import { useCallback, useMemo } from "react";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { ToolsetName, ToolsetPreference } from "@/tools/toolset";
import { TOOLSET_OPTIONS } from "@/tools/toolset-catalog";
import { formatToolsetName } from "@/tools/toolset-labels";

interface ToolsetSelectorProps {
  currentToolset?: ToolsetName;
  currentPreference?: ToolsetPreference;
  onSelect: (toolsetId: ToolsetPreference) => void;
  onCancel: () => void;
}

export function ToolsetSelector({
  currentToolset,
  currentPreference = "auto",
  onSelect,
  onCancel,
}: ToolsetSelectorProps) {
  const items = useMemo<SingleSelectItem[]>(
    () =>
      TOOLSET_OPTIONS.map((toolset) => {
        const isCurrent = toolset.id === currentPreference;
        return {
          key: toolset.id,
          label: toolset.id === "auto" ? "Auto" : toolset.label,
          description: toolset.description,
          isCurrent,
          // Only `auto` has something extra to say: the preset it resolves to
          // right now. Every other row takes the standard `(current)` marker.
          currentLabel:
            toolset.id === "auto" && isCurrent
              ? ` (current - ${formatToolsetName(currentToolset)})`
              : undefined,
        };
      }),
    [currentPreference, currentToolset],
  );

  const handleSelect = useCallback(
    (key: string) => {
      const toolset = TOOLSET_OPTIONS.find((option) => option.id === key);
      if (toolset) onSelect(toolset.id);
    },
    [onSelect],
  );

  return (
    <OverlayFrame command="/toolset" title="Swap your agent's toolset">
      <SingleSelectPicker
        items={items}
        onSelect={handleSelect}
        onCancel={onCancel}
      />
    </OverlayFrame>
  );
}
