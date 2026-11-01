/**
 * F-06 / 46-6-Fix-A W11 + W12 · notes, seed and decay wiring in the dream run
 * controller.
 *
 * These cases drive the parts of `executeDreamRun` that touch the note queue
 * and the decay ledger. Every one of them goes through the injected seams
 * (`claimNotes`, `collectSeed`, `consumeNotes`, `readMarks`, `applyDecay`), so
 * no test reads or writes the real `~/.haruyuki` home, the memory repository or
 * git. The shared harness lives in `dream-run-test-harness.ts`.
 *
 * The contract these pin:
 *
 * - the queue is claimed and the seed built once, before the first turn, and
 *   the seed only rides in that first turn;
 * - a seed or queue failure degrades to one line and never stops the run;
 * - a settled run (`succeeded` / `budget_exhausted`) consumes only `applied`
 *   notes, a failed run keeps everything, and an unparsed answer is no answer;
 * - the report body gains a harness-written `## Notes` section, and the run
 *   record gains the optional `notes` block;
 * - the decay ledger update runs after the report and never changes the
 *   terminal state.
 */
import { describe, expect, test } from "bun:test";
import type { ConsumeDreamNotesResult } from "@/agent/dream/dream-notes";
import type { DreamReviewMark } from "@/agent/dream/dream-review-marks";
import { executeDreamRun } from "@/agent/dream/dream-run";
import {
  claimedNote,
  EMPTY_PARTS,
  type Harness,
  makeHarness,
  makeSettings,
  RUN_INPUT,
} from "@/agent/dream/dream-run-test-harness";
import type { DreamRunDeps } from "@/agent/dream/dream-run-types";

describe("executeDreamRun · notes and seed (W11)", () => {
  test("claims notes, collects the seed and injects it in the first turn only", async () => {
    const notes = [claimedNote("note-aaaaaaaa"), claimedNote("note-bbbbbbbb")];
    const claimCalls: Array<{ agentId: string; runId: string; now: number }> =
      [];
    const harness = makeHarness({
      overrides: {
        claimNotes: async (agentId, runId, now) => {
          claimCalls.push({ agentId, runId, now });
          return notes;
        },
      },
    });
    await executeDreamRun(RUN_INPUT, harness.deps);

    // claim uses the run start time, and the seed receives the claimed notes.
    expect(claimCalls).toEqual([
      { agentId: "agent-a", runId: "run-1", now: 1_700_000_000_000 },
    ]);
    expect(harness.seedInputs).toHaveLength(1);
    expect(harness.seedInputs[0]?.notes.map((note) => note.id)).toEqual([
      "note-aaaaaaaa",
      "note-bbbbbbbb",
    ]);
    // First turn: seed + shared manual. Later turn: short block, no seed.
    expect(harness.turns[0]?.prompt).toContain("## Pending notes");
    expect(harness.turns[0]?.prompt).toContain("note-aaaaaaaa");
    expect(harness.turns[1]?.prompt).not.toContain("## Pending notes");
    expect(harness.turns[1]?.prompt).not.toContain("note-aaaaaaaa");

    // Reading the queue happens before the first turn and before the report.
    expect(harness.events.indexOf("notes.claim")).toBeLessThan(
      harness.events.indexOf("seed.collect"),
    );
    expect(harness.events.indexOf("seed.collect")).toBeLessThan(
      harness.events.indexOf("report"),
    );
  });

  test("a note/seed failure degrades to a one-line block and the run still succeeds", async () => {
    const harness = makeHarness({
      overrides: {
        claimNotes: async () => {
          throw new Error("queue unreadable");
        },
        collectSeed: async () => {
          throw new Error("git exploded");
        },
      },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");
    expect(harness.turns[0]?.prompt).toContain(
      "could not prepare this run's seed",
    );
    // No seed means the decay ledger update is skipped, not faked.
    expect(harness.decayInputs).toHaveLength(0);
    // No notes were claimed, so nothing is settled and no notes metadata exists.
    expect(harness.consumeCalls).toHaveLength(0);
    expect(harness.metadata.at(-1)?.notes).toBeUndefined();
  });
});

describe("executeDreamRun · notes settlement (W12)", () => {
  const NOTES = [claimedNote("note-aaaaaaaa"), claimedNote("note-bbbbbbbb")];

  function notesHarness(options: {
    reports?: string[];
    status?: "succeeded" | "failed";
    settlement?: ConsumeDreamNotesResult;
    overrides?: Partial<DreamRunDeps>;
  }): Harness {
    const reports = options.reports ?? [];
    let calls = 0;
    return makeHarness({
      spawnedTurn: (input) => {
        calls += 1;
        if (options.status === "failed" && calls === 2) {
          return {
            success: false,
            error: "model exploded",
            aborted: false,
            usage: EMPTY_PARTS,
          };
        }
        return {
          success: true,
          report: reports[0] ?? `report for ${input.tier}`,
          aborted: false,
          usage: { ...EMPTY_PARTS, outputTokens: 100 },
        };
      },
      ...(options.settlement !== undefined
        ? { consumeResult: options.settlement }
        : {}),
      overrides: {
        claimNotes: async () => NOTES,
        ...options.overrides,
      },
    });
  }

  test("a succeeded run consumes only `applied` and records the outcome map", async () => {
    const harness = notesHarness({
      reports: [
        "## 概览\n- tidied\n\n## Notes 回应\n- note-aaaaaaaa: applied (done)\n- note-bbbbbbbb: needs-authorization, the user must confirm",
      ],
      settlement: { consumed: ["note-aaaaaaaa"], kept: ["note-bbbbbbbb"] },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");

    expect(harness.consumeCalls).toHaveLength(1);
    expect(harness.consumeCalls[0]?.outcomes).toEqual({
      "note-aaaaaaaa": "applied",
      "note-bbbbbbbb": "needs-authorization",
    });
    const final = harness.metadata.at(-1);
    expect(final?.notes).toEqual({
      consumed: ["note-aaaaaaaa"],
      kept: ["note-bbbbbbbb"],
      outcomes: {
        "note-aaaaaaaa": "applied",
        "note-bbbbbbbb": "needs-authorization",
      },
    });
    // The report carries the harness-written Notes section before it is
    // committed, listing both the consumed and the kept note.
    const body = harness.reports[0]?.body ?? "";
    expect(body).toContain("## Notes");
    expect(body).toContain("- note-aaaaaaaa: applied");
    expect(body).toContain("- note-bbbbbbbb: needs-authorization");
    expect(body).toContain("settled the queue");
  });

  test("a failed run keeps every note but still records parsed answers", async () => {
    const harness = notesHarness({
      status: "failed",
      reports: ["## Notes 回应\n- note-aaaaaaaa: applied"],
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("failed");
    expect(harness.consumeCalls).toHaveLength(0);
    expect(harness.metadata.at(-1)?.notes).toEqual({
      consumed: [],
      kept: [],
      outcomes: { "note-aaaaaaaa": "applied" },
    });
    expect(harness.reports[0]?.body).toContain("did not reach a settled state");
  });

  test("a budget-exhausted run settles the queue like a success", async () => {
    const harness = makeHarness({
      settings: makeSettings({ maxPerRun: 1_000 }),
      spawnedTurn: () => ({
        success: true,
        report: "## Notes 回应\n- note-aaaaaaaa: applied",
        aborted: false,
        usage: { ...EMPTY_PARTS, outputTokens: 2_000 },
      }),
      consumeResult: { consumed: ["note-aaaaaaaa"], kept: [] },
      overrides: {
        claimNotes: async () => [claimedNote("note-aaaaaaaa")],
      },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");
    expect(harness.metadata.at(-1)?.status).toBe("budget_exhausted");
    expect(harness.consumeCalls).toHaveLength(1);
    expect(harness.metadata.at(-1)?.notes).toEqual({
      consumed: ["note-aaaaaaaa"],
      kept: [],
      outcomes: { "note-aaaaaaaa": "applied" },
    });
  });

  test("an unparsed answer keeps the note (no outcome, nothing consumed)", async () => {
    const harness = notesHarness({
      reports: ["## Notes 回应\n- note-aaaaaaaa: maybe later"],
    });
    await executeDreamRun(RUN_INPUT, harness.deps);
    expect(harness.consumeCalls).toHaveLength(1);
    expect(harness.consumeCalls[0]?.outcomes).toEqual({});
    expect(harness.metadata.at(-1)?.notes).toEqual({
      consumed: [],
      kept: [],
      outcomes: {},
    });
    expect(harness.reports[0]?.body).toContain(
      "- note-aaaaaaaa: no answer (kept)",
    );
  });
});

describe("executeDreamRun · decay ledger (W11)", () => {
  const MARK: DreamReviewMark = {
    version: 1,
    runId: "run-1",
    path: "system/human.md",
    coverage: "content",
    evidence: "checked links and index",
    createdAt: 1_700_000_000_000,
  };

  test("reads the run's marks and applies the ledger update after the report", async () => {
    const harness = makeHarness({
      overrides: {
        readMarks: async (runId) => {
          harness.markRunIds.push(runId);
          return [MARK];
        },
      },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");
    expect(harness.markRunIds).toEqual(["run-1"]);
    expect(harness.decayInputs).toHaveLength(1);
    const decay = harness.decayInputs[0];
    expect(decay?.runId).toBe("run-1");
    expect(decay?.baselineSha).toContain("baseline-run-1");
    expect(decay?.marks).toEqual([MARK]);
    expect(decay?.seed.notes).toEqual([]);
    expect(harness.events.indexOf("report")).toBeLessThan(
      harness.events.indexOf("decay.apply"),
    );
  });

  test("a ledger failure never changes the run's terminal state", async () => {
    const harness = makeHarness({
      overrides: {
        applyDecay: async () => {
          throw new Error("ledger disk full");
        },
      },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");
    expect(harness.metadata.at(-1)?.status).toBe("succeeded");
    expect(harness.markers).toHaveLength(0);
  });
});
