import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("headless shared reminder wiring", () => {
  test("one-shot mode builds shared reminders with system-info flag", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain('isSubagent ? "subagent" : "headless-one-shot"');
    expect(source).toContain("systemInfoReminderEnabled,");
  });

  test("post-turn reflection receives the compaction-driven context tracker", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("contextTracker: reminderContextTracker");
    expect(source).toContain("reminderState: sharedReminderState");
  });

  test("headless uses the effective runtime cwd for init events and reminders", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain(
      'import { getCurrentWorkingDirectory } from "./runtime-context";',
    );
    expect(source).toContain("cwd: getCurrentWorkingDirectory()");
    expect(source).toContain("workingDirectory: getCurrentWorkingDirectory()");
    expect(source).toContain(
      "settingsManager.getLocalLastAgentId(\n      getCurrentWorkingDirectory(),",
    );
  });

  test("subagent mode is wired via HARUYUKI_CODE_AGENT_ROLE check", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain(
      'process.env.HARUYUKI_CODE_AGENT_ROLE === "subagent"',
    );
    expect(source).toContain('isSubagent ? "subagent" : "headless-one-shot"');
    expect(source).toContain(
      'isSubagent ? "subagent" : "headless-bidirectional"',
    );
  });

  test("one-shot approval drain uses shared stream processor", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain(
      "const approvalStream = await sendScopedApprovalMessages(",
    );
    expect(source).toContain("await drainStreamWithResume(");
    expect(source).not.toContain("for await (const _ of approvalStream)");
  });

  test("bidirectional mode wires the reflection launcher into the post-turn check", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("const maybeLaunchReflectionSubagent = async (");
    expect(source).toContain("launchReflectionSubagent({");
    expect(source).toContain("reflectionSettings: launchSettings");
    expect(source).toContain("maybeLaunchPostTurnReflection({");
    expect(source).toContain("launch: maybeLaunchReflectionSubagent");
    // F-03 §5.11.2: completions arrive on the run controller's terminal seam,
    // not from an `onCompletionMessage` option (the launcher no longer has one).
    expect(source).toContain("subscribeReflectionRunFinished(");
    expect(source).not.toContain("onCompletionMessage");
    // ...and headless delivers them as a queued task notification.
    expect(source).toContain("formatReflectionRunFinishedNotification(event)");
    expect(source).toContain('kind: "task_notification"');
  });

  test("bidirectional reflection delegates MemFS root resolution to launcher", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).not.toContain("memoryDir: getMemoryFilesystemRoot");
    expect(source).not.toContain("memoryDir: getScopedMemoryFilesystemRoot");
  });

  test("bidirectional mode records successful turns for reflection", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("const userOtid = randomUUID();");
    expect(source).toContain("buffers.userLineIdByOtid.set(userOtid");
    expect(source).toContain("content: enrichedContent, otid: userOtid");
    expect(source).toContain("appendTranscriptDeltaJsonl(");
  });
});
