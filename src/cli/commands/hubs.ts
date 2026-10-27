// src/cli/commands/hubs.ts
// The hub table: the one place that says which subcommand exists, what it runs,
// and what a retired top-level name now points at.
//
// Why the hubs resolve to a *command string* instead of running anything: the
// commands they cover already have an owner. Some are pure handlers in this
// directory (`/secret`, `/workflows`); most are orchestration branches in the
// TUI submit handler, which need agent ids, overlays and the mod adapter — state
// the registry cannot reach. Rewriting `/agent pin x` to `/pin x` at the input
// boundary keeps exactly one dispatch path per action. The target string is the
// *internal* form: `MOVED_COMMANDS` below intercepts it when a user types it, so
// nothing user-facing is reachable under the old spelling.
//
// The eight hubs are the ones 《42-1》 §2–§8 settled. `/topic` is not a hub: it
// keeps its title argument and grows `list` and `search` subcommands in
// `topic.ts` / `topics.ts` (the two that open a face are claimed in the submit
// layer — a hub rewrites to a command string, and a command string cannot carry
// an overlay).

export interface HubSubcommand {
  /** Word typed after the hub name. */
  name: string;
  /** Syntax hint for the rest of the line, without the subcommand. */
  args?: string;
  desc: string;
  /** Command the subcommand runs (an internal form). */
  command: string;
  /** Words inserted between `command` and the user's arguments. */
  prefix?: readonly string[];
}

export interface HubDefinition {
  /** The hub itself, including the slash: "/agent". */
  name: string;
  desc: string;
  /** Ordering in autocomplete and `/help`, same scale as the registry. */
  order?: number;
  /**
   * What a bare hub invocation does. A hub without one answers its own
   * subcommand list instead.
   */
  bare?: {
    command: string;
    prefix?: readonly string[];
    /** One line describing the bare form, used by the subcommand list. */
    desc: string;
  };
  subcommands: readonly HubSubcommand[];
}

export const HUBS: Record<string, HubDefinition> = {
  "/agent": {
    name: "/agent",
    desc: "Agent: browse, pin, rename, describe, system, personality, tools",
    order: 10,
    bare: {
      command: "/agents",
      desc: "Browse agents (pinned, Haruyuki, all)",
    },
    subcommands: [
      { name: "list", desc: "Browse agents", command: "/agents" },
      { name: "pin", args: "[name]", desc: "Pin this agent", command: "/pin" },
      { name: "unpin", desc: "Unpin this agent", command: "/unpin" },
      { name: "pinned", desc: "Browse pinned agents", command: "/pinned" },
      {
        name: "rename",
        args: "<name>",
        desc: "Rename this agent",
        command: "/rename",
        prefix: ["agent"],
      },
      {
        name: "describe",
        args: "<text>",
        desc: "Set this agent's description",
        command: "/description",
      },
      { name: "system", desc: "Switch system prompt", command: "/system" },
      {
        name: "personality",
        desc: "Switch personality",
        command: "/personality",
      },
      { name: "toolset", desc: "Switch toolset", command: "/toolset" },
      {
        name: "subagents",
        desc: "Manage custom subagents",
        command: "/subagents",
      },
      {
        name: "ade",
        desc: "Open this agent in ADE (browser)",
        command: "/ade",
      },
      {
        name: "profile",
        args: "<save|load|delete|usage> [name]",
        desc: "Save, load or delete a local agent profile",
        command: "/profile",
      },
    ],
  },
  "/session": {
    name: "/session",
    desc: "Session: rename this conversation, log out",
    order: 20.5,
    subcommands: [
      {
        name: "rename",
        args: "<name>",
        desc: "Rename this conversation",
        command: "/rename",
        prefix: ["convo"],
      },
      {
        name: "logout",
        desc: "Clear saved credentials and exit",
        command: "/logout",
      },
    ],
  },
  "/memory": {
    name: "/memory",
    desc: "Memory: view, init, filesystem backend, remote, palace, recall",
    order: 15,
    bare: { command: "/memory", desc: "View your agent's memory" },
    subcommands: [
      {
        name: "recall",
        args: "[setting] [value]",
        desc: "Configure passive recall of earlier conversations",
        command: "/recall",
      },
      {
        name: "init",
        desc: "Initialize (or re-init) this agent's memory",
        command: "/init",
      },
      {
        name: "memfs",
        args: "[enable|disable|sync|reset]",
        desc: "Manage the filesystem-backed memory",
        command: "/memfs",
      },
      {
        name: "remote",
        args: "<set|unset|status|push> [url]",
        desc: "Push this agent's memory repo to another git remote",
        command: "/memory-repository",
      },
      {
        name: "palace",
        desc: "Open the Memory Palace in your browser",
        command: "/palace",
      },
      {
        name: "config",
        desc: "Sleep-time reflection triggers and limits",
        command: "/sleeptime",
      },
    ],
  },
  "/messages": {
    name: "/messages",
    desc: "Messages: history, clear",
    order: 32.85,
    subcommands: [
      {
        name: "history",
        desc: "Open the message history (also Ctrl+X h)",
        command: "/message-history",
      },
      {
        name: "clear",
        desc: "Reset all agent messages (destructive)",
        command: "/clear-messages",
      },
    ],
  },
  "/skill": {
    name: "/skill",
    desc: "Skill: list the available skills, or create a new one",
    order: 28.5,
    // `/skills` was a second name for the same listing, so the hub took the
    // listing over: bare `/skill` and `/skill list` both open it, and the old
    // spelling answers with the new one (`MOVED_COMMANDS`).
    bare: { command: "/skills", desc: "List the available skills" },
    subcommands: [
      { name: "list", desc: "List the available skills", command: "/skills" },
      {
        name: "skill-creator",
        args: "[description]",
        desc: "Enter skill creation mode",
        command: "/skill-creator",
      },
    ],
  },
  "/context": {
    name: "/context",
    desc: "Context: usage, limit, pending prefix changes",
    order: 33.5,
    bare: { command: "/context", desc: "Show context window usage" },
    subcommands: [
      {
        name: "limit",
        args: "[tokens] [--override]",
        desc: "Set or reset the max context window",
        command: "/context-limit",
      },
      {
        name: "pending",
        args: "[full]",
        desc: "Show prefix changes registered but not yet applied",
        command: "/context-pending",
      },
    ],
  },
  "/config": {
    name: "/config",
    desc: "Config: providers, MCP, hooks, secrets, terminal, appearance",
    order: 32.6,
    subcommands: [
      {
        name: "connect",
        desc: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
        command: "/connect",
      },
      {
        name: "mcp",
        desc: "Manage MCP servers (add, connect with OAuth)",
        command: "/mcp",
      },
      { name: "hooks", desc: "Manage hooks configuration", command: "/hooks" },
      {
        name: "secret",
        args: "<set|list|unset> [key] [value]",
        desc: "Manage secrets for shell commands",
        command: "/secret",
      },
      {
        name: "experiments",
        desc: "Toggle experiments",
        command: "/experiments",
      },
      {
        name: "mods",
        args: "learn [memory-citations] [options] | generate-env [request]",
        desc: "Run mod learning targets",
        command: "/mods",
      },
      {
        name: "statusline",
        args: "[request]",
        desc: "Customize the bottom statusline",
        command: "/statusline",
      },
      {
        name: "title",
        desc: "Configure terminal window title",
        command: "/title",
      },
      {
        name: "terminal",
        args: "[--revert]",
        desc: "Setup terminal keyboard shortcuts",
        command: "/terminal",
      },
      {
        name: "font-width",
        args: "auto|narrow|wide",
        desc: "How wide this terminal draws ambiguous characters",
        command: "/font-width",
      },
      {
        name: "console-font",
        args: "auto|off|<face>",
        desc: "Hold the Windows console font at the configured face",
        command: "/console-font",
      },
      {
        name: "stream",
        desc: "Toggle token streaming on/off",
        command: "/stream",
      },
      {
        name: "reasoning-tab",
        args: "[on|off|status]",
        desc: "Toggle Tab shortcut for reasoning tiers",
        command: "/reasoning-tab",
      },
      {
        name: "system-reminders",
        args: "[on|off|status]",
        desc: "Show or hide system reminders",
        command: "/system-reminders",
      },
    ],
  },
  "/maintenance": {
    name: "/maintenance",
    desc: "Maintenance: feedback, background shells, workflows, GitHub app, hidden sessions",
    order: 36,
    subcommands: [
      {
        name: "feedback",
        desc: "Save a feedback report to the local log",
        command: "/feedback",
      },
      {
        name: "bg",
        desc: "Show background shell processes",
        command: "/bg",
      },
      {
        name: "workflows",
        desc: "Show workflow runs, their agents, and token usage",
        command: "/workflows",
      },
      {
        name: "install-github-app",
        desc: "Setup Haruyuki GitHub Action in this repo",
        command: "/install-github-app",
      },
      {
        name: "sessions",
        desc: "Browse hidden sessions (read-only)",
        command: "/hidden-sessions",
      },
    ],
  },
};

/**
 * Retired top-level names, and where they went.
 *
 * These entries are what a user sees when they type the old spelling: the run
 * stops and the new form is named. They also stay reserved so a mod command
 * cannot inherit a name this build just retired (`local-mod-loader.ts`).
 */
export const MOVED_COMMANDS: Record<string, string> = {
  // moved into /agent
  "/agents": "/agent list",
  "/pin": "/agent pin",
  "/unpin": "/agent unpin",
  "/pinned": "/agent pinned",
  "/rename": "/agent rename <name> (or /session rename <name>)",
  "/description": "/agent describe <text>",
  "/system": "/agent system",
  "/personality": "/agent personality",
  "/toolset": "/agent toolset",
  "/subagents": "/agent subagents",
  "/ade": "/agent ade",
  "/profile": "/agent profile <save|load|delete|usage> [name]",
  // moved into /session
  "/logout": "/session logout",
  // moved into /memory
  "/memfs": "/memory memfs",
  "/memory-repository": "/memory remote",
  "/palace": "/memory palace",
  "/init": "/memory init",
  "/sleeptime": "/memory config",
  // moved into /messages
  "/message-history": "/messages history",
  "/clear-messages": "/messages clear",
  // moved into /skill
  "/skills": "/skill list",
  "/skill-creator": "/skill skill-creator",
  // moved into /context
  "/context-limit": "/context limit",
  "/context-pending": "/context pending",
  "/compaction": "/compact config",
  // moved into /config
  "/experiments": "/config experiments",
  "/mods": "/config mods",
  "/statusline": "/config statusline",
  "/title": "/config title",
  "/terminal": "/config terminal",
  "/font-width": "/config font-width",
  "/console-font": "/config console-font",
  "/stream": "/config stream",
  "/reasoning-tab": "/config reasoning-tab",
  "/system-reminders": "/config system-reminders",
  "/mcp": "/config mcp",
  "/hooks": "/config hooks",
  "/secret": "/config secret",
  "/connect": "/config connect",
  // moved into /maintenance
  "/feedback": "/maintenance feedback",
  "/bg": "/maintenance bg",
  "/workflows": "/maintenance workflows",
  "/install-github-app": "/maintenance install-github-app",
  // `/topics` is listed under /topic, which is a command rather than a hub.
  "/topics": "/topic list",
};

/** Removed outright, with the surviving command that does the job. */
export const REMOVED_COMMANDS: Record<string, string> = {
  "/chdir": "/cd <path>",
  "/reflection": "/reflect",
  "/set-max-context": "/context limit",
  "/profiles": "/agent pinned",
  "/link": "/agent toolset",
  "/unlink": "/agent toolset",
  "/conversations": "/resume",
};

/**
 * Every retired token, without the slash. A mod command may not take one of
 * these names: a user who just learned `/memfs` is gone would otherwise type it
 * and run somebody's mod instead.
 */
export const RETIRED_COMMAND_NAMES: readonly string[] = [
  ...Object.keys(MOVED_COMMANDS),
  ...Object.keys(REMOVED_COMMANDS),
].map((name) => name.slice(1));

export type HubResolution =
  | { kind: "none" }
  | { kind: "command"; text: string }
  | { kind: "error"; message: string };

function buildCommand(
  command: string,
  prefix: readonly string[] | undefined,
  rest: readonly string[],
): string {
  return [command, ...(prefix ?? []), ...rest].join(" ");
}

/**
 * Rewrite a hub invocation, or explain why the old spelling no longer runs.
 *
 * Returns `none` for anything that is not a hub or a retired name, so callers
 * can treat this as a filter in front of the existing dispatch.
 */
export function resolveHubInput(input: string): HubResolution {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "none" };

  const parts = trimmed.split(/\s+/);
  const token = parts[0];
  if (!token) return { kind: "none" };

  const rest = parts.slice(1);

  const hub = HUBS[token];
  if (hub) {
    if (rest.length === 0) {
      return hub.bare
        ? {
            kind: "command",
            text: buildCommand(hub.bare.command, hub.bare.prefix, []),
          }
        : { kind: "error", message: formatHubHelp(hub) };
    }

    const sub = hub.subcommands.find((candidate) => candidate.name === rest[0]);
    if (sub) {
      return {
        kind: "command",
        text: buildCommand(sub.command, sub.prefix, rest.slice(1)),
      };
    }

    return {
      kind: "error",
      message: [
        `${token}: unknown subcommand "${rest[0]}".`,
        "",
        formatHubHelp(hub),
      ].join("\n"),
    };
  }

  const movedTo = MOVED_COMMANDS[token];
  if (movedTo) {
    return {
      kind: "error",
      message: `${token} is now ${movedTo}.\nType the new form to run it.`,
    };
  }

  const replacedBy = REMOVED_COMMANDS[token];
  if (replacedBy) {
    return {
      kind: "error",
      message: `${token} was removed.\nUse ${replacedBy} instead.`,
    };
  }

  return { kind: "none" };
}

/** The subcommand list a hub prints for a bare, unknown or `help` invocation. */
export function formatHubHelp(hub: HubDefinition): string {
  const rows = hub.subcommands.map((sub) => {
    const usage = [hub.name, sub.name, sub.args].filter(Boolean).join(" ");
    return `  ${usage.padEnd(38)}${sub.desc}`;
  });

  const lines = [`${hub.name} — ${hub.desc}`, "", "USAGE"];
  if (hub.bare) {
    lines.push(`  ${hub.name.padEnd(38)}${hub.bare.desc}`);
  }
  lines.push(...rows);
  return lines.join("\n");
}

/** True when `input`'s first word names a hub. Used for queue-bypass routing. */
export function isHubCommand(input: string): boolean {
  const token = input.trim().split(/\s+/)[0];
  return Boolean(token && HUBS[token]);
}

/**
 * A hub by name, for callers that name it in source (the registry entries).
 * Throws rather than returning undefined: a missing hub there is a typo, and the
 * alternative is a registry entry that silently answers nothing.
 */
export function requireHub(name: string): HubDefinition {
  const hub = HUBS[name];
  if (!hub) throw new Error(`Unknown hub: ${name}`);
  return hub;
}

/** The subcommand list, by hub name. */
export function formatHubHelpFor(name: string): string {
  return formatHubHelp(requireHub(name));
}
