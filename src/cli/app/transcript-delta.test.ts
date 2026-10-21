import { describe, expect, test } from "bun:test";
import type { Line } from "@/cli/helpers/accumulator";
import { type Buffers, createBuffers } from "@/cli/helpers/accumulator";
import { appendTurnTranscriptDelta } from "./transcript-delta";

function buffersWith(ids: string[]): Buffers {
  const buffers = createBuffers();
  for (const id of ids) {
    const line = { kind: "status", id, lines: [id] } as Line;
    buffers.byId.set(id, line);
    buffers.order.push(id);
  }
  return buffers;
}

describe("appendTurnTranscriptDelta", () => {
  test("writes only the lines added during the turn", async () => {
    const calls: { agentId: string; conversationId: string; ids: string[] }[] =
      [];
    await appendTurnTranscriptDelta({
      buffers: buffersWith(["before", "a", "b"]),
      agentId: "agent-1",
      conversationId: "conv-1",
      // Index 0 is the line that predates the turn.
      startLineIndex: 1,
      write: async (agentId, conversationId, lines) => {
        calls.push({
          agentId,
          conversationId,
          ids: lines.map((line) => line.id),
        });
        return lines.length;
      },
    });
    expect(calls).toEqual([
      { agentId: "agent-1", conversationId: "conv-1", ids: ["a", "b"] },
    ]);
  });

  test("does nothing when the turn captured no start index", async () => {
    let called = false;
    await appendTurnTranscriptDelta({
      buffers: buffersWith(["a"]),
      agentId: "agent-1",
      conversationId: "conv-1",
      startLineIndex: null,
      write: async () => {
        called = true;
        return 0;
      },
    });
    expect(called).toBe(false);
  });

  test("swallows a writer failure", async () => {
    await expect(
      appendTurnTranscriptDelta({
        buffers: buffersWith(["a"]),
        agentId: "agent-1",
        conversationId: "conv-1",
        startLineIndex: 0,
        write: async () => {
          throw new Error("disk full");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
