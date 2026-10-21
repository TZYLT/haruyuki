import { afterEach, describe, expect, test } from "bun:test";
import { envAmbiguousWidthMode } from "@/cli/app/shell/use-ambiguous-width";
import { resetAmbiguousWidthProbeForTests } from "@/cli/helpers/ambiguous-width-probe";
import {
  getAmbiguousWidth,
  getAmbiguousWidthSource,
  resetAmbiguousWidthForTests,
} from "@/cli/helpers/char-width";

/**
 * Which mode a launch asks for.
 *
 * The environment is the only source this hook can read without a promise, so it is
 * also the one worth pinning: a launch that says `wide` must not end up probing for
 * an answer it would then have to ignore.
 */
afterEach(() => {
  resetAmbiguousWidthForTests();
  resetAmbiguousWidthProbeForTests();
});

describe("the launch's width mode", () => {
  test("reads its own variable and nothing else", () => {
    expect(envAmbiguousWidthMode({ HARUYUKI_AMBIGUOUS_WIDTH: "wide" })).toBe(
      "wide",
    );
    expect(envAmbiguousWidthMode({ HARUYUKI_AMBIGUOUS_WIDTH: "narrow" })).toBe(
      "narrow",
    );
    expect(envAmbiguousWidthMode({ HARUYUKI_AMBIGUOUS_WIDTH: "auto" })).toBe(
      "auto",
    );
    // Unset, empty, or a typo: no opinion, which leaves the settings file and the
    // probe to answer.
    expect(envAmbiguousWidthMode({})).toBeNull();
    expect(envAmbiguousWidthMode({ HARUYUKI_AMBIGUOUS_WIDTH: "" })).toBeNull();
    expect(
      envAmbiguousWidthMode({ HARUYUKI_AMBIGUOUS_WIDTH: "Wide" }),
    ).toBeNull();
  });

  test("a mode is not applied by reading it", () => {
    // The read is pure: the hook decides when to apply, so a unit test that only
    // asks about the environment cannot move the layout.
    envAmbiguousWidthMode({ HARUYUKI_AMBIGUOUS_WIDTH: "wide" });
    expect(getAmbiguousWidth()).toBe(1);
    expect(getAmbiguousWidthSource()).toBe("default");
  });
});
