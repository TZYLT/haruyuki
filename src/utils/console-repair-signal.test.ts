import { afterEach, describe, expect, test } from "bun:test";
import {
  requestConsoleRepairCheck,
  setConsoleRepairHandler,
} from "@/utils/console-repair-signal";

/**
 * The tools → CLI font-repair signal (T-08).
 *
 * The pinned behaviour is the *absence* of behaviour: no handler must mean a
 * silent no-op, because the emitter lives in the shell tool and runs on every
 * platform, including the ones with no console guard at all. The rest pins the
 * registration lifecycle W-06 relies on (one handler, replaceable, clearable).
 */

afterEach(() => {
  setConsoleRepairHandler(null);
});

describe("the console repair signal", () => {
  test("a request with no handler is a no-op", () => {
    expect(() => requestConsoleRepairCheck()).not.toThrow();
  });

  test("a registered handler sees every request", () => {
    let calls = 0;
    setConsoleRepairHandler(() => {
      calls += 1;
    });
    requestConsoleRepairCheck();
    requestConsoleRepairCheck();
    expect(calls).toBe(2);
  });

  test("registering replaces the previous handler", () => {
    const calls: string[] = [];
    setConsoleRepairHandler(() => calls.push("first"));
    setConsoleRepairHandler(() => calls.push("second"));
    requestConsoleRepairCheck();
    expect(calls).toEqual(["second"]);
  });

  test("clearing the handler stops delivery", () => {
    let calls = 0;
    setConsoleRepairHandler(() => {
      calls += 1;
    });
    requestConsoleRepairCheck();
    setConsoleRepairHandler(null);
    requestConsoleRepairCheck();
    expect(calls).toBe(1);
  });
});
