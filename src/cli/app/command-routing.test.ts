import { describe, expect, test } from "bun:test";
import { commands } from "@/cli/commands/registry";
import {
  aliasBareExitCommand,
  isNonStateCommand,
  shouldSlashCommandBypassQueue,
} from "./command-routing";

describe("command routing", () => {
  test("aliases only bare exit and quit without changing other commands", () => {
    expect(aliasBareExitCommand("exit")).toBe("/exit");
    expect(aliasBareExitCommand("quit")).toBe("/exit");
    for (const input of [
      "/reflect --recent 2",
      "/reflection",
      "/dream",
      "exit later",
      "QUIT",
    ]) {
      expect(aliasBareExitCommand(input)).toBe(input);
    }
  });
  test("uses source precedence for slash command queue bypass", () => {
    expect(shouldSlashCommandBypassQueue("/reload")).toBe(true);
    expect(shouldSlashCommandBypassQueue("/mods learn memory-citations")).toBe(
      true,
    );

    expect(
      shouldSlashCommandBypassQueue("/reload", {
        modCommand: { runWhenBusy: false },
      }),
    ).toBe(false);

    expect(
      shouldSlashCommandBypassQueue("/review", {
        modCommand: { runWhenBusy: true },
      }),
    ).toBe(true);

    expect(
      shouldSlashCommandBypassQueue("/review", {
        hasCustomCommand: true,
        modCommand: { runWhenBusy: true },
      }),
    ).toBe(false);
  });

  test("the tab-strip commands exist and are usable while a turn runs", () => {
    // P2 registered the three the design's hint row has always printed (and
    // `/usage` moved from a transcript print to the Usage page). Viewing a tab
    // list or a page changes no agent state, so they must not queue behind a turn
    // — a user who cannot read Settings while the agent works has lost the view
    // for the length of the turn. `/close` only closes a *view*; the runtime
    // refuses on its own while a turn runs (`tab-strip-actions.ts`).
    for (const name of ["/tabs", "/close", "/settings", "/usage"]) {
      expect({ name, registered: commands[name] !== undefined }).toEqual({
        name,
        registered: true,
      });
      expect({ name, bypasses: isNonStateCommand(name) }).toEqual({
        name,
        bypasses: true,
      });
    }
  });
});
