import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireFullScreenTerminal } from "@/cli/app/shell/full-screen-terminal";
import type { FrameStream } from "@/cli/helpers/terminal-frame";
import {
  isCapturingTerminalFrame,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";
import { resetUiV2Resolution } from "@/experiments/ui-v2";
import { settingsManager } from "@/settings-manager";

/**
 * The frame capture is turned on with the rest of the full-screen hand-over.
 *
 * It has to be wired at the entry, not by a component: Ink writes its first frame
 * inside `render()`, before any React effect runs. These tests pin both halves —
 * the decision is the same one the shell and the alternate screen use, and the
 * capture is only taken for the full-screen shell.
 */

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalUiV2 = process.env.HARUYUKI_UI_V2;

let testHome = "";

function fakeStream(): FrameStream & { isTTY: boolean } {
  return {
    isTTY: true,
    write() {
      return true;
    },
  };
}

beforeEach(async () => {
  await settingsManager.reset();
  resetUiV2Resolution();
  testHome = mkdtempSync(join(tmpdir(), "letta-full-screen-terminal-"));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  delete process.env.HARUYUKI_UI_V2;
  await settingsManager.initialize();
});

afterEach(async () => {
  resetTerminalFrameForTests();
  await settingsManager.reset();
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
    testHome = "";
  }
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalUiV2 === undefined) delete process.env.HARUYUKI_UI_V2;
  else process.env.HARUYUKI_UI_V2 = originalUiV2;
});

describe("full-screen terminal wiring", () => {
  test("captures frames only when the full-screen shell is on", () => {
    const stream = fakeStream();

    expect(wireFullScreenTerminal(stream)).toBe(false);
    expect(isCapturingTerminalFrame()).toBe(false);

    resetUiV2Resolution();
    process.env.HARUYUKI_UI_V2 = "1";
    const fullScreenStream = fakeStream();

    expect(wireFullScreenTerminal(fullScreenStream)).toBe(true);
    expect(isCapturingTerminalFrame()).toBe(true);
  });
});
