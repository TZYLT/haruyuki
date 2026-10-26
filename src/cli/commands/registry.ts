// src/cli/commands/registry.ts
// Registry of available CLI commands

import {
  type DreamCommandScope,
  requestCloudReflectionRun,
} from "@/agent/reflection-runs";
import { renderWorkflowTree } from "@/cli/helpers/workflow-display";
import { resolveUiV2Once } from "@/experiments/ui-v2";
import { listWorkflowExecutions } from "@/tools/workflow/execution-registry";
import {
  handleConsoleFontCommand,
  handleFontWidthCommand,
  handleTerminalCommand,
} from "./config-commands";
import { formatHubHelpFor } from "./hubs";
import { handleMemoryRepositoryCommand } from "./memory-repository";
import { handleRecallCommand } from "./recall";
import { handleSecretCommand } from "./secret";
import { handleSystemRemindersCommand } from "./system-reminders";
import { handleTopicCommand } from "./topic";
import { handleTopicsCommand } from "./topics";

/**
 * The receipt for a page command, in the shell that has pages.
 *
 * `/usage`, `/tabs`, `/close` and `/settings` name the full-screen shell's chrome
 * (the two fixed pages and the tab strip). The append shell draws neither, so
 * typing one there can only be answered with a line: the submit handler declines
 * to act (`shell-commands.ts`), and this is what the user sees. Read at *call*
 * time — resolving the experiment at import time would freeze whatever the
 * settings cache happened to hold before it was loaded.
 */
function pageCommandAnswer(openingOutput: string): string {
  return resolveUiV2Once()
    ? openingOutput
    : // It used to name `/experiments ui_v2` as the way to switch. That form is
      // not implemented — `/experiments` takes no UI argument and only knows the
      // `diffs` sub-command — so the receipt taught a command that does nothing
      // but print this same line back. Name the surface that exists.
      "Pages need the full-screen shell (/experiments → full-screen TUI, then restart).";
}

type CommandHandlerResult =
  | string
  | {
      output: string;
      refreshSecretsInfo?: boolean;
    };

type CommandHandler = (
  args: string[],
  scope?: DreamCommandScope,
) => Promise<CommandHandlerResult> | CommandHandlerResult;

interface Command {
  desc: string;
  handler: CommandHandler;
  args?: string; // Optional argument syntax hint (e.g., "[conversation_id]", "<name>")
  hidden?: boolean; // Hidden commands don't show in autocomplete but still work
  order?: number; // Lower numbers appear first in autocomplete (default: 100)
  noArgs?: boolean; // If true, reject any arguments passed to this command
  /**
   * The command is the internal target of a hub subcommand, not something a user
   * types (`/agent pin` runs `/pin`). Kept so a missed rewrite degrades to a
   * known command instead of being sent to the model as chat text; never listed.
   * `HUB_TARGET_COMMANDS` below is the single place that sets it.
   */
  internal?: boolean;
}

async function handleReflectionCommand(
  args: string[],
  scope?: DreamCommandScope,
) {
  if (!scope) throw new Error("Reflection requires an active agent.");
  const output = await requestCloudReflectionRun(scope, args.join(" "));
  // Code-managed reflection needs the TUI/listener runtime, not this registry.
  if (output === null)
    throw new Error(
      "Run this command in the TUI or listener to launch Code-managed reflection.",
    );
  return output;
}

export const commands: Record<string, Command> = {
  // === Hubs (《42-1》 §2–§8) ===
  // A hub handler never runs the action: `resolveHubInput` (hubs.ts) rewrites the
  // invocation to its internal target before dispatch. The handler answers the
  // subcommand list, which is what a bare hub, an unknown subcommand and a
  // direct `executeCommand("/agent")` all need it for.
  "/agent": {
    desc: "Agent: browse, pin, rename, describe, system, personality, tools",
    args: "<list|pin|unpin|pinned|rename|describe|system|personality|toolset|subagents|ade|profile>",
    order: 10,
    handler: () => formatHubHelpFor("/agent"),
  },
  "/session": {
    desc: "Session: rename this conversation, log out",
    args: "<rename|logout>",
    order: 20.5,
    handler: () => formatHubHelpFor("/session"),
  },
  "/messages": {
    desc: "Messages: history, clear",
    args: "<history|clear>",
    order: 32.85,
    handler: () => formatHubHelpFor("/messages"),
  },
  "/skill": {
    desc: "Skill: list the available skills, or create a new one",
    args: "<list|skill-creator>",
    order: 28.5,
    handler: () => formatHubHelpFor("/skill"),
  },
  "/config": {
    desc: "Config: providers, MCP, hooks, secrets, terminal, appearance",
    args: "<connect|mcp|hooks|secret|experiments|mods|statusline|title|terminal|font-width|console-font|stream|reasoning-tab|system-reminders>",
    order: 32.6,
    handler: () => formatHubHelpFor("/config"),
  },
  "/maintenance": {
    desc: "Maintenance: feedback, background shells, workflows, GitHub app, hidden sessions",
    args: "<feedback|bg|workflows|install-github-app|sessions>",
    order: 36,
    handler: () => formatHubHelpFor("/maintenance"),
  },

  // === Page 1: Most commonly used (order 10-19) ===
  "/agents": {
    desc: "Browse agents (pinned, Haruyuki, all)",
    order: 10,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open agent browser
      return "Opening agent browser...";
    },
  },
  "/model": {
    desc: "Switch model",
    order: 11,
    noArgs: true,
    handler: () => {
      return "Opening model selector...";
    },
  },
  "/init": {
    desc: "Initialize (or re-init) your agent's memory",
    order: 12,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to send initialization prompt
      return "Initializing memory...";
    },
  },
  "/doctor": {
    desc: "Investigate an agent issue in this conversation",
    order: 12.1,
    args: "[symptom]",
    handler: () => {
      // Handled by the primary-agent turn in the TUI and listener.
      return "Starting doctor...";
    },
  },
  "/dream": {
    desc: "Reflect on this conversation's memory (alias for /reflect)",
    order: 49,
    args: "[--instruction TEXT]",
    handler: handleReflectionCommand,
  },
  "/reflect": {
    desc: "Launch reflection on this conversation (/reflect [--instruction TEXT])",
    args: "[--instruction TEXT]",
    order: 50,
    handler: handleReflectionCommand,
  },
  "/skills": {
    desc: "Browse available skills",
    order: 28,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open skills browser overlay
      return "Opening skills browser...";
    },
  },
  "/skill-creator": {
    desc: "Enter skill creation mode (/skill-creator [description])",
    order: 28.5,
    handler: () => {
      // Handled specially in App.tsx to trigger skill-creation workflow
      return "Starting skill creation...";
    },
  },
  "/memory": {
    desc: "Memory: view, init, filesystem backend, remote, palace, recall",
    args: "<recall|init|memfs|remote|palace|config>",
    order: 15,
    handler: () => formatHubHelpFor("/memory"),
  },
  "/palace": {
    desc: "Open the Memory Palace in your browser",
    order: 16,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx - opens browser directly
      return "Opening Memory Palace...";
    },
  },
  "/sleeptime": {
    desc: "Configure sleep-time reflection triggers and limits",
    order: 15.5,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open sleeptime settings
      return "Opening sleeptime settings...";
    },
  },
  "/compaction": {
    desc: "Configure compaction mode settings",
    order: 15.6,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open compaction settings
      return "Opening compaction settings...";
    },
  },
  "/context-limit": {
    desc: "Set or reset the max context window",
    args: "[tokens] [--override]",
    order: 15.7,
    handler: () => {
      // Handled specially in App.tsx
      return "Setting max context window...";
    },
  },
  "/memfs": {
    desc: "Manage filesystem-backed memory (/memfs [enable|sync|reset])",
    args: "[enable|disable|sync|reset]",
    order: 27.5, // Advanced feature, near /toolset
    handler: () => {
      // Handled specially in App.tsx
      return "Managing memory filesystem...";
    },
  },
  "/search": {
    desc: "Search messages across all agents (/search [query])",
    order: 15.1,
    handler: () => {
      // Handled specially in App.tsx to show message search
      return "Opening message search...";
    },
  },
  "/connect": {
    desc: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
    order: 17,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx - opens ProviderSelector
      return "Opening provider connection...";
    },
  },
  "/clear": {
    desc: "Clear in-context messages",
    order: 18,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to reset agent messages
      return "Clearing in-context messages...";
    },
  },
  "/clear-messages": {
    desc: "Reset all agent messages (destructive)",
    hidden: true,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to reset agent messages
      return "Resetting agent messages...";
    },
  },
  "/cd": {
    desc: "Change working directory for this TUI session (/cd <path>)",
    args: "<path>",
    order: 18.5,
    handler: () => {
      // Handled specially in App.tsx to switch local cwd
      return "Changing working directory...";
    },
  },

  // === Page 2: Agent management (order 20-29) ===
  "/new": {
    desc: "Start a new conversation (keep agent memory)",
    order: 20,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to create new conversation
      return "Starting new conversation...";
    },
  },
  "/fork": {
    desc: "Fork the current conversation",
    order: 20.5,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to fork current conversation
      return "Forking conversation...";
    },
  },
  "/btw": {
    desc: "Fork conversation and ask a side question (/btw <question>)",
    order: 20.6,
    handler: () => {
      // Handled specially in App.tsx to fork and ask in background
      return "Forking conversation...";
    },
  },
  "/pin": {
    desc: "Pin current agent (/pin [name])",
    order: 22,
    handler: () => {
      // Handled specially in App.tsx
      return "Pinning agent...";
    },
  },
  "/unpin": {
    desc: "Unpin current agent",
    order: 23,
    handler: () => {
      // Handled specially in App.tsx
      return "Unpinning agent...";
    },
  },
  "/rename": {
    desc: "Rename agent or conversation (/rename agent [name]|convo [name])",
    order: 24,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Renaming...";
    },
  },
  "/description": {
    desc: "Update the current agent's description (/description <text>)",
    order: 25,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Updating description...";
    },
  },
  "/toolset": {
    desc: "Switch toolset (replaces /link and /unlink)",
    order: 27,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Opening toolset selector...";
    },
  },
  "/experiments": {
    desc: "Toggle experiments",
    order: 27.1,
    handler: () => {
      // Handled specially in App.tsx to open experiments selector
      return "Opening experiments selector...";
    },
  },
  "/reload": {
    desc: "Reload settings and local mods",
    order: 27.2,
    noArgs: true,
    handler: () => {
      // Handled specially in AppCoordinator to reload runtime surfaces in-place
      return "Reloading...";
    },
  },
  "/mods": {
    desc: "Run mod learning targets",
    order: 27.3,
    args: "learn [memory-citations] [options] | generate-env [request]",
    handler: () => {
      // Handled specially in use-submit-handler.ts to stream mod learning progress
      return "Starting mod learning...";
    },
  },
  "/ade": {
    desc: "Open agent in ADE (browser)",
    order: 28,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and open browser
      return "Opening ADE...";
    },
  },

  // === Page 3: Advanced features (order 30-39) ===
  "/system": {
    desc: "Switch system prompt",
    order: 30,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open system prompt selector
      return "Opening system prompt selector...";
    },
  },
  "/personality": {
    desc: "Switch personality",
    order: 30.5,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open personality selector
      return "Opening personality selector...";
    },
  },
  "/subagents": {
    desc: "Manage custom subagents",
    order: 31,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open SubagentManager component
      return "Opening subagent manager...";
    },
  },
  "/mcp": {
    desc: "Manage MCP servers (add, connect with OAuth)",
    order: 32,
    handler: () => {
      // Handled specially in App.tsx to show MCP server selector
      return "Opening MCP server manager...";
    },
  },
  "/secret": {
    desc: "Manage secrets for shell commands",
    order: 33,
    args: "<set|list|unset> [key] [value]",
    handler: (args: string[]) => handleSecretCommand(args),
  },
  "/memory-repository": {
    desc: "Push this agent's memory repo to an additional git remote",
    order: 33.1,
    args: "<set|unset|status|push> [url]",
    handler: async (args: string[]) => {
      const result = await handleMemoryRepositoryCommand(args);
      return result.output;
    },
  },
  "/usage": {
    desc: "Open the Usage page (overview + breakdown)",
    order: 33,
    noArgs: true,
    handler: () => pageCommandAnswer("Opening usage..."),
  },
  "/tabs": {
    desc: "List open tabs (switch with Enter, close with D)",
    order: 32.9,
    noArgs: true,
    handler: () => pageCommandAnswer("Opening tabs..."),
  },
  "/message-history": {
    desc: "Open the message history (also Ctrl+X h)",
    order: 32.85,
    noArgs: true,
    handler: () => pageCommandAnswer("Opening message history..."),
  },
  "/hidden-sessions": {
    desc: "Browse hidden sessions (read-only)",
    order: 32.86,
    noArgs: true,
    handler: () => pageCommandAnswer("Opening hidden sessions..."),
  },
  "/close": {
    desc: "Close the current tab",
    order: 32.8,
    noArgs: true,
    handler: () => pageCommandAnswer("Closing tab..."),
  },
  "/settings": {
    desc: "Open the Settings page",
    order: 32.7,
    noArgs: true,
    handler: () => pageCommandAnswer("Opening settings..."),
  },
  "/context": {
    desc: "Context: usage, limit, pending prefix changes",
    args: "<limit|pending>",
    order: 33.5,
    handler: () => formatHubHelpFor("/context"),
  },
  "/recompile": {
    desc: "Recompile current agent + conversation (warning: this will evict the cache and increase costs)",
    order: 33.6,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Recompiling agent and conversation...";
    },
  },
  "/context-pending": {
    desc: "Show prefix changes registered but not yet applied (memory, system, skills, tools, model)",
    args: "[full]",
    order: 33.65,
    handler: () => {
      // Handled specially in the TUI submit handler (needs conversation scope)
      return "Checking pending prefix changes...";
    },
  },
  "/feedback": {
    desc: "Save a feedback report to the local log (file bugs at github.com/TZYLT/haruyuki/issues)",
    order: 34,
    handler: () => {
      // Handled specially in App.tsx to send feedback request
      return "Sending feedback...";
    },
  },
  "/help": {
    desc: "Show available commands",
    order: 35,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open help dialog
      return "Opening help...";
    },
  },
  "/hooks": {
    desc: "Manage hooks configuration",
    order: 36,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open hooks manager
      return "Opening hooks manager...";
    },
  },
  "/statusline": {
    desc: "Customize the bottom statusline",
    args: "[request]",
    order: 36.5,
    handler: () => {
      // Handled specially in App.tsx
      return "Starting statusline setup...";
    },
  },
  "/title": {
    desc: "Configure terminal window title",
    noArgs: true,
    order: 36.6,
    handler: () => {
      // Handled specially in App.tsx
      return "Opening title configurator...";
    },
  },
  "/reasoning-tab": {
    desc: "Toggle Tab shortcut for reasoning tiers (/reasoning-tab on|off|status)",
    args: "[on|off|status]",
    order: 36.7,
    handler: () => {
      // Handled specially in App.tsx
      return "Managing reasoning Tab shortcut...";
    },
  },
  "/system-reminders": {
    desc: "Show or hide system reminders",
    args: "[on|off|status]",
    order: 36.8,
    handler: (args: string[]) => handleSystemRemindersCommand(args),
  },
  "/terminal": {
    desc: "Setup terminal shortcuts [--revert]",
    args: "[--revert]",
    order: 37,
    handler: (args: string[]) => handleTerminalCommand(args),
  },
  "/font-width": {
    desc: "How wide this terminal draws ambiguous characters (auto probes it)",
    args: "auto|narrow|wide",
    order: 38,
    handler: (args: string[]) => handleFontWidthCommand(args),
  },
  "/console-font": {
    desc: "Hold the Windows console font at the configured face",
    args: "auto|off|<face>",
    order: 38.5,
    handler: (args: string[]) => handleConsoleFontCommand(args),
  },
  "/install-github-app": {
    desc: "Setup Haruyuki GitHub Action in this repo",
    order: 38,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Opening GitHub App installer...";
    },
  },

  // === Session management (order 40-49) ===
  "/bg": {
    desc: "Show background shell processes",
    order: 42,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to show background processes
      return "Showing background processes...";
    },
  },
  "/workflows": {
    desc: "Show workflow runs, their agents, and token usage",
    order: 42.5,
    noArgs: true,
    handler: () => {
      const executions = listWorkflowExecutions();
      if (executions.length === 0) {
        return "No workflow runs in this session";
      }
      return executions.flatMap(renderWorkflowTree).join("\n");
    },
  },
  "/exit": {
    desc: "Exit this session",
    order: 43,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Exiting...";
    },
  },
  "/logout": {
    desc: "Clear saved credentials and exit",
    order: 44,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access settings manager
      return "Clearing credentials...";
    },
  },

  // === Hidden commands (not shown in autocomplete) ===
  "/stream": {
    desc: "Toggle token streaming on/off",
    hidden: true,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx for live toggling
      return "Toggling token streaming...";
    },
  },
  "/compact": {
    desc: "Trim older context at a topic boundary you pick",
    args: "[n|help]",
    handler: () => {
      // Handled in the TUI submit handler (selector) and by the listener.
      return "Compacting conversation...";
    },
  },
  "/topic": {
    desc: "Mark a topic boundary, or list the topic blocks (/topic list [--all])",
    args: "<title> [summary] | list [--all]",
    handler: (args, scope) =>
      args[0] === "list"
        ? handleTopicsCommand(args.slice(1), scope)
        : handleTopicCommand(args, scope),
  },
  "/topics": {
    desc: "List the topic blocks of the current context",
    args: "[--all]",
    handler: (args, scope) => handleTopicsCommand(args, scope),
  },
  "/recall": {
    desc: "Configure passive recall of earlier conversations and memory",
    args: "[setting] [value]",
    order: 15.4,
    handler: (args, scope) => handleRecallCommand(args, scope),
  },
  "/resume": {
    desc: "Resume a previous conversation",
    args: "[conversation_id]",
    order: 19,
    handler: () => {
      // Handled specially in App.tsx to show conversation selector or switch directly
      return "Opening conversation selector...";
    },
  },
  "/pinned": {
    desc: "Browse agents, opened on the pinned tab",
    noArgs: true,
    handler: () => {
      // Handled by the navigation branch: the agent browser on its pinned tab.
      return "Opening agent browser...";
    },
  },
  "/profile": {
    desc: "Save, load or delete a local agent profile",
    args: "<save|load|delete|usage> [name]",
    handler: () => {
      // Handled by the profile branch in the submit handler, which needs the
      // agent browser and the settings writer. No longer a top-level name:
      // `/agent profile` is the entry point.
      return "Running profile command...";
    },
  },
};

/**
 * The internal forms the hubs run. Each one is still a working command — the
 * point is that nobody types it: `resolveHubInput` rewrites the hub invocation
 * to this string, and `MOVED_COMMANDS` in `hubs.ts` stops a user who types it
 * directly. Listing them here rather than editing forty entries keeps the rule
 * in one place, and the array doubles as the check that every target exists.
 */
export const HUB_TARGET_COMMANDS: readonly string[] = [
  // /agent
  "/agents",
  "/pin",
  "/unpin",
  "/pinned",
  "/rename",
  "/description",
  "/system",
  "/personality",
  "/toolset",
  "/subagents",
  "/ade",
  "/profile",
  // /session
  "/logout",
  // /memory
  "/memfs",
  "/memory-repository",
  "/palace",
  "/init",
  "/sleeptime",
  // /messages
  "/message-history",
  "/clear-messages",
  // /skill
  "/skills",
  "/skill-creator",
  // /context
  "/context-limit",
  "/context-pending",
  "/compaction",
  // /topic
  "/topics",
  // /config
  "/experiments",
  "/mods",
  "/statusline",
  "/title",
  "/terminal",
  "/font-width",
  "/console-font",
  "/stream",
  "/reasoning-tab",
  "/system-reminders",
  "/mcp",
  "/hooks",
  "/secret",
  "/connect",
  // /maintenance
  "/feedback",
  "/bg",
  "/workflows",
  "/install-github-app",
  "/hidden-sessions",
];

for (const name of HUB_TARGET_COMMANDS) {
  const command = commands[name];
  if (command) {
    command.internal = true;
    command.hidden = true;
  }
}

export interface CommandExecutionResult {
  success: boolean;
  output: string;
  notFound?: boolean;
  refreshSecretsInfo?: boolean;
}

function normalizeCommandHandlerResult(result: CommandHandlerResult): {
  output: string;
  refreshSecretsInfo?: boolean;
} {
  if (typeof result === "string") {
    return { output: result };
  }
  return result;
}

/**
 * Execute a command and return the result
 */
export async function executeCommand(
  input: string,
  scope?: DreamCommandScope,
): Promise<CommandExecutionResult> {
  const [command, ...args] = input.trim().split(/\s+/);

  if (!command) {
    return {
      success: false,
      output: "No command found",
    };
  }

  const handler = commands[command];
  if (!handler) {
    return {
      success: false,
      output: `Unknown command: ${command}`,
      notFound: true,
    };
  }

  if (handler.noArgs && args.length > 0) {
    return {
      success: false,
      output: `${command} does not accept arguments.`,
    };
  }

  try {
    const result = normalizeCommandHandlerResult(
      await handler.handler(args, scope),
    );
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      output: `Error executing ${command}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
