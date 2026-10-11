import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import type { RecallDecision, RecallEntry } from "@/reminders/recall-port";
import { formatRecallReminder } from "@/reminders/recall-reminder";

/**
 * History is re-read from the store, and every reminder block is stripped from the
 * user bubble except one: feature ②'s, whose marker line is what the display layer
 * turns into a summary (《26》§6.7). Stripping it would leave a restart with no
 * trace of what the previous turns recalled — the summary would vanish exactly
 * when the user comes back to look at it.
 */

function recallBlock(): string {
  const entries: RecallEntry[] = [
    {
      source: "transcript",
      fingerprint: "transcript:conv-a:m1",
      file: "conv-a",
      conversationKey: "conv-a",
      messageId: "m1",
      timestamp: "2026-10-11T09:00:00.000Z",
      text: "the ledger is reconciled daily",
      score: 4,
    },
  ];
  const decision: RecallDecision = {
    entries,
    status: "injected",
    diagnostics: { threshold: 1, candidates: 1, sources: [] },
  };
  const block = formatRecallReminder(decision);
  if (block === null) throw new Error("the writer produced nothing");
  return block;
}

function userMessage(id: string, text: string): Message {
  return {
    id,
    message_type: "user_message",
    content: [{ type: "text", text }],
  } as unknown as Message;
}

/** The rendered user line for a backfilled history. */
function backfilledUserText(text: string): string | undefined {
  const buffers = createBuffers();
  backfillBuffers(buffers, [userMessage("m1", text)]);
  for (const line of buffers.byId.values()) {
    if (line.kind === "user") return line.text;
  }
  return undefined;
}

describe("backfilling a user message", () => {
  test("keeps the recall block so the summary can be rebuilt", () => {
    const block = recallBlock();
    const text = backfilledUserText(`${block}\n\nthe user's question`);
    expect(text).toContain("<recall-injected");
    expect(text).toContain("the ledger is reconciled daily");
    // The user's own words are still there, and still after the block.
    expect(text).toContain("the user's question");
    expect(text?.indexOf("recall-injected")).toBeLessThan(
      text?.indexOf("the user's question") ?? -1,
    );
  });

  test("still strips every other reminder", () => {
    const text = backfilledUserText(
      "<system-reminder>\nDisk space is low\n</system-reminder>\n\nthe user's question",
    );
    expect(text).toBe("the user's question");
  });

  test("strips a non-recall block that sits next to a recall one", () => {
    const text = backfilledUserText(
      `${recallBlock()}\n\n<system-reminder>\nSession context\n</system-reminder>\n\nthe user's question`,
    );
    expect(text).toContain("recall-injected");
    expect(text).not.toContain("Session context");
    expect(text).toContain("the user's question");
  });
});
