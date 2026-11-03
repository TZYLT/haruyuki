/**
 * The structured subcommand vocabulary that completion and dispatch share
 * (T-02, 47-2 §2.3).
 *
 * W-01 froze the shape only; this module carries the data table (dream /
 * schedule / topic and the enumerable options the registry already prints). One
 * table, consumed by both the completion resolver and the command dispatch, is
 * what stops the two from drifting the way the hand-written switch copies did.
 *
 * A spec describes one word the user can type after its parent. `children` is
 * the next level; a leaf either ends the line or takes a free-text argument
 * (`textArg`) — never both, because a word cannot be both a fixed subcommand and
 * arbitrary text. A non-leaf may still take free text (`note <text>` after the
 * reserved `note remove` path): the reservation only consumes the *next* word.
 *
 * **The hubs are not a second table.** Their eight second-level structures are
 * derived from `HUBS` on demand (`hubSubcommandSpecs`), so a subcommand added
 * there is offered by completion the same day and a retired one disappears. The
 * three commands whose subcommands used to live in a `switch` keep their rows
 * here, because their dispatch is code (`parseDreamAction`, …) rather than a
 * rewrite target.
 *
 * `options` is the enumerated-argument slot (O-07): only values the command
 * actually accepts, transcribed from the registry's `args` hint or the help
 * text. They are candidates at the next level, not subcommands.
 */

import { HUBS, type HubSubcommand } from "./hubs";

export interface SubcommandSpec {
  /** The literal word the user types (`list`, `remove`, …). */
  name: string;
  /** One-line description, shown beside the completion candidate. */
  desc: string;
  /**
   * Syntax hint for the argument that follows this word, without the leading
   * subcommand (`[name]`, `<provider>`). Purely display: the resolver does not
   * parse it.
   */
  args?: string;
  /** Enumerable values accepted at this position (rendered as dim candidates). */
  options?: readonly string[];
  /**
   * This subcommand takes free text as its last argument. Text is not completed;
   * the popup closes once the subcommand word is settled.
   */
  textArg?: boolean;
  /** Next level of fixed subcommands (three-level commands such as `note remove`). */
  children?: readonly SubcommandSpec[];
}

// ── /dream ──────────────────────────────────────────────────────────

/**
 * `/dream`'s seven entrances (R-5.9.2). `note` is the one row that is both a
 * reserved path (`note remove <id>`) and free text (everything else is the
 * note), which is why it carries a child and still accepts a line.
 */
export const DREAM_COMMAND_SPECS = [
  {
    name: "status",
    desc: "Show dream settings, recent runs and ledger spend",
  },
  {
    name: "run",
    args: "[--budget <tokens>]",
    desc: "Start one dream run now (respects the configured budget)",
  },
  { name: "config", desc: "Open the Dream section of the Settings page" },
  { name: "on", desc: "Enable dream and finish first-run setup" },
  { name: "off", desc: "Disable dream" },
  {
    name: "note",
    args: "<text>",
    desc: "Queue a note the next dream run reads first",
    // `remove` is reserved only as the next word; every other line is the note
    // itself, so the row takes free text as well as owning a child.
    textArg: true,
    children: [
      {
        name: "remove",
        args: "<id>",
        desc: "Remove a queued dream note",
        textArg: true,
      },
    ],
  },
  {
    name: "notes",
    args: "[clear]",
    desc: "List the queued dream notes",
    options: ["clear"],
  },
] as const satisfies readonly SubcommandSpec[];

// ── /schedule ───────────────────────────────────────────────────────

/** `/schedule`'s nine subcommands (R-5.12.1); `autostart` takes an enum. */
export const SCHEDULE_COMMAND_SPECS = [
  {
    name: "list",
    args: "[--all]",
    desc: "List tasks (current agent only by default)",
  },
  {
    name: "show",
    args: "<id|name>",
    desc: "Show one task",
    textArg: true,
  },
  {
    name: "add",
    args: "[options]",
    desc: "Create; complete flags create in one step, otherwise the wizard asks",
    textArg: true,
  },
  {
    name: "run",
    args: "<id|name>",
    desc: "Run once now (does not consume the next scheduled trigger)",
    textArg: true,
  },
  { name: "pause", args: "<id|name>", desc: "Pause", textArg: true },
  {
    name: "resume",
    args: "<id|name>",
    desc: "Resume (resets the failure streak)",
    textArg: true,
  },
  { name: "delete", args: "<id|name>", desc: "Delete", textArg: true },
  {
    name: "logs",
    args: "<id|name>",
    desc: "Run history (grouped by runId)",
    textArg: true,
  },
  {
    name: "autostart",
    args: "on|off|status",
    desc: "OS autostart (wakes a short-lived host every minute)",
    options: ["on", "off", "status"],
  },
] as const satisfies readonly SubcommandSpec[];

// ── /topic ──────────────────────────────────────────────────────────

/**
 * `/topic`'s three fixed words. A bare first word is a title, not a
 * subcommand (the fall-through that records the marker), so it has no row.
 * `list` and `search` are dispatched a layer up, in the registry, because they
 * open faces; `show` is the word `topic.ts` must intercept.
 */
export const TOPIC_COMMAND_SPECS = [
  {
    name: "list",
    args: "[--all|--context]",
    desc: "Open the topic blocks this conversation defines",
  },
  {
    name: "search",
    args: "<kw>",
    desc: "Search every topic this agent has recorded",
    textArg: true,
  },
  {
    name: "show",
    args: "<#n|title> [--full] [--out <path>]",
    desc: "Read one topic back, complete text on request",
    textArg: true,
  },
] as const satisfies readonly SubcommandSpec[];

// ── /recall ─────────────────────────────────────────────────────────

/**
 * `/recall embedding`'s words (48-1 §7.1, 48-2 §4.9 D4).
 *
 * The seven entrances are the requirement's command face; the ten tuning rows
 * are the setters D3's settings deep links fall back to
 * (`/recall embedding <knob> <value>`), so a fallback command printed by the
 * settings page is offered by completion too.
 */
export const EMBEDDING_COMMAND_SPECS = [
  { name: "on", desc: "Enable vector recall; first run opens setup" },
  { name: "off", desc: "Disable vector recall; stored vectors stay on disk" },
  {
    name: "status",
    desc: "Backend, space, coverage, calibration and build state",
  },
  {
    name: "build",
    args: "[--full]",
    desc: "Build or refresh the vector index",
    textArg: true,
  },
  {
    name: "cancel",
    desc: "Stop a running build; finished chunks stay",
  },
  {
    name: "reset",
    args: "[--all|--model <id>] [--confirm]",
    desc: "Delete stored vector spaces (previews, then --confirm)",
    textArg: true,
  },
  { name: "setup", desc: "Re-run first-run setup with the current values" },
  {
    name: "weight",
    args: "<0..1>",
    desc: "Vector-arm weight (0 = lexical only)",
    textArg: true,
  },
  {
    name: "depth",
    args: "<n>",
    desc: "Candidates per arm",
    textArg: true,
  },
  {
    name: "chunk",
    args: "<tokens>",
    desc: "Target chunk window",
    textArg: true,
  },
  {
    name: "chunk-max",
    args: "<tokens>",
    desc: "Hard chunk ceiling",
    textArg: true,
  },
  {
    name: "chunk-overlap",
    args: "<tokens>",
    desc: "Chunk overlap",
    textArg: true,
  },
  {
    name: "max-chunks",
    args: "<n>",
    desc: "Chunks embedded per message cap",
    textArg: true,
  },
  {
    name: "threads",
    args: "<n>",
    desc: "Encode/build threads (0 = automatic)",
    textArg: true,
  },
  {
    name: "gpu",
    args: "auto|off|index-only",
    desc: "GPU role",
    options: ["auto", "off", "index-only"],
  },
  {
    name: "quant",
    args: "float32|int8",
    desc: "Vector precision",
    options: ["float32", "int8"],
  },
  {
    name: "spaces",
    args: "<n>",
    desc: "Model spaces kept on disk",
    textArg: true,
  },
] as const satisfies readonly SubcommandSpec[];

/**
 * `/recall`'s full table (O-04: complete the whole command, not just the new
 * part). The thirteen feature-② words come from `parseRecallCommand`; the
 * embedding branch owns everything below its row.
 */
export const RECALL_COMMAND_SPECS = [
  { name: "status", desc: "What passive recall is doing right now" },
  { name: "on", desc: "Switch passive recall on (also clears the breaker)" },
  { name: "off", desc: "Switch passive recall off" },
  { name: "build", desc: "Build the transcript index" },
  {
    name: "now",
    args: "<query>",
    desc: "Run a search and show the passages",
    textArg: true,
  },
  {
    name: "timeout",
    args: "<ms>",
    desc: "Wall-clock budget (0 = no limit)",
    textArg: true,
  },
  {
    name: "dedup",
    args: "<turns>",
    desc: "How long a passage stays suppressed",
    textArg: true,
  },
  {
    name: "limit",
    args: "<n>",
    desc: "Passages injected per turn",
    textArg: true,
  },
  {
    name: "excerpt",
    args: "<lines>",
    desc: "Memory context around a hit",
    textArg: true,
  },
  {
    name: "chars",
    args: "<per> [total]",
    desc: "Per-passage and total character budget",
    textArg: true,
  },
  {
    name: "ratio",
    args: "<0..1>",
    desc: "Relative score floor",
    textArg: true,
  },
  {
    name: "diversity",
    args: "none|file|split",
    desc: "How the slots are shared out",
    options: ["none", "file", "split"],
  },
  {
    name: "display",
    args: "silent|summary|full",
    desc: "How much of an injected block the transcript shows",
    options: ["silent", "summary", "full"],
  },
  {
    name: "embedding",
    args: "[command]",
    desc: "Vector recall: on, off, status, build, cancel, reset, setup, tuning",
    children: EMBEDDING_COMMAND_SPECS,
  },
] as const satisfies readonly SubcommandSpec[];

// ── Lookup ──────────────────────────────────────────────────────────

/** The hand-written tables, keyed by the command token (including the slash). */
export const COMMAND_SPECS: Readonly<
  Record<string, readonly SubcommandSpec[]>
> = {
  "/dream": DREAM_COMMAND_SPECS,
  "/schedule": SCHEDULE_COMMAND_SPECS,
  "/topic": TOPIC_COMMAND_SPECS,
  "/recall": RECALL_COMMAND_SPECS,
};

function toSubcommandSpec(sub: HubSubcommand): SubcommandSpec {
  return {
    name: sub.name,
    desc: sub.desc,
    ...(sub.args === undefined ? {} : { args: sub.args }),
    ...(sub.options === undefined ? {} : { options: sub.options }),
  };
}

/**
 * A hub's rows, derived from `HUBS` (R-02.6: no second hand-written table).
 * `undefined` for anything that is not a hub.
 */
export function hubSubcommandSpecs(
  hubName: string,
): readonly SubcommandSpec[] | undefined {
  const hub = HUBS[hubName];
  return hub?.subcommands.map(toSubcommandSpec);
}

/**
 * The next level below `command` (`"/dream"`), or `undefined` when the command
 * has no structured subcommands (a free-form command, a custom command, a mod).
 * Hubs resolve through `HUBS`; the three command groups resolve through
 * `COMMAND_SPECS`.
 */
export function getSubcommandSpecs(
  command: string,
): readonly SubcommandSpec[] | undefined {
  return COMMAND_SPECS[command] ?? hubSubcommandSpecs(command);
}

/** The row named exactly `word`, or `undefined`. Case is the command's own rule. */
export function findSubcommandSpec(
  specs: readonly SubcommandSpec[],
  word: string,
): SubcommandSpec | undefined {
  return specs.find((spec) => spec.name === word);
}

/** True when `word` names a row of `specs` — the dispatch membership gate. */
export function hasSubcommand(
  specs: readonly SubcommandSpec[],
  word: string,
): boolean {
  return findSubcommandSpec(specs, word) !== undefined;
}

/** One row plus the words that reach it, for drift tests and usage rendering. */
export interface SubcommandSpecRow {
  /** Words from the top level down to and including this row's name. */
  path: readonly string[];
  spec: SubcommandSpec;
}

/** Every row of a spec tree, parents before children. */
export function walkSubcommandSpecs(
  specs: readonly SubcommandSpec[],
): SubcommandSpecRow[] {
  const rows: SubcommandSpecRow[] = [];
  const visit = (
    list: readonly SubcommandSpec[],
    prefix: readonly string[],
  ): void => {
    for (const spec of list) {
      const path = [...prefix, spec.name];
      rows.push({ path, spec });
      if (spec.children) visit(spec.children, path);
    }
  };
  visit(specs, []);
  return rows;
}

/**
 * `Usage: /dream status | /dream run [--budget <tokens>] | …`, rendered from the
 * rows so the usage line cannot list a spelling the parser refuses (or omit one
 * it accepts). Children are listed after their parent, which is the order a
 * reader builds the line in.
 */
export function formatSubcommandUsage(
  command: string,
  specs: readonly SubcommandSpec[],
): string {
  const forms: string[] = [];
  const visit = (
    list: readonly SubcommandSpec[],
    prefix: readonly string[],
  ): void => {
    for (const spec of list) {
      const words = [command, ...prefix, spec.name];
      const form = spec.args === undefined ? words : [...words, spec.args];
      forms.push(form.join(" "));
      if (spec.children) visit(spec.children, [...prefix, spec.name]);
    }
  };
  visit(specs, []);
  return `Usage: ${forms.join(" | ")}`;
}
