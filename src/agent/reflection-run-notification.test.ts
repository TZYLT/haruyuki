import { describe, expect, test } from "bun:test";
import type { ReflectionRunFinishedEvent } from "@/agent/reflection-run";
import { formatReflectionRunFinishedNotification } from "@/agent/reflection-run-notification";

function event(
  overrides: Partial<ReflectionRunFinishedEvent> = {},
): ReflectionRunFinishedEvent {
  return {
    runId: "reflection-agent-1-abc-def",
    agentId: "agent-1",
    parentConversationId: "conv-parent",
    triggerSource: "compaction",
    status: "succeeded",
    timedOut: false,
    startedAt: 1_000,
    durationMs: 12_500,
    ...overrides,
  };
}

describe("reflection completion notification", () => {
  test("success names the run and the duration", () => {
    const text = formatReflectionRunFinishedNotification(event());
    expect(text).toContain("Reflection finished");
    expect(text).toContain("reflection-agent-1-abc-def");
    expect(text).toContain("13s");
    expect(text).toContain("memory was updated");
  });

  test("timeout carries the backup coordinates and the settings advice", () => {
    const text = formatReflectionRunFinishedNotification(
      event({
        status: "timeout",
        timedOut: true,
        backupRef: "refs/letta-backup/reflection-timeout-x",
        backupPatch: "/tmp/backup/reflection-timeout-x.patch",
      }),
    );
    expect(text).toContain("timed out");
    expect(text).toContain("refs/letta-backup/reflection-timeout-x");
    expect(text).toContain("/tmp/backup/reflection-timeout-x.patch");
    expect(text).toContain("committed memory changes were kept");
    expect(text).toContain("reflectionTimeoutMinutes");
  });

  test("timeout without coordinates still reports the discard", () => {
    const text = formatReflectionRunFinishedNotification(
      event({ status: "timeout", timedOut: true }),
    );
    expect(text).toContain("Uncommitted memory changes were discarded");
    expect(text).not.toContain("backed up");
  });

  test("failure points at the repository and the retained session", () => {
    const text = formatReflectionRunFinishedNotification(
      event({ status: "failed" }),
    );
    expect(text).toContain("Reflection failed");
    expect(text).toContain("/maintenance sessions");
    expect(text).toContain("Uncommitted memory work may still be");
  });

  test("cancellation is distinguished from failure", () => {
    const text = formatReflectionRunFinishedNotification(
      event({ status: "cancelled" }),
    );
    expect(text).toContain("cancelled");
    expect(text).not.toContain("Reflection failed");
  });
});
