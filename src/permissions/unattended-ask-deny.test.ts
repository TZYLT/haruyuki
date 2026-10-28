import { afterEach, describe, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import type { PermissionRules } from "@/permissions/types";

/**
 * F-05 Q-51: an unattended scheduled run has nobody to answer an approval, so
 * every `ask`/`alwaysAsk` becomes a deny with reason `unattended`. The flag
 * lives on the per-run mode state; an ordinary session never sets it.
 */

const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };
const WORKING_DIR = "/Users/test/project";

afterEach(() => {
  permissionMode.reset();
});

describe("unattended scheduled runs deny instead of asking", () => {
  test("a tool that would ask is denied with reason unattended", () => {
    const result = checkPermission(
      "Bash",
      { command: "curl http://example.com" },
      NO_RULES,
      WORKING_DIR,
      { mode: "standard", unattended: true },
    );

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("unattended");
  });

  test("the same call still asks when the flag is absent", () => {
    const result = checkPermission(
      "Bash",
      { command: "curl http://example.com" },
      NO_RULES,
      WORKING_DIR,
      { mode: "standard" },
    );

    expect(result.decision).toBe("ask");
  });

  test("an allow decision is left alone", () => {
    const result = checkPermission(
      "Read",
      { file_path: "/Users/test/project/README.md" },
      NO_RULES,
      WORKING_DIR,
      { mode: "standard", unattended: true },
    );

    expect(result.decision).toBe("allow");
  });

  test("an alwaysAllow rule is left alone", () => {
    const result = checkPermission(
      "Bash",
      { command: "ls -la" },
      NO_RULES,
      WORKING_DIR,
      { mode: "unrestricted", unattended: true },
    );

    expect(result.decision).toBe("allow");
  });

  test("an explicit deny rule keeps its own reason", () => {
    const result = checkPermission(
      "Bash",
      { command: "rm -rf /" },
      { allow: [], deny: ["Bash(rm -rf:*)"], ask: [] },
      WORKING_DIR,
      { mode: "standard", unattended: true },
    );

    expect(result.decision).toBe("deny");
    expect(result.reason).not.toBe("unattended");
  });

  test("an alwaysAsk rule is denied too", () => {
    const result = checkPermission(
      "Bash",
      { command: "git push" },
      { allow: [], deny: [], ask: ["Bash(git push:*)"] },
      WORKING_DIR,
      { mode: "standard", unattended: true },
    );

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("unattended");
  });
});
