/**
 * The exit summary — the block a session prints on the way out — in the two
 * forms the two shells need it.
 *
 * The append shell draws it in the Ink frame, which stays readable in the primary
 * buffer. The full-screen shell draws into the alternate screen, whose content
 * Ink discards at teardown (`ink.js:542-552`, "disposable by design"), so its
 * summary has to be written to the primary buffer *after* Ink has left that
 * screen. Both forms come from `exitSummaryLines`, so the text has one owner.
 *
 * A shell whose frame does not survive teardown *registers* the summary here; the
 * conversation core only asks for whatever was registered and hands it to Ink's
 * `exit()`, which is what keeps the mode decision in the shell layer.
 */

import { useApp } from "ink";
import { useCallback } from "react";
import type { SessionStatsSnapshot } from "@/agent/stats";
import { formatDuration } from "@/cli/components/SessionStats";
import { formatCompact } from "@/cli/helpers/format";
import { settingsManager } from "@/settings-manager";

export interface ExitSummaryInput {
  stats: SessionStatsSnapshot;
  agentName: string | null;
  agentId: string;
  conversationId: string;
}

/**
 * One summary row. `id` is the row's identity for React keys: the list is
 * static, and an index key would tie the renderer to the list's order.
 */
export interface ExitSummaryLine {
  readonly id: string;
  readonly kind: "stat" | "blank" | "label" | "command";
  /** Empty for a `blank` row. */
  readonly text: string;
}

export function exitSummaryLines(input: ExitSummaryInput): ExitSummaryLine[] {
  const { stats, agentName, agentId, conversationId } = input;
  const isPinned = agentName && settingsManager.isAgentPinned(agentId);

  const lines: ExitSummaryLine[] = [
    {
      id: "duration-api",
      kind: "stat",
      text: `Total duration (API): ${formatDuration(stats.totalApiMs)}`,
    },
    {
      id: "duration-wall",
      kind: "stat",
      text: `Total duration (wall): ${formatDuration(stats.totalWallMs)}`,
    },
    {
      id: "usage",
      kind: "stat",
      text: `Session usage: ${stats.usage.stepCount} steps, ${formatCompact(stats.usage.promptTokens)} input, ${formatCompact(stats.usage.completionTokens)} output`,
    },
    { id: "gap-agent", kind: "blank", text: "" },
    {
      id: "resume-agent-label",
      kind: "label",
      text: "Resume this agent with:",
    },
    {
      id: "resume-agent",
      kind: "command",
      text: isPinned
        ? `haruyuki -n "${agentName}"`
        : `haruyuki --agent ${agentId}`,
    },
  ];

  // Only show the conversation hint if not on default (default is resumed
  // automatically).
  if (conversationId !== "default" && conversationId !== agentId) {
    lines.push(
      { id: "gap-conversation", kind: "blank", text: "" },
      {
        id: "resume-conversation-label",
        kind: "label",
        text: "Resume this conversation with:",
      },
      {
        id: "resume-conversation",
        kind: "command",
        text: `haruyuki --conv ${conversationId}`,
      },
    );
  }

  return lines;
}

/** The same summary as plain text, for a terminal Ink has already left. */
export function exitSummaryText(input: ExitSummaryInput): string {
  return exitSummaryLines(input)
    .map((line) => line.text)
    .join("\n");
}

/** Payload the core hands to Ink's `exit()`. */
export interface ExitSummaryResult {
  readonly exitSummary: string;
}

type ExitSummaryProducer = () => string;

let producer: ExitSummaryProducer | null = null;

/**
 * Registers the summary this shell wants printed once Ink has left the screen it
 * drew into. Returns the unregister function. A shell whose frame survives
 * teardown (the append shell) never registers, and then there is nothing to
 * print.
 */
export function registerExitSummary(next: ExitSummaryProducer): () => void {
  producer = next;
  return () => {
    if (producer === next) {
      producer = null;
    }
  };
}

/** Test seam: forget the registered summary. */
export function resetExitSummaryRegistration(): void {
  producer = null;
}

/** The registered summary, or `undefined` when nothing needs printing. */
export function registeredExitSummary(): ExitSummaryResult | undefined {
  const text = producer?.();
  return text ? { exitSummary: text } : undefined;
}

export function isExitSummaryResult(
  value: unknown,
): value is ExitSummaryResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { exitSummary?: unknown }).exitSummary === "string"
  );
}

/** What to write once Ink is done, or `null` when there is nothing to write. */
export function pendingExitSummaryText(result: unknown): string | null {
  return isExitSummaryResult(result) ? `\n${result.exitSummary}\n` : null;
}

/** Where the two process-level calls go; a seam tests can redirect. */
export interface ExitSummaryIo {
  exit: (code: number) => void;
  write: (text: string) => void;
}

const defaultIo: ExitSummaryIo = {
  exit: (code: number) => {
    process.exit(code);
  },
  write: (text: string) => {
    process.stdout.write(text);
  },
};

let io: ExitSummaryIo = defaultIo;

/** Test seam: redirect the process-level calls. Pass `null` to restore. */
export function setExitSummaryIo(next: ExitSummaryIo | null): void {
  io = next ?? defaultIo;
}

/**
 * Ink's own `exit`, carrying whatever summary a shell registered, then the
 * process exit.
 *
 * The core calls this instead of `process.exit`, and it exists because of *when*
 * the summary can be written: Ink's unmount is synchronous (`ink.js:491-607`) and
 * writes the alternate-screen exit sequence before it returns, so the macrotask
 * below runs on the restored primary buffer. Writing from a React cleanup, or
 * from the `exit` call itself, lands on the screen Ink is about to discard. Runs
 * that register nothing (no TTY, or a shell that keeps its frame) write nothing.
 */
export function useExitAfterSummary(): () => void {
  const { exit } = useApp();

  return useCallback(() => {
    const result = registeredExitSummary();
    exit(result);

    setTimeout(() => {
      const text = pendingExitSummaryText(result);
      if (text) {
        io.write(text);
      }
      io.exit(0);
    }, 0);
  }, [exit]);
}
