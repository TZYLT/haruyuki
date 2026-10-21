import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireMouseHover,
  acquireMouseTracking,
  disableMouseTracking,
  enableMouseTracking,
  isMouseHoverActive,
  isMouseTrackingEnabled,
  MOUSE_HOVER_DISABLE,
  MOUSE_HOVER_ENABLE,
  MOUSE_TRACKING_DISABLE,
  MOUSE_TRACKING_ENABLE,
  type MouseTrackingStream,
  resetMouseTrackingForTests,
  subscribeToMouseTracking,
  syncMouseTracking,
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

describe("any-motion for hovering", () => {
  test("a hoverable surface asks for 1003, and gives it back", () => {
    const stream = fakeStream();
    enableMouseTracking(stream);

    const release = acquireMouseHover();
    expect(isMouseHoverActive()).toBe(true);
    expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE, MOUSE_HOVER_ENABLE]);

    release();
    expect(isMouseHoverActive()).toBe(false);
    expect(stream.writes).toEqual([
      MOUSE_TRACKING_ENABLE,
      MOUSE_HOVER_ENABLE,
      MOUSE_HOVER_DISABLE,
    ]);

    // Idempotent: a cleanup that runs twice must not underflow the count and
    // switch a second surface's mode off underneath it.
    release();
    expect(stream.writes.length).toBe(3);
  });

  test("two surfaces keep it on until the last one goes", () => {
    const stream = fakeStream();
    enableMouseTracking(stream);
    const page = acquireMouseHover();
    const popup = acquireMouseHover();
    expect(stream.writes.filter((w) => w === MOUSE_HOVER_ENABLE).length).toBe(
      1,
    );

    // The popup closes while the page is open: the mode stays.
    popup();
    expect(isMouseHoverActive()).toBe(true);
    page();
    expect(isMouseHoverActive()).toBe(false);
  });

  test("a claim made before the mouse is on writes nothing, then takes effect", () => {
    const stream = fakeStream();
    const release = acquireMouseHover();
    expect(stream.writes).toEqual([]);

    enableMouseTracking(stream);
    expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE, MOUSE_HOVER_ENABLE]);
    release();
    disableMouseTracking();
  });

  test("Ctrl+X m off takes 1003 with it", () => {
    const stream = fakeStream();
    enableMouseTracking(stream);
    acquireMouseHover();

    disableMouseTracking();
    expect(isMouseHoverActive()).toBe(false);
    // The pointer stops being reported *before* the modes underneath are given
    // back, and both are in the same write: a terminal left in 1003 after the app
    // exits prints motion reports into the user's shell.
    expect(stream.writes.at(-1)).toBe(
      MOUSE_HOVER_DISABLE + MOUSE_TRACKING_DISABLE,
    );
  });
});

describe("ownership across a remount", () => {
  test("a second owner keeps the mode on while the first releases", async () => {
    const stream = fakeStream();
    const first = acquireMouseTracking(stream);
    const second = acquireMouseTracking(stream);
    expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE]);

    // The old shell goes away while the new one is already mounted.
    first();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(isMouseTrackingEnabled()).toBe(true);
    expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE]);

    second();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(isMouseTrackingEnabled()).toBe(false);
    expect(stream.writes).toEqual([
      MOUSE_TRACKING_ENABLE,
      MOUSE_TRACKING_DISABLE,
    ]);
  });

  test("a release followed by an acquire in the same tick never writes the disable", async () => {
    const stream = fakeStream();
    const first = acquireMouseTracking(stream);
    // The keyed root replaces its shell in one commit: release, then acquire.
    first();
    const second = acquireMouseTracking(stream);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(isMouseTrackingEnabled()).toBe(true);
    expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE]);
    second();
  });

  test("a remount cannot undo the user's Ctrl+X m", async () => {
    const stream = fakeStream();
    const first = acquireMouseTracking(stream);
    toggleMouseTracking(stream);
    expect(isMouseTrackingEnabled()).toBe(false);
    first();

    // A page mounting does not turn reporting back on: consent is the user's.
    const second = acquireMouseTracking(stream);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(isMouseTrackingEnabled()).toBe(false);
    second();
  });

  test("re-asserting writes the three modes again without changing state", () => {
    const stream = fakeStream();
    acquireMouseTracking(stream);
    const writes = stream.writes.length;

    expect(syncMouseTracking()).toBe(true);
    expect(stream.writes.slice(writes)).toEqual([MOUSE_TRACKING_ENABLE]);
    expect(isMouseTrackingEnabled()).toBe(true);

    // While the user has it off there is nothing to re-assert.
    toggleMouseTracking(stream);
    expect(syncMouseTracking()).toBe(false);
  });
});
