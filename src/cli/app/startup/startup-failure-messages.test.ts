import { describe, expect, test } from "bun:test";
import {
  defaultAgentCreateFailure,
  initializationFailureMessage,
  invalidModelMessage,
  missingAgentMessage,
  missingConversationMessage,
  noAgentMessage,
  noRecentSessionMessage,
  startupErrorMessage,
} from "./startup-failure-messages";

/**
 * The post-mount failure wording (T-07, R-07.2).
 *
 * The entry point now only wires the seam; these are the sentences it prints,
 * pinned so the move from inline `console.error` calls did not change what the
 * user is told. Plain text only — no ANSI, no stack prefix.
 */

describe("startup failure messages", () => {
  test("each failure keeps the wording the inline path used", () => {
    expect(missingConversationMessage("conv-1")).toBe(
      "Conversation conv-1 not found",
    );
    expect(noRecentSessionMessage()).toContain("No recent session");
    expect(noRecentSessionMessage()).toContain(
      "Run 'haruyuki' to get started.",
    );
    expect(noAgentMessage()).toBe(
      "No agent found. Use --new-agent to create a new agent.",
    );
    expect(invalidModelMessage("nope")).toBe('Error: Invalid model "nope"');
  });

  test("errors are rendered as one readable line, never a stack", () => {
    expect(defaultAgentCreateFailure(new Error("catalog empty"))).toBe(
      "Failed to create default agent: catalog empty",
    );
    expect(startupErrorMessage(new Error("memfs failed"))).toBe("memfs failed");
    expect(startupErrorMessage("plain")).toBe("plain");
  });

  test("a missing --agent keeps the three-line guidance block", () => {
    const message = missingAgentMessage("agent-1", new Error("404"));
    const lines = message.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Agent agent-1 not found");
    expect(lines[1]).toContain("specified agent ID must exist");
    expect(lines[2]).toContain("without --agent");
  });

  test("initialization failures hide the stack unless debug is on", () => {
    const error = new Error("boom");
    const quiet = initializationFailureMessage(error, false);
    expect(quiet).toContain("Error during initialization");
    expect(quiet).not.toContain("Error: boom");
    const debug = initializationFailureMessage(error, true);
    expect(debug).toContain("Error: boom");
  });
});
