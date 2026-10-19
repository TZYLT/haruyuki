// src/cli/app/startup-hints.ts

import type { Line } from "@/cli/helpers/accumulator";

/**
 * The startup screen's command hints, and the "is this transcript empty" test
 * that chooses between the first-run and the resumed sets.
 *
 * Pure text selection, moved out of `AppCoordinator` unchanged: the coordinator
 * is the file the size ratchet pins hardest, and a function that takes six
 * booleans and returns strings has no business living in the component that owns
 * the session.
 */

/**
 * The hints the welcome block lists, most useful first.
 *
 * Capped at five so the block stays a hint rather than a manual: the first-run
 * set adds the memory hints, and the resumed set points at browsing instead.
 */
export function buildStartupCommandHints(options: {
  isResumingConversation: boolean;
  isPinned: boolean;
  isLocalBackend: boolean;
  hasMessages: boolean;
  /**
   * Retained in the signature so the startup hint `useEffect` dependency lists
   * keep their shape; the hint that used it pointed at `/login`, which is gone.
   */
  hasCloudCredentials: boolean;
  hasAvailableLocalModels: boolean;
}): string[] {
  const {
    isResumingConversation,
    isPinned,
    isLocalBackend,
    hasMessages,
    hasCloudCredentials: _hasCloudCredentials,
    hasAvailableLocalModels,
  } = options;

  const baseHints = isResumingConversation
    ? [
        "→ **/agents**    list all agents",
        "→ **/resume**    browse all conversations",
        "→ **/new**       start a new conversation",
        "→ **/init**      initialize your agent's memory",
      ]
    : isPinned
      ? [
          "→ **/agents**    list all agents",
          "→ **/resume**    resume a previous conversation",
          "→ **/memory**    view your agent's memory",
          "→ **/init**      initialize your agent's memory",
        ]
      : [
          "→ **/agents**    list all agents",
          "→ **/resume**    resume a previous conversation",
          "→ **/pin**       save + name your agent",
          "→ **/init**      initialize your agent's memory",
        ];

  const onboardingHints: string[] = [];

  if (isLocalBackend && !hasAvailableLocalModels) {
    onboardingHints.push(
      "→ **/model**     switch models",
      "→ **/connect**   configure your llm api keys",
    );
  }

  if (!hasMessages) {
    onboardingHints.push(
      "→ **/rename**    name your agent",
      "→ **/init**      initialize your agent's memory",
    );
  }

  const dedupedHints: string[] = [];
  const seenHints = new Set<string>();

  for (const hint of [...onboardingHints, ...baseHints]) {
    if (seenHints.has(hint)) {
      continue;
    }
    seenHints.add(hint);
    dedupedHints.push(hint);
    if (dedupedHints.length === 5) {
      break;
    }
  }

  return dedupedHints;
}

/** Whether the transcript holds anything a user would read (not just chrome). */
export function hasConversationContent(lines: Line[]): boolean {
  return lines.some((line) => {
    switch (line.kind) {
      case "user":
      case "assistant":
      case "reasoning":
      case "tool_call":
      case "error":
      case "command":
      case "bash_command":
        return true;
      default:
        return false;
    }
  });
}
