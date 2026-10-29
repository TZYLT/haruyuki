import { afterEach, describe, expect, test } from "bun:test";
import { resolveUnattendedApproval } from "@/cron/unattended-approval";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import type { PermissionRules } from "@/permissions/types";

/**
 * The checker applies the shared unattended rule (F-05 M2 F14): the inline copy
 * moved to `@/cron/unattended-approval` so the permission layer and the
 * scheduler cannot drift apart. These tests pin the seam, not the policy — the
 * policy itself is covered by `unattended-ask-deny.test.ts`.
 */

const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };
const WORKING_DIR = "/Users/test/project";

afterEach(() => {
  permissionMode.reset();
});

describe("checker's unattended rule is the shared module's", () => {
  test("an ask is denied with exactly the shared rule's decision and reason", () => {
    const shared = resolveUnattendedApproval("ask");
    const result = checkPermission(
      "Bash",
      { command: "curl http://example.com" },
      NO_RULES,
      WORKING_DIR,
      { mode: "standard", unattended: true },
    );

    expect(result.decision).toBe(shared.decision);
    expect(result.reason).toBe(shared.reason);
  });

  test("without the unattended flag the same call still asks", () => {
    const result = checkPermission(
      "Bash",
      { command: "curl http://example.com" },
      NO_RULES,
      WORKING_DIR,
      { mode: "standard" },
    );

    expect(result.decision).toBe("ask");
  });
});
