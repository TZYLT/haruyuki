/**
 * The detached-build spawn boundary (48-2 §4.8).
 *
 * `child_process.spawn` reports ENOENT as an asynchronous `error` event and
 * returns a handle with no `pid`; reporting that as a running detached build is
 * the P3 "phantom detached build" bug. These cases pin the guard without
 * leaving a real child behind.
 */

import { describe, expect, test } from "bun:test";
import { spawnDetachedBuildChild } from "./embedding-detached-child";

const OPTIONS = {
  detached: true,
  windowsHide: true,
  stdio: "ignore",
  env: {},
} as const;

describe("spawnDetachedBuildChild", () => {
  test("throws when the command does not exist instead of returning no-pid", () => {
    expect(() =>
      spawnDetachedBuildChild(
        "hryk-embedding-detached-command-that-does-not-exist",
        [],
        OPTIONS,
      ),
    ).toThrow("did not start (no pid)");
  });

  test("returns the handle when the command spawned", () => {
    const child = spawnDetachedBuildChild(
      process.execPath,
      ["-e", "0"],
      OPTIONS,
    );
    try {
      expect(typeof child.pid).toBe("number");
      expect(child.pid).toBeGreaterThan(0);
    } finally {
      child.kill?.("SIGKILL");
    }
  });
});
