import { afterEach, describe, expect, test } from "bun:test";
import {
  clearNotice,
  getNotice,
  resetNoticeForTests,
  showNotice,
  subscribeToNotice,
} from "@/cli/helpers/notice";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  resetNoticeForTests();
});

describe("transient notices", () => {
  test("shows a notice and notifies subscribers", () => {
    const seen: (string | null)[] = [];
    subscribeToNotice(() => {
      seen.push(getNotice());
    });

    showNotice("copied", 0);

    expect(getNotice()).toBe("copied");
    expect(seen).toEqual(["copied"]);
  });

  test("expires on its own, which is what makes it transient", async () => {
    showNotice("copied", 20);
    expect(getNotice()).toBe("copied");

    await wait(60);

    expect(getNotice()).toBeNull();
  });

  test("a newer notice replaces the older one and restarts the clock", async () => {
    showNotice("first", 80);
    await wait(40);
    showNotice("second", 80);

    // The first notice's timer must not take the second one down with it.
    await wait(60);
    expect(getNotice()).toBe("second");

    await wait(60);
    expect(getNotice()).toBeNull();
  });

  test("a notice with no deadline stays until it is cleared", async () => {
    showNotice("pinned", 0);
    await wait(30);
    expect(getNotice()).toBe("pinned");

    clearNotice();
    expect(getNotice()).toBeNull();
  });

  test("clearing an absent notice notifies nobody", () => {
    let calls = 0;
    subscribeToNotice(() => {
      calls += 1;
    });

    clearNotice();

    expect(calls).toBe(0);
  });
});
