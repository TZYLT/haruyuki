import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getRecoverableStatusNoticeVisibility } from "@/websocket/listener/recoverable-notices";

/**
 * The three surfaces that can show the user a recall line, pinned at their call
 * sites.
 *
 * The provider parks one notice on the shared reminder state; who prints it is a
 * per-surface decision, and two of the three live in files a test cannot drive —
 * `headless.ts` runs the CLI, and `turn.ts` needs a socket, a lease and a live
 * turn. The listener's own end-to-end coverage is in
 * `src/websocket/listener/turn-setup-recall.test.ts`, which proves the provider
 * runs in that path; this file proves the line has somewhere to go afterwards.
 */

function sourceOf(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf-8",
  );
}

describe("recall notice wiring", () => {
  test("the TUI prints the line from the shared reminder state", () => {
    const source = sourceOf("../cli/app/submit-compact-commands.ts");
    // Same mechanism as the topic nudge, which is the repository's precedent for
    // "the engine parks it, the TUI prints it once".
    expect(source).toContain(
      "takePendingRecallNotice(ctx.sharedReminderStateRef.current)",
    );
    expect(source).toContain("reportPendingRecallNotice(ctx);");
  });

  test("headless prints the line to stderr on both paths", () => {
    const source = sourceOf("../headless.ts");
    // Two call sites: the one-shot prompt and the bidirectional queue drain.
    expect(
      source.match(/reportRecallNoticeToStderr\(sharedReminderState\)/g),
    ).toHaveLength(2);
    expect(source).toContain(
      "if (notice) console.error(formatRecallNoticeLine(notice));",
    );
  });

  test("the listener emits the line through the status-notice channel", () => {
    const source = sourceOf("../websocket/listener/turn.ts");
    expect(source).toContain("takePendingRecallNotice(runtime.reminderState)");
    expect(source).toContain('kind: "recall_degraded"');
    // The turn owns the socket, so it must be the one that emits.
    expect(source).toContain("formatRecallNoticeLine(recallNotice)");
  });

  test("the recall notice is transcript-visible, not debug-only", () => {
    // A turn that went out without the passages the user expected is something
    // the user has to be able to see (《26》§6.5).
    expect(getRecoverableStatusNoticeVisibility("recall_degraded")).toBe(
      "transcript",
    );
  });
});
