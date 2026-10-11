/**
 * The three display tiers (《26》§6.7).
 *
 * The blocks under test are built by the real writer, not by hand: the summary
 * line is derived from the marker, so a reader that only agreed with a
 * hand-written fixture would be exactly the drift this round-trip catches.
 */
import { describe, expect, test } from "bun:test";
import {
  formatRecallBlockForDisplay,
  formatRecallSummaryLine,
  isRecallDisplay,
  RECALL_DISPLAY_DEFAULT,
} from "./recall-display";
import type { RecallDecision, RecallEntry } from "./recall-port";
import { formatRecallReminder } from "./recall-reminder";

function entry(source: "transcript" | "memory", index: number): RecallEntry {
  return source === "transcript"
    ? {
        source,
        fingerprint: `transcript:conv-${index}:m${index}`,
        file: `conv-${index}`,
        conversationKey: `conv-${index}`,
        messageId: `m${index}`,
        timestamp: "2026-10-11T09:00:00.000Z",
        text: `earlier passage ${index}`,
        score: 4,
      }
    : {
        source,
        fingerprint: `memory:reference/notes-${index}.md`,
        file: `reference/notes-${index}.md`,
        startLine: 3,
        endLine: 5,
        text: `memory passage ${index}`,
        score: 3,
      };
}

function blockOf(entries: RecallEntry[]): string {
  const decision: RecallDecision = {
    entries,
    status: "injected",
    diagnostics: { threshold: 1, candidates: entries.length, sources: [] },
  };
  const text = formatRecallReminder(decision);
  if (text === null) throw new Error("the writer produced nothing");
  return text;
}

describe("the display tier", () => {
  test("is a closed set with a summary default", () => {
    expect(RECALL_DISPLAY_DEFAULT).toBe("summary");
    for (const value of ["silent", "summary", "full"] as const) {
      expect(isRecallDisplay(value)).toBe(true);
    }
    for (const value of ["", "quiet", "SUMMARY", undefined, 1, null]) {
      expect(isRecallDisplay(value)).toBe(false);
    }
  });
});

describe("the summary line", () => {
  test("counts what was recalled and from where", () => {
    expect(
      formatRecallSummaryLine({ items: 3, transcript: 2, memory: 1 }),
    ).toBe(
      "↩ recalled 3 passages · 2 earlier conversations · 1 memory passage",
    );
  });

  test("reads correctly with a single passage and a single source", () => {
    expect(
      formatRecallSummaryLine({ items: 1, transcript: 1, memory: 0 }),
    ).toBe("↩ recalled 1 passage · 1 earlier conversation");
    expect(
      formatRecallSummaryLine({ items: 1, transcript: 0, memory: 1 }),
    ).toBe("↩ recalled 1 passage · 1 memory passage");
  });
});

describe("rendering a block for the transcript", () => {
  const block = blockOf([
    entry("transcript", 1),
    entry("transcript", 2),
    entry("memory", 1),
  ]);

  test("silent hides it, expanded or not", () => {
    // The user asked for it never to appear; an unrelated Ctrl+R must not
    // override that.
    expect(
      formatRecallBlockForDisplay({
        text: block,
        display: "silent",
        expanded: false,
      }),
    ).toBeNull();
    expect(
      formatRecallBlockForDisplay({
        text: block,
        display: "silent",
        expanded: true,
      }),
    ).toBeNull();
  });

  test("full shows the text and offers no expansion", () => {
    const rendered = formatRecallBlockForDisplay({
      text: block,
      display: "full",
      expanded: false,
    });
    expect(rendered).toBe(block);
    expect(rendered).toContain("earlier passage 1");
    expect(rendered).not.toContain("ctrl+r");
  });

  test("summary shows one line and keeps the body for the expansion", () => {
    const collapsed = formatRecallBlockForDisplay({
      text: block,
      display: "summary",
      expanded: false,
    });
    expect(collapsed).toBe(
      "▸ ↩ recalled 3 passages · 2 earlier conversations · 1 memory passage (ctrl+r to expand)",
    );
    // The passages are not in the collapsed line: that is the whole point of the
    // tier, since the block is up to 1200 characters of transcript.
    expect(collapsed).not.toContain("earlier passage 1");

    const expanded = formatRecallBlockForDisplay({
      text: block,
      display: "summary",
      expanded: true,
    });
    expect(expanded).toContain("earlier passage 1");
    expect(expanded).toContain("ctrl+r to collapse");
    expect(expanded?.startsWith("↩ recalled 3 passages")).toBe(true);
  });

  test("a block with no readable marker is not summarised", () => {
    // Another reminder in the same envelope: not ours, so there is no summary to
    // invent for it.
    const other = `<system-reminder>\nDisk space is low\n</system-reminder>`;
    expect(
      formatRecallBlockForDisplay({
        text: other,
        display: "summary",
        expanded: false,
      }),
    ).toBeNull();

    // A recall marker missing a required attribute is not trusted either.
    const malformed = `<system-reminder>\n<recall-injected items="2" />\nmade up\n</system-reminder>`;
    expect(
      formatRecallBlockForDisplay({
        text: malformed,
        display: "summary",
        expanded: false,
      }),
    ).toBeNull();

    // The full tier shows the text itself, so it has nothing to parse.
    expect(
      formatRecallBlockForDisplay({
        text: other,
        display: "full",
        expanded: false,
      }),
    ).toBe(other);
  });
});
