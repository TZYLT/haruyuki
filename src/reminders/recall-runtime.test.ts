import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  RecallDecision,
  RecallSourceDiagnostic,
  RecallSourceId,
} from "./recall-port";
import {
  formatRecallNoticeLine,
  RECALL_BREAKER_THRESHOLD,
  readRecallRuntimeStatus,
  recallBreakerTripped,
  recordRecallDecision,
  resetRecallRuntime,
  takePendingRecallNotice,
} from "./recall-runtime";

/**
 * The breaker is process-wide module state, which is exactly why its rules need
 * a test: "three in a row" is a statement about a sequence, and every rule about
 * what does *not* count is a rule about not reaching three.
 */

function decision(
  status: RecallDecision["status"],
  options: {
    reason?: string;
    timedOut?: boolean;
    sources?: RecallSourceDiagnostic[];
  } = {},
): RecallDecision {
  return {
    entries: [],
    status,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.timedOut === true ? { timedOut: true } : {}),
    diagnostics: {
      threshold: 0,
      candidates: 0,
      sources: options.sources ?? [],
    },
  };
}

function source(
  id: RecallSourceId,
  status: RecallSourceDiagnostic["status"],
  reason?: string,
): RecallSourceDiagnostic {
  return {
    source: id,
    status,
    candidates: 0,
    ...(reason === undefined ? {} : { reason }),
  };
}

const unavailableTranscript = [
  source("transcript", "unavailable", "no sidecar"),
];

beforeEach(() => {
  resetRecallRuntime();
});

afterEach(() => {
  // Bun shares one module registry across the files of a worker, so a test that
  // leaves the breaker tripped would switch recall off for whatever runs next.
  resetRecallRuntime();
});

describe("the breaker", () => {
  test("trips after three consecutive failures", () => {
    expect(
      recordRecallDecision(decision("failed", { reason: "store unreadable" })),
    ).toEqual({ kind: "failed", reason: "store unreadable" });
    expect(
      recordRecallDecision(decision("failed", { reason: "store unreadable" })),
    ).toEqual({ kind: "failed", reason: "store unreadable" });
    expect(recallBreakerTripped()).toBe(false);

    expect(
      recordRecallDecision(decision("failed", { reason: "store unreadable" })),
    ).toEqual({
      kind: "tripped",
      failures: RECALL_BREAKER_THRESHOLD,
      reason: "store unreadable",
    });
    expect(recallBreakerTripped()).toBe(true);
  });

  test("a timeout is a failure, and says so", () => {
    expect(
      recordRecallDecision(decision("no-match", { timedOut: true })),
    ).toEqual({
      kind: "timed-out",
      reason: "the recall deadline expired",
      entries: 0,
    });
    expect(readRecallRuntimeStatus().consecutiveFailures).toBe(1);
  });

  test("a success anywhere in the run resets the count", () => {
    recordRecallDecision(decision("failed", { reason: "boom" }));
    recordRecallDecision(decision("failed", { reason: "boom" }));
    // "Nothing matched" is the feature working, not failing.
    expect(recordRecallDecision(decision("no-match"))).toBeNull();
    expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);

    recordRecallDecision(decision("failed", { reason: "boom" }));
    recordRecallDecision(decision("failed", { reason: "boom" }));
    expect(recallBreakerTripped()).toBe(false);

    // The last reason survives the recovery: `/recall status` is asked after the
    // fact, and "never failed" would be a lie.
    expect(readRecallRuntimeStatus().lastFailureReason).toBe("boom");
  });

  test("a trip reports the failure it tripped on, once", () => {
    recordRecallDecision(decision("failed", { reason: "disk on fire" }));
    expect(
      recordRecallDecision(decision("failed", { reason: "disk on fire" })),
    ).toEqual({ kind: "failed", reason: "disk on fire" });
    const trip = recordRecallDecision(
      decision("failed", { reason: "disk on fire" }),
    );
    expect(trip).toEqual({
      kind: "tripped",
      failures: RECALL_BREAKER_THRESHOLD,
      reason: "disk on fire",
    });
    if (trip?.kind !== "tripped") throw new Error("expected a trip notice");
    expect(formatRecallNoticeLine(trip)).toContain("disk on fire");
  });

  test("stays tripped until it is reset, counting nothing further", () => {
    for (let index = 0; index < RECALL_BREAKER_THRESHOLD; index += 1) {
      recordRecallDecision(decision("failed", { reason: "boom" }));
    }
    expect(recallBreakerTripped()).toBe(true);

    // A turn that would have succeeded does not silently re-arm the feature: only
    // the user's `/recall on` does (《26》§6.6).
    recordRecallDecision(decision("no-match"));
    expect(recallBreakerTripped()).toBe(true);

    resetRecallRuntime();
    expect(recallBreakerTripped()).toBe(false);
    expect(readRecallRuntimeStatus()).toEqual({
      lastDecision: null,
      consecutiveFailures: 0,
      tripped: false,
      lastFailureReason: null,
    });
  });
});

describe("the degradation notice", () => {
  test("a missing transcript index is reported once per episode", () => {
    const missing = decision("no-match", { sources: unavailableTranscript });
    expect(recordRecallDecision(missing)).toEqual({ kind: "index-missing" });
    // The condition persists until `build` runs; repeating the line every turn
    // would be noise the user cannot act on any faster.
    expect(recordRecallDecision(missing)).toBeNull();
    expect(recordRecallDecision(missing)).toBeNull();
  });

  test("is re-armed by a turn that could read the index", () => {
    const missing = decision("no-match", { sources: unavailableTranscript });
    expect(recordRecallDecision(missing)).toEqual({ kind: "index-missing" });
    recordRecallDecision(
      decision("no-match", { sources: [source("transcript", "empty")] }),
    );
    expect(recordRecallDecision(missing)).toEqual({ kind: "index-missing" });
  });

  test("a missing memory workspace is not an index problem", () => {
    // The agent simply has no memory; there is no command that would fix it, so
    // telling the user to run `build` would send them somewhere useless.
    expect(
      recordRecallDecision(
        decision("no-match", {
          sources: [
            source("transcript", "empty"),
            source("memory", "unavailable", "no memory workspace"),
          ],
        }),
      ),
    ).toBeNull();
    expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);
  });

  test("does not count against the breaker", () => {
    for (let index = 0; index < 10; index += 1) {
      recordRecallDecision(
        decision("unavailable", { sources: unavailableTranscript }),
      );
    }
    expect(recallBreakerTripped()).toBe(false);
    expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);
  });

  test("a partial failure with a result is not a strike", () => {
    // One source threw, the other answered: recall worked, so the environment is
    // not the problem the breaker exists to catch.
    recordRecallDecision(
      decision("no-match", {
        sources: [
          source("transcript", "failed", "boom"),
          source("memory", "empty"),
        ],
      }),
    );
    expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);
  });
});

describe("the notice line", () => {
  test("names what happened and what to do about it", () => {
    expect(
      formatRecallNoticeLine({ kind: "timed-out", reason: "slow", entries: 0 }),
    ).toBe("Recall timed out and was skipped for this turn: slow");
    expect(formatRecallNoticeLine({ kind: "failed", reason: "boom" })).toBe(
      "Recall failed and was skipped for this turn: boom",
    );
    expect(formatRecallNoticeLine({ kind: "index-missing" })).toContain(
      "/recall build",
    );
    const tripped = formatRecallNoticeLine({
      kind: "tripped",
      failures: 3,
      reason: "boom",
    });
    expect(tripped).toContain("3 turns in a row");
    expect(tripped).toContain("boom");
    expect(tripped).toContain("/recall on");
  });

  test("a timeout that still injected passages is not called a skip", () => {
    // `timedOut` is orthogonal to the status: the budget can run out after a
    // passage was already chosen, and the line has to say what actually happened.
    const line = formatRecallNoticeLine({
      kind: "timed-out",
      reason: "slow",
      entries: 2,
    });
    expect(line).toContain("2 passages");
    expect(line).not.toContain("skipped");
  });

  test("every kind has a line", () => {
    for (const notice of [
      { kind: "timed-out", reason: "r", entries: 0 },
      { kind: "timed-out", reason: "r", entries: 3 },
      { kind: "failed", reason: "r" },
      { kind: "index-missing" },
      { kind: "tripped", failures: 3, reason: "r" },
    ] as const) {
      expect(formatRecallNoticeLine(notice).length).toBeGreaterThan(0);
    }
  });
});

describe("claiming a parked notice", () => {
  test("returns it once and clears the field", () => {
    const state = { pendingRecallNotice: { kind: "index-missing" } as const };
    expect(takePendingRecallNotice(state)).toEqual({ kind: "index-missing" });
    expect(state.pendingRecallNotice).toBeNull();
    expect(takePendingRecallNotice(state)).toBeNull();
  });

  test("an empty state is not an error", () => {
    expect(takePendingRecallNotice({ pendingRecallNotice: null })).toBeNull();
  });
});
