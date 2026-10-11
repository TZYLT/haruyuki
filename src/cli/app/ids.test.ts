import { describe, expect, test } from "bun:test";
import { appendOptimisticUserLine, appendRecallLine } from "@/cli/app/ids";
import { createBuffers } from "@/cli/helpers/accumulator";
import type { RecallEntry } from "@/reminders/recall-port";
import { formatRecallReminder } from "@/reminders/recall-reminder";

/**
 * The live turn's recall row.
 *
 * A turn's injection exists only after `buildSharedReminderParts` runs, which is
 * after the optimistic user row has been appended — and `<Static>` never
 * re-renders a row it has printed, so the block cannot be folded into that row.
 * It gets a row of its own instead, and this is where that row is created.
 */

/** A real injection: three passages, ~1.4k characters. */
function recallBlock(passageLength = 40): string {
  const entries: RecallEntry[] = [1, 2, 3].map((n) => ({
    source: "memory" as const,
    fingerprint: `memory:notes.md:${n}`,
    file: "notes.md",
    startLine: n,
    endLine: n + 2,
    text: "x".repeat(passageLength),
    score: 4 - n,
  }));
  const block = formatRecallReminder({
    entries,
    status: "injected",
    diagnostics: { threshold: 1, candidates: 3, sources: [] },
  });
  if (block === null) throw new Error("the writer produced nothing");
  return block;
}

describe("appendRecallLine", () => {
  test("appends the injection under the turn's user row", () => {
    const buffers = createBuffers();
    appendOptimisticUserLine(buffers, "what did we decide?", "otid-1");
    const block = recallBlock();
    const id = appendRecallLine(buffers, [{ type: "text", text: block }]);

    expect(id).not.toBeNull();
    expect(buffers.order).toHaveLength(2);
    expect(buffers.order[1]).toBe(id ?? "");
    expect(buffers.byId.get(id ?? "")).toMatchObject({
      kind: "recall",
      text: block,
    });
  });

  test("adds nothing when no reminder carries an injection", () => {
    const buffers = createBuffers();
    appendOptimisticUserLine(buffers, "hello", "otid-2");

    expect(appendRecallLine(buffers, [])).toBeNull();
    expect(
      appendRecallLine(buffers, [
        {
          type: "text",
          text: "<system-reminder>\nDisk space is low\n</system-reminder>",
        },
      ]),
    ).toBeNull();
    expect(buffers.order).toHaveLength(1);
  });

  test("finds the block among the turn's other reminders", () => {
    const buffers = createBuffers();
    const block = recallBlock();
    const id = appendRecallLine(buffers, [
      {
        type: "text",
        text: "<system-reminder>\nAgent info\n</system-reminder>",
      },
      { type: "text", text: block },
    ]);

    expect(buffers.byId.get(id ?? "")).toMatchObject({ text: block });
  });

  test("keeps a block longer than the display clip whole", () => {
    const buffers = createBuffers();
    const block = recallBlock(400);
    expect(block.length).toBeGreaterThan(500);

    const id = appendRecallLine(buffers, [{ type: "text", text: block }]);
    // The row stores the block verbatim; the tier decides at render time how much
    // of it to show, and `full` has to be able to show all of it.
    expect(buffers.byId.get(id ?? "")).toMatchObject({ text: block });
  });
});
