import type { ToolName } from "./tool-definitions";
import type {
  ToolsetName,
  ToolsetOption,
  ToolsetPreference,
} from "./toolset-types";

interface ToolsetDefinition extends Omit<ToolsetOption, "id"> {
  tools: readonly ToolName[];
}

export const WORKTREE_TOOL_NAMES = new Set<ToolName>([
  "EnterWorktree",
  "ExitWorktree",
]);

/**
 * Presets in picker order. Availability filters and explicit allowlists apply afterward.
 *
 * `TopicMark` is an optional family that ships in every non-empty preset. The
 * frozen prompt chapter and the one-shot nudge both tell the model to call it, so
 * a preset that omits it would advertise a tool the payload cannot carry;
 * `declaration-gates.ts` removes it again on the cloud backend and when the switch
 * is off. The `none` preset declares no built-in tools at all, which is why
 * `shouldAdvertiseTopicMarking` also consults the toolset.
 *
 * `TopicQuery` rides with it: a marker the model cannot look up is a write with no
 * reader. It needs no setting gate of its own — reading the index is harmless — so
 * it is listed wherever markers are.
 */
export const TOOLSET_CATALOG: Readonly<Record<ToolsetName, ToolsetDefinition>> =
  {
    letta: {
      // The `letta` key is a persistence contract: `ToolsetPreference` stores it
      // in settings, so the id cannot move without a migration. Only the
      // user-facing strings are ours to name — and they must not say "Letta",
      // because this preset is Haruyuki's own unified toolset for every model,
      // not an upstream surface.
      display_name: "Haruyuki",
      label: "Haruyuki toolset",
      description: "Experimental unified toolset for every model",
      is_featured: true,
      tools: [
        "EnterWorktree",
        "ExitWorktree",
        "SetWorkingDirectory",
        "Task",
        "Monitor",
        "WatchPR",
        "Wake",
        "TaskStop",
        "Skill",
        "Workflow",
        "exec_command",
        "write_stdin",
        "Read",
        "Edit",
        "Write",
        "ViewImage",
        "UpdatePlan",
        "TopicMark",
        "TopicQuery",
      ],
    },
    none: {
      display_name: "None",
      label: "None",
      description: "Empty built-in preset; keeps connected tools",
      is_featured: true,
      tools: [],
    },
    default: {
      display_name: "Claude",
      label: "Claude toolset",
      description:
        "Optimized for Anthropic models, recommended for all non-OpenAI models",
      is_featured: true,
      tools: [
        "Bash",
        "Monitor",
        "WatchPR",
        "Wake",
        "EnterWorktree",
        "ExitWorktree",
        "SetWorkingDirectory",
        "Edit",
        "TaskStop",
        "Read",
        "Skill",
        "Workflow",
        "Task",
        "TaskCreate",
        "TaskGet",
        "TaskList",
        "TaskUpdate",
        "Write",
        "TopicMark",
        "TopicQuery",
      ],
    },
    codex: {
      display_name: "Codex",
      label: "Codex toolset",
      description: "Optimized for GPT/Codex models",
      is_featured: true,
      tools: [
        "EnterWorktree",
        "ExitWorktree",
        "SetWorkingDirectory",
        "Task",
        "Monitor",
        "WatchPR",
        "Wake",
        "TaskStop",
        "Skill",
        "Workflow",
        "exec_command",
        "write_stdin",
        "ViewImage",
        "ApplyPatch",
        "UpdatePlan",
        "TopicMark",
        "TopicQuery",
      ],
    },
  };

/** Auto selects a preset; client-facing options omit the internal tool lists. */
export const TOOLSET_OPTIONS: readonly ToolsetOption[] = [
  {
    id: "auto",
    display_name: "Auto",
    label: "Auto",
    description: "Auto-select based on the model",
    is_featured: true,
  },
  ...(Object.keys(TOOLSET_CATALOG) as ToolsetName[]).map((id) => {
    const { tools: _tools, ...option } = TOOLSET_CATALOG[id];
    return { id, ...option };
  }),
];

export function isToolsetPreference(
  value: unknown,
): value is ToolsetPreference {
  return TOOLSET_OPTIONS.some((option) => option.id === value);
}
