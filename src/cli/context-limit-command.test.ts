import { describe, expect, test } from "bun:test";
import { resolveHubInput } from "@/cli/commands/hubs";
import { commands, executeCommand } from "@/cli/commands/registry";

describe("/context hub and its limit subcommand", () => {
  test("advertises the hub and keeps the target internal", () => {
    expect(commands["/context"]).toMatchObject({
      desc: "Context: usage, limit, pending prefix changes",
      args: "<limit|pending>",
    });
    expect(commands["/context"]?.hidden).not.toBe(true);

    expect(commands["/context-limit"]).toMatchObject({
      desc: "Set or reset the max context window",
      args: "[tokens] [--override]",
      hidden: true,
      internal: true,
    });

    const discoverableCommands = Object.entries(commands)
      .filter(([, command]) => !command.hidden)
      .map(([name]) => name);

    expect(discoverableCommands).toContain("/context");
    expect(discoverableCommands).not.toContain("/context-limit");
    // The alias is gone, not hidden: `/set-max-context` names `/context limit`
    // in hubs.ts REMOVED_COMMANDS and has no registry entry to fall back on.
    expect(commands["/set-max-context"]).toBeUndefined();
  });

  test("resolves the hub form to the internal target", () => {
    expect(resolveHubInput("/context limit 10000 --override")).toEqual({
      kind: "command",
      text: "/context-limit 10000 --override",
    });
    expect(resolveHubInput("/context pending full")).toEqual({
      kind: "command",
      text: "/context-pending full",
    });
  });

  test("the internal target still runs", async () => {
    await expect(
      executeCommand("/context-limit 10000 --override"),
    ).resolves.toMatchObject({
      success: true,
      output: "Setting max context window...",
    });
  });

  test("the removed alias answers with the hub form", async () => {
    expect(await executeCommand("/set-max-context 10000")).toMatchObject({
      success: false,
      notFound: true,
    });
    expect(resolveHubInput("/set-max-context 10000")).toEqual({
      kind: "error",
      message: expect.stringContaining("/context limit"),
    });
  });
});
