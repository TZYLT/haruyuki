import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The three interactive submit paths have to hand the recall provider the user's
 * own words (`SharedReminderContext.userInputText`), and two of them are hooks that
 * cannot be driven in a test: `use-submit-handler.ts` is a React callback with the
 * whole coordinator behind it, and `handleHeadlessCommand` runs the CLI.
 *
 * So this pins the call sites themselves, which is how the repository already
 * guards cross-file wiring of this shape (see
 * `src/cli/app/reflection-transcript-wiring.test.ts`). The listener path is not
 * asserted here: it has a real end-to-end test in
 * `src/websocket/listener/turn-setup-recall.test.ts`.
 */

const READ_WINDOW = 1200;

function sourceOf(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf-8",
  );
}

/** The text of every `buildSharedReminderParts(...)` call in a source file. */
function reminderCallSites(source: string): string[] {
  const calls: string[] = [];
  let index = source.indexOf("buildSharedReminderParts(");
  while (index !== -1) {
    calls.push(source.slice(index, index + READ_WINDOW));
    index = source.indexOf("buildSharedReminderParts(", index + 1);
  }
  return calls;
}

describe("recall injection wiring", () => {
  const paths: Array<[string, string, number]> = [
    ["the TUI submit path", "../cli/app/use-submit-handler.ts", 1],
    ["the headless one-shot path", "../headless.ts", 2],
    ["the websocket listener path", "../websocket/listener/turn-setup.ts", 1],
  ];

  for (const [label, path, expectedCalls] of paths) {
    test(`${label} supplies the turn's user text`, () => {
      const calls = reminderCallSites(sourceOf(path));
      expect(calls).toHaveLength(expectedCalls);
      for (const call of calls) {
        expect(call).toContain("userInputText");
      }
    });
  }

  test("the TUI searches with the notification-free text", () => {
    const source = sourceOf("../cli/app/use-submit-handler.ts");
    expect(source).toContain("const userTextForInput = cleanedText.trim();");
    expect(source).toContain("userInputText: userTextForInput,");
  });

  test("headless searches with a user prompt and not with automation", () => {
    const source = sourceOf("../headless.ts");
    // One-shot: an agent-launched prompt is agent-to-agent traffic, not a user.
    expect(source).toContain(
      'isAgentLaunch || values["from-agent"] ? undefined : prompt,',
    );
    // Bidirectional: only queued inputs that came from the user count.
    expect(source).toContain(
      'queuedInputs.filter((input) => input.kind === "user")',
    );
  });

  test("the listener context passes the text through", () => {
    const source = sourceOf("./listen-context.ts");
    expect(source).toContain("userInputText?: string;");
    expect(source).toContain("userInputText: params.userInputText,");
  });

  test("the TUI shows the turn's injection as its own committed row", () => {
    const source = sourceOf("../cli/app/use-submit-handler.ts");
    const append = source.indexOf("appendRecallLine(");
    expect(append).toBeGreaterThan(-1);
    // The user row has to exist first, and `transcriptStartLineIndex` has to have
    // been taken already: appending before that would move the index off the user's
    // line and into the recall row.
    expect(source.indexOf("appendOptimisticUserLine(")).toBeLessThan(append);
    expect(source.indexOf("transcriptStartLineIndex")).toBeLessThan(append);
  });

  test("the recall row commits without waiting for a phase", () => {
    // Only the kinds listed here are promoted to the transcript without a `phase`;
    // anything else would sit in the buffers and never be printed.
    const source = sourceOf("../cli/app/AppCoordinator.tsx");
    const list = source.indexOf('ln.kind === "user" ||');
    expect(list).toBeGreaterThan(-1);
    expect(source.slice(list, list + 300)).toContain('ln.kind === "recall" ||');
  });

  test("the transcript renders the recall row", () => {
    expect(sourceOf("../cli/app/StaticTranscript.tsx")).toContain(
      'item.kind === "recall"',
    );
  });
});
