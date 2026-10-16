import { afterEach, describe, expect, test } from "bun:test";
import {
  disableMouseTracking,
  enableMouseTracking,
  isMouseTrackingEnabled,
  MOUSE_TRACKING_DISABLE,
  MOUSE_TRACKING_ENABLE,
  type MouseTrackingStream,
  resetMouseTrackingForTests,
  subscribeToMouseTracking,
  toggleMouseTracking,
} from "@/cli/helpers/mouse-tracking";

function fakeStream(isTTY = true): MouseTrackingStream & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    isTTY,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

afterEach(() => {
  resetMouseTrackingForTests();
});

describe("mouse tracking", () => {
  test("asks for the three modes once, and takes them back once", () => {
    const stream = fakeStream();

    expect(enableMouseTracking(stream)).toBe(true);
    expect(isMouseTrackingEnabled()).toBe(true);
    expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE]);

    // Already on: no second request, and the caller can tell.
    expect(enableMouseTracking(stream)).toBe(false);
    expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE]);

    expect(disableMouseTracking()).toBe(true);
    expect(isMouseTrackingEnabled()).toBe(false);
    expect(stream.writes).toEqual([
      MOUSE_TRACKING_ENABLE,
      MOUSE_TRACKING_DISABLE,
    ]);

    // Already off: nothing to take back.
    expect(disableMouseTracking()).toBe(false);
    expect(stream.writes).toEqual([
      MOUSE_TRACKING_ENABLE,
      MOUSE_TRACKING_DISABLE,
    ]);
  });

  test("the enable and disable sequences are mirrors of each other", () => {
    // A mode left on after the app exits prints escape garbage into the user's
    // shell, so the pair has to be exact: same three modes, reverse order.
    const enable = ["1000h", "1002h", "1006h"].map((mode) => `\u001B[?${mode}`);
    const disable = ["1006l", "1002l", "1000l"].map(
      (mode) => `\u001B[?${mode}`,
    );
    expect(MOUSE_TRACKING_ENABLE).toBe(enable.join(""));
    expect(MOUSE_TRACKING_DISABLE).toBe(disable.join(""));
  });

  test("toggles between the two states", () => {
    const stream = fakeStream();

    expect(toggleMouseTracking(stream)).toBe(true);
    expect(isMouseTrackingEnabled()).toBe(true);
    expect(toggleMouseTracking(stream)).toBe(false);
    expect(isMouseTrackingEnabled()).toBe(false);
    expect(stream.writes).toEqual([
      MOUSE_TRACKING_ENABLE,
      MOUSE_TRACKING_DISABLE,
    ]);
  });

  test("writes nothing when the output is not a terminal", () => {
    const piped = fakeStream(false);

    expect(enableMouseTracking(piped)).toBe(false);
    expect(isMouseTrackingEnabled()).toBe(false);
    expect(piped.writes).toEqual([]);
  });

  test("notifies subscribers on every change", () => {
    const stream = fakeStream();
    const seen: boolean[] = [];
    subscribeToMouseTracking(() => {
      seen.push(isMouseTrackingEnabled());
    });

    enableMouseTracking(stream);
    disableMouseTracking();
    // An idempotent call changes nothing, so it says nothing.
    disableMouseTracking();

    expect(seen).toEqual([true, false]);
  });

  test("takes the modes back when the process exits without unmounting", () => {
    const stream = fakeStream();
    const before = process.listeners("exit");

    enableMouseTracking(stream);
    const added = process
      .listeners("exit")
      .filter((listener) => !before.includes(listener));
    expect(added.length).toBe(1);

    // Call the exit hook the way a process exit would.
    (added[0] as () => void)();

    expect(isMouseTrackingEnabled()).toBe(false);
    expect(stream.writes).toEqual([
      MOUSE_TRACKING_ENABLE,
      MOUSE_TRACKING_DISABLE,
    ]);
  });

  test("the test seam removes the exit hook it installed", () => {
    const stream = fakeStream();
    const before = process.listeners("exit").length;

    enableMouseTracking(stream);
    expect(process.listeners("exit").length).toBe(before + 1);

    resetMouseTrackingForTests();
    expect(process.listeners("exit").length).toBe(before);
    expect(isMouseTrackingEnabled()).toBe(false);
  });
});
