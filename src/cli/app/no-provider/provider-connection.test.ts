import { describe, expect, test } from "bun:test";
import {
  formatDisconnectedMessageHint,
  formatOAuthShellGuidance,
} from "./provider-connection";

/**
 * The empty state's wording (T-07, R-07.3 / R-07.5 / R-07.6).
 *
 * These are the sentences the user acts on, so they are pinned: a message sent
 * with no provider points at the connection, the OAuth route points at a shell,
 * and neither prefers the old `/connect` name.
 */

describe("the --no-provider empty state wording", () => {
  test("a message hint names both routes and no old command name", () => {
    const hint = formatDisconnectedMessageHint();
    expect(hint).toContain("Not connected yet");
    expect(hint).toContain("/config connect");
    expect(hint).toContain("haruyuki connect <provider>");
    expect(hint).not.toContain("/connect ");
    // One line on screen: the hint is appended after the composer.
    expect(hint.split("\n")).toHaveLength(1);
  });

  test("OAuth providers are handed to a shell, naming the provider", () => {
    const guidance = formatOAuthShellGuidance("ChatGPT / Codex plan");
    expect(guidance).toContain("ChatGPT / Codex plan");
    expect(guidance).toContain("shell");
    expect(guidance).toContain("haruyuki connect <provider>");
    expect(guidance).not.toContain("/connect ");
  });
});
