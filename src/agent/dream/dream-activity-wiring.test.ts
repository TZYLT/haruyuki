/**
 * F-06 idle semantics: where the marker may be written.
 *
 * The behavioural contract lives in `dream-activity.test.ts` (storage and the
 * in-flight window) and `send-message-stream-dream-activity.test.ts` (the
 * dispatch seam). This file pins the *location* the user ruling fixed: the
 * submit handler, the turn-end bookkeeping and the headless exit must not write
 * the marker any more, because typing, a slash command, an approval or a plain
 * file operation is not "the user sent a request to the model".
 *
 * It is deliberately a source assertion: the bug was a call site, and a future
 * edit that puts the call back would otherwise pass every unit test here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function sourceOf(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

const FORMER_CALL_SITES: string[] = [
  "src/cli/app/use-submit-handler.ts",
  "src/cli/app/use-conversation-loop.ts",
  "src/websocket/listener/turn-completion.ts",
  "src/headless.ts",
];

describe("dream activity has one producer", () => {
  test.each(FORMER_CALL_SITES)("%s does not stamp the dream clock", (path) => {
    const source = sourceOf(path);
    expect(source).not.toContain("markDreamActivity");
    expect(source).not.toContain("markDreamTurnInFlight");
    expect(source).not.toContain("finishDreamTurn");
  });

  test("the dispatch seam is the writer", () => {
    const source = sourceOf("src/agent/message.ts");
    expect(source).toContain("shouldRecordDreamActivity");
    expect(source).toContain("markDreamTurnInFlight");
    expect(source).toContain("finishDreamTurn");
  });

  test("automated TUI and listener turns are classified at their turn boundary", () => {
    expect(sourceOf("src/cli/app/use-submit-handler.ts")).toContain(
      "automatedTurn",
    );
    expect(sourceOf("src/cli/app/use-conversation-loop.ts")).toContain(
      "automatedTurn",
    );
    expect(sourceOf("src/websocket/listener/queue.ts")).toContain(
      "automatedTurn",
    );
  });
});
