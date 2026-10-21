import { afterEach, describe, expect, test } from "bun:test";
import {
  AMBIGUOUS_WIDTH_PROBE_BYTES,
  type AmbiguousWidthProbeStart,
  claimAmbiguousWidthReply,
  columnToAmbiguousWidth,
  disarmAmbiguousWidthProbe,
  isAmbiguousWidthProbeArmed,
  isCursorPositionReply,
  probeReplyColumn,
  resetAmbiguousWidthProbeForTests,
  startAmbiguousWidthProbe,
} from "@/cli/helpers/ambiguous-width-probe";
import {
  getAmbiguousWidth,
  getAmbiguousWidthSource,
  resetAmbiguousWidthForTests,
} from "@/cli/helpers/char-width";

/**
 * Asking the terminal how wide the ambiguous characters are.
 *
 * Nothing here can run a real terminal, so the protocol is tested in the two halves
 * that carry the judgement: what a `CSI row ; col R` answer *means*, and what the
 * reader does with a payload — including the one thing it must never do, which is
 * let the answer through to the text path.
 */
afterEach(() => {
  resetAmbiguousWidthProbeForTests();
  resetAmbiguousWidthForTests();
});

function fakeStdout(): {
  written: string[];
  isTTY: boolean;
  write(s: string): void;
} {
  const written: string[] = [];
  return {
    written,
    isTTY: true,
    write(chunk: string) {
      written.push(chunk);
    },
  };
}

function fakeStdin(): { isTTY: boolean } {
  return { isTTY: true };
}

function arm(
  stdout: ReturnType<typeof fakeStdout>,
  timeoutMs = 50,
): AmbiguousWidthProbeStart {
  return startAmbiguousWidthProbe({
    stdin: fakeStdin() as unknown as NodeJS.ReadStream,
    stdout,
    env: {},
    timeoutMs,
  });
}

describe("reading the terminal's answer", () => {
  test("a reply's column is one past the width the character took", () => {
    expect(probeReplyColumn("\u001B[1;2R")).toBe(2);
    expect(probeReplyColumn("\u001B[1;3R")).toBe(3);
    expect(probeReplyColumn("\u001B[12;40R")).toBe(40);
    expect(probeReplyColumn("hello")).toBeNull();
    expect(probeReplyColumn("\u001B[1;2")).toBeNull();
  });

  test("column two means narrow, three means wide, anything else means nothing", () => {
    expect(columnToAmbiguousWidth(2)).toBe(1);
    expect(columnToAmbiguousWidth(3)).toBe(2);
    for (const column of [0, 1, 4, 40]) {
      expect(columnToAmbiguousWidth(column)).toBeNull();
    }
  });

  test("the shape is claimed whoever asked for it", () => {
    expect(isCursorPositionReply("\u001B[1;3R")).toBe(true);
    expect(isCursorPositionReply("\u001B[<0;10;5M")).toBe(false);
    expect(isCursorPositionReply("a")).toBe(false);
  });
});

describe("the probe", () => {
  test("writes exactly its own bytes and stays armed", () => {
    const stdout = fakeStdout();
    expect(arm(stdout)).toEqual({ kind: "armed" });
    expect(stdout.written).toEqual([AMBIGUOUS_WIDTH_PROBE_BYTES]);
    // Same row, one column left: Ink's own cursor bookkeeping is row-based, so a
    // probe that moved vertically would corrupt the next frame.
    expect(AMBIGUOUS_WIDTH_PROBE_BYTES.startsWith("\r")).toBe(true);
    expect(AMBIGUOUS_WIDTH_PROBE_BYTES).not.toContain("\u001B[1;1H");
    expect(AMBIGUOUS_WIDTH_PROBE_BYTES).toContain("\u001B[6n");
    expect(isAmbiguousWidthProbeArmed()).toBe(true);
  });

  test("a two-column answer becomes the width every row is laid out with", () => {
    const stdout = fakeStdout();
    arm(stdout);
    expect(claimAmbiguousWidthReply("\u001B[1;3R")).toBe(true);
    expect(getAmbiguousWidth()).toBe(2);
    expect(getAmbiguousWidthSource()).toBe("probe");
    expect(isAmbiguousWidthProbeArmed()).toBe(false);
  });

  test("a one-column answer leaves the table's own number in place", () => {
    arm(fakeStdout());
    expect(claimAmbiguousWidthReply("\u001B[1;2R")).toBe(true);
    expect(getAmbiguousWidth()).toBe(1);
    expect(getAmbiguousWidthSource()).toBe("probe");
  });

  test("a reply nobody asked for is claimed, and changes nothing", () => {
    expect(isAmbiguousWidthProbeArmed()).toBe(false);
    expect(claimAmbiguousWidthReply("\u001B[1;3R")).toBe(true);
    expect(getAmbiguousWidth()).toBe(1);
    expect(getAmbiguousWidthSource()).toBe("default");
  });

  test("an unanswered probe gives up and stays on the table's answer", async () => {
    arm(fakeStdout(), 10);
    expect(isAmbiguousWidthProbeArmed()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(isAmbiguousWidthProbeArmed()).toBe(false);
    expect(getAmbiguousWidth()).toBe(1);
    expect(getAmbiguousWidthSource()).toBe("default");
  });

  test("an unanswered resize probe does not downgrade a resolved width", async () => {
    // The machine's Consolas/等宽楷体 case: once the terminal has answered "wide",
    // a re-probe that gets no answer (the terminal is busy, the reply is filtered)
    // must keep the wide answer — otherwise every resize would flip the layout.
    arm(fakeStdout());
    expect(claimAmbiguousWidthReply("\u001B[1;3R")).toBe(true);
    expect(getAmbiguousWidth()).toBe(2);
    arm(fakeStdout(), 10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getAmbiguousWidth()).toBe(2);
    expect(getAmbiguousWidthSource()).toBe("probe");
  });

  test("no terminal, no probe", () => {
    expect(
      startAmbiguousWidthProbe({
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
        stdout: { isTTY: false, write() {} },
        env: {},
      }),
    ).toEqual({ kind: "skipped", reason: "not-a-tty" });
    expect(
      startAmbiguousWidthProbe({
        stdin: fakeStdin() as unknown as NodeJS.ReadStream,
        stdout: fakeStdout(),
        env: { HARUYUKI_AMBIGUOUS_WIDTH_PROBE: "0" },
      }),
    ).toEqual({ kind: "skipped", reason: "disabled" });
  });

  test("a second arm replaces the first instead of counting probes", () => {
    const first = fakeStdout();
    const second = fakeStdout();
    arm(first);
    arm(second);
    expect(isAmbiguousWidthProbeArmed()).toBe(true);
    expect(claimAmbiguousWidthReply("\u001B[1;3R")).toBe(true);
    expect(isAmbiguousWidthProbeArmed()).toBe(false);
    disarmAmbiguousWidthProbe();
  });
});
