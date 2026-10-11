import { describe, expect, test } from "bun:test";
import { runRecall } from "@/reminders/recall-service";
import {
  RECALL_FIXTURE_QUERY as QUERY,
  withRecallFixture,
} from "@/test-utils/recall-fixture";

/**
 * The M3 acceptance: on a fixture conversation, assert exactly what would be
 * injected and what would not. Every other part of the feature is unit-tested in
 * isolation; this is the one that goes through the real store, the real index
 * sidecar, and the real memory workspace.
 */

describe("runRecall", () => {
  test("injects history and memory, and never the current conversation's message", async () => {
    await withRecallFixture(async (fixture) => {
      const decision = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        options: { diversity: "none", limit: 5 },
      });

      expect(decision.status).toBe("injected");
      const sources = decision.entries.map((entry) => entry.source);
      expect(sources).toContain("transcript");
      expect(sources).toContain("memory");

      const transcript = decision.entries.filter(
        (entry) => entry.source === "transcript",
      );
      // `N`: the current conversation's own message is still in context, so it is
      // not recallable even though its sidecar is in the corpus.
      expect(
        transcript.every(
          (entry) => entry.conversationKey === fixture.historyDirectory,
        ),
      ).toBe(true);
      expect(transcript[0]?.text).toContain("每日对账");

      const memory = decision.entries.find(
        (entry) => entry.source === "memory",
      );
      expect(memory?.file).toBe("reference/notes.md");
      expect(memory?.text).toContain("每日对账");
    });
  });

  test("keeps every entry inside the character budget", async () => {
    await withRecallFixture(async (fixture) => {
      const decision = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        options: { excerptCharacters: 12, totalCharacters: 40, limit: 3 },
      });
      expect(decision.entries.length).toBeGreaterThan(0);
      for (const entry of decision.entries) {
        expect(entry.text.length).toBeLessThanOrEqual(12);
      }
      const total = decision.entries.reduce(
        (sum, entry) => sum + entry.text.length,
        0,
      );
      expect(total).toBeLessThanOrEqual(40);
    });
  });

  test("does not repeat what the window already covers", async () => {
    await withRecallFixture(async (fixture) => {
      const first = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        options: { limit: 5 },
      });
      expect(first.entries.length).toBeGreaterThan(0);

      const sameTurn = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        options: { limit: 5 },
      });
      expect(sameTurn.entries).toEqual([]);
      expect(sameTurn.status).toBe("suppressed");

      // Past K turns the window has aged out and the same hits come back.
      const later = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 12,
        options: { limit: 5, dedupTurns: 10 },
      });
      expect(later.status).toBe("injected");
      expect(later.entries.length).toBe(first.entries.length);
    });
  });

  test("a turn with no searchable terms injects nothing and writes nothing", async () => {
    await withRecallFixture(async (fixture) => {
      const decision = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: "!!!",
        currentTurn: 1,
      });
      expect(decision.status).toBe("no-match");
      expect(decision.entries).toEqual([]);
    });
  });

  test("memory can be switched off without losing the transcript source", async () => {
    await withRecallFixture(async (fixture) => {
      const decision = await runRecall({
        backend: fixture.backend,
        agentId: fixture.agentId,
        conversationId: fixture.currentConversationId,
        userText: QUERY,
        currentTurn: 1,
        memoryEnabled: false,
        options: { limit: 5 },
      });
      expect(decision.entries.length).toBeGreaterThan(0);
      expect(
        decision.entries.every((entry) => entry.source === "transcript"),
      ).toBe(true);
      expect(
        decision.diagnostics.sources.find(
          (diagnostic) => diagnostic.source === "memory",
        ),
      ).toBeUndefined();
    });
  });
});
