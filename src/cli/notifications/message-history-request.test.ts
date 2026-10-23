import { afterEach, describe, expect, test } from "bun:test";
import {
  hasMessageHistoryOpener,
  openMessageHistory,
  registerMessageHistoryOpener,
  resetMessageHistoryOpenerForTests,
} from "./message-history-request";

/**
 * The seam between the hint row and the shell that owns the face.
 *
 * Two properties matter to callers, and both are easy to get wrong in a way no
 * render test sees: "no door" must be answerable *before* a click is claimed
 * (the append shell has no face, and must not swallow the pointer), and the
 * cleanup of a shell that has already been replaced must not clear the
 * replacement's registration (a conversation switch mounts the new shell before
 * the old one unmounts).
 */
afterEach(resetMessageHistoryOpenerForTests);

describe("the message history opener", () => {
  test("with nothing registered there is no door and asking changes nothing", () => {
    expect(hasMessageHistoryOpener()).toBe(false);
    expect(openMessageHistory()).toBe(false);
  });

  test("a registered opener runs once and reports that it did", () => {
    let calls = 0;
    const dispose = registerMessageHistoryOpener(() => {
      calls += 1;
    });
    expect(hasMessageHistoryOpener()).toBe(true);
    expect(openMessageHistory()).toBe(true);
    expect(calls).toBe(1);
    dispose();
    expect(hasMessageHistoryOpener()).toBe(false);
  });

  test("a replaced shell's cleanup leaves the replacement registered", () => {
    const disposeOld = registerMessageHistoryOpener(() => {});
    let raised = 0;
    registerMessageHistoryOpener(() => {
      raised += 1;
    });
    disposeOld();
    expect(openMessageHistory()).toBe(true);
    expect(raised).toBe(1);
  });
});
