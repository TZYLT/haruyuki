/**
 * `prepare → pick → apply` for the paths without a picker (F-04), tested without
 * a backend: the subject here is this module's ordering, its receipt copy, and
 * the facts it hands the caller's ledger.
 *
 * The "writes the ledger" half deliberately has no test here — this module does
 * not write one. The callers that do (headless, the listener) pin their own rows
 * in their own suites.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCompactionTopicReport,
  compactionUsageFactsFromFailure,
  formatCompactionDegradedNote,
  formatCompactNoopReason,
  formatCompactPlanningFailure,
  formatLocalCompactionReceipt,
  type LocalCompactionBackend,
  resolveCompactionPick,
  runLocalCompaction,
} from "@/agent/compaction-execute";
import type {
  CompactionPreview,
  CompactPick,
  CompactUsage,
} from "@/backend/local/compaction-preview";
import { renderCompactionOverview } from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import { CompactionCancelledError } from "@/backend/local/compaction-summarizer";
import { withCompactUsage } from "@/backend/local/compaction-usage-error";
import type { LocalTopicList } from "@/backend/local/local-topic-trim";
import type { TopicBlock } from "@/backend/local/topic-compaction";

function blocksFixture(): TopicBlock[] {
  return [
    {
      index: 1,
      title: "one",
      markerId: null,
      createdBy: "summarizer",
      summary: "section one",
      anchorMessageId: null,
      absorbedTitles: [],
      boundaryMessageId: "m1",
      startIndex: 0,
      endIndex: 2,
      rewindTurns: 0,
      startMarkerAnchorMessageId: null,
      messageCount: 2,
      tokens: 40,
      startsAt: "2026-01-01T00:00:00.000Z",
      sparse: false,
    },
    {
      index: 2,
      title: "two",
      markerId: null,
      createdBy: "summarizer",
      summary: "section two",
      anchorMessageId: null,
      absorbedTitles: [],
      boundaryMessageId: "m2",
      startIndex: 2,
      endIndex: 3,
      rewindTurns: 0,
      startMarkerAnchorMessageId: null,
      messageCount: 1,
      tokens: 20,
      startsAt: "2026-01-01T00:00:00.000Z",
      sparse: true,
    },
  ];
}

function previewFixture(
  overrides: Partial<CompactionPreview> = {},
): CompactionPreview {
  return {
    conversationId: "conv-1",
    agentId: "agent-1",
    model: "openai/gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: [{ title: "one", startMessageId: "m1", section: "section one" }],
    overview: {
      restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
      narrative: "They talked it through.",
    },
    blocks: blocksFixture(),
    numberedBlocks: 1,
    suggestionIndex: 2,
    usage: {
      promptTokens: 120,
      cachedInputTokens: 80,
      completionTokens: 30,
      wallMs: 1_500,
    },
    degraded: null,
    ...overrides,
  };
}

function applyResultFixture(
  overrides: Partial<CompactionApplyResult> = {},
): CompactionApplyResult {
  return {
    executed: true,
    source: "topic_pick",
    topicTitle: "two",
    foldedTopicIds: ["marker-1"],
    foldedTitles: ["one"],
    numMessagesBefore: 6,
    numMessagesAfter: 3,
    summarizedMessageCount: 3,
    summarizedTokens: 600,
    retainedTokens: 200,
    retentionCapTokens: 400,
    stats: {},
    ...overrides,
  };
}

interface ScriptedCompaction {
  backend: LocalCompactionBackend;
  /** Every pick `apply` was handed, in order. */
  seenPicks: CompactPick[];
  /** How many times `prepare` was called. */
  prepares: () => number;
}

/**
 * The three backend calls, scripted. No store, no provider: a run's ordering is
 * this module's subject, and a real backend would only add noise.
 */
function scriptedCompaction(
  options: {
    preview?: CompactionPreview;
    /** Thrown by `prepare`; a `CompactionCancelledError` ends the run as cancelled. */
    prepareError?: unknown;
    apply?: (input: {
      preview: CompactionPreview;
      pick: CompactPick;
    }) => CompactionApplyResult;
  } = {},
): ScriptedCompaction {
  const seenPicks: CompactPick[] = [];
  let prepares = 0;
  const list: LocalTopicList = {
    blocks: blocksFixture(),
    markers: [],
    contextMessageCount: 6,
    contextTokens: 600,
    retentionCapTokens: 400,
    suggestedBlockIndex: 1,
  };
  return {
    backend: {
      listTopics: () => list,
      prepareCompaction: async () => {
        prepares += 1;
        if (options.prepareError !== undefined) throw options.prepareError;
        return options.preview ?? previewFixture();
      },
      applyCompaction: async (input) => {
        seenPicks.push(input.pick);
        return options.apply?.(input) ?? applyResultFixture();
      },
    },
    seenPicks,
    prepares: () => prepares,
  };
}

describe("resolveCompactionPick", () => {
  test("no number means the rate's default selection", () => {
    expect(resolveCompactionPick(blocksFixture(), undefined)).toEqual({
      kind: "ratio_suggestion",
    });
  });

  test("a block number becomes that block's boundary message id", () => {
    // 1-based: block 2 is the second row, never `blocks[2]`.
    expect(resolveCompactionPick(blocksFixture(), 2)).toEqual({
      kind: "message",
      messageId: "m2",
    });
  });

  test("an out-of-range number is refused by name, with the table size", () => {
    expect(() => resolveCompactionPick(blocksFixture(), 9)).toThrow(
      "There is no topic block 9: this context has 2 blocks",
    );
    expect(() => resolveCompactionPick(blocksFixture(), 9)).toThrow(
      "compress by the rate",
    );
  });
});

describe("runLocalCompaction", () => {
  test("a completed run reports the preview, the result, and its spend", async () => {
    const scripted = scriptedCompaction();

    const outcome = await runLocalCompaction({
      backend: scripted.backend,
      conversationId: "conv-1",
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    expect(outcome.preview.agentId).toBe("agent-1");
    expect(outcome.result.executed).toBe(true);
    expect(outcome.receipt).toContain("Compaction complete.");
    expect(outcome.report.suggestion_index).toBe(2);
    // The ledger facts: numbers and ids, no ledger write.
    expect(outcome.agentId).toBe("agent-1");
    expect(outcome.model).toBe("openai/gpt-5.5");
    expect(outcome.usage).toEqual({
      promptTokens: 120,
      cachedInputTokens: 80,
      completionTokens: 30,
      wallMs: 1_500,
    });
    expect(scripted.seenPicks).toEqual([{ kind: "ratio_suggestion" }]);
  });

  test("a numbered run locks the message id before the summarizer runs", async () => {
    const scripted = scriptedCompaction();

    const outcome = await runLocalCompaction({
      backend: scripted.backend,
      conversationId: "conv-1",
      blockIndex: 2,
    });

    expect(outcome.kind).toBe("completed");
    expect(scripted.seenPicks).toEqual([{ kind: "message", messageId: "m2" }]);
  });

  test("an out-of-range number refuses before paying for a summarizer call", async () => {
    const scripted = scriptedCompaction();

    await expect(
      runLocalCompaction({
        backend: scripted.backend,
        conversationId: "conv-1",
        blockIndex: 9,
      }),
    ).rejects.toThrow("There is no topic block 9");
    expect(scripted.prepares()).toBe(0);
  });

  test("a cancelled run reports the spend it carried on the error (§5.14)", async () => {
    const spend: CompactUsage = {
      promptTokens: 1_200,
      cachedInputTokens: 900,
      completionTokens: 0,
      wallMs: 4_000,
    };
    const scripted = scriptedCompaction({
      prepareError: withCompactUsage(new CompactionCancelledError(), spend),
    });

    const outcome = await runLocalCompaction({
      backend: scripted.backend,
      conversationId: "conv-1",
      agentId: "agent-1",
    });

    expect(outcome).toEqual({
      kind: "cancelled",
      receipt: "Cancelled: the context is unchanged.",
      agentId: "agent-1",
      model: "",
      usage: spend,
    });
  });

  test("a failure rethrows unchanged, and its spend can still be read", async () => {
    const failure = withCompactUsage(new Error("provider refused"), {
      promptTokens: 1_200,
      cachedInputTokens: 0,
      completionTokens: 0,
      wallMs: 4_000,
    });
    const scripted = scriptedCompaction({ prepareError: failure });

    await expect(
      runLocalCompaction({
        backend: scripted.backend,
        conversationId: "conv-1",
      }),
    ).rejects.toThrow("provider refused");

    // `compactionUsageFactsFromFailure` reads the same error the caller catches,
    // so the row and the reported failure describe one run.
    expect(compactionUsageFactsFromFailure(failure, "agent-1")).toEqual({
      agentId: "agent-1",
      model: "",
      usage: {
        promptTokens: 1_200,
        cachedInputTokens: 0,
        completionTokens: 0,
        wallMs: 4_000,
      },
    });
  });

  test("an error with no spend reports zeroes rather than guessing", () => {
    expect(
      compactionUsageFactsFromFailure(new Error("boom"), "agent-1"),
    ).toEqual({
      agentId: "agent-1",
      model: "",
      usage: null,
    });
  });

  test("a failure nobody can attribute names no agent, so no row is written", () => {
    expect(
      compactionUsageFactsFromFailure(new Error("boom"), undefined),
    ).toEqual({ agentId: null, model: "", usage: null });
  });
});

describe("receipt and report copy", () => {
  test("buildCompactionTopicReport carries the overview, the table, and the write-back", () => {
    const report = buildCompactionTopicReport(
      previewFixture(),
      applyResultFixture(),
    );

    expect(report.overview).toBe(
      renderCompactionOverview(previewFixture().overview),
    );
    expect(report.overview).toContain("They talked it through.");
    expect(report.blocks.map((block) => block.boundary_message_id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(report.blocks[0]?.summary).toBe("section one");
    expect(report.suggestion_index).toBe(2);
    expect(report.numbered_blocks).toBe(1);
    expect(report.degraded).toBe(false);
    expect(report.degraded_kind).toBeNull();
    expect(report.usage).toEqual({
      prompt_tokens: 120,
      cached_input_tokens: 80,
      completion_tokens: 30,
      wall_ms: 1500,
    });
    expect(report.applied).toEqual({
      executed: true,
      kept_topic: "two",
      folded_topics: ["one"],
      messages_before: 6,
      messages_after: 3,
    });
  });

  test("a no-op receipt states the structured reason in prose", () => {
    const receipt = formatLocalCompactionReceipt(
      previewFixture(),
      applyResultFixture({
        executed: false,
        noopReason: "stale_preview",
        numMessagesBefore: 4,
        retainedTokens: 80,
      }),
    );

    expect(receipt).toContain("Nothing was written");
    expect(receipt).toContain("dropped whole");
    expect(receipt).not.toContain("stale_preview");
  });

  test("a degraded run says which of the two causes it was", () => {
    const refusal = formatLocalCompactionReceipt(
      previewFixture({ degraded: "refusal" }),
      applyResultFixture(),
    );
    const format = formatLocalCompactionReceipt(
      previewFixture({ degraded: "format" }),
      applyResultFixture(),
    );

    expect(refusal).toContain("refused or was unavailable");
    expect(format).toContain("unusable twice");
    expect(formatCompactionDegradedNote(null)).toBeNull();
  });

  test("formatCompactNoopReason names every structured reason", () => {
    const reasons = [
      undefined,
      "empty_context",
      "nothing_before_boundary",
      "unknown_block",
      "stale_preview",
      "no_suggestion",
    ] as const;
    for (const reason of reasons) {
      const text = formatCompactNoopReason(reason);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("_");
    }
  });
});

describe("formatCompactPlanningFailure", () => {
  test("translates the planner's 'too little context' errors", () => {
    expect(
      formatCompactPlanningFailure(
        new Error("Not enough messages for sliding window compaction."),
      ),
    ).toContain("too short to summarize");
    expect(
      formatCompactPlanningFailure(
        new Error("No assistant message found for sliding window compaction."),
      ),
    ).toContain("too short to summarize");
    expect(
      formatCompactPlanningFailure(
        new Error(
          "Assistant message index 3 is at the end of the message buffer, skipping compaction.",
        ),
      ),
    ).toContain("newest messages are already the whole context");
  });

  test("passes an unrelated failure through unchanged", () => {
    expect(formatCompactPlanningFailure(new Error("provider exploded"))).toBe(
      "provider exploded",
    );
    expect(formatCompactPlanningFailure("plain string")).toBe("plain string");
  });
});
