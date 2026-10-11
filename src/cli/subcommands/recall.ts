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
  handleRecallCommand,
  parseRecallCommand,
  RECALL_COMMAND_USAGE,
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

function parseRecallArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: RECALL_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

export async function runRecallSubcommand(
  argv: string[],
  deps: RecallSubcommandDeps = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseRecallArgs>;
  try {
    parsed = parseRecallArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
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

  try {
    await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
  } catch (error) {
    console.error(
      `Error: settings could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const backend = deps.backend ?? getBackend();
  if (!(backend instanceof LocalBackend)) {
    console.error(
      "Passive recall is local-backend only: it searches this machine's transcripts and memory files.",
    );
    return 1;
  }

  const agentId =
    parsed.values.agent ??
    process.env.HARUYUKI_AGENT_ID ??
    process.env.AGENT_ID ??
    settingsManager.getSettings().lastAgent ??
    undefined;
  const conversationId =
    parsed.values.conversation ?? process.env.CONVERSATION_ID ?? undefined;

  const output = await handleRecallCommand(
    positionals,
    {
      agentId: agentId ?? "",
      conversationId: conversationId ?? null,
    },
    { backend },
  );
  console.log(output);
  return 0;
}
