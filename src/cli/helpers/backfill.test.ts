import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { splitSystemReminderBlocks } from "@/cli/components/UserMessageRich";
import { createBuffers } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import { formatRecallBlockForDisplay } from "@/reminders/recall-display";
import type { RecallDecision, RecallEntry } from "@/reminders/recall-port";
import {
  formatRecallReminder,
  isRecallReminderText,
} from "@/reminders/recall-reminder";

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

/**
 * The fixture above is deliberately tiny, and an injection shorter than the clip
 * cannot show what the clip does to one. A real injection is ~1.4k characters —
 * three passages plus their headers — which is longer than
 * `CLIP_CHAR_LIMIT_TEXT`. Truncating it cuts the closing `</system-reminder>` off,
 * and `splitSystemReminderBlocks` then classifies the whole remainder as user
 * prose (`closeIdx === -1`), so `UserMessage`'s recall branch never runs and no
 * `↩ recalled` line is ever rendered at any tier.
 */
function longRecallBlock(): string {
  const entries: RecallEntry[] = [1, 2, 3].map((n) => ({
    source: "transcript" as const,
    fingerprint: `transcript:conv-${n}:m${n}`,
    file: `conv-${n}`,
    conversationKey: `conv-${n}`,
    messageId: `m${n}`,
    timestamp: "2026-10-11T09:00:00.000Z",
    text: "a passage of recalled text long enough to overflow the clip ".repeat(
      10,
    ),
    score: 5 - n,
  }));
  const block = formatRecallReminder({
    entries,
    status: "injected",
    diagnostics: { threshold: 1, candidates: 3, sources: [] },
  });
  if (block === null) throw new Error("the writer produced nothing");
  return block;
}

describe("a recall block longer than the display clip", () => {
  test("the fixture really is longer than the clip", () => {
    expect(longRecallBlock().length).toBeGreaterThan(500);
  });

  test("keeps its closing tag, so the renderer still sees a reminder", () => {
    const text = backfilledUserText(
      `${longRecallBlock()}\n\nthe user's question`,
    );
    expect(text).toContain("</system-reminder>");
    const blocks = splitSystemReminderBlocks(text ?? "");
    const recall = blocks.filter((block) => isRecallReminderText(block.text));
    expect(recall).toHaveLength(1);
    expect(recall[0]?.isSystemReminder).toBe(true);
  });

  test("renders the summary line the default tier promises", () => {
    const text = backfilledUserText(
      `${longRecallBlock()}\n\nthe user's question`,
    );
    const recall = splitSystemReminderBlocks(text ?? "").find((block) =>
      isRecallReminderText(block.text),
    );
    if (recall === undefined) {
      throw new Error("the recall block did not survive backfill");
    }
    const shown = formatRecallBlockForDisplay({
      text: recall.text,
      display: "summary",
      expanded: false,
    });
    expect(shown).toContain("↩ recalled 3 passages");
  });
});
