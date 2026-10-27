import { describe, expect, test } from "bun:test";
import type { LocalMessage } from "@/backend/local/local-message";
import {
  alignTrimBoundary,
  decideTopicNudge,
  evaluateTopicMarkerGate,
  isLocalUserTurnMessage,
  listTopicBlocks,
  normalizeTopicBoundaryRewindTurns,
  ratioSuggestionMessageId,
  resolveTrimPlan,
  type TopicBlock,
  userTurnsSinceLastTopicMarker,
} from "@/backend/local/topic-compaction";

/** Text of exactly `tokens * 4` characters, so the estimator returns `tokens`. */
function textForTokens(tokens: number): string {
  return "x".repeat(tokens * 4);
}

function userMessage(id: string, tokens = 1): LocalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: textForTokens(tokens) }],
    timestamp: 0,
  } as LocalMessage;
}

function assistantMessage(
  id: string,
  tokens = 1,
  options: { toolCall?: boolean } = {},
): LocalMessage {
  return {
    id,
    role: "assistant",
    content: options.toolCall
      ? [{ type: "toolCall", id: `call-${id}`, name: "Bash", arguments: {} }]
      : [{ type: "text", text: textForTokens(tokens) }],
    timestamp: 0,
  } as LocalMessage;
}

function toolResultMessage(id: string, tokens = 1): LocalMessage {
  return {
    id,
    role: "toolResult",
    toolCallId: `call-${id}`,
    toolName: "Bash",
    content: [{ type: "text", text: textForTokens(tokens) }],
    timestamp: 0,
  } as LocalMessage;
}

/**
 * `turns` user turns, two messages each: `u1, a1, u2, a2, …`. Turn `t` starts at
 * index `(t - 1) * 2`.
 */
function conversation(turns: number, tokensPerMessage = 1): LocalMessage[] {
  const messages: LocalMessage[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push(userMessage(`u${turn}`, tokensPerMessage));
    messages.push(assistantMessage(`a${turn}`, tokensPerMessage));
  }
  return messages;
}

function marker(id: string, title: string, anchorMessageId: string | null) {
  return {
    id,
    title,
    createdBy: "agent" as const,
    anchorMessageId,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("normalizeTopicBoundaryRewindTurns", () => {
  test("defaults, clamps, and floors the rewind", () => {
    expect(normalizeTopicBoundaryRewindTurns(undefined)).toBe(2);
    expect(normalizeTopicBoundaryRewindTurns(Number.NaN)).toBe(2);
    expect(normalizeTopicBoundaryRewindTurns(0)).toBe(0);
    expect(normalizeTopicBoundaryRewindTurns(1.7)).toBe(1);
    expect(normalizeTopicBoundaryRewindTurns(9)).toBe(3);
    // Unusable, not "no rewind": the same rule the other topic knobs use, so a
    // negative setting cannot silently mean a different cut (L-10).
    expect(normalizeTopicBoundaryRewindTurns(-4)).toBe(2);
  });
});

describe("isLocalUserTurnMessage", () => {
  test("a compaction summary is not a user turn", () => {
    expect(isLocalUserTurnMessage(userMessage("u1"))).toBe(true);
    const summary = {
      id: "s1",
      role: "user",
      content: [{ type: "text", text: "summary" }],
      timestamp: 0,
      metadata: { compaction: { summary: "summary" } },
    } as LocalMessage;
    expect(isLocalUserTurnMessage(summary)).toBe(false);
  });
});

/**
 * Boundaries are observed through the public block list: block `n` starts at the
 * boundary marker `n-1` derived. Testing the planner's *output* rather than a
 * boundary-only helper keeps the assertions on copy a receipt actually renders.
 */
function blockStartIds(
  messages: readonly LocalMessage[],
  markers: Parameters<typeof listTopicBlocks>[1],
  rewindTurns: number,
): string[] {
  return listTopicBlocks(messages, markers, { rewindTurns }).map(
    (block) => block.boundaryMessageId,
  );
}

describe("effective boundaries", () => {
  test("rewinds the default two user turns to the older turn's first message", () => {
    // The topic ended after turn 3; the agent only marked it at the end of
    // turn 6. Two turns of rewind put the boundary on turn 4's first message,
    // so a later trim cannot bury turn 4 (the new topic's opening).
    const messages = conversation(6);
    expect(blockStartIds(messages, [marker("t1", "topic A", "a6")], 2)).toEqual(
      ["u1", "u4"],
    );
  });

  test("rewind 0 still aligns to the first message of the anchor's turn", () => {
    const messages = conversation(6);
    // The anchor is `a6`; keeping from `a6` would leave an answer whose
    // question was summarized, so the boundary is turn-aligned either way.
    expect(blockStartIds(messages, [marker("t1", "topic A", "a6")], 0)).toEqual(
      ["u1", "u6"],
    );
    expect(blockStartIds(messages, [marker("t1", "topic A", "u6")], 0)).toEqual(
      ["u1", "u6"],
    );
  });

  test("rewind 3 from a late anchor lands on turn 3", () => {
    const messages = conversation(6);
    expect(blockStartIds(messages, [marker("t1", "topic A", "a6")], 3)).toEqual(
      ["u1", "u3"],
    );
  });

  test("a turn-1 anchor clamps to the start and keeps its title", () => {
    const messages = conversation(6);
    const blocks = listTopicBlocks(messages, [marker("t1", "topic A", "a1")], {
      rewindTurns: 3,
    });

    // Nothing precedes the boundary, so the marker defines no block of its own —
    // but its title is still reported instead of being dropped (L-4).
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBeNull();
    expect(blocks[0]?.absorbedTitles).toEqual(["topic A"]);
  });

  test("an anchor that left the context resolves to the previous boundary", () => {
    const messages = conversation(6);
    const blocks = listTopicBlocks(
      messages,
      [
        marker("t1", "older topic", "gone-from-context"),
        marker("t2", "topic A", "a6"),
      ],
      { rewindTurns: 2 },
    );

    expect(blocks.map((block) => block.boundaryMessageId)).toEqual([
      "u1",
      "u4",
    ]);
    expect(blocks[0]?.title).toBe("topic A");
    expect(blocks[0]?.absorbedTitles).toEqual(["older topic"]);
  });

  test("two markers in one turn cannot pull the boundary backwards", () => {
    const messages = conversation(6);
    const blocks = listTopicBlocks(
      messages,
      [marker("t1", "topic A", "a6"), marker("t2", "topic A again", "a6")],
      { rewindTurns: 2 },
    );

    expect(blocks.map((block) => block.boundaryMessageId)).toEqual([
      "u1",
      "u4",
    ]);
    expect(blocks[0]?.absorbedTitles).toEqual(["topic A again"]);
  });
});

describe("listTopicBlocks", () => {
  test("no markers yields a single current-topic block", () => {
    const messages = conversation(3, 10);
    const blocks = listTopicBlocks(messages, [], { rewindTurns: 2 });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      index: 1,
      title: null,
      markerId: null,
      boundaryMessageId: "u1",
      startIndex: 0,
      endIndex: 6,
      messageCount: 6,
      tokens: 60,
      sparse: false,
      absorbedTitles: [],
    });
  });

  test("the doc example: three turns of topic A survive a late marker", () => {
    // Turns 1-3 = topic A, 4-6 = topic B, marked at the end of turn 6.
    const messages = conversation(6);
    const blocks = listTopicBlocks(messages, [marker("t1", "A", "a6")], {
      rewindTurns: 2,
    });

    expect(blocks.map((block) => block.title)).toEqual(["A", null]);
    expect(blocks[0]).toMatchObject({
      index: 1,
      startIndex: 0,
      endIndex: 6,
      boundaryMessageId: "u1",
      rewindTurns: 0,
      startMarkerAnchorMessageId: null,
      markerId: "t1",
      anchorMessageId: "a6",
      createdBy: "agent",
    });
    // Block 2 starts at turn 4 — topic B's opening — because block 1 is closed
    // by a marker that was written two turns late.
    expect(blocks[1]).toMatchObject({
      index: 2,
      startIndex: 6,
      endIndex: 12,
      boundaryMessageId: "u4",
      rewindTurns: 2,
      startMarkerAnchorMessageId: "a6",
      title: null,
      markerId: null,
      createdBy: null,
    });
  });

  test("blocks start on user turns and never split a tool call", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", 1, { toolCall: true }),
      toolResultMessage("r1"),
      userMessage("u2"),
      assistantMessage("a2"),
      userMessage("u3"),
      assistantMessage("a3"),
    ];
    const blocks = listTopicBlocks(messages, [marker("t1", "A", "a2")], {
      rewindTurns: 0,
    });

    expect(blocks.map((block) => block.boundaryMessageId)).toEqual([
      "u1",
      "u2",
    ]);
    for (const block of blocks) {
      expect(messages[block.startIndex]?.role).not.toBe("toolResult");
    }
    expect(blocks[1]?.messageCount).toBe(4);
  });

  test("markers clamped onto the same boundary merge into one block", () => {
    const messages = conversation(6);
    const blocks = listTopicBlocks(
      messages,
      [marker("t1", "A", "a6"), marker("t2", "A2", "a6")],
      { rewindTurns: 2 },
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.title).toBe("A");
    expect(blocks[0]?.absorbedTitles).toEqual(["A2"]);
    expect(blocks[1]?.title).toBeNull();
  });

  test("a marker with no room left to rewind owns no block", () => {
    // Marked at the end of turn 1 with a two-turn rewind: there is no region
    // before it, so its title names nothing in the current context.
    const messages = conversation(3);
    const blocks = listTopicBlocks(messages, [marker("t1", "A", "a1")], {
      rewindTurns: 2,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBeNull();
  });

  test("a one-message block is reported as sparse", () => {
    // After a compaction the context starts with the summary; a marker anchored
    // in the first kept turn leaves only the summary in block 1.
    const summary = {
      id: "s1",
      role: "user",
      content: [{ type: "text", text: "summary" }],
      timestamp: 0,
      metadata: { compaction: { summary: "summary" } },
    } as LocalMessage;
    const messages = [summary, ...conversation(2)];
    const blocks = listTopicBlocks(messages, [marker("t1", "A", "a1")], {
      rewindTurns: 0,
    });

    expect(blocks[0]).toMatchObject({
      boundaryMessageId: "s1",
      messageCount: 1,
      sparse: true,
      startIndex: 0,
      title: "A",
    });
    expect(blocks[1]).toMatchObject({
      boundaryMessageId: "u1",
      sparse: false,
      title: null,
      rewindTurns: 0,
    });
  });

  test("an empty context has no blocks", () => {
    expect(listTopicBlocks([], [marker("t1", "A", null)])).toEqual([]);
  });

  test("a trimmed anchor is dropped when it has nothing to merge into", () => {
    const messages = conversation(4);
    const blocks = listTopicBlocks(
      messages,
      [marker("t1", "gone", "trimmed")],
      {
        rewindTurns: 2,
      },
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBeNull();
  });
});

describe("ratioSuggestionMessageId", () => {
  const messages = conversation(3, 100); // 6 messages x 100 tokens

  test("returns the start of the smallest region that fits the cap", () => {
    // 250 tokens: the tail three messages (300) do not fit, the tail two (200)
    // do, so the region starts at `u3`.
    expect(ratioSuggestionMessageId(messages, 250)).toBe("u3");
  });

  test("keeps the newest message when a single message exceeds the cap", () => {
    expect(ratioSuggestionMessageId(messages, 50)).toBe("a3");
  });

  test("suggests the start when everything fits", () => {
    expect(ratioSuggestionMessageId(messages, 10_000)).toBe("u1");
    expect(ratioSuggestionMessageId(messages, Number.POSITIVE_INFINITY)).toBe(
      "u1",
    );
  });

  test("an empty context has no suggestion", () => {
    expect(ratioSuggestionMessageId([], 100)).toBeNull();
  });
});

describe("alignTrimBoundary", () => {
  const messages = [
    userMessage("u1"),
    assistantMessage("a1", 1, { toolCall: true }),
    toolResultMessage("r1"),
    toolResultMessage("r2"),
    userMessage("u2"),
    assistantMessage("a2"),
  ];

  test("a user or assistant start is already safe", () => {
    expect(alignTrimBoundary(messages, "u2")).toEqual({
      startIndex: 4,
      adjusted: false,
    });
    expect(alignTrimBoundary(messages, "a2")).toEqual({
      startIndex: 5,
      adjusted: false,
    });
    expect(alignTrimBoundary(messages, "u1")).toEqual({
      startIndex: 0,
      adjusted: false,
    });
  });

  test("a tool-result start advances past the whole result run", () => {
    expect(alignTrimBoundary(messages, "r1")).toEqual({
      startIndex: 4,
      adjusted: true,
      reason: "start_split_tool_pair",
    });
  });

  test("an unknown start cannot trim anything", () => {
    expect(alignTrimBoundary(messages, "nope")).toEqual({
      startIndex: 0,
      adjusted: true,
      reason: "start_message_not_in_context",
    });
  });

  test("a result run at the end of the context has no safe start", () => {
    expect(
      alignTrimBoundary([userMessage("u1"), toolResultMessage("r1")], "r1"),
    ).toEqual({
      startIndex: 0,
      adjusted: true,
      reason: "no_safe_start",
    });
  });
});

describe("resolveTrimPlan", () => {
  const messages = conversation(6, 100); // 12 messages, 100 tokens each
  const blocks = listTopicBlocks(messages, [marker("t1", "A", "a6")], {
    rewindTurns: 2,
  }); // block 1 = turns 1-3, block 2 = turns 4-6

  test("picking block 2 summarizes exactly the earlier topic", () => {
    const plan = resolveTrimPlan({
      messages,
      blocks,
      pick: { kind: "topic", index: 2 },
      retentionCapTokens: 10_000,
    });

    expect(plan.noop).toBeUndefined();
    expect(plan.source).toBe("topic_pick");
    expect(plan.startIndex).toBe(6);
    expect(plan.summarize.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    expect(plan.keep.map((message) => message.id)).toEqual([
      "u4",
      "a4",
      "u5",
      "a5",
      "u6",
      "a6",
    ]);
    expect(plan.summarizedTitles).toEqual(["A"]);
    expect(plan.topicTitle).toBeNull();
    expect(plan.ratioCapApplied).toBe(false);
  });

  test("picking the first block is a no-op", () => {
    const plan = resolveTrimPlan({
      messages,
      blocks,
      pick: { kind: "topic", index: 1 },
      retentionCapTokens: 10_000,
    });

    expect(plan.noop).toBe(true);
    expect(plan.noopReason).toBe("nothing_before_boundary");
    expect(plan.keep).toHaveLength(messages.length);
  });

  test("an unknown block is a no-op", () => {
    const plan = resolveTrimPlan({
      messages,
      blocks,
      pick: { kind: "topic", index: 9 },
      retentionCapTokens: 10_000,
    });

    expect(plan.noopReason).toBe("unknown_block");
  });

  test("the retention cap overrides a topic boundary that keeps too much", () => {
    // Block 2 keeps 600 tokens; a 250-token cap must win.
    const plan = resolveTrimPlan({
      messages,
      blocks,
      pick: { kind: "topic", index: 2 },
      retentionCapTokens: 250,
    });

    expect(plan.ratioCapApplied).toBe(true);
    expect(plan.source).toBe("ratio_cap");
    expect(plan.startIndex).toBe(10);
    expect(plan.topicTitle).toBeNull();
    expect(plan.summarizedTitles).toEqual(["A"]);
  });

  test("a ratio suggestion needs no cap override", () => {
    const plan = resolveTrimPlan({
      messages,
      blocks,
      pick: { kind: "ratio_suggestion" },
      retentionCapTokens: 250,
    });

    expect(plan.source).toBe("ratio_suggestion");
    expect(plan.ratioCapApplied).toBe(false);
    expect(plan.startIndex).toBe(10);
    expect(plan.keep).toHaveLength(2);
    expect(plan.summarizedTitles).toEqual(["A"]);
  });

  test("a suggestion at the very start is a no-op", () => {
    const plan = resolveTrimPlan({
      messages,
      blocks,
      pick: { kind: "ratio_suggestion" },
      retentionCapTokens: 10_000,
    });

    expect(plan.noop).toBe(true);
    expect(plan.noopReason).toBe("nothing_before_boundary");
  });

  test("an empty context is a no-op", () => {
    const plan = resolveTrimPlan({
      messages: [],
      blocks: [],
      pick: { kind: "ratio_suggestion" },
      retentionCapTokens: 100,
    });

    expect(plan.noopReason).toBe("empty_context");
  });

  test("a block whose boundary lost its message cannot trim", () => {
    const second = blocks[1];
    if (!second) throw new Error("expected a trailing block");
    const stale: TopicBlock[] = [{ ...second, boundaryMessageId: "gone" }];
    const plan = resolveTrimPlan({
      messages,
      blocks: stale,
      pick: { kind: "topic", index: 2 },
      retentionCapTokens: 10_000,
    });

    expect(plan.noop).toBe(true);
    expect(plan.noopReason).toBe("nothing_before_boundary");
    expect(plan.boundaryAdjusted).toBe(false);
  });
});

describe("evaluateTopicMarkerGate", () => {
  test("rejects below the reject threshold and reports the wait", () => {
    expect(evaluateTopicMarkerGate({ turnsSincePrevious: 0 })).toEqual({
      status: "rejected",
      turnsUntilAllowed: 5,
    });
    expect(evaluateTopicMarkerGate({ turnsSincePrevious: 3 })).toEqual({
      status: "rejected",
      turnsUntilAllowed: 2,
    });
  });

  test("warns between the thresholds", () => {
    expect(evaluateTopicMarkerGate({ turnsSincePrevious: 5 })).toEqual({
      status: "warned",
      turnsUntilAllowed: 5,
    });
    expect(evaluateTopicMarkerGate({ turnsSincePrevious: 9 })).toEqual({
      status: "warned",
      turnsUntilAllowed: 1,
    });
  });

  test("accepts from the warn threshold up", () => {
    expect(evaluateTopicMarkerGate({ turnsSincePrevious: 10 })).toEqual({
      status: "accepted",
      turnsUntilAllowed: 0,
    });
    expect(evaluateTopicMarkerGate({ turnsSincePrevious: 99 })).toEqual({
      status: "accepted",
      turnsUntilAllowed: 0,
    });
  });

  test("zero disables a threshold", () => {
    expect(
      evaluateTopicMarkerGate({
        turnsSincePrevious: 1,
        warnTurns: 0,
        rejectTurns: 0,
      }),
    ).toEqual({ status: "accepted", turnsUntilAllowed: 0 });
    expect(
      evaluateTopicMarkerGate({
        turnsSincePrevious: 1,
        warnTurns: 10,
        rejectTurns: 0,
      }),
    ).toEqual({ status: "warned", turnsUntilAllowed: 9 });
  });

  test("a negative or unusable count is treated as zero turns", () => {
    expect(evaluateTopicMarkerGate({ turnsSincePrevious: -3 })).toEqual({
      status: "rejected",
      turnsUntilAllowed: 5,
    });
    expect(evaluateTopicMarkerGate({ turnsSincePrevious: Number.NaN })).toEqual(
      {
        status: "rejected",
        turnsUntilAllowed: 5,
      },
    );
  });
});

describe("decideTopicNudge", () => {
  test("fires once the unmarked streak reaches the threshold", () => {
    expect(
      decideTopicNudge({
        turnsSinceLastMarker: 49,
        alreadySentForStreak: false,
      }),
    ).toMatchObject({ due: false, reason: "below_threshold" });
    expect(
      decideTopicNudge({
        turnsSinceLastMarker: 50,
        alreadySentForStreak: false,
      }),
    ).toMatchObject({ due: true, reason: "due" });
  });

  test("reports why, so a stale flag stays distinguishable", () => {
    expect(
      decideTopicNudge({
        turnsSinceLastMarker: 12,
        nudgeTurns: 50,
        alreadySentForStreak: false,
      }),
    ).toMatchObject({ due: false, reason: "below_threshold" });
    expect(
      decideTopicNudge({
        turnsSinceLastMarker: 50,
        nudgeTurns: 50,
        alreadySentForStreak: false,
      }),
    ).toMatchObject({ due: true, reason: "due" });
    expect(
      decideTopicNudge({
        turnsSinceLastMarker: 60,
        nudgeTurns: 50,
        alreadySentForStreak: true,
      }),
    ).toMatchObject({ due: false, reason: "already_sent" });
    // A flag left over from a finished streak reads as "below threshold", not
    // as "already sent": the caller has to be able to tell them apart.
    expect(
      decideTopicNudge({
        turnsSinceLastMarker: 2,
        nudgeTurns: 50,
        alreadySentForStreak: true,
      }),
    ).toMatchObject({ due: false, reason: "below_threshold" });
    expect(
      decideTopicNudge({
        turnsSinceLastMarker: 60,
        nudgeTurns: 0,
        alreadySentForStreak: false,
      }),
    ).toMatchObject({ due: false, reason: "disabled", nudgeTurns: 0 });
  });

  test("normalizes a turn count a reader could not use", () => {
    expect(
      decideTopicNudge({
        turnsSinceLastMarker: Number.NaN,
        nudgeTurns: 3,
        alreadySentForStreak: false,
      }),
    ).toMatchObject({ turnsSinceLastMarker: 0, reason: "below_threshold" });
  });
});

describe("userTurnsSinceLastTopicMarker", () => {
  test("counts every user turn when nothing is marked", () => {
    expect(userTurnsSinceLastTopicMarker(conversation(3), [])).toBe(3);
  });

  test("counts from the last anchor that is still in context", () => {
    const messages = conversation(5);
    expect(
      userTurnsSinceLastTopicMarker(messages, [marker("t1", "A", "a2")]),
    ).toBe(3);
  });

  test("ignores a summary when counting turns", () => {
    const summary = {
      id: "s1",
      role: "user",
      content: [{ type: "text", text: "summary" }],
      timestamp: 0,
      metadata: { compaction: { summary: "summary" } },
    } as LocalMessage;
    const messages = [summary, ...conversation(2)];
    expect(userTurnsSinceLastTopicMarker(messages, [])).toBe(2);
  });

  test("falls back to counting the whole context for a trimmed anchor", () => {
    const messages = conversation(4);
    expect(
      userTurnsSinceLastTopicMarker(messages, [marker("t1", "A", "trimmed")]),
    ).toBe(4);
  });

  test("a summarizer marker does not reset the count (Q-13)", () => {
    const messages = conversation(5);
    // Counted naively this would be one turn (u5). A marker the model wrote while
    // summarizing must not satisfy its own nudge or write-frequency gate.
    const summarizer = {
      ...marker("t1", "auto topic", "a4"),
      createdBy: "summarizer" as const,
    };
    expect(userTurnsSinceLastTopicMarker(messages, [summarizer])).toBe(5);
    // A human marker in front of it still counts.
    expect(
      userTurnsSinceLastTopicMarker(messages, [
        marker("t0", "human", "a2"),
        summarizer,
      ]),
    ).toBe(3);
  });
});
