import { beforeEach, describe, expect, test } from "bun:test";
import {
  acquireInputScope,
  consultedInputScopes,
  owningInputScope,
  resetInputScopes,
} from "@/cli/helpers/focus-ledger";

describe("focus ledger", () => {
  beforeEach(() => {
    resetInputScopes();
  });

  test("the app layer owns input by default", () => {
    expect(owningInputScope()).toBe("app");
    expect(consultedInputScopes()).toEqual(["app", "system"]);
  });

  test("an overlay claim takes input from the app layer", () => {
    const release = acquireInputScope("overlay");
    expect(owningInputScope()).toBe("overlay");
    // The app layer is not consulted at all, so an app-level binding cannot fire
    // behind an open selector.
    expect(consultedInputScopes()).toEqual(["overlay", "system"]);
    release();
    expect(consultedInputScopes()).toEqual(["app", "system"]);
  });

  test("a modal outranks an overlay", () => {
    const releaseOverlay = acquireInputScope("overlay");
    const releaseModal = acquireInputScope("modal");
    expect(owningInputScope()).toBe("modal");
    releaseModal();
    expect(owningInputScope()).toBe("overlay");
    releaseOverlay();
    expect(owningInputScope()).toBe("app");
  });

  test("a page sits between the overlay and the app", () => {
    // 《38》§3.6: a page owns the main area, so `↑↓`/`PgUp`/`Esc` are its own and
    // the composer behind it must not also act on them — but a confirm or a text
    // editor popped *on* the page still takes the keyboard from it.
    const releasePage = acquireInputScope("page");
    expect(owningInputScope()).toBe("page");

    const releaseOverlay = acquireInputScope("overlay");
    expect(owningInputScope()).toBe("overlay");

    const releaseModal = acquireInputScope("modal");
    expect(owningInputScope()).toBe("modal");

    releaseModal();
    expect(owningInputScope()).toBe("overlay");
    releaseOverlay();
    expect(owningInputScope()).toBe("page");
    releasePage();
    expect(owningInputScope()).toBe("app");
  });

  test("claims are ref-counted, so one release does not drop a shared scope", () => {
    const first = acquireInputScope("overlay");
    const second = acquireInputScope("overlay");
    first();
    expect(owningInputScope()).toBe("overlay");
    second();
    expect(owningInputScope()).toBe("app");
  });

  test("releasing twice is harmless", () => {
    const release = acquireInputScope("modal");
    release();
    release();
    expect(owningInputScope()).toBe("app");
  });

  test("the system layer is consulted whoever owns input", () => {
    const release = acquireInputScope("modal");
    expect(consultedInputScopes()).toContain("system");
    release();
    expect(consultedInputScopes()).toContain("system");
  });
});
