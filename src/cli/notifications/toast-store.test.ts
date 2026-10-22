import { afterEach, describe, expect, test } from "bun:test";
import {
  clearToasts,
  getToastSnapshot,
  MAX_VISIBLE_TOASTS,
  pushToast,
  resetToastsForTests,
  subscribeToToasts,
} from "@/cli/notifications/toast-store";

/**
 * The band's four promises (`docs/38` §15.2): three seconds, three rows, the
 * oldest folded away and counted, and nothing left behind once the last one
 * leaves. The timers are real but short — the store takes its deadline as an
 * argument, which is the same seam `helpers/notice.ts` uses.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  resetToastsForTests();
});

describe("the toast band", () => {
  test("shows a toast, notifies once, and hands out a stable snapshot", () => {
    const seen: number[] = [];
    subscribeToToasts(() => {
      seen.push(getToastSnapshot().toasts.length);
    });

    const before = getToastSnapshot();
    pushToast("turn done", 0);

    expect(getToastSnapshot().toasts.map((toast) => toast.text)).toEqual([
      "turn done",
    ]);
    expect(seen).toEqual([1]);
    // Identity is what `useSyncExternalStore` compares, so an unchanged band has
    // to hand back the same object.
    expect(getToastSnapshot()).not.toBe(before);
    expect(getToastSnapshot()).toBe(getToastSnapshot());
  });

  test("the newest toast is the last row, closest to the input", () => {
    pushToast("first", 0);
    pushToast("second", 0);

    expect(getToastSnapshot().toasts.map((toast) => toast.text)).toEqual([
      "first",
      "second",
    ]);
  });

  test("a blank toast is not a toast", () => {
    const seen: number[] = [];
    subscribeToToasts(() => seen.push(1));

    pushToast("   ", 0);
    pushToast("", 0);

    expect(getToastSnapshot().toasts).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("leaves on its own after its deadline", async () => {
    pushToast("turn done", 20);
    expect(getToastSnapshot().toasts).toHaveLength(1);

    await wait(60);

    expect(getToastSnapshot().toasts).toEqual([]);
  });

  test("a toast with no deadline stays until it is cleared", async () => {
    pushToast("pinned", 0);
    await wait(20);
    expect(getToastSnapshot().toasts).toHaveLength(1);

    clearToasts();
    expect(getToastSnapshot().toasts).toEqual([]);
  });

  test("caps the band and counts what it folded", () => {
    for (let index = 0; index < MAX_VISIBLE_TOASTS; index += 1) {
      pushToast(`toast ${index}`, 0);
    }
    expect(getToastSnapshot()).toMatchObject({ folded: 0 });

    pushToast("latest", 0);

    const { toasts, folded } = getToastSnapshot();
    expect(toasts.map((toast) => toast.text)).toEqual([
      "toast 1",
      "toast 2",
      "latest",
    ]);
    expect(folded).toBe(1);
  });

  test("the fold count goes away with the band it described", () => {
    for (let index = 0; index < MAX_VISIBLE_TOASTS + 1; index += 1) {
      pushToast(`toast ${index}`, 0);
    }
    expect(getToastSnapshot().folded).toBe(1);

    clearToasts();

    expect(getToastSnapshot()).toEqual({ toasts: [], folded: 0 });
  });

  test("one toast expiring does not take the others with it", async () => {
    pushToast("short", 20);
    pushToast("long", 0);

    await wait(60);

    expect(getToastSnapshot().toasts.map((toast) => toast.text)).toEqual([
      "long",
    ]);
  });
});
