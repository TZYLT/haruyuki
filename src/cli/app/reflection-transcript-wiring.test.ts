import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("interactive reflection transcript wiring", () => {
  test("coordinator wires the reflection launcher into the post-turn check", () => {
    const coordinatorPath = fileURLToPath(
      new URL("./AppCoordinator.tsx", import.meta.url),
    );
    const source = readFileSync(coordinatorPath, "utf-8");

    expect(source).toContain("const maybeRunPostTurnReflection = useCallback(");
    expect(source).toContain("maybeLaunchPostTurnReflection({");
    expect(source).toContain("launchReflectionSubagent({");
  });

  test("conversation loop evaluates reflection after the transcript append on end_turn", () => {
    const conversationLoopPath = fileURLToPath(
      new URL("./use-conversation-loop.ts", import.meta.url),
    );
    const loopSource = readFileSync(conversationLoopPath, "utf-8");

    const endTurnIndex = loopSource.indexOf(
      'if (stopReasonToHandle === "end_turn")',
    );
    // The append itself lives in `transcript-delta.ts` (extracted when the
    // ledger needed room); the loop's contract is that it happens inside the
    // end_turn branch, before reflection is evaluated.
    const appendIndex = loopSource.indexOf(
      "await appendTurnTranscriptDelta({",
      endTurnIndex,
    );
    const reflectionIndex = loopSource.indexOf(
      "await maybeRunPostTurnReflection();",
      endTurnIndex,
    );

    expect(endTurnIndex).toBeGreaterThanOrEqual(0);
    expect(appendIndex).toBeGreaterThan(endTurnIndex);
    expect(reflectionIndex).toBeGreaterThan(appendIndex);
  });

  test("manual /compact restores context before launching reflection", () => {
    const compactPath = fileURLToPath(
      new URL("./submit-compact-commands.ts", import.meta.url),
    );
    const source = readFileSync(compactPath, "utf-8");
    // Both paths (the local `prepare → apply` and the cloud compaction) must
    // finish the context rewrite before the reminder is marked and reflection
    // launches. The local anchor is the apply call: the preview is in memory until
    // it lands, and that await is the moment the context actually changed.
    const localApplyIndex = source.indexOf(
      "const result = await runtime.apply({ preview, pick });",
    );
    const cloudCompactIndex = source.indexOf(
      "await getBackend().compactConversationMessages(",
    );
    const afterIndex = source.lastIndexOf(
      "await afterCompaction(ctx, conversationId)",
    );
    const afterDefinitionIndex = source.indexOf(
      "async function afterCompaction(",
    );
    // The reminder, the reflection launch and the description refresh live in the
    // shared tail (L-18): `afterCompaction` is defined before it is called after
    // each rewrite, and it delegates to the tail, which owns the order.
    const tailCallIndex = source.indexOf("runPostCompactionTail({");
    const reflectIndex = source.indexOf("reflect: () =>");

    expect(localApplyIndex).toBeGreaterThanOrEqual(0);
    expect(cloudCompactIndex).toBeGreaterThanOrEqual(0);
    expect(afterIndex).toBeGreaterThan(localApplyIndex);
    expect(afterIndex).toBeGreaterThan(cloudCompactIndex);
    expect(afterDefinitionIndex).toBeGreaterThanOrEqual(0);
    expect(afterDefinitionIndex).toBeLessThan(afterIndex);
    expect(tailCallIndex).toBeGreaterThan(afterDefinitionIndex);
    expect(reflectIndex).toBeGreaterThan(tailCallIndex);
    expect(source).toContain('triggerSource: "compaction"');

    const tailSource = readFileSync(
      fileURLToPath(new URL("../helpers/post-compaction.ts", import.meta.url)),
      "utf-8",
    );
    const reminderIndex = tailSource.indexOf(
      "markPostCompactionContextRemindersPending(",
    );
    const tailReflectIndex = tailSource.indexOf("input.reflect();");
    const descriptionIndex = tailSource.indexOf(
      "input.regenerateDescription();",
    );
    // Ordering inside the tail: mark -> reflect -> regenerate.
    expect(reminderIndex).toBeGreaterThanOrEqual(0);
    expect(tailReflectIndex).toBeGreaterThan(reminderIndex);
    expect(descriptionIndex).toBeGreaterThan(tailReflectIndex);

    const submitHandlerSource = readFileSync(
      fileURLToPath(new URL("./use-submit-handler.ts", import.meta.url)),
      "utf-8",
    );
    expect(submitHandlerSource).not.toContain(
      "queuePendingReflectionWorktreeReminders",
    );
    expect(submitHandlerSource).not.toContain(
      "pendingReflectionTrigger = true",
    );
  });

  test("successful TUI turns append user and assistant rows to the reflection transcript", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./use-submit-handler.ts", import.meta.url),
    );
    const conversationLoopPath = fileURLToPath(
      new URL("./use-conversation-loop.ts", import.meta.url),
    );
    const transcriptDeltaPath = fileURLToPath(
      new URL("./transcript-delta.ts", import.meta.url),
    );
    const submitSource = readFileSync(submitHandlerPath, "utf-8");
    const loopSource = readFileSync(conversationLoopPath, "utf-8");
    const deltaSource = readFileSync(transcriptDeltaPath, "utf-8");

    expect(submitSource).toContain(
      "const transcriptStartLineIndex = userTextForInput",
    );
    expect(submitSource).toContain("transcriptStartLineIndex,");
    expect(loopSource).toContain("const transcriptTurnStartLineIndex =");
    expect(loopSource).toContain('if (stopReasonToHandle === "end_turn")');
    expect(loopSource).toContain("await appendTurnTranscriptDelta({");
    // The slice and the JSONL writer are the extracted module's job now.
    expect(deltaSource).toContain("toLines(input.buffers).slice(");
    expect(deltaSource).toContain("input.write ?? appendTranscriptDeltaJsonl");

    expect(
      loopSource.indexOf('if (stopReasonToHandle === "end_turn")'),
    ).toBeLessThan(loopSource.indexOf("await appendTurnTranscriptDelta({"));
  });
});
