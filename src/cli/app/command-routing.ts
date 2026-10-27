// Interactive slash commands that open overlays immediately (bypass queueing)
// These commands let users browse/view while the agent is working
// Any changes made in the overlay will be queued until end_turn

import { isHubCommand, resolveHubInput } from "@/cli/commands/hubs";

const INTERACTIVE_SLASH_COMMANDS = new Set([
  "/model",
  "/experiments",
  "/toolset",
  "/system",
  "/personality",
  "/subagents",
  "/memory",
  "/sleeptime",
  "/mcp",
  "/help",
  "/agents",
  "/resume",
  "/pinned",
  "/search",
  "/feedback",
  "/pin",
]);

// Non-state commands that should run immediately while the agent is busy
// These don't modify agent state, so they should bypass queueing
const NON_STATE_COMMANDS = new Set([
  "/ade",
  "/bg",
  "/workflows", // read-only view of background workflow runs
  "/hidden-sessions", // read-only browse of hidden conversations (`docs/44-1` §5.1.5)
  "/btw",
  "/usage",
  "/tabs", // list open tabs: a view, not a state change
  "/settings", // focus the Settings page: a view
  "/close", // closes a *view*; the runtime refuses on its own while a turn runs
  "/help",
  "/hooks",
  "/search",
  "/memory",
  "/feedback",
  "/mods", // starts background local mod-learning runs; does not need the foreground lock
  "/reasoning-tab",
  "/secret",
  "/palace", // read-only memory viewer
  "/exit", // session exit
  "/rename", // agent/convo rename
  "/btw",
  "/reload", // runtime surface reload (has its own busy guard)
  "/dream", // Cloud admission or Code-managed background reflection
  "/reflect",
]);

export function aliasBareExitCommand(input: string): string {
  if (input === "exit" || input === "quit") return "/exit";
  return input;
}

export type RoutedSlashInput =
  | { kind: "text"; text: string }
  | { kind: "error"; message: string };

/**
 * The input boundary, in one place: the bare `exit`/`quit` alias, the hub
 * rewrite, and the answer a retired name gets.
 *
 * The submit handler calls this before it looks at the command for anything
 * else, so the queue-bypass rules, the custom/model lookup and the dispatch
 * chain all see one spelling per command.
 */
export function routeSlashCommandInput(input: string): RoutedSlashInput {
  const aliased = aliasBareExitCommand(input);
  const resolution = resolveHubInput(aliased);
  if (resolution.kind === "error") {
    return { kind: "error", message: resolution.message };
  }
  if (resolution.kind === "command") {
    return { kind: "text", text: resolution.text };
  }
  return { kind: "text", text: aliased };
}

/**
 * Report a refused input the way every other command failure is reported, and
 * tell the submit handler to clear the input box.
 */
export function reportRoutedInputError(
  commandRunner: {
    start(input: string, output: string): { fail(message: string): void };
  },
  input: string,
  message: string,
): { submitted: true } {
  const cmd = commandRunner.start(input, message);
  cmd.fail(message);
  return { submitted: true };
}

// Check if a command is interactive (opens overlay, should not be queued)
export function isInteractiveCommand(msg: string): boolean {
  const trimmed = msg.trim().toLowerCase();
  // Check exact matches first
  if (INTERACTIVE_SLASH_COMMANDS.has(trimmed)) return true;
  // Check prefix matches for commands with arguments
  for (const cmd of INTERACTIVE_SLASH_COMMANDS) {
    if (trimmed.startsWith(`${cmd} `)) return true;
  }
  // A hub is a menu: it either opens an overlay or prints its own subcommand
  // list, so it must never wait in the queue behind a turn. Normally the input
  // boundary has already rewritten it to an internal target (whose own flags
  // decide), so this covers the call that still carries the hub name.
  return isHubCommand(trimmed);
}

/**
 * `/topic` is a mixed bag, and it is the one command whose *subcommand* decides
 * whether it is a view: `list`, `search` and `show` only read (and the first two
 * open a face over the transcript), while `/topic <title>` writes a marker. A busy
 * agent must not make a read-only browse wait behind a turn, and must not let a
 * marker write jump the queue — so the bypass is decided by the prefix, not by the
 * command.
 */
function isReadOnlyTopicForm(trimmed: string): boolean {
  if (!trimmed.startsWith("/topic ")) return false;
  const [subcommand] = trimmed.slice("/topic ".length).trim().split(/\s+/);
  return (
    subcommand === "list" || subcommand === "search" || subcommand === "show"
  );
}

export function isNonStateCommand(msg: string): boolean {
  const trimmed = msg.trim().toLowerCase();
  if (NON_STATE_COMMANDS.has(trimmed)) return true;
  if (isReadOnlyTopicForm(trimmed)) return true;
  for (const cmd of NON_STATE_COMMANDS) {
    if (trimmed.startsWith(`${cmd} `)) return true;
  }
  return false;
}

export function shouldSlashCommandBypassQueue(
  msg: string,
  options: {
    hasCustomCommand?: boolean;
    modCommand?: { runWhenBusy: boolean };
  } = {},
): boolean {
  if (options.hasCustomCommand) return false;
  if (options.modCommand) return options.modCommand.runWhenBusy;
  return isInteractiveCommand(msg) || isNonStateCommand(msg);
}
