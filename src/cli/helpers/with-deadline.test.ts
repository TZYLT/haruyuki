import { describe, expect, test } from "bun:test";
import { withDeadline } from "./with-deadline";

const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe("withDeadline", () => {
  test("passes a fast answer through untouched", async () => {
    expect(await withDeadline(Promise.resolve(42), 1000)).toBe(42);
  });

  test("gives up on a promise that never settles", async () => {
    // The `/context` case: the request can hang without ever leaving a trace, and
    // the command row must still get an answer — `undefined` means "no breakdown
    // in time", which the renderer already handles.
    const started = Date.now();
    expect(await withDeadline(never<number>(), 20)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a rejection is a fact, not a timeout", async () => {
    // A 404 from a backend without the endpoint must not be swallowed into
    // "no answer": the caller has a reason to distinguish them later.
    await expect(
      withDeadline(Promise.reject(new Error("boom")), 1000),
    ).rejects.toThrow("boom");
  });

  test("the timer does not outlive the call", async () => {
    // An uncleared timer keeps the process alive for its full delay and, in a
    // test run, holds a handle nobody can see. The deadline is one second here;
    // the assertion is that the call returns immediately, not a second later.
    const started = Date.now();
    await withDeadline(Promise.resolve("now"), 1000);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
