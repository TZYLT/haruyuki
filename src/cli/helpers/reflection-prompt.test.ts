import { describe, expect, test } from "bun:test";
import { buildReflectionTaskMessage } from "@/cli/helpers/reflection-prompt";

const runId = "reflection-agent-1-abc123-xyz";

describe("buildReflectionTaskMessage", () => {
  test("appends one message carrying the persona, the assignment and the run id", () => {
    const message = buildReflectionTaskMessage({ runId });

    // Persona and job come from reflection-v3.md …
    expect(message).toContain(
      "You are the reflection subagent for this conversation.",
    );
    expect(message).toContain("You are not the primary agent.");
    expect(message).toContain("## Your job");
    // … the per-run parts are appended after it.
    expect(message).toContain("## This assignment");
    expect(message).toContain(`Run id: ${runId}`);
    expect(message.trim().length).toBeGreaterThan(0);
    // One message: no paragraph asks the reader to fetch a transcript file.
    expect(message).toContain("there is no transcript file to read");
    expect(message).not.toContain("read it via Bash (e.g. `wc -c");
  });

  test("adds the user instruction as its own section only when present", () => {
    const without = buildReflectionTaskMessage({ runId });
    const withInstruction = buildReflectionTaskMessage({
      runId,
      instruction: "  focus on the migration plan  ",
    });

    expect(without).not.toContain("Additional instruction from the user");
    expect(withInstruction).toContain(
      "## Additional instruction from the user",
    );
    expect(withInstruction).toContain("focus on the migration plan");
    // The instruction is trimmed and does not relax the durable-only rule.
    expect(withInstruction).not.toContain("  focus on the migration plan  ");
    expect(withInstruction).toContain("It does not relax the rules above");
  });

  test("describes the memory layout the repo actually uses", () => {
    const v1 = buildReflectionTaskMessage({ runId, memoryFormat: "memfs-v1" });
    const v2 = buildReflectionTaskMessage({ runId, memoryFormat: "memfs-v2" });

    expect(v1).toContain("`system/` folder");
    expect(v2).toContain("Root Markdown files are in-context memory");
    expect(v2).not.toContain("`system/` folder");
  });

  test("keeps the tool and commit contract in the message", () => {
    const message = buildReflectionTaskMessage({ runId });

    expect(message).toContain("Use **Edit** for files that already exist");
    expect(message).toContain("git commit");
    expect(message).toContain("Do not pass `--no-verify`");
  });
});
