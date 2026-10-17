import { describe, expect, test } from "bun:test";
import {
  stopUntilResumed,
  waitForResumeSignal,
} from "@/cli/hooks/useSuspend/use-suspend.ts";

async function withTimeout<T>(
  promise: Promise<T>,
  ms = 50,
): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
}

describe("waitForResumeSignal", () => {
  test("resolves on the next SIGCONT", async () => {
    const resumed = waitForResumeSignal();
    process.emit("SIGCONT");
    await expect(resumed).resolves.toBeUndefined();
  });

  test("ignores an unrelated signal", async () => {
    const resumed = waitForResumeSignal();
    process.emit("SIGWINCH");
    expect(await withTimeout(resumed)).toBe("timeout");

    // The listener is still armed, so the eventual SIGCONT still releases it.
    process.emit("SIGCONT");
    await expect(resumed).resolves.toBeUndefined();
  });
});

describe("stopUntilResumed", () => {
  test("arms the resume listener before asking the process to stop", () => {
    const order: string[] = [];

    void stopUntilResumed(
      () => {
        order.push("stop");
      },
      () => {
        order.push("wait");
        return Promise.resolve();
      },
    );

    expect(order).toEqual(["wait", "stop"]);
  });

  test("resolves when the stop is synchronous and the resume arrives first", async () => {
    // A self-delivered SIGTSTP stops the process inside `stop()`: no JS runs
    // while stopped, so the matching SIGCONT is handled before `stop()`
    // returns. Only a listener armed *before* the stop can observe it — arming
    // afterwards waits forever and leaves the terminal handed over.
    const waiting: Array<() => void> = [];
    let stopReturned = false;
    let resumedDuringStop = false;

    const stop = () => {
      for (const notify of waiting.splice(0)) {
        notify();
      }
      resumedDuringStop = true;
      stopReturned = true;
    };
    const waitForResume = () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
      });

    const outcome = await withTimeout(stopUntilResumed(stop, waitForResume));

    expect(stopReturned).toBe(true);
    expect(resumedDuringStop).toBe(true);
    expect(outcome).not.toBe("timeout");
  });

  test("resolves on the watchdog when SIGCONT never arrives", async () => {
    // The container case: there is no controlling terminal, so the stop is a no-op
    // and nothing will ever send `SIGCONT`. Ink restores the terminal only when the
    // callback it was given settles, so a hand-over that never settles is a terminal
    // left handed over with no way back.
    let stopped = false;
    const outcome = await withTimeout(
      stopUntilResumed(
        () => {
          stopped = true;
        },
        () => new Promise<void>(() => {}), // never resumed
        20,
      ),
      200,
    );

    expect(stopped).toBe(true);
    expect(outcome).toBeUndefined();
  });

  test("a real resume wins over the watchdog", async () => {
    // The watchdog must not turn a normal resume into a late one: it resolves only if
    // the signal promise has not settled first, and clearing its timer is what keeps a
    // parked `Ctrl+Z` from restoring the terminal a second time.
    let resumed = false;
    const outcome = await withTimeout(
      stopUntilResumed(
        () => {},
        () => {
          resumed = true;
          return Promise.resolve();
        },
        1000,
      ),
      200,
    );

    expect(resumed).toBe(true);
    expect(outcome).toBeUndefined();
  });
});
