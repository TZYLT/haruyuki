import { Box, type DOMElement } from "ink";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { commands } from "@/cli/commands/registry";
import {
  findSubcommandSpec,
  getSubcommandSpecs,
  type SubcommandSpec,
} from "@/cli/commands/subcommand-specs";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import {
  applyCandidate,
  type CompletionCandidate,
  type CompletionState,
  fillCompletion,
  isCandidateAlreadyTyped,
  resolveCommandCompletion,
} from "@/cli/helpers/command-completion";
import { useRowHovered } from "@/cli/helpers/hover-store";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useMouseRows } from "@/cli/helpers/use-mouse-rows";
import { useAutocompleteNavigation } from "@/cli/hooks/use-autocomplete-navigation";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { resolveUiV2Once } from "@/experiments/ui-v2";
import { settingsManager } from "@/settings-manager";
import { AutocompleteBox, AutocompleteItem } from "./Autocomplete";
import { Text } from "./Text";
import type { AutocompleteProps, CommandMatch } from "./types/autocomplete";

// Match Codex's slash-command popup behavior: a small hard cap that can shrink
// on short terminals, but never expands just because the terminal is tall.
const MAX_POPUP_ROWS = 8;
const CMD_COL_WIDTH = 14;

/** A stable empty list: an inactive popup keeps the same `matches` identity. */
const NO_CANDIDATES: readonly CompletionCandidate[] = [];

const BUILTIN_SKILL_ALIASES = new Set([
  "acquiring-skills",
  "context-doctor",
  "creating-skills",
  "customizing-statusline",
  "initializing-memory",
  "migrating-memory",
  "syncing-memory-filesystem",
]);

/**
 * The commands that only mean something in the full-screen shell.
 *
 * `/tabs`, `/close`, `/settings`, `/usage`, `/message-history` and
 * `/hidden-sessions` name the tab strip, the two fixed pages and the read-only
 * faces. The append shell draws
 * none of them, so in legacy they are not offered at all — typing one still works
 * (the registry answers with one honest line), but a list that offers a command
 * the shell cannot perform is a list that lies.
 *
 * Read at render time, never at module load: `resolveUiV2Once` resolves the
 * experiment through the settings cache, and at import time that cache may not be
 * populated yet — a wrong answer there is cached for the whole process.
 */
export const FULL_SCREEN_ONLY_COMMANDS = new Set([
  "/tabs",
  "/close",
  "/settings",
  "/usage",
  // It was missing: `/message-history` has been a shell command since it landed
  // (`shell-commands.ts` answers `false` for it in legacy, so the registry prints
  // its one-line receipt) but the list kept offering it there — a suggestion for a
  // command the shell cannot perform, which is exactly what this set is for.
  "/message-history",
  // Same contract, same reason: `/maintenance sessions` opens the hidden-session
  // list, which only the full-screen shell can paint.
  "/hidden-sessions",
]);

// Compute filtered command list (excluding hidden commands), sorted by order
const _allCommands: CommandMatch[] = Object.entries(commands)
  .filter(([, { hidden }]) => !hidden)
  .map(([cmd, { desc, order }]) => ({
    cmd,
    desc,
    order: order ?? 100, // Default order for commands without explicit order
  }))
  .sort((a, b) => a.order - b.order);

interface CommandListSources {
  /** Registry commands, already pin-filtered for the current agent. */
  builtin: readonly CommandMatch[];
  /** User-level command files (`.commands/` + `<harness>/commands/`). */
  custom: readonly CommandMatch[];
  /** User-invocable skills. */
  skill: readonly CommandMatch[];
  /** Commands contributed by trusted local mods. */
  mod: readonly CommandMatch[];
}

/**
 * Merge the four command sources into the single level-1 list the resolver
 * filters, with the precedence the popup has always had: a custom command hides
 * the builtin of the same name, a mod command hides it too, and a skill yields
 * to both. Sorting is by `order`, stably, so a source cannot reorder another's
 * rows.
 *
 * Pulled out of the component so the precedence is testable without mounting:
 * the custom and skill sources come from files on disk and from the checkout's
 * own skill set, which a frame test cannot own.
 */
export function mergeCommandList(
  sources: CommandListSources,
  options: { fullScreen: boolean },
): CommandMatch[] {
  const customCommandNames = new Set(sources.custom.map((cmd) => cmd.cmd));
  const modCommandNames = new Set(sources.mod.map((cmd) => cmd.cmd));

  const visibleBuiltins = sources.builtin.filter(
    (cmd) =>
      !customCommandNames.has(cmd.cmd) &&
      !modCommandNames.has(cmd.cmd) &&
      (options.fullScreen || !FULL_SCREEN_ONLY_COMMANDS.has(cmd.cmd)),
  );
  const visibleModCommands = sources.mod.filter(
    (cmd) => !customCommandNames.has(cmd.cmd),
  );

  const reservedCommands = new Set([
    ...visibleBuiltins.map((cmd) => cmd.cmd),
    ...visibleModCommands.map((cmd) => cmd.cmd),
    ...sources.custom.map((cmd) => cmd.cmd),
  ]);
  const visibleSkillCommands = sources.skill.filter(
    (cmd) => !reservedCommands.has(cmd.cmd),
  );

  return [
    ...visibleBuiltins,
    ...visibleModCommands,
    ...sources.custom,
    ...visibleSkillCommands,
  ].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * The description a level-3 enumerated value is shown with (R-02.5).
 *
 * An `options` row is a bare string in the spec table, so the resolver gives it
 * no description of its own. The row borrows its parent's one-line description
 * instead of inventing a second glossary: `on/off/status` under `/schedule
 * autostart` read as the values of *that* subcommand, and the words stay in the
 * one table completion and dispatch share.
 */
function optionParentDescription(state: CompletionState): string | undefined {
  if (!state.candidates.some((candidate) => candidate.kind === "option")) {
    return undefined;
  }
  if (state.command === null) return undefined;

  let rows: readonly SubcommandSpec[] | undefined = getSubcommandSpecs(
    state.command,
  );
  let last: SubcommandSpec | undefined;
  for (const word of state.path) {
    if (rows === undefined) return undefined;
    const match = findSubcommandSpec(rows, word);
    if (!match) return undefined;
    last = match;
    rows = match.children;
  }
  return last?.desc;
}

export function SlashCommandAutocomplete({
  currentInput,
  cursorPosition = currentInput.length,
  onSelect,
  onAutocomplete,
  onActiveChange,
  agentId,
  workingDirectory: _workingDirectory = process.cwd(),
  modCommands = {},
}: AutocompleteProps) {
  const columns = useTerminalWidth();
  const terminalRows = useTerminalRows();
  const [customCommands, setCustomCommands] = useState<CommandMatch[]>([]);
  const [skillCommands, setSkillCommands] = useState<CommandMatch[]>([]);

  // Load custom commands once on mount
  useEffect(() => {
    import("@/cli/commands/custom.js").then(({ getCustomCommands }) => {
      getCustomCommands().then((customs) => {
        const matches: CommandMatch[] = customs.map((cmd) => ({
          cmd: `/${cmd.id}`,
          // Include source/namespace in description for disambiguation
          desc: `${cmd.description} (${cmd.source}${cmd.namespace ? `:${cmd.namespace}` : ""})`,
          order: 200 + (cmd.source === "project" ? 0 : 100),
        }));
        setCustomCommands(matches);
      });
    });
  }, []);

  // Load user-invocable skills for slash-command autocomplete.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { discoverClientSideSkills } = await import(
          "@/agent/client-skills"
        );
        const { getSkillSources } = await import("@/agent/context");
        const { isUserInvocableSkill } = await import("@/agent/skills");
        const discovery = await discoverClientSideSkills({
          agentId,
          skillSources: getSkillSources(),
        });
        if (cancelled) return;
        const matches: CommandMatch[] = discovery.skills
          .filter(
            (skill) =>
              isUserInvocableSkill(skill) &&
              !(
                skill.source === "bundled" &&
                BUILTIN_SKILL_ALIASES.has(skill.id)
              ),
          )
          .map((skill) => ({
            cmd: `/${skill.id}`,
            desc: `${skill.description}${skill.argumentHint ? ` ${skill.argumentHint}` : ""} (${skill.source} skill)`,
            order: 300,
          }));
        setSkillCommands(matches);
      } catch {
        if (!cancelled) {
          setSkillCommands([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Check pin status to conditionally show/hide pin/unpin commands
  const builtinCommands = useMemo(() => {
    if (!agentId) return _allCommands;
    try {
      const isPinned = settingsManager.isAgentPinned(agentId);
      return _allCommands.filter((cmd) => {
        // Hide /pin if agent is already pinned, /unpin when it is not
        if (cmd.cmd === "/pin" && isPinned) return false;
        if (cmd.cmd === "/unpin" && !isPinned) return false;
        return true;
      });
    } catch (_error) {
      // If settings aren't loaded, just use all builtins
      return _allCommands;
    }
  }, [agentId]);

  const modCommandMatches = useMemo<CommandMatch[]>(
    () =>
      Object.values(modCommands).map((command) => ({
        cmd: `/${command.id}`,
        desc: `${command.description}${command.args ? ` ${command.args}` : ""} (mod)`,
        order: command.order,
      })),
    [modCommands],
  );

  const allCommands = useMemo(
    () =>
      mergeCommandList(
        {
          builtin: builtinCommands,
          custom: customCommands,
          skill: skillCommands,
          mod: modCommandMatches,
        },
        { fullScreen: resolveUiV2Once() },
      ),
    [builtinCommands, customCommands, skillCommands, modCommandMatches],
  );

  // The typed level, its next words and the candidates after the filter rule
  // (level 1 `includes`, levels 2+ prefix) — the whole of R-02.3's data half.
  const completion = useMemo(
    () => resolveCommandCompletion(currentInput, allCommands, cursorPosition),
    [allCommands, currentInput, cursorPosition],
  );

  // Esc closes the popup (R-02.3). Dismissal is stored as "the text it was
  // dismissed for", so it expires on its own the moment the draft changes and
  // the popup reopens on the next keystroke — no reset effect needed.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const dismissed = dismissedAt === currentInput;
  const active = completion.active && !dismissed;
  const matches = active ? completion.candidates : NO_CANDIDATES;
  const optionDescription = useMemo(
    () => optionParentDescription(completion),
    [completion],
  );

  /**
   * Tab (and a row click): fill the highlighted word **and the separating
   * space**, which is what opens the next level, and keep the popup. At the last
   * level the next resolve has no candidates, so the popup closes by itself.
   */
  const fillCandidate = (candidate: CompletionCandidate): void => {
    const filled = fillCompletion(currentInput, completion, candidate);
    if (onAutocomplete) {
      onAutocomplete(filled);
    } else {
      onSelect?.(filled);
    }
  };

  /**
   * Enter, B case (Q-46 / R-02.4).
   *
   * The popup is visible, so Enter first fills the highlighted word — without a
   * separator, which is what keeps "half a command costs two Enters" true: the
   * second Enter sees the word already typed and executes. When the fill would
   * not change the text (`isCandidateAlreadyTyped`), there is nothing to fill and
   * Enter falls through to the ordinary execution path with the whole draft.
   *
   * Returns whether this popup acted; `false` would let the composer's own Enter
   * have the key, which only matters for a caller that cannot fill.
   */
  const handleEnter = (candidate: CompletionCandidate): boolean => {
    if (isCandidateAlreadyTyped(currentInput, completion, candidate)) {
      if (!onSelect) return false;
      onSelect(currentInput);
      return true;
    }
    if (!onAutocomplete) return false;
    onAutocomplete(applyCandidate(currentInput, completion, candidate));
    return true;
  };

  const { selectedIndex, setSelectedIndex } =
    useAutocompleteNavigation<CompletionCandidate>({
      matches,
      onEnter: handleEnter,
      onAutocomplete: fillCandidate,
      onDismiss: () => {
        setDismissedAt(currentInput);
      },
      // Disable automatic active state management - we handle it manually below
      manageActiveState: false,
    });

  // The composer reads this flag to stand its Enter submit and history handler
  // down, so it must flip with what the user can actually see: a dismissed
  // popup is not active even while its candidate list would still resolve.
  useLayoutEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Don't show if input doesn't start with "/"
  if (!currentInput.startsWith("/")) {
    return null;
  }

  // No candidates: nothing to show at all (R-02.3). The composer keeps Enter and
  // the unknown command still reaches the registry as ordinary input.
  if (!active) {
    return null;
  }

  // Calculate visible window based on selected index, bounded by viewport.
  const availablePopupRows = Math.max(1, terminalRows - 8);
  const visibleCommandCount = Math.min(MAX_POPUP_ROWS, availablePopupRows);
  const totalMatches = matches.length;
  const needsScrolling = totalMatches > visibleCommandCount;

  let startIndex = 0;
  if (needsScrolling) {
    // Keep selected item visible, preferring to show it in the middle
    const halfWindow = Math.floor(visibleCommandCount / 2);
    startIndex = Math.max(0, selectedIndex - halfWindow);
    startIndex = Math.min(startIndex, totalMatches - visibleCommandCount);
  }

  const visibleMatches = matches.slice(
    startIndex,
    startIndex + visibleCommandCount,
  );
  const showScrollDown = startIndex + visibleCommandCount < totalMatches;

  // A click is the row's *accept*, and accept is the fill half of Tab
  // (R-02.4: "鼠标点击候选行与填词同义") — never an execution. It moves the
  // cursor onto the row it landed on and fills that same candidate, so the two
  // inputs cannot disagree about what accepting means.
  const acceptCandidate = (index: number): void => {
    const item = matches[index];
    if (!item) return;
    setSelectedIndex(index);
    fillCandidate(item);
  };

  return (
    <AutocompleteBox>
      <CommandRows
        items={visibleMatches}
        startIndex={startIndex}
        selectedIndex={selectedIndex}
        columns={columns}
        optionDescription={optionDescription}
        onActivate={acceptCandidate}
      />
      {showScrollDown ? (
        <Text dimColor>
          {"  "}↓ {totalMatches - startIndex - visibleCommandCount} more below
        </Text>
      ) : needsScrolling ? (
        <Text> </Text>
      ) : null}
    </AutocompleteBox>
  );
}

/** The popup's rows area in the hover store (`use-mouse-rows.ts`). */
const AUTOCOMPLETE_AREA = "autocomplete";

/**
 * The rows the pointer can aim at, and nothing else.
 *
 * A block of its own rather than the whole `AutocompleteBox`: the "↓ N more below"
 * footer is drawn under the rows and is not a command, so a click there must not
 * accept the last row. The geometry is measured from this box at event time
 * (`use-mouse-rows.ts`), which is also why the window offset is applied here — the
 * box's row 0 is list row `startIndex`, not row 0.
 *
 * `chrome` layer: the popup is drawn in the bottom chrome, and a press here must
 * not be offered to the transcript's selection underneath it.
 */
function CommandRows({
  items,
  startIndex,
  selectedIndex,
  columns,
  optionDescription,
  onActivate,
}: {
  items: readonly CompletionCandidate[];
  startIndex: number;
  selectedIndex: number;
  columns: number;
  optionDescription: string | undefined;
  onActivate: (index: number) => void;
}) {
  const rowsRef = useRef<DOMElement | null>(null);
  useMouseRows({
    area: AUTOCOMPLETE_AREA,
    ref: rowsRef,
    rowCount: items.length,
    activate: (index) => onActivate(startIndex + index),
    layer: "chrome",
  });

  return (
    <Box ref={rowsRef} flexDirection="column">
      {items.map((item, idx) => (
        <CommandRow
          key={`${item.kind}:${item.value}`}
          item={item}
          index={idx}
          columns={columns}
          optionDescription={optionDescription}
          selected={startIndex + idx === selectedIndex}
        />
      ))}
    </Box>
  );
}

/**
 * One row, with its own hover subscription: a pointer moving across the list
 * re-renders the two rows involved, not the popup (《38》§19.3.5).
 *
 * The one-line geometry lives here because the hover background has to reach the
 * end of the row to read as a row: the description is padded to the width the row
 * has left, and only while hovered (the padding is invisible otherwise, and a
 * frame would see trailing spaces where no row used to have any).
 *
 * The row's three fields are the ones R-02.5 asks for: the name, the argument
 * placeholder (`<name>`, `[--all]`) dim and never a row of its own, and one line
 * of description. An enumerated value has no description of its own in the spec
 * table, so it borrows the subcommand's — the parent's line explains what the
 * enum controls.
 */
function CommandRow({
  item,
  index,
  columns,
  optionDescription,
  selected,
}: {
  item: CompletionCandidate;
  index: number;
  columns: number;
  optionDescription: string | undefined;
  selected: boolean;
}) {
  const hovered = useRowHovered(AUTOCOMPLETE_AREA, index);

  // Keep the footer height stable while navigating by forcing a single-line
  // representation for each row.
  const displayName = truncateText(item.label, CMD_COL_WIDTH).padEnd(
    CMD_COL_WIDTH,
  );
  // 2-char gutter comes from <AutocompleteItem />.
  const remaining = Math.max(0, columns - 2 - CMD_COL_WIDTH - 1);
  // `args` is the syntax hint the spec table carries (`<id|name>`, `[--all]`):
  // display only, never a candidate row of its own.
  const hint = item.args;
  const hintText = hint === undefined ? "" : truncateText(hint, remaining);
  const hintWidth = hintText.length === 0 ? 0 : terminalTextWidth(hintText);
  const separatorWidth = hintText.length === 0 ? 0 : 1;
  const description =
    item.desc.length > 0
      ? item.desc
      : item.kind === "option"
        ? (optionDescription ?? "")
        : "";
  const displayDesc = truncateText(
    description,
    Math.max(0, remaining - hintWidth - separatorWidth),
  );
  const suffixWidth = hintWidth + separatorWidth + displayDesc.length;
  const pad =
    hovered && !selected
      ? " ".repeat(Math.max(0, remaining - suffixWidth))
      : "";

  return (
    <AutocompleteItem selected={selected} hovered={hovered}>
      {displayName}{" "}
      {hintText.length > 0 ? <Text dimColor>{hintText}</Text> : null}
      {hintText.length > 0 && displayDesc.length > 0 ? " " : null}
      <Text dimColor={!selected}>{displayDesc}</Text>
      {pad}
    </AutocompleteItem>
  );
}
