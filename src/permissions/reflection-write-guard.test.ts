import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCurrentAgentId } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  attachReflectionTask,
  finishReflectionRun,
  resetReflectionRuns,
  startReflectionRun,
} from "@/agent/reflection-run";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import { checkReflectionWriteBlock } from "@/permissions/reflection-write-guard";

const AGENT_ID = "agent-reflection-guard-test";
const OTHER_AGENT_ID = "agent-reflection-guard-other";
const ENV_KEYS = [
  "HARUYUKI_HOME",
  "HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL",
] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;
let memoryDir: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "reflection-guard-"));
  process.env.HARUYUKI_HOME = home;
  delete process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
  permissionMode.setMode("standard");
  memoryDir = getScopedMemoryFilesystemRoot(AGENT_ID);
  mkdirSync(join(memoryDir, "system"), { recursive: true });
});

afterEach(() => {
  resetReflectionRuns();
  setCurrentAgentId(null);
  permissionMode.reset();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function startRun(agentId = AGENT_ID): string {
  const run = startReflectionRun({
    agentId,
    parentConversationId: "conv-parent",
    triggerSource: "manual",
    timeoutMinutes: 3,
  });
  attachReflectionTask(run.runId, {
    taskId: `task-${run.runId}`,
    abort: () => {},
  });
  return run.runId;
}

const guard = (
  toolName: string,
  toolArgs: Record<string, unknown>,
  agentId: string | null = AGENT_ID,
) =>
  checkReflectionWriteBlock({
    toolName,
    toolArgs,
    agentId,
    workingDirectory: "/Users/test/project",
  });

describe("reflection write guard", () => {
  test("blocks Write, Edit and ApplyPatch inside the reflecting agent's memory", () => {
    startRun();
    for (const toolName of ["Write", "Edit"]) {
      const block = guard(toolName, {
        file_path: join(memoryDir, "system", "user.md"),
      });
      expect(block?.blocked).toBe(true);
      expect(block?.message).toStartWith("Permission denied:");
      expect(block?.message).toContain("memory repository");
    }
    const patched = guard("ApplyPatch", {
      input: `*** Begin Patch\n*** Update File: ${join(memoryDir, "notes.md")}\n*** End Patch`,
    });
    expect(patched?.blocked).toBe(true);
  });

  test("blocks an ApplyPatch that touches the memory repository among other files", () => {
    startRun();
    const block = guard("ApplyPatch", {
      input: [
        "*** Begin Patch",
        `*** Update File: ${join(memoryDir, "persona.md")}`,
        "*** Update File: /Users/test/project/src/app.ts",
        "*** End Patch",
      ].join("\n"),
    });
    expect(block?.blocked).toBe(true);
    expect(block?.message).toContain("persona.md");
  });

  test("never blocks reads, writes outside the repository, or shell commands", () => {
    startRun();
    expect(
      guard("Read", { file_path: join(memoryDir, "persona.md") }),
    ).toBeNull();
    expect(
      guard("Write", { file_path: "/Users/test/project/notes.md" }),
    ).toBeNull();
    expect(guard("Bash", { cmd: "git -C . commit -m wip" })).toBeNull();
    expect(guard("Glob", { pattern: "**/*.md" })).toBeNull();
  });

  test("does nothing when no reflection run is active", () => {
    expect(
      guard("Write", { file_path: join(memoryDir, "persona.md") }),
    ).toBeNull();
  });

  test("does nothing for a different agent's run", () => {
    startRun(OTHER_AGENT_ID);
    expect(
      guard("Write", { file_path: join(memoryDir, "persona.md") }),
    ).toBeNull();
  });

  test("falls back to the ambient agent when the input carries none", () => {
    startRun();
    setCurrentAgentId(AGENT_ID);
    const block = guard(
      "Write",
      { file_path: join(memoryDir, "persona.md") },
      null,
    );
    expect(block?.blocked).toBe(true);
  });

  test("allows writes again once the run finished", async () => {
    const runId = startRun();
    await finishReflectionRun(runId, "succeeded");
    expect(
      guard("Write", { file_path: join(memoryDir, "persona.md") }),
    ).toBeNull();
  });
});

describe("permission checker with an active reflection run", () => {
  const check = (
    toolName: string,
    toolArgs: Record<string, unknown>,
    modeState?: {
      mode: "standard" | "acceptEdits" | "unrestricted" | "strict";
    },
  ) =>
    checkPermission(
      toolName,
      toolArgs,
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
      modeState as never,
      AGENT_ID,
    );

  test("denies memory writes in every permission mode", () => {
    startRun();
    for (const mode of ["standard", "acceptEdits", "unrestricted"] as const) {
      const result = check(
        "Edit",
        { file_path: join(memoryDir, "persona.md") },
        { mode },
      );
      expect(result.decision).toBe("deny");
      expect(result.reason).toStartWith("Permission denied:");
      expect(result.matchedRule).toBe(
        "reflection run owns the memory repository",
      );
    }
  });

  test("denies even when an explicit allow rule matches", () => {
    startRun();
    const result = checkPermission(
      "Write",
      { file_path: join(memoryDir, "persona.md") },
      { allow: ["Write"], deny: [], ask: [] },
      "/Users/test/project",
      undefined,
      AGENT_ID,
    );
    expect(result.decision).toBe("deny");
  });

  test("leaves reads, other paths and Bash alone", () => {
    startRun();
    expect(
      check("Read", { file_path: join(memoryDir, "persona.md") }).decision,
    ).not.toBe("deny");
    expect(
      check("Edit", { file_path: "/Users/test/project/src/app.ts" }).decision,
    ).not.toBe("deny");
    expect(check("Bash", { cmd: "echo hello" }).decision).not.toBe("deny");
  });

  test("auto-allows own-memory writes again after the run ends", async () => {
    const runId = startRun();
    await finishReflectionRun(runId, "succeeded");
    const result = check("Edit", { file_path: join(memoryDir, "persona.md") });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Agent memory directory operation");
  });
});
