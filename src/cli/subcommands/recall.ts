/**
 * `haruyuki recall <build|status|now>` — feature ② without a TUI.
 *
 * Three of the `/recall` subcommands only make sense outside a session: building
 * the index is a one-off maintenance task (《26》§6.10), and both `status` and `now`
 * are things a person asks before starting a session or while debugging one. They
 * are the same implementations the slash command uses, so the two surfaces cannot
 * disagree about what a knob means or what a receipt says.
 *
 * Every other `/recall` spelling is accepted too — the settings are global, and a
 * script that wants to flip `display` should not have to launch the TUI.
 */
import { parseArgs } from "node:util";
import { getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  EMBEDDING_COMMAND_USAGE,
  parseEmbeddingCommand,
} from "@/cli/commands/embedding";
import {
  handleRecallCommand,
  parseRecallCommand,
  RECALL_COMMAND_USAGE,
  RECALL_LOCAL_ONLY,
  RECALL_PROBE_NEEDS_AGENT,
  type RecallCommandDeps,
} from "@/cli/commands/recall";
import { settingsManager } from "@/settings-manager";

export interface RecallSubcommandDeps extends RecallCommandDeps {
  initializeSettings?: () => Promise<void>;
}

const RECALL_OPTIONS = {
  agent: { type: "string" },
  conversation: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  haruyuki recall build [--help]              Build the transcript index",
      "  haruyuki recall status [--agent <id>]       Show what recall is doing",
      "  haruyuki recall now <query> [--agent <id>] [--conversation <id>]",
      "                                              Search and print the passages",
      "",
      "  Any other /recall subcommand works here too, so a script can set a knob:",
      ...RECALL_COMMAND_USAGE.split("\n")
        .filter((line) => line.trimStart().startsWith("/recall "))
        .map((line) => `  haruyuki ${line.trimStart().slice(1)}`),
      "",
      "Options:",
      "  --agent <id>         Agent to scope the search to",
      "                       (defaults to HARUYUKI_AGENT_ID / AGENT_ID / the last agent)",
      "  --conversation <id>  Conversation the probe runs in (defaults to `default`)",
      "  -h, --help           Show this help",
      "",
      "Notes:",
      "  - Recall is local-backend only: it searches this machine's transcripts.",
      "  - `now` is a probe. It neither consumes nor extends the dedup window, so",
      "    running it cannot change what the next turn injects.",
    ].join("\n"),
  );
}

/** The first value that is not blank: `""` is a mistyped flag, not a scope. */
function firstNonBlank(
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseRecallArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: RECALL_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

/**
 * One of the three shared options' values.
 *
 * A missing value (or the next token being another flag) is an error rather
 * than a silent fallback: `--agent --full` used to swallow `--full` as the
 * agent id and drop the flag the user actually asked for.
 */
function optionValue(
  argv: string[],
  index: number,
  name: string,
): { value: string } | { error: string } {
  const value = argv[index + 1];
  if (
    value === undefined ||
    value.trim().length === 0 ||
    value.startsWith("-")
  ) {
    return { error: `${name} needs a value.` };
  }
  return { value: value.trim() };
}

/**
 * The embedding family's own flags (`--full`, `--confirm`, `--keep-after-exit`)
 * are not `haruyuki recall` options, and `parseArgs(..., strict: true)` would
 * reject them before the command ever sees them. Split them out first: pull the
 * three shared options off the front when they appear, and hand every remaining
 * token to the embedding parser unchanged. Returns `null` when the invocation
 * is not the embedding family, so the ordinary strict parse still runs for
 * every other subcommand.
 */
function splitEmbeddingArgv(argv: string[]): {
  positionals: string[];
  agent?: string;
  conversation?: string;
  help: boolean;
  error?: string;
} | null {
  const positionals: string[] = [];
  let agent: string | undefined;
  let conversation: string | undefined;
  let help = false;
  let error: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--agent" || token === "--conversation") {
      const name = token === "--agent" ? "--agent" : "--conversation";
      const read = optionValue(argv, index, name);
      index += 1;
      if ("error" in read) {
        error = error ?? read.error;
        continue;
      }
      if (name === "--agent") agent = read.value;
      else conversation = read.value;
      continue;
    }
    if (token.startsWith("--agent=") || token.startsWith("--conversation=")) {
      const name = token.slice(0, token.indexOf("="));
      const value = token.slice(token.indexOf("=") + 1).trim();
      if (value.length === 0) {
        error = error ?? `${name} needs a value.`;
        continue;
      }
      if (name === "--agent") agent = value;
      else conversation = value;
      continue;
    }
    if (token === "-h" || token === "--help") {
      help = true;
      continue;
    }
    positionals.push(token);
  }
  if (positionals[0] !== "embedding") return null;
  return {
    positionals,
    agent,
    conversation,
    help,
    ...(error === undefined ? {} : { error }),
  };
}

export async function runRecallSubcommand(
  argv: string[],
  deps: RecallSubcommandDeps = {},
): Promise<number> {
  let parsed: {
    values: { agent?: string; conversation?: string; help?: boolean };
    positionals: string[];
  };
  const embeddingSplit = splitEmbeddingArgv(argv);
  if (embeddingSplit !== null && embeddingSplit.error !== undefined) {
    // A flag with no value is a script error, like any other bad argument.
    console.error(`Error: ${embeddingSplit.error}`);
    printUsage();
    return 1;
  }
  if (embeddingSplit !== null) {
    parsed = {
      values: {
        ...(embeddingSplit.agent === undefined
          ? {}
          : { agent: embeddingSplit.agent }),
        ...(embeddingSplit.conversation === undefined
          ? {}
          : { conversation: embeddingSplit.conversation }),
        help: embeddingSplit.help,
      },
      positionals: embeddingSplit.positionals,
    };
  } else {
    try {
      parsed = parseRecallArgs(argv);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      printUsage();
      return 1;
    }
  }

  const positionals = parsed.positionals;
  if (parsed.values.help || positionals.length === 0) {
    printUsage();
    return 0;
  }

  // Refuse before touching anything: a script that mistypes a knob must see a
  // failure exit, and the slash command's refusal text is the same copy.
  const command = parseRecallCommand(positionals);
  if (command.kind === "error") {
    console.error(`${command.message}\n\n${RECALL_COMMAND_USAGE}`);
    return 1;
  }

  // The embedding family has its own parser and vocabulary. Its refusals are
  // script errors like any other, so they fail the exit code here rather than
  // being printed by the handler with success.
  if (command.kind === "embedding") {
    const parsedEmbedding = parseEmbeddingCommand(command.args);
    if (parsedEmbedding.kind === "error") {
      console.error(`${parsedEmbedding.message}\n\n${EMBEDDING_COMMAND_USAGE}`);
      return 1;
    }
  }

  try {
    await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
  } catch (error) {
    console.error(
      `Error: settings could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const requestedAgent = firstNonBlank(
    parsed.values.agent,
    process.env.HARUYUKI_AGENT_ID,
    process.env.AGENT_ID,
    settingsManager.getSettings().lastAgent,
  );
  const conversationId = firstNonBlank(
    parsed.values.conversation,
    process.env.CONVERSATION_ID,
  );

  const needsStore =
    command.kind === "status" ||
    command.kind === "build" ||
    command.kind === "probe";
  const backend = deps.backend ?? getBackend();
  // Only the kinds that read the store need a local backend: every knob is a global
  // setting, and a script flipping `display` should not need a working store.
  if (needsStore && !(backend instanceof LocalBackend)) {
    console.error(RECALL_LOCAL_ONLY);
    return 1;
  }

  // No resolved agent means "no scope", which `status` reports as the whole store
  // and `now` refuses. Passing an empty id would work by accident
  // (`loadRecallCorpus` treats a falsy filter as no filter) and hide that choice.
  if (command.kind === "probe" && requestedAgent === undefined) {
    console.error(RECALL_PROBE_NEEDS_AGENT);
    return 1;
  }

  let output: string;
  try {
    output = await handleRecallCommand(
      positionals,
      requestedAgent === undefined
        ? undefined
        : { agentId: requestedAgent, conversationId: conversationId ?? null },
      { backend, embedding: { lifecycle: "headless" } },
    );
  } catch (error) {
    // `build` walks every transcript and `status` loads the whole corpus: an I/O
    // failure has to leave the process with a message and a failure exit code, not
    // an unhandled rejection.
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  console.log(output);
  return 0;
}
