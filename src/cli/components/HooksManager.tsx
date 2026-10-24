// src/cli/components/HooksManager.tsx
// Interactive TUI for managing hooks configuration

import { Box } from "ink";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { ConfirmOptions } from "@/cli/overlay/confirm";
import { OverlayFrame } from "@/cli/overlay/frame";
import { listBindings } from "@/cli/overlay/list-bindings";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import {
  type HookCommand,
  type HookEvent,
  type HookMatcher,
  isCommandHook,
  isPromptHook,
  isToolEvent,
  type SimpleHookEvent,
  type SimpleHookMatcher,
  type ToolHookEvent,
} from "@/hooks/types";
import {
  addHookMatcher,
  addSimpleHookMatcher,
  countHooksForEvent,
  countTotalHooks,
  type HookMatcherWithSource,
  type HookWithSource,
  isUserHooksDisabled,
  loadMatchersWithSource,
  loadSimpleMatchersWithSource,
  removeHook,
  type SaveLocation,
  setHooksDisabled,
} from "@/hooks/writer";
import { settingsManager } from "@/settings-manager";
import { appHomeDirName } from "@/utils/app-paths";
import { colors } from "./colors";
import { Text } from "./Text";

/**
 * How many rows the hook list shows at once, and what PageUp/PageDown step over.
 *
 * The face listed every hook it found, which on a long config pushes the exit-code
 * reminder and the hint line off the top of the terminal. Windowing is the signed
 * change for this commit (`overlay/README.md` rule 4: opt-in, so this number is a
 * decision, not a default).
 */
const WINDOW_ROWS = 10;

/** The copy of this face's delete confirmation; the rows themselves are shared. */
const HOOK_DELETE_OPTIONS = [
  { key: "delete", label: "Yes, delete" },
  { key: "cancel", label: "No, cancel" },
];

/**
 * Get a display label for a hook (command or prompt).
 * For prompt hooks, returns just the prompt text (without prefix).
 */
function getHookDisplayLabel(hook: HookCommand | undefined): string {
  if (!hook) return "";
  if (isCommandHook(hook)) {
    return hook.command;
  }
  if (isPromptHook(hook)) {
    return `${hook.prompt.slice(0, 40)}${hook.prompt.length > 40 ? "..." : ""}`;
  }
  return "";
}

interface HooksManagerProps {
  onClose: () => void;
}

type Step =
  | "events"
  | "hooks-list" // Was "matchers" - now handles both matchers and commands
  | "add-matcher" // For tool events only
  | "add-command"
  | "save-location"
  | "delete-confirm";

// All hook events with descriptions
const HOOK_EVENTS: { event: HookEvent; description: string }[] = [
  { event: "PreToolUse", description: "Before tool execution" },
  { event: "PostToolUse", description: "After tool execution" },
  { event: "PostToolUseFailure", description: "After tool execution fails" },
  { event: "PermissionRequest", description: "When permission is requested" },
  { event: "UserPromptSubmit", description: "When user submits a prompt" },
  { event: "Notification", description: "When notifications are sent" },
  { event: "Stop", description: "When the agent finishes responding" },
  { event: "SubagentStop", description: "When a subagent completes" },
  { event: "PreCompact", description: "Before context compaction" },
  { event: "SessionStart", description: "When a session starts" },
  { event: "SessionEnd", description: "When a session ends" },
];

/** Identity of the events screen's first row: the all-hooks toggle. */
const TOGGLE_ROW_KEY = "toggle-hooks";

/**
 * One row per hook event, in the order `HOOK_EVENTS` declares them.
 *
 * The toggle row is deliberately **not** here: its label is state ("Disable all
 * hooks" / "Enable all hooks"), so the screen builds its item list from this plus
 * that row where the state is. Keeping a static copy in this array is how the row
 * used to lie whenever hooks were already disabled.
 */
const EVENT_ROWS: OverlayListItem[] = HOOK_EVENTS.map(
  ({ event, description }) => ({
    key: event,
    label: event,
    description,
  }),
);

// Fallback tool names if agent tools can't be fetched
const FALLBACK_TOOL_NAMES = [
  "Task",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "AskUserQuestion",
  "Skill",
  "TaskStop",
];

// Save location options
const SAVE_LOCATIONS: {
  location: SaveLocation;
  label: string;
  path: string;
}[] = [
  {
    location: "project-local",
    label: "Project settings (local)",
    path: `${appHomeDirName()}/settings.local.json`,
  },
  {
    location: "project",
    label: "Project settings",
    path: `${appHomeDirName()}/settings.json`,
  },
  {
    location: "user",
    label: "User settings",
    path: `~/${appHomeDirName()}/settings.json`,
  },
];

function getSourceLabel(source: SaveLocation): string {
  switch (source) {
    case "user":
      return "User";
    case "project":
      return "Project";
    case "project-local":
      return "Local";
  }
}

/**
 * `/config hooks` on the overlay toolkit.
 *
 * The face was six screens behind one `useInput`, a `╭─╮` header it drew itself on
 * every one of them, and no test at all. Each piece is now the toolkit's: the frame
 * draws the header (`> /config hooks`, with the count and `(disabled)` moved into its
 * title), `useWizard` walks the six steps as one trail, the two lists are
 * `useOverlayList` tables, the two fields are `OverlayTextField`s — which is the
 * same `PasteAwareTextInput` this face already used, now the toolkit's labelled row
 * with `marker={null}` because the face draws the editor inside its own rounded box
 * — and the confirmation is `ConfirmOptions`.
 *
 * Two of the face's keys were already the toolkit's, and the fields they sit in were
 * already real editors; what the rewrite removes is the sixth hand-written Escape
 * ladder in this tree and the second copy of the header. That ladder cannot be driven
 * under a bare mount either — this face is the second instance of the `memo` plus
 * `useInput` freeze `ApprovalOptions.test.tsx` records first, which is why the frame
 * baseline below needed the `memo(` removed (`overlay/README.md`; whether a running
 * app's re-render cadence masks it is L3's question in `docs/36` M5). The rewrite's own
 * sixteen scripted frames, from the events screen through both add flows and the
 * delete confirmation, are byte-identical to that face's once its header is taken off
 * and the one-column indent that box needed is removed.
 *
 * Three things the rewrite had to keep, because they are this face's behaviour and
 * not the toolkit's:
 *
 * - **The escape ladder.** `events` is the root (Escape closes), `hooks-list`
 *   returns to it, `add-command` returns to `add-matcher` for a tool event and to
 *   the hook list for a simple one — which the trail reproduces for free, because
 *   a simple event never pushes `add-matcher`. Finishing an add or a delete from
 *   four steps deep lands back on the hook list via `popTo`, not on the root.
 * - **The cursor resets.** Leaving the hook list resets the events cursor, and a
 *   completed delete resets the hook cursor, which is what the old
 *   `setSelectedIndex(0)` did on each of those transitions.
 * - **The row markup**, character for character: the numbers, the cyan source
 *   label, the matcher column padded to twelve, and the `✦` that marks a prompt
 *   hook.
 *
 * The `╭─╮` box and the one-column body indent it needed are gone: this frame's
 * header is the same one the other eight migrated faces use.
 */
export const HooksManager = memo(function HooksManager({
  onClose,
}: HooksManagerProps) {
  const terminalWidth = useTerminalWidth();
  const boxWidth = Math.min(terminalWidth - 4, 70);

  const [selectedEvent, setSelectedEvent] = useState<HookEvent | null>(null);
  // For tool events: HookMatcherWithSource[], for simple events: HookWithSource[]
  const [hooks, setHooks] = useState<HookWithSource[]>([]);
  const [totalHooks, setTotalHooks] = useState(0);

  // Local backends do not manage tools server-side, so the matcher picker
  // always uses the static fallback list.
  const toolNames = FALLBACK_TOOL_NAMES;

  // Track whether all hooks are disabled
  const [hooksDisabled, setHooksDisabledState] = useState(isUserHooksDisabled);

  // New hook state
  const [newMatcher, setNewMatcher] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [selectedLocation, setSelectedLocation] = useState(0);

  // Delete confirmation
  const [deleteHookIndex, setDeleteHookIndex] = useState(-1);
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState(1); // Default to No

  const wizard = useWizard<Step>({ initial: "events" });
  const { back, canGoBack, goTo, popTo, step } = wizard;

  // Helper to check if current event is a tool event
  const isCurrentToolEvent = selectedEvent ? isToolEvent(selectedEvent) : false;

  // Refresh counts - called when hooks change
  const refreshCounts = useCallback(() => {
    setTotalHooks(countTotalHooks());
    setHooksDisabledState(isUserHooksDisabled());
  }, []);

  // Track if initial settings load has been done
  const initialLoadDone = useRef(false);

  // Ensure settings are loaded before counting hooks (runs once on mount)
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const loadSettings = async () => {
      try {
        await settingsManager.loadProjectSettings();
        await settingsManager.loadLocalProjectSettings();
      } catch {
        // Settings may already be loaded or not available
      }
      refreshCounts();
    };
    loadSettings();
  }, [refreshCounts]);

  // Refresh counts when returning to events screen
  useEffect(() => {
    if (step === "events") {
      refreshCounts();
    }
  }, [step, refreshCounts]);

  // Load hooks when event is selected (matchers for both tool and simple events)
  const loadHooks = useCallback((event: HookEvent) => {
    if (isToolEvent(event)) {
      setHooks(loadMatchersWithSource(event as ToolHookEvent));
    } else {
      setHooks(loadSimpleMatchersWithSource(event as SimpleHookEvent));
    }
  }, []);

  // Handle toggling the "disable all hooks" setting
  const handleToggleDisableAll = useCallback(() => {
    const newValue = !hooksDisabled;
    setHooksDisabled(newValue);
    setHooksDisabledState(newValue);
  }, [hooksDisabled]);

  // Items for the hook list: [+ Add new hook] + existing hooks
  const hookItems = useMemo<OverlayListItem[]>(() => {
    const addLabel = isCurrentToolEvent
      ? "+ Add new matcher..."
      : "+ Add new hook...";
    return [
      { key: "add-hook", label: addLabel },
      ...hooks.map((hook, index) => ({
        key: `${hook.source}-${hook.sourceIndex}-${index}`,
        label: `[${getSourceLabel(hook.source)}]`,
      })),
    ];
  }, [hooks, isCurrentToolEvent]);

  // The events screen's rows: the toggle (whose text is state) and then the
  // event rows (whose text is data). Built here so the list the view windows and
  // the list the cursor moves through are the same array.
  const disableToggleLabel = hooksDisabled
    ? "Enable all hooks"
    : "Disable all hooks";
  const eventRows = useMemo<OverlayListItem[]>(
    () => [{ key: TOGGLE_ROW_KEY, label: disableToggleLabel }, ...EVENT_ROWS],
    [disableToggleLabel],
  );

  const eventsList = useOverlayList({
    owner: "hooks-events",
    items: eventRows,
    navigationEnabled: step === "events",
    onConfirm: (_key, index) => {
      if (index === 0) {
        // Toggle "disable all hooks"
        handleToggleDisableAll();
        return;
      }
      // Select a hook event (index is shifted by 1)
      const entry = HOOK_EVENTS[index - 1];
      if (!entry) return;
      setSelectedEvent(entry.event);
      loadHooks(entry.event);
      goTo("hooks-list");
    },
    // Escape and Ctrl+C are the wizard's, so this list declares no cancel: a list
    // that did would answer Escape for the other five steps as well.
    onCancel: undefined,
  });

  const hooksList = useOverlayList({
    owner: "hooks-hooks",
    items: hookItems,
    rows: WINDOW_ROWS,
    anchor: "edge",
    navigationEnabled: step === "hooks-list",
    onConfirm: (_key, index) => {
      if (index === 0) {
        // Add new hook - for tool events, ask for the matcher first.
        if (isCurrentToolEvent) {
          setNewMatcher("");
          goTo("add-matcher");
        } else {
          setNewCommand("");
          goTo("add-command");
        }
        return;
      }
      // Delete selected hook
      setDeleteHookIndex(index - 1);
      setDeleteConfirmIndex(1); // Default to No
      goTo("delete-confirm");
    },
    onCancel: undefined,
  });

  /** Escape with a step to return to: that step's own state is reset here. */
  const leaveStep = useCallback(() => {
    if (step === "hooks-list") {
      setSelectedEvent(null);
      // What `setSelectedIndex(0)` did when this list handed the screen back.
      eventsList.setCursor(0);
    }
    back();
  }, [back, eventsList, step]);

  // Handle adding a hook
  const handleAddHook = useCallback(async () => {
    if (!selectedEvent || !newCommand.trim()) return;

    const location = SAVE_LOCATIONS[selectedLocation]?.location;
    if (!location) return;

    if (isToolEvent(selectedEvent)) {
      // Tool events use HookMatcher with matcher pattern
      const matcher: HookMatcher = {
        matcher: newMatcher.trim() || "*",
        hooks: [{ type: "command", command: newCommand.trim() }],
      };
      await addHookMatcher(selectedEvent as ToolHookEvent, matcher, location);
    } else {
      // Simple events use SimpleHookMatcher (same structure, just no matcher field)
      const matcher: SimpleHookMatcher = {
        hooks: [{ type: "command", command: newCommand.trim() }],
      };
      await addSimpleHookMatcher(
        selectedEvent as SimpleHookEvent,
        matcher,
        location,
      );
    }

    loadHooks(selectedEvent);
    refreshCounts();

    // Reset and go back to hooks list
    setNewMatcher("");
    setNewCommand("");
    setSelectedLocation(0);
    popTo("hooks-list");
  }, [
    selectedEvent,
    newMatcher,
    newCommand,
    selectedLocation,
    loadHooks,
    popTo,
    refreshCounts,
  ]);

  // Handle deleting a hook
  const handleDeleteHook = useCallback(async () => {
    if (deleteHookIndex < 0 || !selectedEvent) return;

    const hook = hooks[deleteHookIndex];
    if (!hook) return;

    await removeHook(selectedEvent, hook.sourceIndex, hook.source);
    loadHooks(selectedEvent);
    refreshCounts();

    // Reset and go back to hooks list
    setDeleteHookIndex(-1);
    popTo("hooks-list");
    hooksList.setCursor(0);
  }, [
    deleteHookIndex,
    selectedEvent,
    hooks,
    loadHooks,
    popTo,
    refreshCounts,
    hooksList,
  ]);

  useKeyBindings("hooks-manager-keys", [
    {
      scope: "overlay",
      bindings: [
        // The save-location picker is three rows with its own cursor: arrows move
        // it and Enter writes the hook. It is a `listBindings` table rather than a
        // list, because it is a step inside this overlay and does not own Escape.
        ...listBindings({
          count: SAVE_LOCATIONS.length,
          cursor: selectedLocation,
          onMoveCursor: setSelectedLocation,
          onConfirm: () => {
            void handleAddHook();
          },
          onCancel: undefined,
          navigationEnabled: step === "save-location",
        }),
        // The delete confirmation is a two-row list of its own, for the same
        // reason: Escape here is the wizard's ("back to the hook list"), which is
        // also how the old handler read it.
        ...listBindings({
          count: HOOK_DELETE_OPTIONS.length,
          cursor: deleteConfirmIndex,
          onMoveCursor: setDeleteConfirmIndex,
          onConfirm: () => {
            if (deleteConfirmIndex === 0) {
              void handleDeleteHook();
            } else {
              popTo("hooks-list");
            }
          },
          onCancel: undefined,
          navigationEnabled: step === "delete-confirm" && deleteHookIndex >= 0,
        }),
        ...wizardBindings({ canGoBack, onBack: leaveStep, onCancel: onClose }),
      ],
    },
  ]);

  // Render Events List
  if (step === "events") {
    const title = `Hooks · ${totalHooks} hooks${hooksDisabled ? " (disabled)" : ""}`;

    return (
      <OverlayFrame
        command="/hooks"
        title={title}
        footer="Enter to select · esc to cancel"
      >
        <OverlayListView
          items={eventRows}
          cursor={eventsList.cursor}
          renderRow={(item, index, isCursor) => {
            if (index === 0) {
              return (
                <Text>
                  <Text
                    bold={isCursor}
                    color={
                      isCursor ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {isCursor ? CLI_GLYPHS.selection : " "} 1.
                  </Text>
                  <Text dimColor> {item.label}</Text>
                </Text>
              );
            }

            // The count is per event, so it is looked up by the row's own key;
            // the text on screen is the item's, which is what makes the list the
            // single description of a row rather than a second copy of it.
            const entry = HOOK_EVENTS[index - 1];
            if (!entry) return null;
            const hookCount = countHooksForEvent(entry.event);
            const countStr = hookCount > 0 ? ` (${hookCount})` : "";

            return (
              <Text>
                <Text
                  bold={isCursor}
                  color={isCursor ? colors.selector.itemHighlighted : undefined}
                >
                  {isCursor ? CLI_GLYPHS.selection : " "} {index + 1}.{" "}
                  {item.label}
                </Text>
                <Text dimColor> - {item.description}</Text>
                <Text color="yellow">{countStr}</Text>
              </Text>
            );
          }}
        />
      </OverlayFrame>
    );
  }

  // Render Hooks List (matchers for tool events, commands for simple events)
  if (step === "hooks-list" && selectedEvent) {
    const title = isCurrentToolEvent
      ? `${selectedEvent} - Tool Matchers`
      : `${selectedEvent} - Hooks`;

    return (
      <OverlayFrame
        command="/hooks"
        title={title}
        footer="Enter to select · esc to go back"
      >
        {isCurrentToolEvent ? (
          <>
            <Text dimColor>
              Input to command is JSON of tool call arguments.
            </Text>
            <Text dimColor>Exit code 0 - stdout/stderr not shown</Text>
            <Text dimColor>
              Exit code 2 - show stderr to model and block tool call
            </Text>
            <Text dimColor>
              Other exit codes - show stderr to user only but continue
            </Text>
          </>
        ) : (
          <>
            <Text dimColor>Exit code 0 - success, continue</Text>
            <Text dimColor>Exit code 2 - show stderr to model and block</Text>
            <Text dimColor>Other exit codes - show stderr to user only</Text>
          </>
        )}
        <Box height={1} />

        <OverlayListView
          items={hookItems}
          cursor={hooksList.cursor}
          rows={WINDOW_ROWS}
          anchor="edge"
          renderRow={(_item, index, isCursor) => {
            if (index === 0) {
              const addLabel = isCurrentToolEvent
                ? "+ Add new matcher..."
                : "+ Add new hook...";
              return (
                <Text>
                  <Text
                    bold={isCursor}
                    color={
                      isCursor ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {isCursor ? CLI_GLYPHS.selection : " "} 1.{" "}
                  </Text>
                  <Text color="green">{addLabel}</Text>
                </Text>
              );
            }

            const hook = hooks[index - 1];
            if (!hook) return null;
            const sourceLabel = `[${getSourceLabel(hook.source)}]`;

            // Handle both tool matchers (with matcher field) and simple matchers
            const isToolMatcher = "matcher" in hook;
            const matcherPattern = isToolMatcher
              ? (hook as HookMatcherWithSource).matcher || "*"
              : null;
            // Both types have hooks array - get display label for first hook
            const firstHook = "hooks" in hook ? hook.hooks[0] : undefined;
            const command = getHookDisplayLabel(firstHook);
            const truncatedCommand =
              command.length > 50 ? `${command.slice(0, 47)}...` : command;
            const isPrompt = firstHook ? isPromptHook(firstHook) : false;

            return (
              <Text>
                <Text
                  bold={isCursor}
                  color={isCursor ? colors.selector.itemHighlighted : undefined}
                >
                  {isCursor ? CLI_GLYPHS.selection : " "} {index + 1}.{" "}
                </Text>
                <Text color="cyan">{sourceLabel}</Text>
                {matcherPattern !== null ? (
                  <Text> {matcherPattern.padEnd(12)} </Text>
                ) : (
                  <Text> </Text>
                )}
                {isPrompt && <Text color={colors.status.processing}>✦ </Text>}
                <Text dimColor>{truncatedCommand}</Text>
              </Text>
            );
          }}
        />
      </OverlayFrame>
    );
  }

  // Render Add Matcher - Tool Pattern Input
  if (step === "add-matcher" && selectedEvent) {
    return (
      <OverlayFrame
        command="/hooks"
        title={`Add new matcher for ${selectedEvent}`}
        footer="Enter to continue · esc to cancel"
      >
        <Text dimColor>Input to command is JSON of tool call arguments.</Text>
        <Text dimColor>Exit code 0 - stdout/stderr not shown</Text>
        <Text dimColor>
          Exit code 2 - show stderr to model and block tool call
        </Text>
        <Box height={1} />

        <Text dimColor>Possible matcher values for field tool_name:</Text>
        <Text dimColor>{toolNames.join(", ")}</Text>
        <Box height={1} />

        <Text>Tool matcher:</Text>
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          width={boxWidth - 2}
          flexDirection="column"
        >
          <Box flexWrap="wrap">
            <OverlayTextField
              value={newMatcher}
              onChange={setNewMatcher}
              marker={null}
              placeholder="* (matches all tools)"
              onSubmit={() => {
                setNewCommand("");
                goTo("add-command");
              }}
            />
          </Box>
        </Box>
        <Box height={1} />

        <Text dimColor>Example Matchers:</Text>
        <Text dimColor>• Write (single tool)</Text>
        <Text dimColor>• Write|Edit (multiple tools)</Text>
        <Text dimColor>• * (all tools)</Text>
      </OverlayFrame>
    );
  }

  // Render Add Command Input
  if (step === "add-command" && selectedEvent) {
    const title = isCurrentToolEvent
      ? `Add new matcher for ${selectedEvent}`
      : `Add new hook for ${selectedEvent}`;

    return (
      <OverlayFrame
        command="/hooks"
        title={title}
        footer="Enter to continue · esc to go back"
      >
        {isCurrentToolEvent && <Text>Matcher: {newMatcher || "*"}</Text>}
        {isCurrentToolEvent && <Box height={1} />}

        <Text>Command:</Text>
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          width={boxWidth - 2}
          flexDirection="column"
        >
          <Box flexWrap="wrap">
            <OverlayTextField
              value={newCommand}
              onChange={setNewCommand}
              marker={null}
              placeholder="/path/to/script.sh"
              onSubmit={() => {
                setSelectedLocation(0);
                goTo("save-location");
              }}
            />
          </Box>
        </Box>
      </OverlayFrame>
    );
  }

  // Render Save Location Picker
  if (step === "save-location" && selectedEvent) {
    return (
      <OverlayFrame
        command="/hooks"
        title="Save hook configuration"
        footer="Enter to confirm · esc to go back"
      >
        <Text>Event: {selectedEvent}</Text>
        {isCurrentToolEvent && <Text>Matcher: {newMatcher || "*"}</Text>}
        <Text>Command: {newCommand}</Text>
        <Box height={1} />

        <Text>Where should this hook be saved?</Text>
        <Box height={1} />

        {SAVE_LOCATIONS.map((loc, index) => {
          const isSelected = index === selectedLocation;
          const prefix = isSelected ? CLI_GLYPHS.selection : " ";

          return (
            <Text key={loc.location}>
              <Text
                bold={isSelected}
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {prefix} {index + 1}. {loc.label}
              </Text>
              <Text dimColor> {loc.path}</Text>
            </Text>
          );
        })}
      </OverlayFrame>
    );
  }

  // Render Delete Confirmation
  if (step === "delete-confirm" && deleteHookIndex >= 0) {
    const hook = hooks[deleteHookIndex];
    const isToolMatcher = hook && "matcher" in hook;
    const matcherPattern = isToolMatcher
      ? (hook as HookMatcherWithSource).matcher || "*"
      : null;
    // Both types have hooks array - get display label for first hook
    const firstHook = hook && "hooks" in hook ? hook.hooks[0] : undefined;
    const command = getHookDisplayLabel(firstHook);
    const isPrompt = firstHook ? isPromptHook(firstHook) : false;

    return (
      <OverlayFrame
        command="/hooks"
        title="Delete hook?"
        footer="Enter to confirm · esc to cancel"
      >
        {matcherPattern !== null && <Text>Matcher: {matcherPattern}</Text>}
        <Text>
          {isPrompt ? (
            <>
              Hook: <Text color={colors.status.processing}>✦ </Text>
              {command}
            </>
          ) : (
            <>Command: {command}</>
          )}
        </Text>
        <Text>Source: {hook ? getSourceLabel(hook.source) : ""}</Text>
        <Box height={1} />

        <ConfirmOptions
          options={HOOK_DELETE_OPTIONS}
          selectedIndex={deleteConfirmIndex}
        />
      </OverlayFrame>
    );
  }

  return null;
});
