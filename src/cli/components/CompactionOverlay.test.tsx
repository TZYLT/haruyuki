import { afterEach, describe, expect, test } from "bun:test";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import { CompactionOverlay } from "@/cli/components/CompactionOverlay";
import {
  clearTopicTrimRequest,
  setCompactionPreparingRequest,
  setTopicTrimRequest,
} from "@/cli/helpers/topic-trim-request";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The "compaction" slot, judged on the frame.
 *
 * The face has three states and one mount, and the mount is what matters: a
 * summarizer with no wall-clock timeout needs a visible elapsed time and a
 * working Esc (§5.2.6, Q-38), and the picker that follows must replace it in
 * place — a remount between them would drop a frame and, on a `<Static>` host,
 * risk a double print.
 *
 * The request is parked through the same store the submit handler uses, so these
 * tests exercise the real wiring rather than a prop that production never passes.
 */

const ESCAPE = "\u001B";

function block(index: number, title: string): TopicBlock {
  return {
    index,
    title,
    markerId: `m${index}`,
    createdBy: "user",
    anchorMessageId: `a${index}`,
    absorbedTitles: [],
    boundaryMessageId: `message-${index}`,
    startIndex: index,
    endIndex: index + 1,
    rewindTurns: 0,
    startMarkerAnchorMessageId: null,
    messageCount: 2,
    tokens: 40,
    startsAt: "2026-10-03T09:31:00.000Z",
    sparse: false,
  };
}

function mount(options: { onCancel?: () => void } = {}) {
  return mountInkTty(
    <CompactionOverlay
      settings={undefined}
      onSave={() => {}}
      onCancel={options.onCancel ?? (() => {})}
    />,
    { columns: 100, rows: 24 },
  );
}

afterEach(() => {
  clearTopicTrimRequest();
  resetInkTtyState();
});

describe("the preparing face", () => {
  test("shows the elapsed time and how to leave", async () => {
    // Started five seconds ago, so the frame has a number to show that a static
    // "0s" could not be mistaken for.
    setCompactionPreparingRequest({
      startedAt: Date.now() - 5_000,
      onCancel: () => {},
    });
    const tty = mount();
    try {
      const painted = await tty.text();
      expect(painted).toContain("Preparing the compaction");
      expect(painted).toContain("Summarizing this conversation's older topics");
      expect(painted).toMatch(/\b[5-9]s\b/);
      expect(painted).toContain("Nothing has been written yet");
      expect(painted).toContain("Esc cancel");
    } finally {
      tty.stop();
    }
  });

  test("Esc aborts the call and takes the face down", async () => {
    let cancelled = 0;
    let dismissed = 0;
    setCompactionPreparingRequest({
      startedAt: Date.now(),
      onCancel: () => {
        cancelled += 1;
      },
    });
    const tty = mount({
      onCancel: () => {
        dismissed += 1;
      },
    });
    try {
      await tty.press(ESCAPE);
      expect(cancelled).toBe(1);
      expect(dismissed).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("the picker replaces it in place when the preview lands", async () => {
    // The transition the store exists for: `preparing` → `trim` without a
    // remount. If this remounted, the overlay's identity would change and the
    // frame between the two would be lost.
    setCompactionPreparingRequest({
      startedAt: Date.now(),
      onCancel: () => {},
    });
    const tty = mount();
    try {
      expect(await tty.text()).toContain("Preparing the compaction");

      setTopicTrimRequest({
        blocks: [block(1, "Auth token refresh"), block(2, "Deploy check")],
        suggestionIndex: 2,
        onPick: () => {},
      });
      await Bun.sleep(120);
      const painted = await tty.text();
      expect(painted).toContain("Choose the topic block to keep");
      expect(painted).toContain("1. Auth token refresh");
      expect(painted).toContain("2. Deploy check");
      expect(painted).not.toContain("Preparing the compaction");
    } finally {
      tty.stop();
    }
  });

  test("with nothing parked it is the mode selector, as /compact config expects", async () => {
    const tty = mount();
    try {
      const painted = await tty.text();
      expect(painted).not.toContain("Preparing the compaction");
      expect(painted).not.toContain("Choose the topic block to keep");
    } finally {
      tty.stop();
    }
  });
});
