/**
 * `DreamDone` (F-06 R-5.4.3, route §2.3 M3).
 *
 * The tool is the run's explicit "finishing" signal: it records the handoff on
 * the run record and tells the model to stop. It must not commit memory and must
 * not touch the run's terminal status — the controller owns that. These cases
 * pin the recorded shape and the refusals.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { setConversationId } from "@/agent/context";
import { runOutsideRuntimeContext } from "@/runtime-context";
import {
  DREAM_DONE_MAX_HANDOFF_CHARS,
  dream_done,
} from "@/tools/impl/dream-done";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

afterEach(() => {
  setConversationId(null);
});

function metadata(overrides: Partial<DreamRunMetadata> = {}): DreamRunMetadata {
  return {
    runId: "run-42",
    triggerSource: "scheduled",
    agentId: "agent-1",
    conversationId: "conv-dream-1",
    tierPlan: ["tidy", "think"],
    tierReached: "tidy",
    startedAt: Date.UTC(2026, 9, 30, 20, 0),
    endedAt: null,
    baselineSha: "base-sha",
    budgetTokens: 80_000,
    spentTokens: 41_000,
    timeLimitMinutes: null,
    status: "running",
    reportPath: null,
    handoff: null,
    ...overrides,
  };
}

function recorder() {
  const captured: Array<{
    conversationId: string;
    metadata: DreamRunMetadata;
  }> = [];
  return {
    captured,
    writeMetadata: async (input: {
      conversationId: string;
      metadata: DreamRunMetadata;
    }) => {
      captured.push(input);
    },
  };
}

function call(
  args: Parameters<typeof dream_done>[0],
  options: {
    record?: unknown;
    writes?: ReturnType<typeof recorder>;
    failRetrieve?: boolean;
    conversationId?: string;
  } = {},
) {
  const recorded = options.writes ?? recorder();
  return dream_done(args, {
    backend: {
      retrieveConversation: async () => {
        if (options.failRetrieve) throw new Error("not found");
        return options.record ?? { dream: metadata() };
      },
    },
    conversationId: options.conversationId ?? "conv-dream-1",
    writeMetadata: recorded.writeMetadata,
  });
}

describe("dream_done", () => {
  test("writes the handoff and leaves every other run field intact", async () => {
    const writes = recorder();
    const result = await call(
      { handoff: "  finish the acme notes  ", status: "handoff" },
      { writes },
    );
    expect(result.status).toBe("success");
    expect(writes.captured).toHaveLength(1);
    expect(writes.captured[0]?.conversationId).toBe("conv-dream-1");
    expect(writes.captured[0]?.metadata.handoff).toBe("finish the acme notes");
    expect(writes.captured[0]?.metadata.runId).toBe("run-42");
    expect(writes.captured[0]?.metadata.status).toBe("running");
    expect(writes.captured[0]?.metadata.spentTokens).toBe(41_000);
    expect(result.content).toContain("handoff recorded");
    expect(result.content).toContain("status: handoff");
    expect(result.content).toContain("Stop calling tools");
    expect(result.content).toContain("MemoryCommit");
  });

  test("defaults to done", async () => {
    const writes = recorder();
    const result = await call({ handoff: "nothing left" }, { writes });
    expect(result.content).toContain("status: done");
    expect(writes.captured[0]?.metadata.handoff).toBe("nothing left");
  });

  test("is idempotent: a second call overwrites the same field", async () => {
    const writes = recorder();
    await call({ handoff: "first" }, { writes });
    await call({ handoff: "second" }, { writes });
    expect(writes.captured).toHaveLength(2);
    expect(writes.captured[1]?.metadata.handoff).toBe("second");
  });

  test("refuses a missing, empty or oversized handoff", async () => {
    expect((await call({})).status).toBe("error");
    expect((await call({ handoff: 42 })).status).toBe("error");
    expect((await call({ handoff: "   " })).status).toBe("error");
    expect(
      (await call({ handoff: "x".repeat(DREAM_DONE_MAX_HANDOFF_CHARS + 1) }))
        .status,
    ).toBe("error");
  });

  test("refuses an unknown status word", async () => {
    const result = await call({ handoff: "ok", status: "succeeded" });
    expect(result.status).toBe("error");
    expect(result.content).toContain('"done" or "handoff"');
  });

  test("refuses a conversation without a run record", async () => {
    const result = await call({ handoff: "ok" }, { record: { hidden: true } });
    expect(result.status).toBe("error");
    expect(result.content).toContain("not a dream run");
  });

  test("reports an unknown conversation", async () => {
    const result = await call({ handoff: "ok" }, { failRetrieve: true });
    expect(result.status).toBe("error");
    expect(result.content).toContain("was not found");
  });

  test("refuses without a conversation context", async () => {
    setConversationId(null);
    const result = await runOutsideRuntimeContext(() =>
      dream_done({ handoff: "ok" }),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("no conversation");
  });
});
