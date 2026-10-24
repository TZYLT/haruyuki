import { describe, expect, test } from "bun:test";
import {
  formatHubHelpFor,
  HUBS,
  isHubCommand,
  MOVED_COMMANDS,
  REMOVED_COMMANDS,
  resolveHubInput,
} from "@/cli/commands/hubs";
import { commands, HUB_TARGET_COMMANDS } from "@/cli/commands/registry";

const HUB_NAMES = [
  "/agent",
  "/session",
  "/memory",
  "/messages",
  "/skill",
  "/context",
  "/config",
  "/maintenance",
];

function firstWord(text: string): string {
  return text.trim().split(/\s+/)[0] ?? "";
}

describe("hub table", () => {
  test("declares exactly the eight settled hubs", () => {
    expect(Object.keys(HUBS).sort()).toEqual([...HUB_NAMES].sort());
  });

  test("every hub is registered and every registered hub is in the table", () => {
    for (const name of HUB_NAMES) {
      expect({ name, registered: commands[name] !== undefined }).toEqual({
        name,
        registered: true,
      });
      expect({ name, listed: commands[name]?.hidden !== true }).toEqual({
        name,
        listed: true,
      });
    }
  });

  test("every subcommand and bare form runs a command the registry still has", () => {
    for (const hub of Object.values(HUBS)) {
      const targets = [
        ...(hub.bare ? [hub.bare.command] : []),
        ...hub.subcommands.map((sub) => sub.command),
      ];
      for (const target of targets) {
        expect({ hub: hub.name, target }).toEqual({
          hub: hub.name,
          target,
        });
        expect(commands[target]).toBeDefined();
      }
    }
  });

  test("the targets are internal: no user types them, so they never claim the name", () => {
    for (const name of HUB_TARGET_COMMANDS) {
      expect({ name, registered: commands[name] !== undefined }).toEqual({
        name,
        registered: true,
      });
      expect({ name, internal: commands[name]?.internal }).toEqual({
        name,
        internal: true,
      });
      expect({ name, hidden: commands[name]?.hidden }).toEqual({
        name,
        hidden: true,
      });
    }
  });

  test("a subcommand that advertises arguments does not hit a no-args guard", () => {
    // The hub hands the user's remaining words straight to the target, so a
    // target that rejects arguments would silently refuse the documented form.
    for (const hub of Object.values(HUBS)) {
      for (const sub of hub.subcommands) {
        if (!sub.args) continue;
        expect({ sub: sub.name, target: sub.command }).toEqual({
          sub: sub.name,
          target: sub.command,
        });
        expect(commands[sub.command]?.noArgs).not.toBe(true);
      }
    }
  });

  test("every retired name points at something that exists", () => {
    for (const [name, replacement] of [
      ...Object.entries(MOVED_COMMANDS),
      ...Object.entries(REMOVED_COMMANDS),
    ]) {
      const token = firstWord(replacement);
      // A replacement may name a hub ("/agent") or a surviving command
      // ("/topic", "/resume", "/cd"). Neither may be a retired name again.
      expect({
        name,
        target: token,
        exists: Boolean(HUBS[token] ?? commands[token]),
      }).toEqual({ name, target: token, exists: true });
      expect({
        name,
        target: token,
        retiredAgain: Boolean(MOVED_COMMANDS[token]),
      }).toEqual({ name, target: token, retiredAgain: false });
    }
  });

  test("no retired name survives in the registry", () => {
    for (const name of [
      ...Object.keys(MOVED_COMMANDS),
      ...Object.keys(REMOVED_COMMANDS),
    ]) {
      // A moved name may still exist as an internal target (that is how the hub
      // reaches it); a removed one may not exist at all.
      if (MOVED_COMMANDS[name]) {
        expect({ name, internal: commands[name]?.internal }).toEqual({
          name,
          internal: true,
        });
      } else {
        expect({ name, registered: commands[name] !== undefined }).toEqual({
          name,
          registered: false,
        });
      }
    }
  });
});

describe("hub resolution", () => {
  test.each([
    ["/agent", "/agents"],
    ["/agent list", "/agents"],
    ["/agent pin work", "/pin work"],
    ["/agent unpin", "/unpin"],
    ["/agent pinned", "/pinned"],
    ["/agent rename Haruyuki Two", "/rename agent Haruyuki Two"],
    ["/agent describe a local companion", "/description a local companion"],
    ["/agent system", "/system"],
    ["/agent personality", "/personality"],
    ["/agent toolset", "/toolset"],
    ["/agent subagents", "/subagents"],
    ["/agent ade", "/ade"],
    ["/agent profile save mine", "/profile save mine"],
    ["/session rename Ship it", "/rename convo Ship it"],
    ["/session logout", "/logout"],
    ["/memory", "/memory"],
    ["/memory recall", "/recall"],
    ["/memory recall recall_interval 5", "/recall recall_interval 5"],
    ["/memory init", "/init"],
    ["/memory memfs sync", "/memfs sync"],
    ["/memory remote status", "/memory-repository status"],
    ["/memory palace", "/palace"],
    ["/memory config", "/sleeptime"],
    ["/messages history", "/message-history"],
    ["/messages clear", "/clear-messages"],
    ["/skill", "/skills"],
    ["/skill list", "/skills"],
    [
      "/skill skill-creator a skill that lints",
      "/skill-creator a skill that lints",
    ],
    ["/context", "/context"],
    ["/context limit 10000 --override", "/context-limit 10000 --override"],
    ["/context pending full", "/context-pending full"],
    ["/config connect", "/connect"],
    ["/config mcp", "/mcp"],
    ["/config secret set KEY value", "/secret set KEY value"],
    ["/config font-width wide", "/font-width wide"],
    ["/config console-font auto", "/console-font auto"],
    ["/config system-reminders on", "/system-reminders on"],
    ["/maintenance feedback", "/feedback"],
    ["/maintenance bg", "/bg"],
    ["/maintenance workflows", "/workflows"],
    ["/maintenance install-github-app", "/install-github-app"],
  ])("%s resolves to %s", (input, expected) => {
    expect(resolveHubInput(input)).toEqual({ kind: "command", text: expected });
  });

  test("a hub with no bare form answers its subcommand list", () => {
    const result = resolveHubInput("/session");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("/session rename <name>");
    expect(result.message).toContain("/session logout");
  });

  test("an unknown subcommand is refused, with the list attached", () => {
    const result = resolveHubInput("/agent bogus");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain('unknown subcommand "bogus"');
    expect(result.message).toContain("/agent rename <name>");
  });

  test("subcommands match exactly, so a title argument is not eaten", () => {
    // `/topic` is a command, not a hub: its first word is the title.
    expect(resolveHubInput("/topic Auth token refresh bug")).toEqual({
      kind: "none",
    });
    expect(resolveHubInput("/topic list")).toEqual({ kind: "none" });
  });

  test.each([
    "/compact",
    "/compact 2",
    "/model",
    "/resume abc",
    "/new",
    "/search token refresh",
    "/memfs enable",
  ])("%s is not a hub", (input) => {
    // `/memfs` is retired, so it answers with the move; everything else passes
    // through untouched.
    const result = resolveHubInput(input);
    if (input === "/memfs enable") {
      expect(result).toEqual({
        kind: "error",
        message: expect.stringContaining("/memory memfs"),
      });
    } else {
      expect(result).toEqual({ kind: "none" });
    }
  });

  test("plain chat is untouched", () => {
    for (const input of ["hello", "", "  ", "agent pin me"]) {
      expect(resolveHubInput(input)).toEqual({ kind: "none" });
    }
  });

  test("a retired name names its replacement and does not run", () => {
    for (const [name, replacement] of Object.entries({
      ...MOVED_COMMANDS,
      ...REMOVED_COMMANDS,
    })) {
      const result = resolveHubInput(`${name} extra`);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain(firstWord(replacement));
    }
  });

  test("the two rename homes are both named, since one old name served both", () => {
    const result = resolveHubInput("/rename Foo");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("/agent rename");
    expect(result.message).toContain("/session rename");
  });

  test("isHubCommand answers for the hub alone and not for its targets", () => {
    expect(isHubCommand("/agent pin")).toBe(true);
    expect(isHubCommand("/memory")).toBe(true);
    expect(isHubCommand("/agents")).toBe(false);
    expect(isHubCommand("hello")).toBe(false);
  });
});

describe("hub help", () => {
  test("lists every subcommand with its syntax and description", () => {
    const help = formatHubHelpFor("/agent");
    expect(help).toContain("/agent — Agent: browse, pin, rename");
    for (const sub of HUBS["/agent"]?.subcommands ?? []) {
      expect(help).toContain(sub.name);
      expect(help).toContain(sub.desc);
    }
  });

  test("a bare-form hub still prints the bare form's own line", () => {
    const help = formatHubHelpFor("/memory");
    expect(help).toContain("View your agent's memory");
    expect(help).toContain("/memory remote <set|unset|status|push> [url]");
  });

  test("the registry answers a bare hub with that same list", async () => {
    const { executeCommand } = await import("@/cli/commands/registry");
    await expect(executeCommand("/agent")).resolves.toMatchObject({
      success: true,
      output: expect.stringContaining("/agent pin [name]"),
    });
  });
});

describe("/topic list", () => {
  test("lists topic blocks through the /topic command", async () => {
    const { executeCommand } = await import("@/cli/commands/registry");
    const result = await executeCommand("/topic list");
    // With no agent scope the list command fails on its own guard, which is
    // proof the `list` word reached the topics handler rather than the marker
    // handler (whose error is "Topic markers require an active agent").
    expect(result.output).toContain("Topic lists require an active agent");
  });

  test("still records a marker for any other first word", async () => {
    const { executeCommand } = await import("@/cli/commands/registry");
    const result = await executeCommand("/topic Auth token refresh bug");
    expect(result.output).toContain("Topic markers require an active agent");
  });
});
