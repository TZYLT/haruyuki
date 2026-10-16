import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLog, debugLogFile, resetDebugScreenSuppression } from "./debug";

describe("DebugLogFile", () => {
  let dir: string;
  let previousTelem: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "letta-debug-log-"));
    // The test preload sets HARUYUKI_CODE_TELEM=0, which disables file logging.
    previousTelem = process.env.HARUYUKI_CODE_TELEM;
    process.env.HARUYUKI_CODE_TELEM = "1";
  });

  afterEach(() => {
    if (previousTelem === undefined) {
      delete process.env.HARUYUKI_CODE_TELEM;
    } else {
      process.env.HARUYUKI_CODE_TELEM = previousTelem;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists lines to the agent session file", () => {
    debugLogFile.init("agent-1", "session-1", { dir });
    debugLogFile.appendLine("hello\n");
    const content = readFileSync(join(dir, "agent-1", "session-1.log"), "utf8");
    expect(content).toContain("hello");
  });

  test("stops writing at the size cap and records one truncation notice", () => {
    debugLogFile.init("agent-1", "session-2", { dir, maxBytes: 128 });
    for (let i = 0; i < 50; i++) {
      debugLogFile.appendLine(`line ${i} ${"x".repeat(40)}\n`);
    }
    const path = join(dir, "agent-1", "session-2.log");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("log truncated after 128 bytes");
    // Exactly one notice, no matter how many writes arrive past the cap.
    expect(content.match(/log truncated/g)?.length).toBe(1);
    // Size stays bounded: cap plus at most one in-flight line and the notice.
    expect(statSync(path).size).toBeLessThan(128 + 128 + 128);
  });

  test("a fresh session resets the cap accounting", () => {
    debugLogFile.init("agent-1", "session-3", { dir, maxBytes: 64 });
    for (let i = 0; i < 20; i++) {
      debugLogFile.appendLine(`line ${i} ${"x".repeat(40)}\n`);
    }
    debugLogFile.init("agent-1", "session-4", { dir, maxBytes: 64 });
    debugLogFile.appendLine("fresh session line\n");
    const content = readFileSync(join(dir, "agent-1", "session-4.log"), "utf8");
    expect(content).toContain("fresh session line");
    expect(content).not.toContain("log truncated");
  });
});

/**
 * The interactive session hands the screen to Ink, so a debug line printed to
 * it lands inside the frame that is being drawn (and costs a full repaint). An
 * interactive session is identified by `debugLogFile.init()` having run.
 */
describe("debug screen output", () => {
  let dir: string;
  let errors: string[];
  const restore: (() => void)[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "letta-debug-screen-"));
    resetDebugScreenSuppression();
    errors = [];
    for (const [key, value] of [
      ["HARUYUKI_CODE_TELEM", "1"],
      ["HARUYUKI_DEBUG", "1"],
      ["HARUYUKI_DEBUG_FILE", undefined],
      ["HARUYUKI_DEBUG_SCREEN", undefined],
    ] as const) {
      const previous = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      restore.push(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    const originalError = console.error;
    console.error = ((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    }) as typeof console.error;
    restore.push(() => {
      console.error = originalError;
    });
  });

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
    resetDebugScreenSuppression();
    rmSync(dir, { recursive: true, force: true });
  });

  test("prints to the screen before the session owns the terminal", () => {
    debugLog("test", "before init");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("before init");
  });

  test("stops printing to the screen once init() has run, and still logs to the file", () => {
    debugLogFile.init("agent-1", "session-1", { dir });
    debugLog("test", "after init");
    expect(errors).toEqual([]);
    expect(
      readFileSync(join(dir, "agent-1", "session-1.log"), "utf8"),
    ).toContain("after init");
  });

  test("HARUYUKI_DEBUG_SCREEN=1 keeps the screen output", () => {
    process.env.HARUYUKI_DEBUG_SCREEN = "1";
    debugLogFile.init("agent-1", "session-2", { dir });
    debugLog("test", "forced");
    expect(errors.map((line) => line.includes("forced"))).toEqual([true]);
  });

  test("suppresses the screen even when file logging is disabled", () => {
    // HARUYUKI_CODE_TELEM=0 skips the file, but the screen must still be handed
    // over: the reason is Ink owning the terminal, not telemetry.
    process.env.HARUYUKI_CODE_TELEM = "0";
    debugLogFile.init("agent-1", "session-3", { dir });
    debugLog("test", "no file, no screen");
    expect(errors).toEqual([]);
  });
});
