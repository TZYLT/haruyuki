/**
 * The dream-run tool allowance (F-06 Q-53).
 *
 * The allowance must be exactly two things: enough for an unattended child to
 * commit its own memory, and impossible for an ordinary session to acquire.
 * The context comes from the conversation record's `origin: "dream"`, threaded
 * through the runtime context by `tools/toolset.ts`; these cases pin the
 * permission side.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import type { PermissionRules } from "@/permissions/types";
import { runWithRuntimeContext } from "@/runtime-context";

const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };
const WORKING_DIR = "/tmp/haruyuki-dream-permission";
const AGENT_ID = "agent-dream-permission";

function decide(
  toolName: string,
  mode: "standard" | "acceptEdits" | "unrestricted" | "strict",
  dreamRun: boolean,
  rules: PermissionRules = NO_RULES,
) {
  return runWithRuntimeContext(
    { agentId: AGENT_ID, dreamRun },
    () =>
      checkPermission(toolName, {}, rules, WORKING_DIR, { mode }, AGENT_ID)
        .decision,
  );
}

afterEach(() => {
  permissionMode.reset();
});

describe("dream tool allowance", () => {
  test("MemoryCommit is allowed inside a dream run under acceptEdits", () => {
    expect(decide("MemoryCommit", "acceptEdits", true)).toBe("allow");
    expect(decide("MemoryCommit", "standard", true)).toBe("allow");
  });

  test("the same call asks outside a dream run", () => {
    expect(decide("MemoryCommit", "acceptEdits", false)).toBe("ask");
    expect(decide("MemoryCommit", "unrestricted", false)).toBe("allow");
  });

  test("strict mode still asks inside a dream run", () => {
    // Strict is not one of the three dream permission tiers; if it is ever
    // passed, the unattended child must fail rather than silently widen.
    expect(decide("MemoryCommit", "strict", true)).toBe("ask");
  });

  test("an explicit deny rule wins over the dream allowance", () => {
    expect(
      decide("MemoryCommit", "acceptEdits", true, {
        allow: [],
        deny: ["MemoryCommit"],
        ask: [],
      }),
    ).toBe("deny");
  });

  test("the allowance does not leak to other tools", () => {
    expect(decide("Bash", "acceptEdits", true)).toBe("ask");
    // acceptEdits keeps its own override for edit tools.
    expect(
      runWithRuntimeContext({ agentId: AGENT_ID, dreamRun: true }, () =>
        checkPermission(
          "Write",
          { file_path: `${WORKING_DIR}/MEMORY.md` },
          NO_RULES,
          WORKING_DIR,
          { mode: "acceptEdits" },
          AGENT_ID,
        ),
      ).decision,
    ).toBe("allow");
  });
});
