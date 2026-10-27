/**
 * Copy and parsing coverage for `/compact` (D-110 + D-119).
 *
 * The receipts are what a user reads after a destructive-feeling operation, so
 * every structured fact the planner produces — the source of the cut, the
 * rewound boundary, the ratio cap, the evicted topics — has an assertion here.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_ARGUMENTS,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
  formatContextPressureHint,
  formatNoMarkerCompactHint,
  formatSingleBlockCompactHint,
  parseCompactCommandArgs,
} from "@/cli/helpers/compact-command";

describe("parseCompactCommandArgs", () => {
  test("no arguments means the interactive path", () => {
    expect(parseCompactCommandArgs([])).toEqual({ kind: "auto" });
  });

  test("help is its own request", () => {
    expect(parseCompactCommandArgs(["help"])).toEqual({ kind: "help" });
  });

  test("a positive number is a block pick", () => {
    expect(parseCompactCommandArgs(["3"])).toEqual({ kind: "block", index: 3 });
    expect(parseCompactCommandArgs(["007"])).toEqual({
      kind: "block",
      index: 7,
    });
  });

  test("block numbers start at one", () => {
    expect(parseCompactCommandArgs(["0"])).toEqual({
      kind: "invalid",
      message: "Block numbers start at 1.",
    });
  });

  test("mode words still parse, so the cloud path keeps working", () => {
    for (const mode of COMPACT_MODE_ARGUMENTS) {
      expect(parseCompactCommandArgs([mode])).toEqual({ kind: "mode", mode });
    }
  });

  test("junk and extra arguments are refused by name", () => {
    expect(parseCompactCommandArgs(["nope"])).toEqual({
      kind: "invalid",
      message: 'Unknown argument "nope".',
    });
    expect(parseCompactCommandArgs(["3", "4"])).toEqual({
      kind: "invalid",
      message: 'Unexpected argument "4".',
    });
  });
});

describe("formatNoMarkerCompactHint", () => {
  test("points at both marking channels while the agent can mark", () => {
    const hint = formatNoMarkerCompactHint(true);
    expect(hint).toContain("compression rate decided the cut point");
    expect(hint).toContain("TopicMark");
  });

  test("explains the switch when the agent cannot mark", () => {
    const hint = formatNoMarkerCompactHint(false);
    expect(hint).toContain("switched off");
    expect(hint).not.toContain("TopicMark");
  });
});

describe("formatSingleBlockCompactHint", () => {
  test("a marker pinned to the start is explained, and /topic is the way out", () => {
    const hint = formatSingleBlockCompactHint({
      topicMarkingEnabled: true,
      liveMarkerAnchor: true,
    });
    expect(hint).toContain("sits at the very start of the current context");
    expect(hint).toContain("compression rate decided the cut point");
    expect(hint).toContain("/topic <title>");
    expect(hint).toContain("TopicMark");
    // Never claims there are no markers: that is the case this note exists for.
    expect(hint).not.toContain("No topic markers yet");
  });

  test("trimmed-away anchors get their own wording", () => {
    const hint = formatSingleBlockCompactHint({
      topicMarkingEnabled: true,
      liveMarkerAnchor: false,
    });
    expect(hint).toContain("anchor has left the current context");
  });

  test("stays silent about TopicMark when the agent cannot mark", () => {
    const hint = formatSingleBlockCompactHint({
      topicMarkingEnabled: false,
      liveMarkerAnchor: true,
    });
    expect(hint).toContain("switched off");
    expect(hint).not.toContain("TopicMark");
  });
});

describe("formatContextPressureHint", () => {
  test("a soft tier only advises", () => {
    const hint = formatContextPressureHint({
      level: "soft",
      contextTokens: 750,
      contextWindow: 1_000,
      hasBlocks: false,
      hasMarkers: false,
    });
    expect(hint).toContain("about 75%");
    expect(hint).toContain("750 of 1000 tokens");
    expect(hint).toContain("/compact compresses older topics");
    expect(hint).not.toContain("past the point");
  });

  test("a hard tier with blocks points at the picker", () => {
    const hint = formatContextPressureHint({
      level: "hard",
      contextTokens: 900,
      contextWindow: 1_000,
      hasBlocks: true,
      hasMarkers: true,
    });
    expect(hint).toContain("Pick a topic block to keep before sending");
    expect(hint).toContain("Esc to send anyway");
  });

  test("a hard tier with nothing marked says how to mark one", () => {
    const hint = formatContextPressureHint({
      level: "hard",
      contextTokens: 950,
      contextWindow: 1_000,
      hasBlocks: false,
      hasMarkers: false,
    });
    expect(hint).toContain(
      "past the point where a turn this large can be sent",
    );
    expect(hint).toContain("/compact to compress the older part");
    expect(hint).toContain("/topic <title>");
  });

  test("a hard tier whose markers define no boundary does not claim nothing is marked (H-2)", () => {
    const hint = formatContextPressureHint({
      level: "hard",
      contextTokens: 950,
      contextWindow: 1_000,
      hasBlocks: false,
      hasMarkers: true,
    });
    expect(hint).toContain("markers in this conversation define no boundary");
    expect(hint).not.toContain("nothing has marked a topic boundary yet");
    expect(hint).toContain("/topic <title>");
  });

  test("never implies the rate has nothing to compress", () => {
    // A large prompt floor makes the tier fire while the transcript is small. The
    // hint must still advise `/compact`: the rate compresses a share of what is
    // there, so a trim is always possible — the floor is not its business.
    for (const level of ["soft", "hard"] as const) {
      const hint = formatContextPressureHint({
        level,
        contextTokens: 950,
        contextWindow: 1_000,
        hasBlocks: false,
        hasMarkers: true,
      });
      expect(hint).not.toContain("would write nothing");
      expect(hint).not.toContain("Nothing to trim");
    }
  });
});

describe("command copy", () => {
  test("the usage documents the picker, the number, and the rate's block-1 rule", () => {
    expect(COMPACT_COMMAND_USAGE).toContain("/compact <n>");
    expect(COMPACT_COMMAND_USAGE).toContain("works without a terminal");
    expect(COMPACT_COMMAND_USAGE).toContain("compression rate");
    expect(COMPACT_COMMAND_USAGE).toContain(
      "block 1, which keeps the whole context",
    );
    expect(COMPACT_COMMAND_USAGE).not.toContain("self_compact");
  });

  test("the local mode refusal names the strategy", () => {
    expect(COMPACT_MODE_LOCAL_UNSUPPORTED).toContain("sliding_window");
    expect(COMPACT_MODE_LOCAL_UNSUPPORTED).toContain("/compact help");
  });
});
