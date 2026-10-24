import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveHubInput } from "@/cli/commands/hubs";
import { commands, executeCommand } from "@/cli/commands/registry";
import { SUPPORTED_REMOTE_COMMANDS } from "@/websocket/listener/listener-constants";

describe("/messages clear command", () => {
  test("is executable but internal: /messages clear is the entry point", async () => {
    expect(commands["/clear-messages"]).toMatchObject({
      desc: "Reset all agent messages (destructive)",
      hidden: true,
      internal: true,
      noArgs: true,
    });
    await expect(executeCommand("/clear-messages")).resolves.toEqual({
      success: true,
      output: "Resetting agent messages...",
    });
  });

  test("the hub form reaches it and the old name does not run", () => {
    expect(resolveHubInput("/messages clear")).toEqual({
      kind: "command",
      text: "/clear-messages",
    });
    expect(resolveHubInput("/clear-messages")).toEqual({
      kind: "error",
      message: expect.stringContaining("/messages clear"),
    });
  });

  test("is handled by interactive and remote command paths", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./app/use-submit-handler.ts", import.meta.url),
    );
    const listenerCommandsPath = fileURLToPath(
      new URL("../websocket/listener/commands.ts", import.meta.url),
    );

    expect(readFileSync(submitHandlerPath, "utf8")).toContain(
      'trimmed === "/clear-messages"',
    );
    expect(readFileSync(listenerCommandsPath, "utf8")).toContain(
      'case "clear-messages":',
    );
    // The wire id is frozen for desktop clients even though the TUI name moved.
    expect(SUPPORTED_REMOTE_COMMANDS).toContain("clear-messages");
  });
});
