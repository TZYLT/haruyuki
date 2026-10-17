// System prompt selector.
// Wraps SingleSelectPicker with system-prompt-specific logic.

import { memo, useCallback, useMemo, useState } from "react";
import { SYSTEM_PROMPTS } from "@/agent/prompt-assets";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";

const SHOW_ALL_KEY = "__show_all__";

interface SystemPromptSelectorProps {
  currentPromptId?: string;
  onSelect: (promptId: string) => void;
  onCancel: () => void;
}

export const SystemPromptSelector = memo(function SystemPromptSelector({
  currentPromptId,
  onSelect,
  onCancel,
}: SystemPromptSelectorProps) {
  const [showAll, setShowAll] = useState(false);

  const featuredPrompts = useMemo(
    () => SYSTEM_PROMPTS.filter((prompt) => prompt.isFeatured),
    [],
  );

  const visiblePrompts = useMemo(() => {
    if (showAll) return SYSTEM_PROMPTS;
    if (featuredPrompts.length > 0) return featuredPrompts;
    return SYSTEM_PROMPTS.slice(0, 3);
  }, [featuredPrompts, showAll]);

  const hasShowAllOption =
    !showAll && visiblePrompts.length < SYSTEM_PROMPTS.length;

  const items = useMemo<SingleSelectItem[]>(() => {
    const promptItems: SingleSelectItem[] = visiblePrompts.map((prompt) => ({
      key: prompt.id,
      label: prompt.label,
      description: prompt.description,
      isCurrent: prompt.id === currentPromptId,
    }));
    if (hasShowAllOption) {
      promptItems.push({
        key: SHOW_ALL_KEY,
        label: "Show all prompts",
        dimLabel: true,
      });
    }
    return promptItems;
  }, [visiblePrompts, hasShowAllOption, currentPromptId]);

  const handleSelect = useCallback(
    (key: string) => {
      if (key === SHOW_ALL_KEY) {
        setShowAll(true);
        return;
      }
      onSelect(key);
    },
    [onSelect],
  );

  return (
    <OverlayFrame command="/system" title="Swap your agent's system prompt">
      <SingleSelectPicker
        items={items}
        onSelect={handleSelect}
        onCancel={onCancel}
      />
    </OverlayFrame>
  );
});
