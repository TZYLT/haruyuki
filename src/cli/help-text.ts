import { renderCliOptionsHelp } from "./args";

/**
 * The `--help` text.
 *
 * Kept out of `src/index.ts` (which sits at its source-size ratchet) so the help
 * copy can grow again. Plaintext by design — no colors — so the output pipes
 * cleanly into files and other commands.
 *
 * Every example keeps the long name `haruyuki`: `hryk` is an equivalent short
 * name for the same program, and the short name only appears in the note below.
 */
export function renderHelpText(): string {
  return `
Haruyuki is a general purpose CLI for interacting with Letta agents

USAGE
  # interactive TUI
  haruyuki                 Resume last conversation for this project
  haruyuki --new           Create a new conversation (for concurrent sessions)
  haruyuki --resume        Open agent selector UI to pick agent/conversation
  haruyuki --new-agent     Create a new agent directly (skip profile selector)
  haruyuki --agent <id>    Open a specific agent by ID

  # headless
  haruyuki -p "..."        One-off prompt in headless mode (no TTY UI)

  # maintenance
  haruyuki memory ...      Memory filesystem subcommands
  haruyuki agents ...      Agents subcommands (JSON-only)
  haruyuki model ...       Get, list, or set models and reasoning (JSON-only)
  haruyuki messages ...    Messages subcommands (JSON-only)
  haruyuki mcp ...         List, search, and call MCP servers available to an agent
  haruyuki mods ...        List and manage local mods
  haruyuki server ...      Run the local agent server (App Server + channels)
  haruyuki connect ...     Connect providers from terminal
  haruyuki install ...     Install a skill or mod package
  haruyuki skills ...      List or delete installed agent skills

  hryk is an equivalent short name for haruyuki: every command above also works as
  "hryk <args>". It is available from a source checkout or the packaged tarball; npm
  registry installs provide the haruyuki command only. Examples use the long name.

OPTIONS
${renderCliOptionsHelp()}
SUBCOMMANDS
  haruyuki memory status --agent <id>
  haruyuki memory diff --agent <id>
  haruyuki memory resolve --agent <id> --resolutions '<JSON>'
  haruyuki memory backup --agent <id>
  haruyuki memory backups --agent <id>
  haruyuki memory restore --agent <id> --from <backup> --force
  haruyuki memory export --agent <id> --out <dir>
  haruyuki memory pull --agent <id>
  haruyuki memory tokens [--memory-dir <path>] [--agent <id>] [--format text|json]
  haruyuki agents list [--query <text> | --name <name> | --tags <tags>]
  haruyuki messages search --query <text> [--all-agents]
  haruyuki messages list [--agent <id>]
  haruyuki messages transcript --conversation <id> [--out <path>]
  haruyuki steps trace --agent <id> --step <id>
  haruyuki mods list [--agent <id>]
  haruyuki mods package <mod-file> --name <package-name> [--out <dir>]
  haruyuki mods enable <package-spec>
  haruyuki mods disable <package-spec>
  haruyuki mods remove <package-spec>
  haruyuki mcp list|get|tools|search|call ... [--agent <id>]
  haruyuki server [--listen [url]] [options]
  haruyuki connect <provider> [options]
  haruyuki install <thing> [--agent <id> | -n <name>]
  haruyuki skills list [--agent <id> | -n <name>]
  haruyuki skills delete <skill_name> --agent <id>
  haruyuki local-backend migrate-transcripts [--storage-dir <path>] [--dry-run]

BEHAVIOR
  On startup, Haruyuki checks for saved profiles:
  - If profiles exist, you'll be prompted to select one or create a new agent
  - Agents can be pinned for quick access with /pin
  - Use /profile save <name> to bookmark your current agent

  Agent pins are stored in ~/.haruyuki/settings.json.

  Providers are connected from the terminal: haruyuki connect <provider>.

EXAMPLES
  # when installed as an executable
  haruyuki                    # Show profile selector or create new
  haruyuki --new              # Create new conversation
  haruyuki --agent agent_123  # Open specific agent
  haruyuki install official/finance/stocks --agent agent-123
  haruyuki install npm:@letta-ai/mod-plan-mode

  # inside the interactive session
  /profile save MyAgent    # Save current agent as profile
  /profiles                # Open profile selector
  /pin                     # Pin current agent
  /unpin                   # Unpin current agent
  /logout                  # Clear saved credentials and exit

  # headless with JSON output (includes stats)
  haruyuki -p "hello" --output-format json

`.trim();
}
