/**
 * Dream run context markers (F-06 W7).
 *
 * A dream tier turn is a separate process, so the parent passes the run id and
 * the current tier through the child environment. This pins the reader: a valid
 * tier and a non-empty run id become the child's runtime context, and garbage is
 * ignored rather than trusted.
 */
import { describe, expect, test } from "bun:test";
import {
  DREAM_RUN_ID_ENV,
  DREAM_TIER_ENV,
} from "@/utils/subagent-launch-marker";
import { readDreamRunContext } from "./toolset";

describe("dream run context markers", () => {
  test("reads a valid tier and trims the run id", () => {
    expect(
      readDreamRunContext({
        [DREAM_TIER_ENV]: "think",
        [DREAM_RUN_ID_ENV]: " run-123 ",
      }),
    ).toEqual({ dreamTier: "think", dreamRunId: "run-123" });
  });

  test("ignores an unknown tier, an empty run id, and an empty env", () => {
    expect(readDreamRunContext({ [DREAM_TIER_ENV]: "sleep" })).toEqual({});
    expect(readDreamRunContext({ [DREAM_RUN_ID_ENV]: "   " })).toEqual({});
    expect(readDreamRunContext({})).toEqual({});
  });

  test("keeps a known tier even when the run id is missing", () => {
    expect(readDreamRunContext({ [DREAM_TIER_ENV]: "tidy" })).toEqual({
      dreamTier: "tidy",
    });
  });
});
