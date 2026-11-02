import { describe, expect, test } from "bun:test";
import { needsHiddenWindowsConsole } from "@/tools/impl/shell-launchers";

/**
 * The pipeline-spawn rule behind R-08.1 (T-08).
 *
 * `windowsHide` is not observable from the child, so the decision is a pure
 * function of the executable and the platform: these tests pin the allow-list
 * and, just as importantly, that nothing else gains the flag and that the rule
 * is inert off Windows.
 */
describe("needsHiddenWindowsConsole", () => {
  test("names and absolute paths of the three Windows shells are hidden", () => {
    for (const executable of [
      "pwsh",
      "pwsh.exe",
      "powershell",
      "powershell.exe",
      "cmd",
      "cmd.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Windows\\System32\\cmd.exe",
    ]) {
      expect(needsHiddenWindowsConsole(executable, "win32")).toBe(true);
    }
  });

  test("the launcher list's case does not decide it", () => {
    expect(needsHiddenWindowsConsole("POWERSHELL.EXE", "win32")).toBe(true);
    expect(
      needsHiddenWindowsConsole("C:\\Windows\\System32\\CMD.EXE", "win32"),
    ).toBe(true);
  });

  test("a non-shell child keeps the default console behaviour", () => {
    // `node`, `taskkill` and bash were never implicated in the font flip, and
    // adding the flag there would be an unrequested behaviour change.
    for (const executable of [
      "node",
      "node.exe",
      "taskkill.exe",
      "bash",
      "/bin/bash",
      "git.exe",
    ]) {
      expect(needsHiddenWindowsConsole(executable, "win32")).toBe(false);
    }
  });

  test("off Windows the pipeline rule never fires", () => {
    expect(needsHiddenWindowsConsole("pwsh", "linux")).toBe(false);
    expect(needsHiddenWindowsConsole("cmd.exe", "darwin")).toBe(false);
  });

  test("an empty or separator-only executable is not a shell", () => {
    expect(needsHiddenWindowsConsole("", "win32")).toBe(false);
    expect(needsHiddenWindowsConsole("C:\\", "win32")).toBe(false);
  });
});
