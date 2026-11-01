/**
 * Dream run record on the conversation (F-06 Q-37 / Q-53).
 *
 * The reader is the only way the viewer, recovery and the host see a run, so it
 * must reject corrupt records whole instead of displaying a half-truth, and it
 * must keep the field-set independent from `reflection`.
 */
import { describe, expect, test } from "bun:test";
import { readConversationProvenance } from "@/types/conversation-provenance";
import {
  type DreamRunMetadata,
  isDreamTier,
  readDreamRunMetadata,
} from "@/types/dream-run-metadata";

const VALID: DreamRunMetadata = {
  runId: "dream-run-1",
  triggerSource: "idle",
  agentId: "agent-1",
  conversationId: "local-conv-1",
  tierPlan: ["tidy", "think", "task", "wander"],
  tierReached: "think",
  startedAt: 1_700_000_000_000,
  endedAt: null,
  baselineSha: "0123456789abcdef0123456789abcdef01234567",
  budgetTokens: 80_000,
  spentTokens: 12_345,
  timeLimitMinutes: null,
  status: "running",
  reportPath: null,
  handoff: null,
};

describe("readDreamRunMetadata", () => {
  test("reads a complete record", () => {
    expect(readDreamRunMetadata(VALID)).toEqual(VALID);
    expect(readDreamRunMetadata({ ...VALID, tierReached: null })).toEqual({
      ...VALID,
      tierReached: null,
    });
  });

  test("keeps a finished record's terminal fields", () => {
    const finished: DreamRunMetadata = {
      ...VALID,
      endedAt: VALID.startedAt + 60_000,
      tierReached: "wander",
      timeLimitMinutes: 45,
      status: "budget_exhausted",
      reportPath: "maintenance/dream-report.md",
      handoff: "Continue merging the timeline.",
    };
    expect(readDreamRunMetadata(finished)).toEqual(finished);
  });

  test("reads the optional notes block and rejects a malformed one", () => {
    const withNotes: DreamRunMetadata = {
      ...VALID,
      notes: {
        consumed: ["note-aaaaaaaa"],
        kept: ["note-bbbbbbbb"],
        outcomes: {
          "note-aaaaaaaa": "applied",
          "note-bbbbbbbb": "needs-authorization",
        },
      },
    };
    expect(readDreamRunMetadata(withNotes)).toEqual(withNotes);
    // No notes block stays no notes block (the field is additive).
    expect(readDreamRunMetadata(VALID)?.notes).toBeUndefined();
    // A half-read block drops the whole record rather than guessing.
    expect(
      readDreamRunMetadata({
        ...VALID,
        notes: { consumed: ["note-aaaaaaaa"], kept: [] },
      }),
    ).toBeUndefined();
    expect(
      readDreamRunMetadata({
        ...VALID,
        notes: {
          consumed: [],
          kept: [],
          outcomes: { "note-aaaaaaaa": "maybe" },
        },
      }),
    ).toBeUndefined();
    expect(
      readDreamRunMetadata({ ...VALID, notes: { consumed: [1], kept: [] } }),
    ).toBeUndefined();
  });

  test("rejects records that cannot be tied to a run", () => {
    expect(readDreamRunMetadata(null)).toBeUndefined();
    expect(readDreamRunMetadata("dream")).toBeUndefined();
    expect(readDreamRunMetadata({})).toBeUndefined();
    expect(readDreamRunMetadata({ ...VALID, runId: "" })).toBeUndefined();
    expect(readDreamRunMetadata({ ...VALID, agentId: null })).toBeUndefined();
    expect(
      readDreamRunMetadata({ ...VALID, conversationId: 7 }),
    ).toBeUndefined();
    expect(readDreamRunMetadata({ ...VALID, baselineSha: "" })).toBeUndefined();
    expect(
      readDreamRunMetadata({ ...VALID, triggerSource: "timer" }),
    ).toBeUndefined();
    expect(readDreamRunMetadata({ ...VALID, status: "done" })).toBeUndefined();
    expect(
      readDreamRunMetadata({ ...VALID, startedAt: Number.NaN }),
    ).toBeUndefined();
    expect(
      readDreamRunMetadata({ ...VALID, budgetTokens: -1 }),
    ).toBeUndefined();
    expect(
      readDreamRunMetadata({ ...VALID, spentTokens: "12" }),
    ).toBeUndefined();
  });

  test("rejects a tier plan or reached tier that is not a dream tier", () => {
    expect(
      readDreamRunMetadata({ ...VALID, tierPlan: ["tidy", "sleep"] }),
    ).toBeUndefined();
    expect(
      readDreamRunMetadata({ ...VALID, tierPlan: "tidy" }),
    ).toBeUndefined();
    expect(
      readDreamRunMetadata({ ...VALID, tierReached: "sleep" }),
    ).toBeUndefined();
    // A reached tier outside the plan is corrupt: the controller writes both.
    expect(
      readDreamRunMetadata({
        ...VALID,
        tierPlan: ["tidy"],
        tierReached: "task",
      }),
    ).toBeUndefined();
  });

  test("rejects impossible timing and empty report paths", () => {
    expect(
      readDreamRunMetadata({ ...VALID, timeLimitMinutes: 0 }),
    ).toBeUndefined();
    expect(readDreamRunMetadata({ ...VALID, endedAt: "soon" })).toBeUndefined();
    expect(readDreamRunMetadata({ ...VALID, reportPath: "" })).toBeUndefined();
    expect(readDreamRunMetadata({ ...VALID, handoff: 3 })).toBeUndefined();
  });
});

describe("readConversationProvenance", () => {
  test("exposes the dream record separately from reflection", () => {
    const provenance = readConversationProvenance({
      origin: "dream",
      hidden: true,
      context_mode: "standalone",
      dream: VALID,
    });
    expect(provenance).toMatchObject({
      origin: "dream",
      context_mode: "standalone",
      dream: VALID,
    });
    expect(provenance.reflection).toBeUndefined();
  });

  test("a malformed dream record is dropped, not guessed", () => {
    const provenance = readConversationProvenance({
      origin: "dream",
      dream: { runId: "only-an-id" },
    });
    expect(provenance.origin).toBe("dream");
    expect(provenance.dream).toBeUndefined();
  });

  test("isDreamTier recognizes exactly the four tiers", () => {
    for (const tier of ["tidy", "think", "task", "wander"]) {
      expect(isDreamTier(tier)).toBe(true);
    }
    expect(isDreamTier("sleep")).toBe(false);
    expect(isDreamTier(null)).toBe(false);
  });
});
