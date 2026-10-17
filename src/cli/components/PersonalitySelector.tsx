// Personality selector.
// Wraps SingleSelectPicker with personality-specific logic.

import { memo, useMemo } from "react";
import {
  PERSONALITY_OPTIONS,
  type PersonalityId,
} from "@/agent/personality-presets";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";

interface PersonalitySelectorProps {
  currentPersonalityId?: PersonalityId;
  onSelect: (personalityId: PersonalityId) => void;
  onCancel: () => void;
}

export const PersonalitySelector = memo(function PersonalitySelector({
  currentPersonalityId,
  onSelect,
  onCancel,
}: PersonalitySelectorProps) {
  const items = useMemo<SingleSelectItem[]>(
    () =>
      PERSONALITY_OPTIONS.map((option) => ({
        key: option.id,
        label: option.label,
        description: option.description,
        isCurrent: option.id === currentPersonalityId,
      })),
    [currentPersonalityId],
  );

  return (
    <OverlayFrame command="/personality" title="Swap your agent personality">
      <SingleSelectPicker
        items={items}
        onSelect={(key) => onSelect(key as PersonalityId)}
        onCancel={onCancel}
      />
    </OverlayFrame>
  );
});
