/**
 * Slash-command completion: tokenize, resolve the typed level, filter candidates
 * (T-02, R-02.3 / R-02.4).
 *
 * This module owns *no* command list of its own. Level 1 is handed the commands
 * the popup is allowed to offer (the registry's visible set, plus custom, skill
 * and mod commands); levels 2+ come from `subcommand-specs.ts`, which is the
 * same table the command parsers validate against. That is the whole point of
 * the split: the popup cannot offer a subcommand the dispatcher refuses, and a
 * subcommand dispatch accepts cannot go unoffered.
 *
 * Matching follows the requirement exactly: level 1 keeps the historical
 * `includes` match (typing `rea` finds `/dream`), while levels 2 and 3 match by
 * **prefix** — the word being completed is a declared word, not arbitrary text.
 * A position that takes free text has no candidates and therefore no popup.
 *
 * Enter's "fill, or run when filling would change nothing" rule (Q-46) hangs on
 * this module's two insertion helpers: `applyCandidate` returns the text an
 * accept would produce, so the caller compares it with the current input; when
 * they are equal the word is already typed and Enter runs. `fillCompletion` is
 * the Tab form: the same insertion plus the separating space that opens the next
 * level.
 */

import {
  findSubcommandSpec,
  getSubcommandSpecs,
  type SubcommandSpec,
} from "@/cli/commands/subcommand-specs";

/**
 * The level-1 candidate shape. `CommandMatch` in
 * `components/types/autocomplete.ts` satisfies it structurally, so the popup can
 * pass its merged list without a copy.
 */
export interface CompletionCommand {
  /** Command token, including the slash (`/dream`). */
  cmd: string;
  /** One-line description, shown beside the name. */
  desc: string;
  /** Popup order, lower first. */
  order?: number;
}

export interface CompletionCandidate {
  /** Text inserted at the cursor when the candidate is accepted. */
  value: string;
  /** The name the popup prints. */
  label: string;
  /** One-line description. */
  desc: string;
  /** Argument hint shown dim after the name; never selectable. */
  args?: string;
  /** Which level produced the candidate (`option` is an enumerated value). */
  kind: "command" | "subcommand" | "option";
}

export interface TokenizedCommandInput {
  /** Command token including the slash; `null` when the input is not a command. */
  command: string | null;
  /** Fully typed words after the command, before the cursor. */
  words: readonly string[];
  /** The partial word the cursor sits in ("" when the input ends in whitespace). */
  query: string;
  /** Offset in the input where `query` starts. */
  queryStart: number;
  /** True while the cursor is still inside the command token (level 1). */
  inCommand: boolean;
}

export interface CompletionState {
  /** 1 = command name; 2 = first subcommand; 3+ = deeper levels and enums. */
  level: number;
  /** Command token including the slash, or `null` outside a command. */
  command: string | null;
  /** Fully typed words between the command and the cursor. */
  path: readonly string[];
  /** The partial word the accepted candidate replaces. */
  query: string;
  /** Start of the input slice the candidate replaces. */
  replaceStart: number;
  /** End of the input slice the candidate replaces (the cursor). */
  replaceEnd: number;
  /** What the popup shows, already filtered by the requirement's rule. */
  candidates: readonly CompletionCandidate[];
  /** True when there is something to show; `false` means "no popup". */
  active: boolean;
}

interface CandidateDefinition {
  name: string;
  desc: string;
  args?: string;
  kind: CompletionCandidate["kind"];
}

function specCandidate(spec: SubcommandSpec): CandidateDefinition {
  return {
    name: spec.name,
    desc: spec.desc,
    ...(spec.args === undefined ? {} : { args: spec.args }),
    kind: "subcommand",
  };
}

function toCandidate(definition: CandidateDefinition): CompletionCandidate {
  return {
    value: definition.name,
    label: definition.name,
    desc: definition.desc,
    ...(definition.args === undefined ? {} : { args: definition.args }),
    kind: definition.kind,
  };
}

/**
 * Split the input at the cursor into the command token, the settled words and
 * the partial word being typed.
 *
 * Whitespace is the only separator: quoting is a shell concern the composer's
 * own line editor owns, and a completion candidate is a single word by
 * construction. The input must start with `/`; anything else (an ordinary
 * message, an `@` path) is not a command and gets `command: null`.
 */
export function tokenizeCommandInput(
  input: string,
  cursor: number = input.length,
): TokenizedCommandInput {
  const end = Math.max(0, Math.min(cursor, input.length));
  const before = input.slice(0, end);
  if (!before.startsWith("/")) {
    return {
      command: null,
      words: [],
      query: "",
      queryStart: end,
      inCommand: false,
    };
  }

  const firstSpace = before.search(/\s/);
  if (firstSpace === -1) {
    return {
      command: before,
      words: [],
      query: before.slice(1),
      queryStart: 1,
      inCommand: true,
    };
  }

  const command = before.slice(0, firstSpace);
  const rest = before.slice(firstSpace);
  const settled = rest.trim();
  if (settled.length === 0) {
    return {
      command,
      words: [],
      query: "",
      queryStart: end,
      inCommand: false,
    };
  }

  const words = settled.split(/\s+/);
  // A trailing separator means the user has finished the last word and is
  // waiting for the next level's list.
  if (/\s$/.test(rest)) {
    return {
      command,
      words,
      query: "",
      queryStart: end,
      inCommand: false,
    };
  }
  const query = words.pop() ?? "";
  return {
    command,
    words,
    query,
    queryStart: end - query.length,
    inCommand: false,
  };
}

/**
 * Resolve the completion state for the input at `cursor`.
 *
 * `commands` is the popup's merged level-1 list (already ordered). The function
 * does no I/O and keeps no state, so a caller can call it on every keystroke.
 */
export function resolveCommandCompletion(
  input: string,
  commands: readonly CompletionCommand[],
  cursor: number = input.length,
): CompletionState {
  const tokenized = tokenizeCommandInput(input, cursor);

  if (tokenized.command === null) {
    return {
      level: 1,
      command: null,
      path: [],
      query: "",
      replaceStart: cursor,
      replaceEnd: cursor,
      candidates: [],
      active: false,
    };
  }

  if (tokenized.inCommand) {
    const needle = tokenized.query.toLowerCase();
    const candidates = commands
      .filter(
        (command) =>
          needle.length === 0 ||
          command.cmd.slice(1).toLowerCase().includes(needle),
      )
      .map(
        (command): CompletionCandidate => ({
          value: command.cmd,
          label: command.cmd,
          desc: command.desc,
          kind: "command",
        }),
      );
    return {
      level: 1,
      command: tokenized.command,
      path: [],
      query: tokenized.query,
      replaceStart: 0,
      replaceEnd: cursor,
      candidates,
      active: candidates.length > 0,
    };
  }

  const base = {
    command: tokenized.command,
    query: tokenized.query,
    replaceStart: tokenized.queryStart,
    replaceEnd: cursor,
  };
  const specs = getSubcommandSpecs(tokenized.command);
  if (!specs) {
    // A free-form command (custom, skill, mod) has no structured next level.
    return {
      ...base,
      level: 2,
      path: tokenized.words,
      candidates: [],
      active: false,
    };
  }

  let level = 2;
  let rows: readonly SubcommandSpec[] | undefined = specs;
  let last: SubcommandSpec | undefined;
  for (const word of tokenized.words) {
    const match: SubcommandSpec | undefined =
      rows === undefined ? undefined : findSubcommandSpec(rows, word);
    if (!match) {
      return {
        ...base,
        level,
        path: tokenized.words,
        candidates: [],
        active: false,
      };
    }
    last = match;
    level += 1;
    rows = match.children;
  }

  const definitions: CandidateDefinition[] = [];
  if (rows !== undefined) {
    definitions.push(...rows.map(specCandidate));
  } else if (last?.options !== undefined) {
    definitions.push(
      ...last.options.map((option) => ({
        name: option,
        desc: "",
        kind: "option" as const,
      })),
    );
  }

  const prefix = tokenized.query.toLowerCase();
  const candidates = definitions
    .filter(
      (definition) =>
        prefix.length === 0 || definition.name.toLowerCase().startsWith(prefix),
    )
    .map(toCandidate);

  return {
    ...base,
    level,
    path: tokenized.words,
    candidates,
    active: candidates.length > 0,
  };
}

/**
 * The text an accepted candidate produces, without adding a separator.
 *
 * This is the Q-46 comparison: when it returns `input` unchanged, the typed word
 * already is the candidate, and Enter falls through to execution.
 */
export function applyCandidate(
  input: string,
  state: CompletionState,
  candidate: CompletionCandidate,
): string {
  return `${input.slice(0, state.replaceStart)}${candidate.value}${input.slice(
    state.replaceEnd,
  )}`;
}

/**
 * The text a Tab (or first Enter) fill produces: the candidate word plus the
 * separating space that opens the next level, so `/dream no` becomes
 * `/dream note ` and the popup can list `remove`.
 *
 * The separator is only added when the text does not already continue with
 * whitespace (a cursor parked mid-line must not get a double space).
 */
export function fillCompletion(
  input: string,
  state: CompletionState,
  candidate: CompletionCandidate,
): string {
  const tail = input.slice(state.replaceEnd);
  const separator = /^\s/.test(tail) ? "" : " ";
  return `${input.slice(0, state.replaceStart)}${candidate.value}${separator}${tail}`;
}

/**
 * Whether accepting `candidate` would leave the input as it is. The popup's
 * Enter binding uses this to choose between "fill" and "run" (Q-46).
 */
export function isCandidateAlreadyTyped(
  input: string,
  state: CompletionState,
  candidate: CompletionCandidate,
): boolean {
  return applyCandidate(input, state, candidate) === input;
}
