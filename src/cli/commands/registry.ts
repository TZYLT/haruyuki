// src/cli/commands/registry.ts
// Registry of available CLI commands

import {
  type DreamCommandScope,
  requestCloudReflectionRun,
} from "@/agent/reflection-runs";
import { renderWorkflowTree } from "@/cli/helpers/workflow-display";
import { resolveUiV2Once } from "@/experiments/ui-v2";
import { listWorkflowExecutions } from "@/tools/workflow/execution-registry";
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
    desc: "Reflect on memory (alias for /reflect; Cloud reflects this conversation)",
    order: 49,
    args: "[--recent N | --conversation ID ... | --auto] [--instruction TEXT]",
    handler: handleReflectionCommand,
  },
  "/reflect": {
    desc: "Launch reflection (/reflect [--recent N | --conversation ID ... | --auto] [--instruction TEXT])",
    args: "[--recent N | --conversation ID ... | --auto] [--instruction TEXT]",
    order: 50,
    handler: handleReflectionCommand,
  },
  "/reflection": {
    desc: "Alias for /reflect",
    args: "[--recent N | --conversation ID ... | --auto] [--instruction TEXT]",
    hidden: true,
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
    desc: "View your agent's memory",
    order: 15,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open memory viewer
      return "Opening memory viewer...";
    },
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
    desc: "Configure sleep-time reflection trigger and merge settings",
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
  "/chdir": {
    desc: "Change working directory for this TUI session (/chdir <path>)",
    args: "<path>",
    order: 18.5,
    handler: () => {
      // Handled specially in App.tsx to switch local cwd
      return "Changing working directory...";
    },
  },
  "/cd": {
    desc: "Alias for /chdir",
    args: "<path>",
    hidden: true,
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
    desc: "Show context window usage",
    order: 33.5,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to display context usage
      return "Fetching context usage...";
    },
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
    hidden: true, // Redundant with improved autocomplete, but still works if typed
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
    order: 37,
    handler: async (args: string[]) => {
      if (args.includes("help")) {
        return [
          "/terminal help",
          "",
          "Setup terminal keyboard shortcuts.",
          "",
          "USAGE",
          "  /terminal            — install Shift+Enter keybinding",
          "  /terminal --revert   — remove keybinding",
          "  /terminal help       — show this help",
        ].join("\n");
      }

      const {
        detectTerminalType,
        getKeybindingsPath,
        installKeybinding,
        removeKeybinding,
      } = await import("@/cli/utils/terminal-keybinding-installer");
      const { updateSettings } = await import("@/settings");

      const isRevert = args.includes("--revert") || args.includes("--remove");
      const terminal = detectTerminalType();

      if (!terminal) {
        return "Not running in a VS Code-like terminal. Shift+Enter keybinding is not needed.";
      }

      const terminalName = {
        vscode: "VS Code",
        cursor: "Cursor",
        windsurf: "Windsurf",
      }[terminal];

      const keybindingsPath = getKeybindingsPath(terminal);
      if (!keybindingsPath) {
        return `Could not determine keybindings.json path for ${terminalName}`;
      }

      if (isRevert) {
        const result = removeKeybinding(keybindingsPath);
        if (!result.success) {
          return `Failed to remove keybinding: ${result.error}`;
        }
        await updateSettings({ shiftEnterKeybindingInstalled: false });
        return `Removed Shift+Enter keybinding from ${terminalName}`;
      }

      const result = installKeybinding(keybindingsPath);
      if (!result.success) {
        return `Failed to install keybinding: ${result.error}`;
      }

      if (result.alreadyExists) {
        return `Shift+Enter keybinding already exists in ${terminalName}`;
      }

      await updateSettings({ shiftEnterKeybindingInstalled: true });
      return `Installed Shift+Enter keybinding for ${terminalName}\nLocation: ${keybindingsPath}`;
    },
  },
  "/font-width": {
    desc: "How wide this terminal draws ambiguous characters (auto probes it)",
    args: "auto|narrow|wide",
    order: 38,
    handler: async (args: string[]) => {
      const requested = (args[0] ?? "").toLowerCase();
      const {
        getAmbiguousWidth,
        getAmbiguousWidthMode,
        getAmbiguousWidthSource,
        setAmbiguousWidthMode,
      } = await import("@/cli/helpers/char-width");
      // Every answer starts with what is in force. The machine's report was
      // "changing the font width has no visible effect": a one-column difference in a
      // dozen rows of prose is not something an eye can confirm, so the command has to
      // say the number rather than let the frame be the evidence.
      const source =
        getAmbiguousWidthSource() === "probe"
          ? "the terminal's own answer"
          : getAmbiguousWidthSource() === "mode"
            ? "pinned by this command"
            : "the width table's default";
      const inForce = `In force: ${getAmbiguousWidth()} column(s) — ${source}${getAmbiguousWidthMode() === "auto" ? " (auto)" : ` (${getAmbiguousWidthMode()})`}.`;
      if (
        requested !== "auto" &&
        requested !== "narrow" &&
        requested !== "wide"
      ) {
        return [
          inForce,
          "",
          "/font-width auto | narrow | wide",
          "",
          "Unicode calls `— … ≥ → · “ ”` *ambiguous*: a Western monospace font draws",
          "them one column, a CJK font (or a CJK fallback) draws them two. The app",
          "asks the terminal at startup and after each resize; this command pins the",
          "answer for a terminal that is wrong or will not reply.",
          "",
          "  auto    — ask the terminal (the default)",
          "  narrow  — one column, e.g. Consolas",
          "  wide    — two columns, e.g. 等宽楷体",
        ].join("\n");
      }
      const { startAmbiguousWidthProbe } = await import(
        "@/cli/helpers/ambiguous-width-probe"
      );
      const previous = getAmbiguousWidth();
      setAmbiguousWidthMode(requested);
      try {
        // The same writer `/terminal` uses: read-merge-write of
        // `~/.haruyuki/settings.json`, so keys this module does not model survive.
        const { updateSettings } = await import("@/settings");
        await updateSettings({ ambiguousCharWidth: requested });
      } catch {
        // An unreadable settings file still leaves the session value in force.
      }
      if (requested === "auto") {
        const started = startAmbiguousWidthProbe();
        return started.kind === "armed"
          ? `${inForce}\nProbing the terminal… (rows and selections follow its answer)`
          : `${inForce}\nNo terminal to ask; keeping the width table's answer.`;
      }
      const now = getAmbiguousWidth();
      const change =
        now === previous
          ? "unchanged"
          : `was ${previous}, so every row is being laid out again`;
      return `${inForce}\n${requested}: ${now} column(s) — ${change}; saved to settings.`;
    },
  },
  "/console-font": {
    desc: "Hold the Windows console font at the configured face",
    args: "auto|off|<face>",
    order: 38.5,
    handler: async (args: string[]) => {
      const { parseConsoleFontMode } = await import(
        "@/cli/helpers/console-font"
      );
      const {
        getConsoleFontGuardStatus,
        restartConsoleFontGuardRuntime,
        stopConsoleFontGuardRuntime,
      } = await import("@/cli/helpers/console-font-bun");

      const describe = (
        status: ReturnType<typeof getConsoleFontGuardStatus>,
      ): string[] => {
        const mode =
          typeof status.mode === "object"
            ? status.mode.pinnedFace
            : status.mode;
        const standing =
          status.mode === "off"
            ? " (off)"
            : status.running
              ? ` — restoring ${status.targetFace}`
              : ` — not running (${status.reason ?? "not started"})`;
        // The command answers with what is in force first, the way `/font-width`
        // does: a repair that happened once is invisible on screen, so the state
        // has to be written down rather than left to the frame.
        const lines = [`In force: ${mode}${standing}`];
        if (status.baseline !== null) {
          lines.push(
            `This session started on: ${status.baseline.face} ${status.baseline.cellWidth}x${status.baseline.cellHeight}.`,
          );
        }
        lines.push(`Repairs this session: ${status.repairs}.`);
        return lines;
      };

      const requested = (args[0] ?? "").trim();
      if (requested === "") {
        return [
          ...describe(getConsoleFontGuardStatus()),
          "",
          "/console-font auto | off | <face>",
          "",
          "Classic Windows `conhost.exe` changes a live window's font by itself —",
          "`Consolas` → `宋体` around startup (the console's saved default being",
          "re-applied), `Consolas` → `Terminal` 8×12 mid-turn (the smallest raster face,",
          "which has none of the block or ambiguous glyphs this UI is drawn with) — and",
          "keeps it until the window's properties are changed by hand. No escape",
          "sequence selects a font, so the only way to keep the font still is to hold",
          "it: the guard asks the console what it is drawing with four times a second",
          "and writes the target face back. Windows console host + Bun.",
          "",
          "  (unset)  — the preset, `Consolas`",
          "  auto     — whatever face this session started with",
          "  off      — stop watching",
          "  <face>   — draw with that face, e.g. 霞鹜文楷等宽",
        ].join("\n");
      }

      const mode = parseConsoleFontMode(requested);
      try {
        const { updateSettings } = await import("@/settings");
        await updateSettings({
          consoleFont: typeof mode === "object" ? mode.pinnedFace : mode,
        });
      } catch {
        // An unreadable settings file still leaves the session value in force.
      }
      if (mode === "off") {
        stopConsoleFontGuardRuntime();
        return [
          ...describe(getConsoleFontGuardStatus()),
          "Stopped; saved to settings.",
        ].join("\n");
      }
      await restartConsoleFontGuardRuntime();
      return [
        ...describe(getConsoleFontGuardStatus()),
        "Saved to settings.",
      ].join("\n");
    },
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
    desc: "Mark a topic boundary in this conversation",
    args: "<title> [summary]",
    handler: (args, scope) => handleTopicCommand(args, scope),
  },
  "/topics": {
    desc: "List the topic blocks of the current context",
    args: "[--all]",
    handler: (args, scope) => handleTopicsCommand(args, scope),
  },
  "/recall": {
    desc: "Configure passive recall of earlier conversations and memory",
    args: "[setting] [value]",
    handler: (args, scope) => handleRecallCommand(args, scope),
  },
  "/set-max-context": {
    desc: "Alias for /context-limit",
    args: "[tokens] [--override]",
    hidden: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Setting max context window...";
    },
  },
  "/link": {
    desc: "Attach all Haruyuki tools to agent (deprecated, use /toolset instead)",
    hidden: true,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Linking tools...";
    },
  },
  "/unlink": {
    desc: "Remove all Haruyuki tools from agent (deprecated, use /toolset instead)",
    hidden: true,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Unlinking tools...";
    },
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
    desc: "Browse pinned agents",
    hidden: true, // Alias for /agents (opens to Pinned tab)
    noArgs: true,
    handler: () => {
      return "Opening agent browser...";
    },
  },
  "/profiles": {
    desc: "Browse pinned agents",
    hidden: true, // Alias for /agents (opens to Pinned tab)
    noArgs: true,
    handler: () => {
      return "Opening agent browser...";
    },
  },
};

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
