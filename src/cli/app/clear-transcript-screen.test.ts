import { describe, expect, test } from "bun:test";
import { clearTranscriptScreen } from "./clear-transcript-screen";
import { CLEAR_SCREEN_AND_HOME } from "./constants";

/**
 * Starting a conversation over on the screen as well as in the model.
 *
 * The machine reported it as residual text (2026-10-20): after `/new` the previous
 * conversation's rows were still there. Nothing repaints a row the new frame does
 * not write, so the switch has to say "start from the top" itself.
 */
describe("clearing the transcript screen", () => {
  test("writes the clear-and-home sequence the app already uses", () => {
    const written: string[] = [];
    clearTranscriptScreen({ write: (chunk: string) => written.push(chunk) });
    expect(written).toEqual([CLEAR_SCREEN_AND_HOME]);
  });

  test("a stream that throws does not fail the switch", () => {
    // A closed stdout is the process on its way out; the conversation state is
    // already the new one and the screen is about to stop existing.
    expect(() =>
      clearTranscriptScreen({
        write: () => {
          throw new Error("EPIPE");
        },
      }),
    ).not.toThrow();
  });
});
