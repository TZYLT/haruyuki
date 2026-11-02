/**
 * The plain-text messages every post-mount startup failure prints (T-07, R-07.2).
 *
 * `src/index.ts` is a pinned file whose startup wiring may grow only for the
 * connection itself. The wording of a failure — what happened, then what to run
 * next — is behaviour, so it lives here, and the entry point reads as one line
 * per failure:
 *
 *     failTuiStartup(missingConversationMessage(specifiedConversationId));
 *
 * The messages deliberately keep the text the old inline `console.error` calls
 * used: this change moves where they are printed (after unmount, to stderr, then
 * a nonzero exit), not what the user is told.
 */

import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { failTuiStartup } from "./fail-tui-startup";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `checkAndStart` rejected before it reached one of its own failure paths. */
export function agentResolutionFailure(error: unknown): string {
  return `Failed to resolve a startup agent: ${formatErrorDetails(error)}`;
}

/** The async startup resolver itself: catch once, report through the seam. */
export function failAgentResolution(error: unknown): never {
  failTuiStartup(agentResolutionFailure(error));
}

export function missingConversationMessage(conversationId: string): string {
  return `Conversation ${conversationId} not found`;
}

export function noRecentSessionMessage(): string {
  return "No recent session in .haruyuki/ or ~/.haruyuki.\nRun 'haruyuki' to get started.";
}

export function defaultAgentCreateFailure(error: unknown): string {
  return `Failed to create default agent: ${errorText(error)}`;
}

export function missingAgentMessage(agentId: string, error: unknown): string {
  return [
    `Agent ${agentId} not found (error: ${JSON.stringify(error)})`,
    "When using --agent, the specified agent ID must exist.",
    "Run 'haruyuki' without --agent to create an agent.",
  ].join("\n");
}

export function noAgentMessage(): string {
  return "No agent found. Use --new-agent to create a new agent.";
}

export function invalidModelMessage(model: string): string {
  return `Error: Invalid model "${model}"`;
}

export function startupErrorMessage(error: unknown): string {
  return errorText(error);
}

export function initializationFailureMessage(
  error: unknown,
  debug: boolean,
): string {
  return `Error during initialization: ${formatErrorDetails(error)}${
    debug ? `\n${String(error)}` : ""
  }`;
}
